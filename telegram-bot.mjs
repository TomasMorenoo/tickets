import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL(".", import.meta.url));
const envPath = join(root, ".env");

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim();
const codexEnabled = process.env.CODEX_ENABLED !== "false";
const codexCommand = process.env.CODEX_COMMAND?.trim() || "codex";
const codexHome = process.env.CODEX_HOME?.trim() || "/root/.codex";
const codexWorkspace = process.env.CODEX_DEFAULT_WORKSPACE?.trim() || "/vps/clientes";
const codexTimeoutMs = Number(process.env.CODEX_TIMEOUT_MS) || 20 * 60 * 1000;
const deployQueuePath = join(root, "data", "deploy-queue");

if (!token) {
  console.error("Falta TELEGRAM_BOT_TOKEN en .env");
  process.exit(1);
}

const dbPath = join(root, "data", "tickets.db");
if (!existsSync(dbPath)) {
  console.error("No existe data/tickets.db. Iniciá primero la web con npm start.");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`CREATE TABLE IF NOT EXISTS service_status (
  service TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS codex_chat_sessions (
  chat_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
const setServiceStatus = db.prepare(`
  INSERT INTO service_status(service, status, detail, updated_at) VALUES ('telegram', ?, ?, ?)
  ON CONFLICT(service) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at
`);

function reportStatus(status, detail = "") {
  setServiceStatus.run(status, detail, new Date().toISOString());
}

const getProjects = db.prepare("SELECT id, name, prefix FROM projects ORDER BY sort_order, rowid");
const getProject = db.prepare("SELECT id, name, prefix FROM projects WHERE id = ?");
const getTicketById = db.prepare(`
  SELECT t.*, p.name AS project_name, p.prefix
  FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = ?
`);
const getTicketByCode = db.prepare(`
  SELECT t.*, p.name AS project_name, p.prefix
  FROM tickets t JOIN projects p ON p.id = t.project_id
  WHERE UPPER(p.prefix || '-' || printf('%03d', t.project_number)) = UPPER(?)
`);
const listOpen = db.prepare(`
  SELECT t.*, p.name AS project_name, p.prefix
  FROM tickets t JOIN projects p ON p.id = t.project_id
  WHERE t.status != 'Archivado'
  ORDER BY CASE t.priority WHEN 'Urgente' THEN 0 WHEN 'Alta' THEN 1 WHEN 'Media' THEN 2 ELSE 3 END,
    t.created_at DESC LIMIT 20
`);
const listPending = db.prepare(`
  SELECT t.*, p.name AS project_name, p.prefix
  FROM tickets t JOIN projects p ON p.id = t.project_id
  WHERE t.status = 'Pendiente'
  ORDER BY CASE t.priority WHEN 'Urgente' THEN 0 WHEN 'Alta' THEN 1 WHEN 'Media' THEN 2 ELSE 3 END,
    t.created_at DESC LIMIT 20
`);
const nextId = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS value FROM tickets");
const nextProjectNumber = db.prepare("SELECT COALESCE(MAX(project_number), 0) + 1 AS value FROM tickets WHERE project_id = ?");
const insertTicket = db.prepare(`
  INSERT INTO tickets(id, project_number, title, description, project_id, type, priority, status, created_at, resolved_at, updated_at, claimed_by, resolution_summary)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, NULL, ?, '', '')
`);
const updateStatus = db.prepare("UPDATE tickets SET status = ?, updated_at = ?, claimed_by = ? WHERE id = ? AND status != 'Archivado'");
const resolveTicket = db.prepare(`
  UPDATE tickets SET status = 'Archivado', resolved_at = ?, updated_at = ?, claimed_by = ?, resolution_summary = ?
  WHERE id = ? AND status != 'Archivado'
