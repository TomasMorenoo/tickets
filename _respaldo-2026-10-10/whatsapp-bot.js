const { existsSync, readFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");

const root = __dirname;
const envPath = join(root, ".env");

for (const lockName of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
  try {
    unlinkSync(join(root, ".wwebjs_auth", "session", lockName));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const dbPath = join(root, "data", "tickets.db");
if (!existsSync(dbPath)) {
  console.error("No existe data/tickets.db. Iniciá primero la web con npm start.");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

const notificationsExist = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_notifications'").get());
const resolutionNotificationsExist = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_resolution_notifications'").get());
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_notifications (
    ticket_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    notified_at TEXT NOT NULL,
    PRIMARY KEY(ticket_id, created_at)
  );
  CREATE TABLE IF NOT EXISTS whatsapp_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS whatsapp_reminder_notifications (
    ticket_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    notified_at TEXT NOT NULL,
    PRIMARY KEY(ticket_id, created_at)
  );
  CREATE TABLE IF NOT EXISTS whatsapp_resolution_notifications (
    ticket_id INTEGER NOT NULL,
    resolved_at TEXT NOT NULL,
    notified_at TEXT NOT NULL,
    PRIMARY KEY(ticket_id, resolved_at)
  );
  CREATE TABLE IF NOT EXISTS service_status (
    service TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
`);

if (!notificationsExist) {
  db.exec(`
    INSERT OR IGNORE INTO whatsapp_notifications(ticket_id, created_at, notified_at)
    SELECT id, created_at, datetime('now') FROM tickets
  `);
}

if (!resolutionNotificationsExist) {
  db.exec(`
    INSERT OR IGNORE INTO whatsapp_resolution_notifications(ticket_id, resolved_at, notified_at)
    SELECT id, resolved_at, datetime('now') FROM tickets
    WHERE status = 'Archivado' AND resolved_at IS NOT NULL
  `);
}

const pendingTickets = db.prepare(`
  SELECT t.id, t.project_number, t.title, t.description, t.type, t.priority, t.status, t.created_at,
    p.name AS project_name, p.prefix
  FROM tickets t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN whatsapp_notifications n ON n.ticket_id = t.id AND n.created_at = t.created_at
  WHERE n.ticket_id IS NULL
  ORDER BY t.id
`);
const markNotified = db.prepare("INSERT OR IGNORE INTO whatsapp_notifications(ticket_id, created_at, notified_at) VALUES (?, ?, ?)");
const pendingReminders = db.prepare(`
  SELECT t.id, t.project_number, t.title, t.priority, t.created_at,
    p.name AS project_name, p.prefix
  FROM tickets t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN whatsapp_reminder_notifications n ON n.ticket_id = t.id AND n.created_at = t.created_at
  WHERE t.status != 'Archivado'
    AND datetime(t.created_at) <= datetime('now', '-24 hours')
    AND n.ticket_id IS NULL
  ORDER BY t.created_at, t.id
`);
const markReminderNotified = db.prepare("INSERT OR IGNORE INTO whatsapp_reminder_notifications(ticket_id, created_at, notified_at) VALUES (?, ?, ?)");
const pendingResolutions = db.prepare(`
  SELECT t.id, t.project_number, t.title, t.resolution_summary, t.resolved_at,
    p.name AS project_name, p.prefix
  FROM tickets t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN whatsapp_resolution_notifications n ON n.ticket_id = t.id AND n.resolved_at = t.resolved_at
  WHERE t.status = 'Archivado' AND t.resolved_at IS NOT NULL AND n.ticket_id IS NULL
  ORDER BY t.resolved_at, t.id
`);
const markResolutionNotified = db.prepare("INSERT OR IGNORE INTO whatsapp_resolution_notifications(ticket_id, resolved_at, notified_at) VALUES (?, ?, ?)");
const getMeta = db.prepare("SELECT value FROM whatsapp_meta WHERE key = ?");
const setMeta = db.prepare("INSERT OR REPLACE INTO whatsapp_meta(key, value) VALUES (?, ?)");
const setServiceStatus = db.prepare(`
  INSERT INTO service_status(service, status, detail, updated_at) VALUES ('whatsapp', ?, ?, ?)
  ON CONFLICT(service) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at
`);

function reportStatus(status, detail = "") {
  setServiceStatus.run(status, detail, new Date().toISOString());
}

let ready = false;
let sending = false;
let destination = "";

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: join(root, ".wwebjs_auth") }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

function ticketCode(ticket) {
  return `${ticket.prefix}-${String(ticket.project_number).padStart(3, "0")}`;
}

function formatMessage(ticket) {
  const alert = ticket.priority === "Urgente" ? "🚨 NUEVO TICKET URGENTE" : "🎫 NUEVO TICKET";
  const description = ticket.description?.trim();
  return [
    "------------------",
    alert,
    "------------------",
    `Código: ${ticketCode(ticket)}`,
    `Título: ${ticket.title}`,
    `Proyecto: ${ticket.project_name}`,
    `Tipo: ${ticket.type}`,
    `Prioridad: ${ticket.priority}`,
    `Estado: ${ticket.status}`,
    ...(description ? ["------------------", "Descripción:", description.slice(0, 700)] : []),
    "------------------"
  ].join("\n");
}

function formatReminderMessage(ticket) {
  const elapsedDays = Math.max(1, Math.floor((Date.now() - Date.parse(ticket.created_at)) / 86_400_000));
  return [
    "⏰ Ticket pendiente",
    `${ticketCode(ticket)} · ${ticket.title}`,
    `Lleva ${elapsedDays} ${elapsedDays === 1 ? "día" : "días"} pendiente.`,
    `Prioridad: ${ticket.priority}`
  ].join("\n");
}

function formatResolutionMessage(ticket) {
  const summary = ticket.resolution_summary?.trim();
  return [
    "✅ Ticket solucionado",
    `${ticketCode(ticket)} · ${ticket.title}`,
    ...(summary ? ["", summary.slice(0, 700)] : [])
  ].join("\n");
}

async function resolveDestination() {
  const configured = process.env.WHATSAPP_NOTIFY_NUMBER?.replace(/\D/g, "");
  if (!configured) return client.info.wid._serialized;
  const numberId = await client.getNumberId(configured);
  if (!numberId) throw new Error("WHATSAPP_NOTIFY_NUMBER no corresponde a una cuenta de WhatsApp.");
  return numberId._serialized;
}

async function notifyNewTickets() {
  if (!ready || sending) return;
  sending = true;
  try {
    for (const ticket of pendingTickets.all()) {
      await client.sendMessage(destination, formatMessage(ticket));
      markNotified.run(ticket.id, ticket.created_at, new Date().toISOString());
      console.log(`Notificado: ${ticketCode(ticket)}`);
    }
    for (const ticket of pendingReminders.all()) {
      await client.sendMessage(destination, formatReminderMessage(ticket));
      markReminderNotified.run(ticket.id, ticket.created_at, new Date().toISOString());
      console.log(`Recordatorio enviado: ${ticketCode(ticket)}`);
    }
    for (const ticket of pendingResolutions.all()) {
      await client.sendMessage(destination, formatResolutionMessage(ticket));
      markResolutionNotified.run(ticket.id, ticket.resolved_at, new Date().toISOString());
      console.log(`Solución notificada: ${ticketCode(ticket)}`);
    }
  } catch (error) {
    console.error(`No se pudo enviar la notificación: ${error.message}`);
  } finally {
    sending = false;
  }
}

client.on("qr", qr => {
  reportStatus("Esperando QR", "Vinculación pendiente");
  console.clear();
  console.log("Escaneá este QR desde WhatsApp > Dispositivos vinculados:\n");
  qrcode.generate(qr, { small: true });
  QRCode.toFile(join(root, "data", "whatsapp-qr.png"), qr, { width: 420, margin: 3 })
    .then(() => console.log("\nQR guardado en data/whatsapp-qr.png"))
    .catch(error => console.error(error.message));
});

client.on("authenticated", () => {
  reportStatus("Conectando", "Sesión autenticada");
  console.log("WhatsApp autenticado. Preparando conexión...");
});

client.on("ready", async () => {
  try {
    destination = await resolveDestination();
    ready = true;
    reportStatus("Conectado", "Alertas y recordatorios activos");
    console.log("WhatsApp conectado. Alertas y recordatorios activos.");
    const confirmationKey = `connection-confirmed:${destination}`;
    if (!getMeta.get(confirmationKey)) {
      await client.sendMessage(destination, "✅ Bitácora conectada\n\nLas alertas de tickets llegarán a este chat.");
      setMeta.run(confirmationKey, new Date().toISOString());
      console.log("Mensaje de confirmación enviado.");
    }
    await notifyNewTickets();
  } catch (error) {
    console.error(error.message);
  }
});

client.on("auth_failure", message => {
  reportStatus("Error", "Falló la autenticación");
  console.error(`Falló la autenticación: ${message}`);
});
client.on("disconnected", reason => {
  ready = false;
  reportStatus("Desconectado", String(reason));
  console.error(`WhatsApp desconectado: ${reason}. Reiniciá npm run whatsapp.`);
});

const interval = setInterval(notifyNewTickets, 2500);
const heartbeat = setInterval(() => {
  if (ready) reportStatus("Conectado", "Alertas y recordatorios activos");
}, 15000);

async function shutdown() {
  clearInterval(interval);
  clearInterval(heartbeat);
  await client.destroy().catch(() => {});
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Iniciando WhatsApp...");
reportStatus("Conectando", "Iniciando cliente");
client.initialize().catch(error => {
  console.error(error.message);
  process.exit(1);
});
