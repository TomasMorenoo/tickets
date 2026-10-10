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

// Migración: whatsapp_reminder_notifications de (ticket_id, created_at) a (ticket_id, level)
{
  const cols = db.prepare("PRAGMA table_info(whatsapp_reminder_notifications)").all();
  if (cols.length > 0 && !cols.some(c => c.name === "level")) {
    db.exec(`
      CREATE TABLE whatsapp_reminder_notifications_new (
        ticket_id INTEGER NOT NULL,
        level INTEGER NOT NULL,
        notified_at TEXT NOT NULL,
        PRIMARY KEY(ticket_id, level)
      );
      INSERT OR IGNORE INTO whatsapp_reminder_notifications_new(ticket_id, level, notified_at)
        SELECT ticket_id, 1, notified_at FROM whatsapp_reminder_notifications;
      DROP TABLE whatsapp_reminder_notifications;
      ALTER TABLE whatsapp_reminder_notifications_new RENAME TO whatsapp_reminder_notifications;
    `);
    console.log("Migrado: whatsapp_reminder_notifications a esquema de niveles.");
  }
}

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
    level INTEGER NOT NULL,
    notified_at TEXT NOT NULL,
    PRIMARY KEY(ticket_id, level)
  );
  CREATE TABLE IF NOT EXISTS whatsapp_inprogress_notifications (
    ticket_id INTEGER PRIMARY KEY,
    notified_at TEXT NOT NULL
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
  CREATE TABLE IF NOT EXISTS whatsapp_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    sent_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT ''
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
const activeForReminders = db.prepare(`
  SELECT t.id, t.project_number, t.title, t.priority, t.status, t.created_at,
    p.name AS project_name, p.prefix,
    CAST((julianday('now') - julianday(t.created_at)) * 24 AS INTEGER) AS age_hours
  FROM tickets t
  JOIN projects p ON p.id = t.project_id
  WHERE t.status != 'Archivado'
  ORDER BY t.created_at, t.id
`);
const sentReminderLevels = db.prepare("SELECT ticket_id, level FROM whatsapp_reminder_notifications");
const markReminderLevel = db.prepare("INSERT OR IGNORE INTO whatsapp_reminder_notifications(ticket_id, level, notified_at) VALUES (?, ?, ?)");
const pendingInProgress = db.prepare(`
  SELECT t.id, t.project_number, t.title, t.priority, t.status, t.created_at,
    p.name AS project_name, p.prefix
  FROM tickets t
  JOIN projects p ON p.id = t.project_id
  LEFT JOIN whatsapp_inprogress_notifications n ON n.ticket_id = t.id
  WHERE t.status = 'En proceso' AND n.ticket_id IS NULL
  ORDER BY t.updated_at, t.id
`);
const markInProgressNotified = db.prepare("INSERT OR IGNORE INTO whatsapp_inprogress_notifications(ticket_id, notified_at) VALUES (?, ?)");
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
// Mensajes encolados desde afuera (conector de Claude). Se descartan tras 5 intentos o 24 horas.
const pendingOutbox = db.prepare(`
  SELECT id, body FROM whatsapp_outbox
  WHERE sent_at IS NULL AND attempts < 5
    AND datetime(created_at) >= datetime('now', '-24 hours')
  ORDER BY id
`);
const markOutboxSent = db.prepare("UPDATE whatsapp_outbox SET sent_at = ? WHERE id = ?");
const markOutboxFailed = db.prepare("UPDATE whatsapp_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?");
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
let sendingOutbox = false;
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
  const ageDays = Math.floor((Date.now() - Date.parse(ticket.created_at)) / 86_400_000);
  const ageWeeks = Math.floor(ageDays / 7);
  const timeStr = ageWeeks >= 1
    ? `${ageWeeks} ${ageWeeks === 1 ? "semana" : "semanas"}`
    : `${Math.max(1, ageDays)} ${ageDays === 1 ? "día" : "días"}`;
  const label = ticket.status === "En proceso" ? "🔄 En proceso · Recordatorio" : "⏰ Pendiente · Recordatorio";
  return [
    label,
    `${ticketCode(ticket)} · ${ticket.title}`,
    `Lleva ${timeStr} sin resolver.`,
    `Prioridad: ${ticket.priority}`
  ].join("\n");
}

function formatInProgressMessage(ticket) {
  return [
    "🔄 Ticket en proceso",
    `${ticketCode(ticket)} · ${ticket.title}`,
    `Proyecto: ${ticket.project_name}`,
    `Prioridad: ${ticket.priority}`
  ].join("\n");
}

function reminderThresholdHours(level) {
  if (level === 1) return 24;
  if (level === 2) return 72;
  return 168 * (level - 2);
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
    for (const ticket of pendingInProgress.all()) {
      await client.sendMessage(destination, formatInProgressMessage(ticket));
      markInProgressNotified.run(ticket.id, new Date().toISOString());
      console.log(`En proceso notificado: ${ticketCode(ticket)}`);
    }
    const levelsMap = new Map();
    for (const row of sentReminderLevels.all()) {
      if (!levelsMap.has(row.ticket_id)) levelsMap.set(row.ticket_id, new Set());
      levelsMap.get(row.ticket_id).add(row.level);
    }
    for (const ticket of activeForReminders.all()) {
      const sent = levelsMap.get(ticket.id) || new Set();
      let dueLevel = 0;
      for (let l = 1; ticket.age_hours >= reminderThresholdHours(l); l++) dueLevel = l;
      if (dueLevel === 0 || sent.has(dueLevel)) continue;
      for (let l = 1; l < dueLevel; l++) {
        if (!sent.has(l)) markReminderLevel.run(ticket.id, l, new Date().toISOString());
      }
      await client.sendMessage(destination, formatReminderMessage(ticket));
      markReminderLevel.run(ticket.id, dueLevel, new Date().toISOString());
      console.log(`Recordatorio nivel ${dueLevel} enviado: ${ticketCode(ticket)}`);
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

async function sendOutbox() {
  if (!ready || sendingOutbox) return;
  sendingOutbox = true;
  try {
    for (const message of pendingOutbox.all()) {
      try {
        await client.sendMessage(destination, message.body);
        markOutboxSent.run(new Date().toISOString(), message.id);
        console.log(`Mensaje externo enviado: #${message.id}`);
      } catch (error) {
        markOutboxFailed.run(String(error.message).slice(0, 300), message.id);
        console.error(`No se pudo enviar el mensaje externo #${message.id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`No se pudo leer la cola de mensajes: ${error.message}`);
  } finally {
    sendingOutbox = false;
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
    await sendOutbox();
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
const outboxInterval = setInterval(sendOutbox, 2500);
const heartbeat = setInterval(() => {
  if (ready) reportStatus("Conectado", "Alertas y recordatorios activos");
}, 15000);

async function shutdown() {
  clearInterval(interval);
  clearInterval(outboxInterval);
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
