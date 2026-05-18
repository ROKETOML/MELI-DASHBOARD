const express = require("express");
const axios = require("axios");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Credenciales ML ──────────────────────────────────────────────────────────
const MELI_CLIENT_ID     = process.env.MELI_CLIENT_ID     || "6172573622414849";
const MELI_CLIENT_SECRET = process.env.MELI_CLIENT_SECRET || "jxg6pZpjQoA4q3H5cJMtkrSIP8Kiy8pT";
const REDIRECT_URI       = process.env.REDIRECT_URI       || "https://meli-dashboard-awyd.onrender.com";
const APP_URL            = process.env.APP_URL            || "https://meli-dashboard-awyd.onrender.com";

let ACCESS_TOKEN  = process.env.MELI_ACCESS_TOKEN  || "APP_USR-6172573622414849-051814-d2639d754484e1dd067b1ba205629695-2624087717";
let REFRESH_TOKEN = process.env.MELI_REFRESH_TOKEN || "TG-6a0b610e3a2f2700013dd896-2624087717";

// ─── Estado en memoria ────────────────────────────────────────────────────────
const ordenesProcessadas = new Set();
const ordenesEnProceso   = new Set();
let ventasRecientes = [];
let preguntasRecientes = [];
let stockItems = [];

let stats = {
  hoy:    { monto: 0, ordenes: 0, fecha: hoyAR() },
  semana: { monto: 0, ordenes: 0 },
  mes:    { monto: 0, ordenes: 0 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hoyAR() {
  return new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
}

function horaAR() {
  return new Date().toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit" });
}

function tiempoRelativo(fechaStr) {
  const diff = (Date.now() - new Date(fechaStr).getTime()) / 1000;
  if (diff < 60)    return "ahora";
  if (diff < 3600)  return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function nivelStock(disponible, inicial) {
  if (!inicial || inicial === 0) return "ok";
  const ratio = disponible / inicial;
  if (disponible <= 3 || ratio <= 0.1) return "critico";
  if (ratio <= 0.3) return "bajo";
  return "ok";
}

function resetearSiEsNuevoDia() {
  const hoy = hoyAR();
  if (hoy !== stats.hoy.fecha) {
    console.log(`🔄 Nuevo día (${hoy}), reseteando acumulado`);
    stats.hoy = { monto: 0, ordenes: 0, fecha: hoy };
    ventasRecientes = ventasRecientes.filter(v => v.fecha === hoy);
  }
}

// ─── WebSockets ───────────────────────────────────────────────────────────────
function broadcast(tipo, datos) {
  const msg = JSON.stringify({ tipo, datos, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on("connection", (ws) => {
  console.log("🖥️  Cliente dashboard conectado");
  ws.send(JSON.stringify({
    tipo: "init",
    datos: { stats, ventasRecientes, preguntasRecientes, stockItems }
  }));
});

// ─── Token ML ─────────────────────────────────────────────────────────────────
async function canjearCodigo(code) {
  const res = await axios.post(
    "https://api.mercadolibre.com/oauth/token",
    `grant_type=authorization_code&client_id=${MELI_CLIENT_ID}&client_secret=${MELI_CLIENT_SECRET}&code=${code}&redirect_uri=${REDIRECT_URI}`,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  ACCESS_TOKEN  = res.data.access_token;
  REFRESH_TOKEN = res.data.refresh_token;
  console.log("✅ Token canjeado correctamente");
  console.log("ACCESS_TOKEN:", ACCESS_TOKEN);
  console.log("REFRESH_TOKEN:", REFRESH_TOKEN);
}

async function renovarToken() {
  if (!REFRESH_TOKEN) { console.log("⚠️  Sin refresh token"); return; }
  try {
    console.log("🔄 Renovando Access Token...");
    const res = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      `grant_type=refresh_token&client_id=${MELI_CLIENT_ID}&client_secret=${MELI_CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    ACCESS_TOKEN  = res.data.access_token;
    REFRESH_TOKEN = res.data.refresh_token;
    console.log("✅ Token renovado correctamente");
  } catch (error) {
    console.error("❌ Error renovando token:", error.message);
  }
}

setInterval(renovarToken, 5 * 60 * 60 * 1000);

// ─── Keep alive ───────────────────────────────────────────────────────────────
setInterval(() => {
  axios.get(APP_URL)
    .then(() => console.log("💓 Keep alive OK"))
    .catch(() => console.log("⚠️  Keep alive falló"));
}, 10 * 60 * 1000);

// ─── ML API ───────────────────────────────────────────────────────────────────
async function getOrden(ordenId) {
  try {
    const res = await axios.get(`https://api.mercadolibre.com/orders/${ordenId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    return res.data;
  } catch (e) {
    console.error("❌ Error obteniendo orden:", e.message);
    return null;
  }
}

async function fetchPreguntas() {
  if (!ACCESS_TOKEN) return preguntasRecientes;
  try {
    const res = await axios.get(
      `https://api.mercadolibre.com/questions/search?seller_id=2624087717&status=UNANSWERED&limit=20`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    preguntasRecientes = (res.data.questions || []).map(q => ({
      id:          q.id,
      texto:       q.text,
      comprador:   q.from?.nickname || "Usuario",
      itemId:      q.item_id,
      itemTitulo:  q.item?.title || q.item_id,
      fecha:       q.date_created,
      hace:        tiempoRelativo(q.date_created),
    }));
    broadcast("preguntas", preguntasRecientes);
    return preguntasRecientes;
  } catch (e) {
    console.error("❌ Error preguntas:", e.message);
    return preguntasRecientes;
  }
}

async function fetchStock() {
  if (!ACCESS_TOKEN) return stockItems;
  try {
    const res = await axios.get(
      `https://api.mercadolibre.com/users/2624087717/items/search?limit=20`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    const ids = (res.data.results || []).join(",");
    if (!ids) return stockItems;

    const itemsRes = await axios.get(
      `https://api.mercadolibre.com/items?ids=${ids}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    stockItems = (itemsRes.data || [])
      .filter(i => i.code === 200)
      .map(i => ({
        id:           i.body.id,
        titulo:       i.body.title,
        stock:        i.body.available_quantity,
        stockInicial: i.body.initial_quantity || i.body.available_quantity,
        precio:       i.body.price,
        moneda:       i.body.currency_id,
        estado:       nivelStock(i.body.available_quantity, i.body.initial_quantity),
      }));

    broadcast("stock", stockItems);
    return stockItems;
  } catch (e) {
    console.error("❌ Error stock:", e.message);
    return stockItems;
  }
}

setInterval(async () => {
  await fetchPreguntas();
  await fetchStock();
}, 5 * 60 * 1000);

// ─── Rutas ────────────────────────────────────────────────────────────────────

// Endpoint para canjear código OAuth desde el navegador
app.get("/auth", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.send(`<html><body style="font-family:sans-serif;padding:24px">
      <h2>Falta el código</h2>
      <p>Usá: <code>/auth?code=TG-...</code></p>
    </body></html>`);
  }
  try {
    await canjearCodigo(code);
    // Cargar datos iniciales con el token nuevo
    await Promise.all([fetchPreguntas(), fetchStock()]);
    res.send(`<html><body style="font-family:monospace;padding:24px;background:#0f0f0f;color:#f0f0f0">
      <h2 style="color:#22c55e;font-family:sans-serif">✅ Tokens obtenidos correctamente</h2>
      <p style="color:#888;margin:16px 0 6px">Access Token:</p>
      <pre style="background:#1e1e1e;padding:12px;border-radius:8px;word-break:break-all;color:#FFE600;font-size:12px">${ACCESS_TOKEN}</pre>
      <p style="color:#888;margin:16px 0 6px">Refresh Token:</p>
      <pre style="background:#1e1e1e;padding:12px;border-radius:8px;word-break:break-all;color:#FFE600;font-size:12px">${REFRESH_TOKEN}</pre>
      <p style="color:#22c55e;margin-top:20px;font-family:sans-serif">El servidor ya está usando estos tokens. <a href="/" style="color:#3b82f6">Ir al dashboard →</a></p>
    </body></html>`);
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data, null, 2) : e.message;
    res.send(`<html><body style="font-family:monospace;padding:24px;background:#0f0f0f;color:#ef4444">
      <h2 style="font-family:sans-serif">❌ Error canjeando token</h2>
      <pre style="background:#1e1e1e;padding:12px;border-radius:8px;color:#f87171;font-size:12px">${msg}</pre>
    </body></html>`);
  }
});

// Webhook de ML
app.post("/webhook", async (req, res) => {
  console.log("📩 Notificación:", JSON.stringify(req.body));
  res.sendStatus(200);

  const { topic, resource } = req.body;

  if (topic === "orders_v2" || topic === "orders") {
    const ordenId = resource.split("/").pop();

    if (ordenesProcessadas.has(ordenId) || ordenesEnProceso.has(ordenId)) {
      console.log(`⏭️  Orden ${ordenId} ya procesada, ignorando`);
      return;
    }

    ordenesEnProceso.add(ordenId);
    const orden = await getOrden(ordenId);

    if (!orden) { ordenesEnProceso.delete(ordenId); return; }

    if (orden.status === "paid") {
      ordenesProcessadas.add(ordenId);
      ordenesEnProceso.delete(ordenId);
      setTimeout(() => ordenesProcessadas.delete(ordenId), 60 * 60 * 1000);

      resetearSiEsNuevoDia();

      const monto = orden.total_amount || 0;
      if (orden.currency_id === "ARS") {
        stats.hoy.monto    += monto;
        stats.hoy.ordenes  += 1;
        stats.semana.monto += monto;
        stats.semana.ordenes += 1;
        stats.mes.monto    += monto;
        stats.mes.ordenes  += 1;
      }

      const venta = {
        id:        orden.id,
        comprador: orden.buyer?.nickname || "Comprador",
        items:     orden.order_items.map(i => ({ titulo: i.item.title, cantidad: i.quantity, precio: i.unit_price })),
        total:     monto,
        moneda:    orden.currency_id,
        fecha:     hoyAR(),
        hora:      horaAR(),
        ts:        Date.now(),
      };

      ventasRecientes.unshift(venta);
      if (ventasRecientes.length > 100) ventasRecientes.pop();

      console.log(`✅ Venta: ${orden.id} — ARS ${monto}`);
      broadcast("venta_nueva", { venta, stats });

    } else {
      ordenesEnProceso.delete(ordenId);
    }
  }

  if (topic === "questions") {
    setTimeout(fetchPreguntas, 2000);
  }
});

// API REST
app.get("/api/stats",     (req, res) => res.json({ stats, ventasRecientes: ventasRecientes.slice(0, 20) }));
app.get("/api/preguntas", async (req, res) => res.json(await fetchPreguntas()));
app.get("/api/stock",     async (req, res) => res.json(await fetchStock()));
app.get("/api/init",      async (req, res) => {
  const [preguntas, stock] = await Promise.all([fetchPreguntas(), fetchStock()]);
  res.json({ stats, ventasRecientes: ventasRecientes.slice(0, 20), preguntas, stock });
});

// Dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Arranque ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Dashboard corriendo en puerto ${PORT}`);
  if (ACCESS_TOKEN) {
    console.log("🔑 Token cargado desde variables de entorno");
    await Promise.all([fetchPreguntas(), fetchStock()]);
  } else {
    console.log("⚠️  Sin token. Visitá /auth?code=... para activar");
  }
});