`);
const getCodexSession = db.prepare("SELECT thread_id, workspace_path FROM codex_chat_sessions WHERE chat_id = ?");
const saveCodexSession = db.prepare(`
  INSERT INTO codex_chat_sessions(chat_id, thread_id, workspace_path, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET thread_id = excluded.thread_id, workspace_path = excluded.workspace_path, updated_at = excluded.updated_at
`);
const deleteCodexSession = db.prepare("DELETE FROM codex_chat_sessions WHERE chat_id = ?");

const sessions = new Map();
const codexQueues = new Map();
const codexProcesses = new Map();
const typeMap = { f: "Fix", n: "Feat", r: "Refactor", c: "Config", m: "Mantenimiento" };
const priorityMap = { b: "Baja", m: "Media", a: "Alta", u: "Urgente" };

async function api(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`${method}: ${result.description || response.status}`);
  return result.result;
}

function send(chatId, text, replyMarkup) {
  return api("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function sendChunks(chatId, text) {
  const value = String(text || "Sin respuesta.").trim();
  for (let index = 0; index < value.length; index += 3900) await send(chatId, value.slice(index, index + 3900));
}

function authorized(chatId) {
  return Boolean(allowedChatId) && String(chatId) === allowedChatId;
}

function code(ticket) {
  return `${ticket.prefix}-${String(ticket.project_number).padStart(3, "0")}`;
}

function ticketText(ticket) {
  const urgent = ticket.priority === "Urgente" ? "🚨 " : "";
  return `${urgent}${code(ticket)} · ${ticket.title}\nProyecto: ${ticket.project_name}\nEstado: ${ticket.status}\nTipo: ${ticket.type}\nPrioridad: ${ticket.priority}${ticket.description ? `\n\n${ticket.description}` : ""}`;
}

function ticketActions(ticket) {
  if (ticket.status === "Archivado") return undefined;
  return {
    inline_keyboard: [
      [
        { text: "▶️ En proceso", callback_data: `s:p:${ticket.id}` },
        { text: "👀 Revisión", callback_data: `s:r:${ticket.id}` }
      ],
      [{ text: "🤖 Solucionar con Codex", callback_data: `a:f:${ticket.id}` }],
      [{ text: "✅ Resolver", callback_data: `s:d:${ticket.id}` }]
    ]
  };
}

function codexPrompt(text) {
  return `Sos el agente técnico de Bitácora y hablás por Telegram.
Respondé en español, breve y claro.
Usá las herramientas de Bitácora para consultar tickets.
Si el usuario pide solucionar un ticket: primero obtenelo, verificá workspacePath y tomalo con start_ticket antes de editar.
El proyecto abierto es la raíz /vps/clientes y contiene varios workspaces. Trabajá únicamente dentro del workspacePath exacto del ticket.
No edites si workspacePath está vacío, no existe o está fuera de /vps/clientes.
No leas credenciales, archivos .env, sesiones, tokens ni /root/.codex.
Ejecutá verificaciones adecuadas. Cuando el cambio quede listo, pasá el ticket a Revisión. No lo archives.
Nunca desplegues, reinicies producción, hagas push ni modifiques datos productivos sin una orden explícita.
Si el usuario solo consulta, no cambies estados ni archivos.

Mensaje del usuario:
${text}`;
}

function codexEnvironment() {
  const allowed = ["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  const environment = { HOME: codexHome, CODEX_HOME: codexHome };
  for (const name of allowed) if (process.env[name]) environment[name] = process.env[name];
  return environment;
}

function runCodex(chatId, prompt, threadId) {
  return new Promise((resolve, reject) => {
    if (!existsSync(codexWorkspace)) return reject(new Error(`No existe el workspace: ${codexWorkspace}`));
    mkdirSync(codexHome, { recursive: true });
    const args = threadId
      ? ["exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", threadId, "-"]
      : ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", codexWorkspace, "-"];
    const child = spawn(codexCommand, args, {
      cwd: codexWorkspace,
      env: codexEnvironment(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    codexProcesses.set(String(chatId), child);
    let stdout = "";
    let stderr = "";
    let thread = threadId || "";
    let answer = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), codexTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started") thread = event.thread_id;
          if (event.type === "item.completed" && event.item?.type === "agent_message") answer = event.item.text || answer;
        } catch {}
      }
    });
    child.stderr.on("data", chunk => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.on("error", error => {
      clearTimeout(timer);
      codexProcesses.delete(String(chatId));
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      codexProcesses.delete(String(chatId));
      if (code !== 0) return reject(new Error(stderr.trim() || `Codex terminó con código ${code}`));
      resolve({ threadId: thread, answer: answer || "Tarea terminada sin respuesta de texto." });
    });
    child.stdin.end(prompt);
  });
}

async function executeCodexTurn(chatId, text) {
  if (!codexEnabled) return send(chatId, "Codex está desactivado.");
  const key = String(chatId);
  await send(chatId, "🧠 Codex está trabajando...");
  let saved = getCodexSession.get(key);
  if (saved && saved.workspace_path !== codexWorkspace) {
    deleteCodexSession.run(key);
    saved = undefined;
  }
  let result;
  try {
    result = await runCodex(chatId, codexPrompt(text), saved?.thread_id);
  } catch (error) {
    if (!saved) throw error;
    console.error(`No se pudo reanudar Codex: ${error.message}`);
    deleteCodexSession.run(key);
    result = await runCodex(chatId, codexPrompt(text), null);
  }
  if (result.threadId) saveCodexSession.run(key, result.threadId, codexWorkspace, new Date().toISOString());
  await sendChunks(chatId, result.answer);
  return result;
}

function enqueueDeployment(ticket) {
  const target = ticket.prefix === "TIC" ? "tickets" : ticket.prefix === "DRP" ? "drpiscinas" : "";
  if (!target) return "";
  mkdirSync(deployQueuePath, { recursive: true });
  const ticketCode = code(ticket).replace(/[^A-Z0-9-]/g, "");
  const filename = `${target}__${ticketCode}__${Date.now()}-${process.pid}.request`;
  writeFileSync(join(deployQueuePath, filename), `ticket=${ticketCode}\n`, { flag: "wx" });
  return target;
}

function queueTicketSolution(chatId, ticket) {
  queueCodexTurn(
    chatId,
    `Solucioná el ticket ${code(ticket)}. Leé el detalle completo, realizá el cambio, verificá y dejalo en Revisión.`,
    async () => {
      const updated = getTicketById.get(ticket.id);
      if (!updated || updated.status !== "Revisión") {
        await send(chatId, `⚠️ ${code(ticket)} no quedó en Revisión. No se desplegó.`);
        return;
      }
      const target = enqueueDeployment(updated);
      if (!target) {
        await send(chatId, `⚠️ ${code(ticket)} no tiene despliegue automático configurado.`);
        return;
      }
      await send(chatId, `🚀 ${code(ticket)} quedó en Revisión. Despliegue automático iniciado.`);
    }
  );
}

function queueCodexTurn(chatId, text, onSuccess) {
  const key = String(chatId);
  const previous = codexQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const result = await executeCodexTurn(chatId, text);
      if (onSuccess) await onSuccess(result);
      return result;
    })
    .catch(error => {
      console.error(error);
      return send(chatId, `No pude completar la tarea: ${error.message.slice(0, 700)}`).catch(() => {});
    })
    .finally(() => {
      if (codexQueues.get(key) === next) codexQueues.delete(key);
    });
  codexQueues.set(key, next);
}

function listText(title, rows) {
  if (!rows.length) return `${title}\nNo hay tickets.`;
  return `${title}\n\n${rows.map(ticket => `${ticket.priority === "Urgente" ? "🚨 " : ""}${code(ticket)} · ${ticket.title}\n${ticket.status} · ${ticket.priority}`).join("\n\n")}`;
}

async function reject(chatId) {
  console.log(`Chat pendiente de autorización: ${chatId}`);
  await send(chatId, `Este chat todavía no está autorizado.\n\nTu chat_id es: ${chatId}\nAgregalo como TELEGRAM_ALLOWED_CHAT_ID en .env y reiniciá el bot.`);
}

async function beginTicket(chatId) {
  const projects = getProjects.all();
  if (!projects.length) return send(chatId, "Primero creá un proyecto desde la web.");
  sessions.set(String(chatId), { step: "project" });
  return send(chatId, "Elegí el proyecto:", {
    inline_keyboard: projects.map(project => [{ text: `${project.prefix} · ${project.name}`, callback_data: `n:p:${project.id}` }])
  });
}

function createTicket(session) {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const id = nextId.get().value;
    const projectNumber = nextProjectNumber.get(session.projectId).value;
    insertTicket.run(id, projectNumber, session.title, session.description, session.projectId, session.type, session.priority, now, now);
    db.exec("COMMIT");
    return getTicketById.get(id);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const key = String(chatId);
  const text = message.text?.trim();
  if (!text) return;

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" && !authorized(chatId)) return reject(chatId);
  if (!authorized(chatId)) return reject(chatId);

  if (command === "/start" || command === "/help" || command === "/menu") {
    return send(chatId, "Bitácora de tickets\n\n/hoy — resumen del día\n/codex consulta — hablar con Codex\n/solucionar DRP-001 — solucionar ticket\n/nuevo — crear ticket\n/tickets — tickets abiertos\n/pendientes — solo pendientes\n/proyectos — ver proyectos\n/ticket DRP-001 — abrir ticket\n/proceso DRP-001 — pasar a En proceso\n/revision DRP-001 — pasar a Revisión\n/resolver DRP-001 — archivar con resolución\n/estado — estado de Codex\n/reset — nueva conversación\n/parar — detener tarea activa\n/cancelar — cancelar carga");
  }
  if (command === "/hoy") {
    queueCodexTurn(chatId, "¿Qué hay hoy? Resumí los tickets pendientes y recomendá el orden de trabajo. No modifiques nada.");
    return;
  }
  if (command === "/codex") {
    const prompt = text.replace(/^\/codex(?:@\w+)?\s*/i, "").trim();
    if (!prompt) return send(chatId, "Usá: /codex tu consulta");
    queueCodexTurn(chatId, prompt);
    return;
  }
  if (command === "/solucionar") {
    const ticketCode = text.split(/\s+/)[1];
    if (!ticketCode) return send(chatId, "Usá: /solucionar DRP-001");
    const ticket = getTicketByCode.get(ticketCode);
    if (!ticket || ticket.status === "Archivado") return send(chatId, "No encontré un ticket abierto con ese código.");
    queueTicketSolution(chatId, ticket);
    return;
  }
  if (command === "/nuevo") return beginTicket(chatId);
  if (command === "/tickets") return send(chatId, listText("Tickets abiertos", listOpen.all()));
  if (command === "/pendientes") return send(chatId, listText("Tickets pendientes", listPending.all()));
  if (command === "/proyectos") {
    const projects = getProjects.all();
    return send(chatId, projects.length ? projects.map(project => `${project.prefix} · ${project.name}`).join("\n") : "No hay proyectos.");
  }
  if (command === "/ticket") {
    const ticketCode = text.split(/\s+/)[1];
    if (!ticketCode) return send(chatId, "Usá: /ticket DRP-001");
    const ticket = getTicketByCode.get(ticketCode);
    return ticket ? send(chatId, ticketText(ticket), ticketActions(ticket)) : send(chatId, "No encontré ese ticket.");
  }
  if (command === "/proceso" || command === "/revision") {
    const ticketCode = text.split(/\s+/)[1];
    if (!ticketCode) return send(chatId, `Usá: ${command} DRP-001`);
    const ticket = getTicketByCode.get(ticketCode);
    if (!ticket || ticket.status === "Archivado") return send(chatId, "No encontré un ticket abierto con ese código.");
    const status = command === "/proceso" ? "En proceso" : "Revisión";
    updateStatus.run(status, new Date().toISOString(), message.from?.username || message.from?.first_name || "Telegram", ticket.id);
    return send(chatId, `✅ ${code(ticket)} pasó a ${status}.`);
  }
  if (command === "/resolver") {
    const ticketCode = text.split(/\s+/)[1];
    if (!ticketCode) return send(chatId, "Usá: /resolver DRP-001");
    const ticket = getTicketByCode.get(ticketCode);
    if (!ticket || ticket.status === "Archivado") return send(chatId, "No encontré un ticket abierto con ese código.");
    sessions.set(key, { step: "resolution", ticketId: ticket.id });
    return send(chatId, `¿Cómo se solucionó ${code(ticket)}?`);
  }
  if (command === "/estado") {
    const active = codexProcesses.has(key);
    const saved = getCodexSession.get(key);
    return send(chatId, `Codex: ${active ? "trabajando" : "disponible"}\nConversación: ${saved ? "activa" : "nueva"}`);
  }
  if (command === "/cancelar") {
    sessions.delete(key);
    return send(chatId, "Carga cancelada.");
  }
  if (command === "/reset") {
    deleteCodexSession.run(key);
    return send(chatId, "Conversación de Codex reiniciada.");
  }
  if (command === "/parar") {
    const child = codexProcesses.get(key);
    if (!child) return send(chatId, "No hay una tarea activa.");
    child.kill("SIGTERM");
    return send(chatId, "Tarea detenida.");
  }

  const session = sessions.get(key);
  if (!session) {
    const ticketMatch = text.match(/\b([A-Z]{2,10}-\d{1,6})\b/i);
    if (ticketMatch && /(solucion|arregl|correg|resolv)/i.test(text)) {
      const ticket = getTicketByCode.get(ticketMatch[1]);
      if (!ticket || ticket.status === "Archivado") return send(chatId, "No encontré un ticket abierto con ese código.");
      queueTicketSolution(chatId, ticket);
      return;
    }
    queueCodexTurn(chatId, text);
    return;
  }
  if (session.step === "title") {
    session.title = text.slice(0, 160);
    session.step = "description";
    return send(chatId, "Describí el problema. Enviá - para dejarlo vacío.");
  }
  if (session.step === "description") {
    session.description = text === "-" ? "" : text.slice(0, 3000);
    session.step = "type";
    return send(chatId, "Elegí el tipo:", {
      inline_keyboard: [
        [{ text: "🔴 Fix", callback_data: "n:t:f" }, { text: "🟣 Feat", callback_data: "n:t:n" }],
        [{ text: "🔵 Refactor", callback_data: "n:t:r" }, { text: "🟢 Config", callback_data: "n:t:c" }],
        [{ text: "🟡 Mantenimiento", callback_data: "n:t:m" }]
      ]
    });
  }
  if (session.step === "resolution") {
    const ticket = getTicketById.get(session.ticketId);
    sessions.delete(key);
    if (!ticket || ticket.status === "Archivado") return send(chatId, "El ticket ya no está disponible.");
    const now = new Date().toISOString();
    resolveTicket.run(now, now, message.from?.username || message.from?.first_name || "Telegram", text.slice(0, 3000), ticket.id);
    const updated = getTicketById.get(ticket.id);
    return send(chatId, `✅ ${code(updated)} archivado.\n\n${updated.resolution_summary}`);
  }
}

async function handleCallback(query) {
  const chatId = query.message?.chat.id;
  if (!chatId) return;
  await api("answerCallbackQuery", { callback_query_id: query.id });
  if (!authorized(chatId)) return reject(chatId);
  const key = String(chatId);
  const [group, action, value] = query.data.split(":");

  if (group === "a" && action === "f") {
    const ticket = getTicketById.get(Number(value));
    if (!ticket || ticket.status === "Archivado") return send(chatId, "El ticket ya fue archivado.");
    queueTicketSolution(chatId, ticket);
    return;
  }

  if (group === "n" && action === "p") {
    const project = getProject.get(value);
    if (!project) return send(chatId, "Ese proyecto ya no existe.");
    sessions.set(key, { step: "title", projectId: project.id });
    return send(chatId, `Proyecto: ${project.name}\nEscribí el título del ticket.`);
  }
  const session = sessions.get(key);
  if (group === "n" && action === "t" && session?.step === "type") {
    session.type = typeMap[value];
    session.step = "priority";
    return send(chatId, "Elegí la prioridad:", {
      inline_keyboard: [[
        { text: "Baja", callback_data: "n:r:b" },
        { text: "Media", callback_data: "n:r:m" },
        { text: "Alta", callback_data: "n:r:a" },
        { text: "🚨 Urgente", callback_data: "n:r:u" }
      ]]
    });
  }
  if (group === "n" && action === "r" && session?.step === "priority") {
    session.priority = priorityMap[value];
    const ticket = createTicket(session);
    sessions.delete(key);
    return send(chatId, `✅ Ticket creado\n\n${ticketText(ticket)}`, ticketActions(ticket));
  }
  if (group === "s") {
    const ticket = getTicketById.get(Number(value));
    if (!ticket || ticket.status === "Archivado") return send(chatId, "El ticket ya fue archivado.");
    if (action === "d") {
      sessions.set(key, { step: "resolution", ticketId: ticket.id });
      return send(chatId, `¿Cómo se solucionó ${code(ticket)}?`);
    }
    const status = action === "p" ? "En proceso" : "Revisión";
    const now = new Date().toISOString();
    updateStatus.run(status, now, query.from?.username || query.from?.first_name || "Telegram", ticket.id);
    return send(chatId, `✅ ${code(ticket)} pasó a ${status}.`);
  }
}

async function run() {
  reportStatus("Conectando", "Iniciando bot");
  await api("setMyCommands", { commands: [
    { command: "menu", description: "Ver todos los comandos" },
    { command: "hoy", description: "Resumen y prioridades de hoy" },
    { command: "codex", description: "Consultar a Codex" },
    { command: "solucionar", description: "Solucionar un ticket con Codex" },
    { command: "nuevo", description: "Crear un ticket" },
    { command: "tickets", description: "Ver tickets abiertos" },
    { command: "pendientes", description: "Ver tickets pendientes" },
    { command: "proyectos", description: "Ver proyectos" },
    { command: "ticket", description: "Abrir un ticket por código" },
    { command: "proceso", description: "Pasar ticket a En proceso" },
    { command: "revision", description: "Pasar ticket a Revisión" },
    { command: "resolver", description: "Resolver y archivar un ticket" },
    { command: "estado", description: "Ver estado de Codex" },
    { command: "reset", description: "Nueva conversación con Codex" },
    { command: "parar", description: "Detener tarea activa" },
    { command: "cancelar", description: "Cancelar la carga actual" },
    { command: "help", description: "Ver ayuda" }
  ] });
  const me = await api("getMe");
  reportStatus("Conectado", `@${me.username}`);
  console.log(`Bot @${me.username} conectado.`);
  const heartbeat = setInterval(() => reportStatus("Conectado", `@${me.username}`), 15000);
  heartbeat.unref();
  let offset = 0;
  let delay = 1000;
  while (true) {
    try {
      const updates = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
      delay = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(update.message);
          if (update.callback_query) await handleCallback(update.callback_query);
        } catch (error) {
          console.error(error);
          const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
          if (chatId) await send(chatId, "Ocurrió un error al procesar la acción.").catch(() => {});
        }
      }
    } catch (error) {
      console.error(error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
}

run().catch(error => {
  console.error(error.message);
  process.exit(1);
});
