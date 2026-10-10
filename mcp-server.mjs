#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const root = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(process.env.BITACORA_DB || join(root, "data", "tickets.db"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

ensureColumn("projects", "workspace_path", "workspace_path TEXT NOT NULL DEFAULT ''");
ensureColumn("tickets", "updated_at", "updated_at TEXT NOT NULL DEFAULT ''");
ensureColumn("tickets", "claimed_by", "claimed_by TEXT NOT NULL DEFAULT ''");
ensureColumn("tickets", "resolution_summary", "resolution_summary TEXT NOT NULL DEFAULT ''");

const ticketSelect = `
  SELECT t.id, p.prefix || '-' || printf('%03d', t.project_number) AS code,
    t.title, t.description, t.type, t.priority, t.status,
    t.created_at AS createdAt, t.updated_at AS updatedAt, t.resolved_at AS resolvedAt,
    t.claimed_by AS claimedBy, t.resolution_summary AS resolutionSummary,
    p.id AS projectId, p.name AS projectName, p.workspace_path AS workspacePath
  FROM tickets t JOIN projects p ON p.id = t.project_id
`;

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function findTicket(reference) {
  const value = String(reference).trim();
  const ticket = /^\d+$/.test(value)
    ? db.prepare(`${ticketSelect} WHERE t.id = ?`).get(Number(value))
    : db.prepare(`${ticketSelect} WHERE upper(p.prefix || '-' || printf('%03d', t.project_number)) = upper(?)`).get(value);
  if (!ticket) throw new Error(`Ticket no encontrado: ${value}`);
  return ticket;
}

const server = new McpServer({ name: "bitacora-tickets", version: "1.0.0" });

server.registerTool("list_projects", {
  description: "Lista los proyectos disponibles y su ruta local. Usa workspacePath para abrir el código correcto.",
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, async () => result({ projects: db.prepare("SELECT id, name, prefix, workspace_path AS workspacePath FROM projects ORDER BY sort_order, rowid").all() }));

server.registerTool("list_tickets", {
  description: "Lista tickets con filtros opcionales. Los urgentes aparecen primero.",
  inputSchema: {
    project: z.string().optional().describe("ID, nombre o prefijo del proyecto"),
    status: z.enum(["Pendiente", "En proceso", "Revisión", "Archivado"]).optional(),
    priority: z.enum(["Baja", "Media", "Alta", "Urgente"]).optional(),
    limit: z.number().int().min(1).max(200).default(50)
  },
  annotations: { readOnlyHint: true }
}, async ({ project, status, priority, limit }) => {
  const conditions = [];
  const params = [];
  if (project) {
    conditions.push("(p.id = ? OR lower(p.name) = lower(?) OR lower(p.prefix) = lower(?))");
    params.push(project, project, project);
  }
  if (status) { conditions.push("t.status = ?"); params.push(status); }
  else conditions.push("t.status != 'Archivado'");
  if (priority) { conditions.push("t.priority = ?"); params.push(priority); }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const tickets = db.prepare(`${ticketSelect}${where} ORDER BY CASE t.priority WHEN 'Urgente' THEN 0 ELSE 1 END, t.id DESC LIMIT ?`).all(...params, limit);
  return result({ tickets });
});

server.registerTool("get_ticket", {
  description: "Obtiene todos los datos de un ticket, incluido el proyecto y la ruta local del código.",
  inputSchema: { ticket: z.string().describe("Código como DRP-001 o ID numérico") },
  annotations: { readOnlyHint: true }
}, async ({ ticket }) => result({ ticket: findTicket(ticket) }));

server.registerTool("start_ticket", {
  description: "Toma un ticket para trabajar, lo pasa a En proceso y devuelve la ruta local del proyecto.",
  inputSchema: {
    ticket: z.string().describe("Código como DRP-001 o ID numérico"),
    agent: z.string().min(1).describe("Nombre del agente, por ejemplo Codex o Claude Code")
  }
}, async ({ ticket, agent }) => {
  const current = findTicket(ticket);
  if (current.status === "Archivado") throw new Error("El ticket ya está archivado");
  const now = new Date().toISOString();
  db.prepare("UPDATE tickets SET status = 'En proceso', claimed_by = ?, updated_at = ? WHERE id = ?").run(agent, now, current.id);
  return result({ ticket: findTicket(String(current.id)), instruction: "Trabaja únicamente dentro de workspacePath y verifica los cambios antes de resolver." });
});

server.registerTool("update_ticket_status", {
  description: "Actualiza el estado de un ticket mientras el agente trabaja.",
  inputSchema: {
    ticket: z.string().describe("Código como DRP-001 o ID numérico"),
    status: z.enum(["Pendiente", "En proceso", "Revisión"]),
    agent: z.string().optional()
  }
}, async ({ ticket, status, agent }) => {
  const current = findTicket(ticket);
  const now = new Date().toISOString();
  db.prepare("UPDATE tickets SET status = ?, claimed_by = COALESCE(?, claimed_by), updated_at = ? WHERE id = ?").run(status, agent || null, now, current.id);
  return result({ ticket: findTicket(String(current.id)) });
});

server.registerTool("resolve_ticket", {
  description: "Marca un ticket como resuelto, guarda el resumen técnico y lo archiva.",
  inputSchema: {
    ticket: z.string().describe("Código como DRP-001 o ID numérico"),
    resolution: z.string().min(3).describe("Resumen claro de lo que se cambió y cómo se verificó"),
    agent: z.string().optional()
  }
}, async ({ ticket, resolution, agent }) => {
  const current = findTicket(ticket);
  const now = new Date().toISOString();
  db.prepare("UPDATE tickets SET status = 'Archivado', resolution_summary = ?, claimed_by = COALESCE(?, claimed_by), updated_at = ?, resolved_at = ? WHERE id = ?").run(resolution, agent || null, now, now, current.id);
  return result({ ticket: findTicket(String(current.id)) });
});

const transport = new StdioServerTransport();
await server.connect(transport);
