// Endpoint MCP por HTTP para usar Bitácora como conector de Claude.
// Expone una sola herramienta: encolar un mensaje de WhatsApp. El bot (whatsapp-bot.js)
// lo envía al mismo destino que las alertas de tickets, así que no se puede elegir otro número.
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const MAX_LENGTH = 6000;
const MAX_PER_HOUR = 20;
const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 200_000;

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

  function authorized(request) {
    const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const given = Buffer.from(match[1].trim());
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  function buildServer() {
    const server = new McpServer({ name: "bitacora-whatsapp", version: "1.0.0" });
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
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
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
