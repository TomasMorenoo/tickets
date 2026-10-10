const { createServer } = require("node:http");
const { readFileSync, existsSync, mkdirSync } = require("node:fs");
const { extname, join, normalize } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || "127.0.0.1";
const root = __dirname;
const publicDir = join(root, "dist");
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "tickets.db"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    prefix TEXT NOT NULL UNIQUE,
    workspace_path TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY,
    project_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    updated_at TEXT NOT NULL DEFAULT '',
    claimed_by TEXT NOT NULL DEFAULT '',
    resolution_summary TEXT NOT NULL DEFAULT '',
    UNIQUE(project_id, project_number)
  );
  CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS service_status (
    service TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_project_status ON tickets(project_id, status);
  CREATE INDEX IF NOT EXISTS idx_tickets_status_priority ON tickets(status, priority);
  INSERT OR IGNORE INTO profile(id, first_name, last_name) VALUES (1, '', '');
  PRAGMA optimize;
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

ensureColumn("projects", "workspace_path", "workspace_path TEXT NOT NULL DEFAULT ''");
ensureColumn("tickets", "updated_at", "updated_at TEXT NOT NULL DEFAULT ''");
ensureColumn("tickets", "claimed_by", "claimed_by TEXT NOT NULL DEFAULT ''");
ensureColumn("tickets", "resolution_summary", "resolution_summary TEXT NOT NULL DEFAULT ''");

const selectProjects = db.prepare("SELECT id, name, color, prefix, workspace_path AS workspacePath FROM projects ORDER BY sort_order, rowid");
const selectTickets = db.prepare(`
  SELECT id, project_number AS projectNumber, title, description, project_id AS project,
    type, priority, status, created_at AS createdAt, resolved_at AS resolvedAt,
    updated_at AS updatedAt, claimed_by AS claimedBy, resolution_summary AS resolutionSummary
  FROM tickets ORDER BY id
`);
const selectProfile = db.prepare("SELECT first_name AS firstName, last_name AS lastName FROM profile WHERE id = 1");
const insertProject = db.prepare("INSERT INTO projects(id, name, color, prefix, workspace_path, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
const insertTicket = db.prepare(`
  INSERT INTO tickets(id, project_number, title, description, project_id, type, priority, status, created_at, resolved_at, updated_at, claimed_by, resolution_summary)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateProfile = db.prepare("UPDATE profile SET first_name = ?, last_name = ? WHERE id = 1");
const selectServices = db.prepare("SELECT service, status, detail, updated_at AS updatedAt FROM service_status");

function state() {
  return { projects: selectProjects.all(), tickets: selectTickets.all(), profile: selectProfile.get() };
}

function services() {
  const labels = { telegram: "Telegram", whatsapp: "WhatsApp" };
  const rows = new Map(selectServices.all().map(item => [item.service, item]));
  return {
    services: Object.entries(labels).map(([service, label]) => {
      const row = rows.get(service);
      const fresh = row && Date.now() - Date.parse(row.updatedAt) < 45000;
      return { service, label, status: fresh ? row.status : "Desconectado", detail: fresh ? row.detail : "Sin actividad reciente" };
    })
  };
}

function replaceState(input) {
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const tickets = Array.isArray(input.tickets) ? input.tickets : [];
  const profile = input.profile || { firstName: "", lastName: "" };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM tickets; DELETE FROM projects;");
    projects.forEach((project, index) => insertProject.run(project.id, project.name, project.color, project.prefix, project.workspacePath || "", index));
    tickets.forEach(ticket => insertTicket.run(
      ticket.id,
      ticket.projectNumber,
      ticket.title,
      ticket.description || "",
      ticket.project,
      ticket.type,
      ticket.priority,
      ticket.status === "Solucionado" ? "Archivado" : ticket.status,
      ticket.createdAt,
      ticket.resolvedAt || null,
      ticket.updatedAt || ticket.createdAt,
      ticket.claimedBy || "",
      ticket.resolutionSummary || ""
    ));
    updateProfile.run(profile.firstName || "", profile.lastName || "");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return state();
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Payload demasiado grande");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const relative = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const file = join(publicDir, relative);
  if (!file.startsWith(publicDir) || !existsSync(file)) {
    response.writeHead(404);
    response.end("No encontrado");
    return;
  }
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  response.end(readFileSync(file));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api/health" && request.method === "GET") return json(response, 200, { ok: true });
    if (url.pathname === "/api/services" && request.method === "GET") return json(response, 200, services());
    if (url.pathname === "/api/state" && request.method === "GET") return json(response, 200, state());
    if (url.pathname === "/api/state" && request.method === "PUT") return json(response, 200, replaceState(await readJson(request)));
    return serveStatic(request, response);
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: "No se pudo completar la operación" });
  }
});

server.listen(port, host, () => {
  console.log(`Bitácora disponible en http://${host}:${port}`);
});
