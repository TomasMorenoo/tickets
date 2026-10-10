// Endpoint MCP por HTTP para usar Bitácora como conector de Claude.
// Herramientas: ver proyectos y tickets, crear tickets y encolar un mensaje de WhatsApp.
// El bot (whatsapp-bot.js) envía los mensajes al mismo destino que las alertas de tickets,
// así que no se puede elegir otro número. No permite editar ni archivar tickets.
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const MAX_LENGTH = 6000;
const MAX_PER_HOUR = 20;
const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 200_000;
const MAX_TICKETS_PER_HOUR = 30;
const TICKET_TYPES = ["Fix", "Feat", "Refactor", "Config", "Mantenimiento"];
const PRIORITIES = ["Baja", "Media", "Alta", "Urgente"];
const STATUSES = ["Pendiente", "En proceso", "Revisión", "Archivado"];

const ticketSelect = `
  SELECT t.id, p.prefix || '-' || printf('%03d', t.project_number) AS codigo,
    t.title AS titulo, t.description AS descripcion, t.type AS tipo, t.priority AS prioridad, t.status AS estado,
    t.created_at AS creado, t.updated_at AS actualizado, t.resolved_at AS resuelto,
    t.claimed_by AS tomadoPor, t.resolution_summary AS resumenSolucion,
    p.id AS proyectoId, p.name AS proyecto
  FROM tickets t JOIN projects p ON p.id = t.project_id
`;

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Payload demasiado grande");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createMcpHandler(db) {
  db.exec(`
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

  const expected = Buffer.from((process.env.MCP_HTTP_TOKEN || "").trim());
  const enabled = expected.length >= MIN_TOKEN_LENGTH;
  if (!enabled) console.warn(`Conector MCP desactivado: definí MCP_HTTP_TOKEN (mínimo ${MIN_TOKEN_LENGTH} caracteres) en .env.`);

  const insertMessage = db.prepare("INSERT INTO whatsapp_outbox(body, source, created_at) VALUES (?, ?, ?)");
  const countRecent = db.prepare("SELECT COUNT(*) AS total FROM whatsapp_outbox WHERE created_at >= ?");
  const whatsappStatus = db.prepare("SELECT status, updated_at AS updatedAt FROM service_status WHERE service = 'whatsapp'");
  const selectProjects = db.prepare(`
    SELECT p.id, p.name AS nombre, p.prefix AS prefijo,
      (SELECT COUNT(*) FROM tickets t WHERE t.project_id = p.id AND t.status != 'Archivado') AS ticketsAbiertos
    FROM projects p ORDER BY p.sort_order, p.rowid
  `);
  const findProject = db.prepare("SELECT id, name, prefix FROM projects WHERE id = ? OR lower(name) = lower(?) OR lower(prefix) = lower(?)");
  const ticketById = db.prepare(`${ticketSelect} WHERE t.id = ?`);
  const ticketByCode = db.prepare(`${ticketSelect} WHERE upper(p.prefix || '-' || printf('%03d', t.project_number)) = upper(?)`);
  const nextId = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS value FROM tickets");
  const nextProjectNumber = db.prepare("SELECT COALESCE(MAX(project_number), 0) + 1 AS value FROM tickets WHERE project_id = ?");
  const countRecentTickets = db.prepare("SELECT COUNT(*) AS total FROM tickets WHERE created_at >= ?");
  const insertTicket = db.prepare(`
    INSERT INTO tickets(id, project_number, title, description, project_id, type, priority, status, created_at, resolved_at, updated_at, claimed_by, resolution_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, NULL, ?, '', '')
  `);

  function requireProject(reference) {
    const value = String(reference).trim();
    const project = findProject.get(value, value, value);
    if (!project) {
      const available = selectProjects.all().map(item => `${item.prefijo} (${item.nombre})`).join(", ");
      throw new Error(`Proyecto no encontrado: ${value}. Disponibles: ${available || "ninguno"}.`);
    }
    return project;
  }

  function requireTicket(reference) {
    const value = String(reference).trim();
    const ticket = /^\d+$/.test(value) ? ticketById.get(Number(value)) : ticketByCode.get(value);
    if (!ticket) throw new Error(`Ticket no encontrado: ${value}`);
    return ticket;
  }

  function authorized(request) {
    const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const given = Buffer.from(match[1].trim());
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function buildServer() {
    const server = new McpServer({ name: "bitacora", version: "1.1.0" });
    server.registerTool("enviar_whatsapp", {
      description: "Envía un mensaje de texto al WhatsApp del dueño de Bitácora (el mismo chat que recibe las alertas de tickets). El destino es fijo. El mensaje se encola y el bot lo envía en unos segundos.",
      inputSchema: {
        mensaje: z.string().trim().min(1).max(MAX_LENGTH).describe("Texto a enviar. Admite saltos de línea y el formato de WhatsApp (*negrita*, _cursiva_)."),
        origen: z.string().trim().max(60).optional().describe("Etiqueta para identificar quién lo envía, por ejemplo 'resumen-gmail'.")
      }
    }, async ({ mensaje, origen }) => {
      const now = new Date();
      const recent = countRecent.get(new Date(now.getTime() - 3_600_000).toISOString()).total;
      if (recent >= MAX_PER_HOUR) throw new Error(`Límite alcanzado: ${MAX_PER_HOUR} mensajes por hora.`);
      const { lastInsertRowid } = insertMessage.run(mensaje, origen || "", now.toISOString());
      const status = whatsappStatus.get();
      const connected = Boolean(status && status.status === "Conectado" && now.getTime() - Date.parse(status.updatedAt) < 45000);
      const value = {
        encolado: true,
        id: Number(lastInsertRowid),
        whatsappConectado: connected,
        detalle: connected
          ? "El bot lo envía en unos segundos."
          : "El bot de WhatsApp no está conectado ahora. El mensaje queda en cola y sale si se reconecta dentro de las próximas 24 horas."
      };
      return result(value);
    });

    server.registerTool("listar_proyectos", {
      description: "Lista los proyectos de Bitácora con su prefijo y cuántos tickets abiertos tiene cada uno.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    }, async () => result({ proyectos: selectProjects.all() }));

    server.registerTool("listar_tickets", {
      description: "Lista tickets de Bitácora. Sin filtro de estado devuelve los abiertos (todo menos Archivado). Ordena por prioridad (Urgente primero) y después por los más nuevos. La descripción viene recortada: usá ver_ticket para el detalle.",
      inputSchema: {
        proyecto: z.string().trim().min(1).optional().describe("ID, nombre o prefijo del proyecto, por ejemplo DRP"),
        estado: z.enum(STATUSES).optional().describe("Si se omite, todos menos Archivado"),
        prioridad: z.enum(PRIORITIES).optional(),
        limite: z.number().int().min(1).max(200).default(50)
      },
      annotations: { readOnlyHint: true }
    }, async ({ proyecto, estado, prioridad, limite }) => {
      const conditions = [];
      const params = [];
      if (proyecto) { conditions.push("p.id = ?"); params.push(requireProject(proyecto).id); }
      if (estado) { conditions.push("t.status = ?"); params.push(estado); }
      else conditions.push("t.status != 'Archivado'");
      if (prioridad) { conditions.push("t.priority = ?"); params.push(prioridad); }
      const tickets = db.prepare(`${ticketSelect} WHERE ${conditions.join(" AND ")}
        ORDER BY CASE t.priority WHEN 'Urgente' THEN 0 WHEN 'Alta' THEN 1 WHEN 'Media' THEN 2 ELSE 3 END, t.id DESC LIMIT ?`).all(...params, limite);
      return result({
        total: tickets.length,
        tickets: tickets.map(ticket => ({ ...ticket, descripcion: ticket.descripcion.length > 300 ? `${ticket.descripcion.slice(0, 300)}…` : ticket.descripcion }))
      });
    });

    server.registerTool("ver_ticket", {
      description: "Devuelve todos los datos de un ticket de Bitácora, con la descripción completa.",
      inputSchema: { ticket: z.string().trim().min(1).describe("Código como DRP-001 o ID numérico") },
      annotations: { readOnlyHint: true }
    }, async ({ ticket }) => result({ ticket: requireTicket(ticket) }));

    server.registerTool("crear_ticket", {
      description: "Crea un ticket nuevo en Bitácora, en estado Pendiente. Al crearlo, el bot envía la alerta de ticket nuevo por WhatsApp. Usá listar_proyectos si no sabés a qué proyecto corresponde.",
      inputSchema: {
        proyecto: z.string().trim().min(1).describe("ID, nombre o prefijo del proyecto, por ejemplo DRP"),
        titulo: z.string().trim().min(3).max(200).describe("Título corto y concreto"),
        descripcion: z.string().trim().max(4000).default("").describe("Qué pasa, cómo reproducirlo y qué se espera"),
        tipo: z.enum(TICKET_TYPES).describe("Fix = error, Feat = funcionalidad nueva, Refactor, Config, Mantenimiento"),
        prioridad: z.enum(PRIORITIES).default("Media")
      }
    }, async ({ proyecto, titulo, descripcion, tipo, prioridad }) => {
      const project = requireProject(proyecto);
      const now = new Date();
      const recent = countRecentTickets.get(new Date(now.getTime() - 3_600_000).toISOString()).total;
      if (recent >= MAX_TICKETS_PER_HOUR) throw new Error(`Límite alcanzado: ${MAX_TICKETS_PER_HOUR} tickets por hora.`);
      const stamp = now.toISOString();
      db.exec("BEGIN IMMEDIATE");
      let id;
      try {
        id = nextId.get().value;
        insertTicket.run(id, nextProjectNumber.get(project.id).value, titulo, descripcion, project.id, tipo, prioridad, stamp, stamp);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return result({ creado: true, ticket: ticketById.get(id) });
    });

    return server;
  }

  return async function handleMcp(request, response) {
    if (!enabled) return send(response, 404, { error: "No encontrado" });
    if (request.method !== "POST") return send(response, 405, { error: "Método no permitido" }, { Allow: "POST" });
    if (!authorized(request)) return send(response, 401, { error: "No autorizado" });

    let body;
    try {
      body = await readJson(request);
    } catch {
      return send(response, 400, { jsonrpc: "2.0", error: { code: -32700, message: "JSON inválido" }, id: null });
    }

    // Sin sesiones: cada pedido usa un servidor y un transporte propios.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  };
}
