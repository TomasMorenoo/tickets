const seedProjects = [
  { id: "dr-piscinas", name: "Dr. Piscinas", color: "#5bd6e8", prefix: "DRP" },
  { id: "movie-vault", name: "Movie Vault", color: "#a68cff", prefix: "MOV" },
  { id: "pokedex", name: "Pokédex", color: "#ff6b5f", prefix: "POK" },
  { id: "servicio-tecnico", name: "Servicio técnico", color: "#f5b94c", prefix: "SER" }
];

const seedTickets = [
  { id: 12, projectNumber: 2, title: "Error al eliminar productos", description: "Al confirmar la eliminación de un producto, la pantalla queda cargando y el registro sigue apareciendo.", project: "dr-piscinas", type: "Fix", priority: "Alta", status: "Pendiente", createdAt: "2026-09-12T14:30:00", resolvedAt: null },
  { id: 11, projectNumber: 1, title: "Agregar filtros por género", description: "Incorporar filtros combinables para navegar películas por género y año.", project: "movie-vault", type: "Feat", priority: "Media", status: "En proceso", createdAt: "2026-09-10T11:15:00", resolvedAt: null },
  { id: 10, projectNumber: 1, title: "Mejorar vista en celulares", description: "Las tarjetas se sienten muy juntas en pantallas chicas y algunos nombres se cortan.", project: "pokedex", type: "Refactor", priority: "Media", status: "Revisión", createdAt: "2026-09-08T18:40:00", resolvedAt: null },
  { id: 9, projectNumber: 1, title: "Limpieza y cambio de pasta térmica", description: "Notebook con temperatura elevada y ventilador funcionando constantemente.", project: "servicio-tecnico", type: "Mantenimiento", priority: "Alta", status: "Solucionado", createdAt: "2026-09-05T09:20:00", resolvedAt: "2026-09-07T16:00:00" },
  { id: 8, projectNumber: 1, title: "Corregir enlaces del pie de página", description: "Los accesos a contacto y políticas apuntaban a rutas antiguas.", project: "dr-piscinas", type: "Fix", priority: "Baja", status: "Solucionado", createdAt: "2026-09-03T13:00:00", resolvedAt: "2026-09-04T12:00:00" }
];

const statuses = ["Pendiente", "En proceso", "Revisión", "Solucionado"];
const boardStatuses = ["Pendiente", "En proceso", "Revisión"];
const statusColors = { "Pendiente": "#ff6b5f", "En proceso": "#f5b94c", "Revisión": "#5bd6e8", "Solucionado": "#d8ff47", "Archivado": "#89919d" };
const priorityColors = { "Baja": "#89919d", "Media": "#5bd6e8", "Alta": "#f5b94c", "Urgente": "#ff6b5f" };
const ticketTypes = ["Fix", "Feat", "Refactor", "Config", "Mantenimiento"];
const typeColors = { "Fix": "#ff6b5f", "Feat": "#a68cff", "Refactor": "#5bd6e8", "Config": "#d8ff47", "Mantenimiento": "#f5b94c" };
const legacyTicketTypes = new Set(["Error", "Mejora", "Agregar", "Corrección de código", "Mejora de código", "Nueva funcionalidad", "Servicio técnico"]);
const typeSuggestions = { "Error": "Fix", "Agregar": "Feat", "Corrección de código": "Fix", "Nueva funcionalidad": "Feat", "Servicio técnico": "Mantenimiento" };

function typeColor(type) {
  return typeColors[type] || "#89919d";
}

function visibleTicketTypes() {
  return [...ticketTypes, ...new Set(tickets.map(ticket => ticket.type).filter(type => !ticketTypes.includes(type)))];
}

function ticketTypeOptions(currentType = "") {
  const options = [...ticketTypes];
  if (currentType && !options.includes(currentType)) options.push(currentType);
  return options.map(type => `<option value="${escapeHtml(type)}" ${type === currentType ? "selected" : ""}>${escapeHtml(type)}</option>`).join("");
}

function legacyTickets() {
  return tickets.filter(ticket => legacyTicketTypes.has(ticket.type));
}

let projects = [];
let tickets = [];
let profile = { firstName: "", lastName: "" };
let apiReady = false;
let state = { view: "dashboard", project: "all", projectDisplay: "list", projectSearch: "", projectType: "all", projectPriority: "all", projectStatus: "all" };

const content = document.querySelector("#content");
const ticketDialog = document.querySelector("#ticket-dialog");
const projectDialog = document.querySelector("#project-dialog");
const detailDialog = document.querySelector("#detail-dialog");
const settingsDialog = document.querySelector("#settings-dialog");
const typeMigrationDialog = document.querySelector("#type-migration-dialog");
const typeMigrationContent = document.querySelector("#type-migration-content");

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error("Error de servidor");
  return response.json();
}

function save() {
  if (!apiReady) return Promise.resolve();
  return api("/api/state", {
    method: "PUT",
    body: JSON.stringify({ projects, tickets, profile })
  }).catch(() => showToast("No se pudieron guardar los cambios"));
}

function profileInitials() {
  const first = profile.firstName.trim();
  const last = profile.lastName.trim();
  if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
  return (first || last).slice(0, 2).toUpperCase() || "MA";
}

function renderProfile() {
  document.querySelectorAll("[data-owner-avatar]").forEach(element => { element.textContent = profileInitials(); });
}

function projectById(id) {
  return projects.find(project => project.id === id) || { name: "Sin proyecto", color: "#89919d", prefix: "GEN" };
}

function autoPrefix(name) {
  const words = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (!words.length) return "NUE";
  let prefix = words[0].slice(0, 3);
  for (let index = 1; prefix.length < 3 && index < words.length; index += 1) prefix += words[index][0];
  return prefix.padEnd(3, "X");
}

function uniquePrefix(prefix) {
  if (!projects.some(project => project.prefix === prefix)) return prefix;
  let suffix = 2;
  while (projects.some(project => project.prefix === `${prefix.slice(0, 4)}${suffix}`)) suffix += 1;
  return `${prefix.slice(0, 4)}${suffix}`;
}

function nextProjectNumber(projectId) {
  return Math.max(0, ...tickets.filter(ticket => ticket.project === projectId).map(ticket => Number(ticket.projectNumber) || 0)) + 1;
}

function ticketCode(ticket) {
  return `${projectById(ticket.project).prefix}-${String(ticket.projectNumber).padStart(3, "0")}`;
}

function migrateData() {
  const defaults = { "dr-piscinas": "DRP", "movie-vault": "MOV", "pokedex": "POK", "servicio-tecnico": "SER" };
  projects.forEach(project => { project.prefix ||= defaults[project.id] || uniquePrefix(autoPrefix(project.name)); });
  projects.forEach(project => {
    const projectTickets = tickets.filter(ticket => ticket.project === project.id).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const used = new Set(projectTickets.map(ticket => Number(ticket.projectNumber)).filter(Boolean));
    let number = 1;
    projectTickets.forEach(ticket => {
      if (ticket.projectNumber) return;
      while (used.has(number)) number += 1;
      ticket.projectNumber = number;
      used.add(number);
    });
  });
  tickets.forEach(ticket => {
    if (ticket.status !== "Solucionado") return;
    ticket.status = "Archivado";
    ticket.resolvedAt ||= new Date().toISOString();
  });
  save();
}

function navigate(view, project = "all") {
  const url = new URL(window.location.href);
  url.search = "";
  if (view === "all") url.searchParams.set("view", "tickets");
  if (view === "archive") url.searchParams.set("view", "archive");
  if (view === "project") url.searchParams.set("project", project);
  window.history.pushState({}, "", url);
  applyRoute();
}

function applyRoute() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("project");
  const view = params.get("view");
  const project = projects.find(item => item.id === projectId);

  if (project) {
    state.view = "project";
    state.project = project.id;
  } else if (view === "tickets") {
    state.view = "all";
    state.project = "all";
  } else if (view === "archive") {
    state.view = "archive";
    state.project = "all";
  } else {
    state.view = "dashboard";
    state.project = "all";
  }

  const title = state.view === "project" ? projectById(state.project).name : state.view === "all" ? "Todos los tickets" : state.view === "archive" ? "Archivo" : "Dashboard";
  document.querySelector("#page-title").textContent = title;
  document.title = `${title} · Bitácora`;
  document.querySelectorAll("[data-view]").forEach(item => item.classList.toggle("active", item.dataset.view === state.view));
  render();
}

function addVolumeDemoTickets() {
  if (localStorage.getItem("bitacora-volume-demo-v1") || !projects.length) return;
  const titles = [
    "Revisar navegación principal",
    "Corregir validación del formulario",
    "Optimizar carga de imágenes",
    "Ajustar diseño en celulares",
    "Actualizar contenido de inicio",
    "Revisar funcionamiento del buscador",
    "Mejorar mensajes de error",
    "Agregar una acción rápida",
    "Validar enlaces externos",
    "Revisar configuración general"
  ];
  const types = ticketTypes;
  const priorities = ["Media", "Alta", "Baja", "Urgente"];
  let nextId = Math.max(0, ...tickets.map(ticket => ticket.id)) + 1;

  statuses.forEach((status, statusIndex) => {
    titles.forEach((title, index) => {
      const project = projects[(statusIndex * titles.length + index) % projects.length];
      const timestamp = new Date(Date.now() - (statusIndex * 10 + index) * 60 * 60 * 1000).toISOString();
      tickets.push({
        id: nextId,
        projectNumber: nextProjectNumber(project.id),
        title,
        description: "Ticket de prueba para verificar el tablero cuando contiene muchos elementos.",
        project: project.id,
        type: types[index % types.length],
        priority: priorities[(index + statusIndex) % priorities.length],
        status: status === "Solucionado" ? "Archivado" : status,
        createdAt: timestamp,
        resolvedAt: status === "Solucionado" ? timestamp : null
      });
      nextId += 1;
    });
  });

  localStorage.setItem("bitacora-volume-demo-v1", "true");
  save();
}

function filteredTickets() {
  return tickets.filter(ticket => {
    const workspaceView = state.view === "project" || state.view === "all";
    const projectMatch = state.project === "all" || ticket.project === state.project;
    const viewMatch = state.view === "archive" ? ticket.status === "Archivado" : state.view === "all" ? ticket.status !== "Archivado" : ticket.status !== "Archivado";
    const search = state.projectSearch.trim().toLowerCase();
    const searchMatch = !workspaceView || !search || `${ticketCode(ticket)} ${ticket.title} ${ticket.description || ""} ${projectById(ticket.project).name}`.toLowerCase().includes(search);
    const typeMatch = !workspaceView || state.projectType === "all" || ticket.type === state.projectType;
    const priorityMatch = !workspaceView || state.projectPriority === "all" || ticket.priority === state.projectPriority;
    const statusMatch = !workspaceView || state.projectStatus === "all" || ticket.status === state.projectStatus;
    return projectMatch && viewMatch && searchMatch && typeMatch && priorityMatch && statusMatch;
  });
}

function renderProjects() {
  const list = document.querySelector("#project-list");
  list.innerHTML = `
    <button class="project-button ${state.project === "all" ? "active" : ""}" data-project="all">
      <span class="project-badge" style="--project-color:#89919d">ALL</span><span class="project-name">Todos</span><span class="project-count">${tickets.filter(t => t.status !== "Archivado").length}</span>
    </button>
  ` + projects.map(project => `
    <button class="project-button ${state.project === project.id ? "active" : ""}" data-project="${project.id}">
      <span class="project-badge" style="--project-color:${project.color}">${project.prefix}</span><span class="project-name">${escapeHtml(project.name)}</span><span class="project-count">${tickets.filter(t => t.project === project.id && t.status !== "Archivado").length}</span>
    </button>
  `).join("");

  list.querySelectorAll("[data-project]").forEach(button => button.addEventListener("click", () => {
    navigate(button.dataset.project === "all" ? "dashboard" : "project", button.dataset.project);
  }));

  document.querySelector("#project-select").innerHTML = projects.map(project => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("");
}

function renderStats() {
  const scopedTickets = state.view === "project" ? tickets.filter(ticket => ticket.project === state.project) : tickets;
  document.querySelector("#stat-pending").textContent = scopedTickets.filter(ticket => ticket.status === "Pendiente").length;
  document.querySelector("#stat-progress").textContent = scopedTickets.filter(ticket => ticket.status === "En proceso" || ticket.status === "Revisión").length;
  document.querySelector("#stat-done").textContent = scopedTickets.filter(ticket => ticket.status === "Solucionado" || ticket.status === "Archivado").length;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  document.querySelector("#stat-week").textContent = scopedTickets.filter(ticket => ticket.resolvedAt && new Date(ticket.resolvedAt).getTime() >= weekAgo).length;
}

function renderDashboard() {
  content.className = "content project-dashboard";
  content.innerHTML = projects.map(project => {
    const items = tickets.filter(ticket => ticket.project === project.id && ticket.status !== "Archivado");
    const count = status => items.filter(ticket => ticket.status === status).length;
    const urgentPending = items.filter(ticket => ticket.status === "Pendiente" && ticket.priority === "Urgente").length;
    return `<button class="project-summary" data-open-project="${project.id}" style="--project-color:${project.color}">
      <span class="project-summary-head">
        <span class="project-summary-badge">${project.prefix}</span>
        <span><strong>${escapeHtml(project.name)}</strong><small>${items.length} tickets</small></span>
        <span class="project-summary-arrow">›</span>
      </span>
      <span class="project-statuses">
        <span class="project-status"><span class="status-value"><strong>${count("Pendiente")}</strong>${urgentPending ? `<span class="urgent-pulse" role="img" aria-label="${urgentPending} tickets urgentes" title="${urgentPending} urgentes"></span>` : ""}</span><span>Pendientes</span></span>
        <span class="project-status"><strong>${count("En proceso")}</strong><span>En proceso</span></span>
        <span class="project-status"><strong>${count("Revisión")}</strong><span>En revisión</span></span>
      </span>
    </button>`;
  }).join("") + `<button class="project-summary project-summary-add" data-add-project>
    <span class="add-project-symbol">+</span><strong>Nuevo proyecto</strong><small>Crear otro espacio de trabajo</small>
  </button>`;
  content.querySelectorAll("[data-open-project]").forEach(button => button.addEventListener("click", () => {
    navigate("project", button.dataset.openProject);
  }));
  content.querySelector("[data-add-project]").addEventListener("click", openProjectDialog);
}

function ticketCard(ticket) {
  const project = projectById(ticket.project);
  return `<button class="ticket-card" data-ticket="${ticket.id}">
    <span class="ticket-top"><span class="ticket-id">${ticketCode(ticket)}</span><span class="priority" title="Prioridad ${ticket.priority}" style="--priority-color:${priorityColors[ticket.priority]}"></span></span>
    <h3>${escapeHtml(ticket.title)}</h3>
    <p>${escapeHtml(ticket.description || "Sin descripción")}</p>
    <span class="ticket-bottom"><span class="tag type-tag" style="--tag-color:${typeColor(ticket.type)}">${escapeHtml(ticket.type)}</span><span class="project-mini" style="--project-color:${project.color}"><i></i>${project.name}</span></span>
  </button>`;
}

function renderBoard(items, target = content) {
  target.className = target === content ? "content board" : "board";
  target.innerHTML = boardStatuses.map(status => {
    const statusTickets = items.filter(ticket => ticket.status === status);
    return `<section class="column">
      <div class="column-head" style="--status-color:${statusColors[status]}"><div class="column-title"><i></i>${status.toUpperCase()}</div><span class="column-count">${statusTickets.length}</span></div>
      <div class="ticket-stack">${statusTickets.length ? statusTickets.map(ticketCard).join("") : `<div class="empty-column">Sin tickets</div>`}</div>
    </section>`;
  }).join("");
}

function renderList(items, target = content, projectScoped = false, expanded = false) {
  target.className = target === content ? "content" : "";
  if (!items.length) {
    target.innerHTML = `<div class="empty-state"><div><strong>No hay tickets</strong>Probá cambiando los filtros.</div></div>`;
    return;
  }
  target.innerHTML = `<div class="ticket-table"><table><thead><tr><th>ID</th><th>TICKET</th>${projectScoped ? "" : '<th class="col-project">PROYECTO</th>'}<th>ESTADO</th><th class="col-type">TIPO</th>${expanded ? '<th class="col-priority">PRIORIDAD</th><th class="col-date">FECHA</th>' : ""}</tr></thead><tbody>${items.map(ticket => {
    const project = projectById(ticket.project);
    return `<tr data-ticket="${ticket.id}"><td>${ticketCode(ticket)}</td><td><strong>${escapeHtml(ticket.title)}</strong></td>${projectScoped ? "" : `<td class="col-project"><span class="project-mini" style="--project-color:${project.color}"><i></i>${project.name}</span></td>`}<td><span class="status-tag" style="--status-color:${statusColors[ticket.status]}"><i></i>${ticket.status}</span></td><td class="col-type"><span class="tag type-tag" style="--tag-color:${typeColor(ticket.type)}">${escapeHtml(ticket.type)}</span></td>${expanded ? `<td class="col-priority"><span class="priority-label" style="--priority-color:${priorityColors[ticket.priority]}"><i></i>${ticket.priority}</span></td><td class="col-date">${new Date(ticket.createdAt).toLocaleDateString("es-AR")}</td>` : ""}</tr>`;
  }).join("")}</tbody></table></div>`;
}

function bindTicketLinks(target = document) {
  target.querySelectorAll("[data-ticket]").forEach(element => element.addEventListener("click", () => openDetail(Number(element.dataset.ticket))));
}

function renderProjectResults(projectScoped = true) {
  const target = document.querySelector("#project-results");
  if (!target) return;
  const items = filteredTickets().sort((a, b) => {
    if (a.priority === "Urgente" && b.priority !== "Urgente") return -1;
    if (b.priority === "Urgente" && a.priority !== "Urgente") return 1;
    return b.id - a.id;
  });
  if (state.projectDisplay === "list") renderList(items, target, projectScoped, true);
  else renderBoard(items, target);
  bindTicketLinks(target);
}

function renderProjectView(projectScoped = true) {
  content.className = "content project-view";
  content.innerHTML = `<section class="toolbar project-toolbar">
    <div class="view-tabs" role="tablist" aria-label="Vista de tickets">
      <button class="${state.projectDisplay === "list" ? "active" : ""}" data-project-display="list" role="tab">Lista</button>
      <button class="${state.projectDisplay === "board" ? "active" : ""}" data-project-display="board" role="tab">Tabla</button>
    </div>
    <div class="filters">
      <label class="search"><span>⌕</span><input id="project-search" type="search" placeholder="Buscar tickets" value="${escapeHtml(state.projectSearch)}" aria-label="Buscar tickets"></label>
      <select id="project-type-filter" aria-label="Filtrar por tipo">
        <option value="all">Todos los tipos</option>
        ${visibleTicketTypes().map(type => `<option value="${escapeHtml(type)}" ${state.projectType === type ? "selected" : ""}>${escapeHtml(type)}</option>`).join("")}
      </select>
      <select id="project-priority-filter" aria-label="Filtrar por prioridad">
        <option value="all">Toda prioridad</option>
        ${Object.keys(priorityColors).map(priority => `<option value="${priority}" ${state.projectPriority === priority ? "selected" : ""}>${priority}</option>`).join("")}
      </select>
      <select id="project-status-filter" aria-label="Filtrar por estado">
        <option value="all">Todos los estados</option>
        ${boardStatuses.map(status => `<option value="${status}" ${state.projectStatus === status ? "selected" : ""}>${status}</option>`).join("")}
      </select>
    </div>
  </section><div id="project-results"></div>`;

  content.querySelectorAll("[data-project-display]").forEach(button => button.addEventListener("click", () => {
    state.projectDisplay = button.dataset.projectDisplay;
    renderProjectView(projectScoped);
  }));
  document.querySelector("#project-search").addEventListener("input", event => {
    state.projectSearch = event.target.value;
    renderProjectResults(projectScoped);
  });
  document.querySelector("#project-type-filter").addEventListener("change", event => {
    state.projectType = event.target.value;
    renderProjectResults(projectScoped);
  });
  document.querySelector("#project-priority-filter").addEventListener("change", event => {
    state.projectPriority = event.target.value;
    renderProjectResults(projectScoped);
  });
  document.querySelector("#project-status-filter").addEventListener("change", event => {
    state.projectStatus = event.target.value;
    renderProjectResults(projectScoped);
  });
  renderProjectResults(projectScoped);
}

function render() {
  renderProjects();
  renderStats();
  const items = filteredTickets().sort((a, b) => b.id - a.id);
  if (state.view === "dashboard") renderDashboard();
  else if (state.view === "archive") renderList(items);
  else if (state.view === "all") renderProjectView(false);
  else renderProjectView(true);
  if (state.view === "archive") bindTicketLinks();
  renderTypeMigrationNotice();
}

function openDetail(id) {
  const ticket = tickets.find(item => item.id === id);
  if (!ticket) return;
  const project = projectById(ticket.project);
  const target = document.querySelector("#ticket-detail");
  target.style.setProperty("--detail-color", project.color);

  function renderDetailView() {
    const statusIndex = boardStatuses.indexOf(ticket.status);
    const nextStatus = statusIndex >= 0 && statusIndex < boardStatuses.length - 1 ? boardStatuses[statusIndex + 1] : null;
    const archived = ticket.status === "Archivado";
    target.innerHTML = `<div class="detail-ticket-head">
        <div><span class="detail-code">${ticketCode(ticket)}</span><p>${escapeHtml(project.name)}</p></div>
        <span class="status-tag" style="--status-color:${statusColors[ticket.status]}"><i></i>${ticket.status}</span>
        <button class="close-detail" aria-label="Cerrar">×</button>
      </div>
      <div class="detail-ticket-layout">
        <main class="detail-ticket-main">
          <span class="detail-label">ASUNTO</span>
          <h2>${escapeHtml(ticket.title)}</h2>
          <span class="detail-label">DESCRIPCIÓN</span>
          <p class="detail-description">${escapeHtml(ticket.description || "Sin descripción.")}</p>
          ${ticket.resolutionSummary ? `<span class="detail-label detail-resolution-label">SOLUCIÓN APLICADA</span><p class="detail-description">${escapeHtml(ticket.resolutionSummary)}</p>` : ""}
        </main>
        <aside class="detail-ticket-stub">
          <div><span>TIPO</span><strong style="--stub-color:${typeColor(ticket.type)}">${escapeHtml(ticket.type)}</strong></div>
          <div><span>PRIORIDAD</span><strong style="--stub-color:${priorityColors[ticket.priority]}">${ticket.priority}</strong></div>
          <div><span>FECHA</span><strong>${new Date(ticket.createdAt).toLocaleDateString("es-AR")}</strong></div>
          ${ticket.claimedBy ? `<div><span>AGENTE</span><strong>${escapeHtml(ticket.claimedBy)}</strong></div>` : ""}
        </aside>
      </div>
      <div class="detail-content">
        <div class="detail-ticket-actions">
          <button class="detail-action advance-action" id="advance-ticket" ${nextStatus ? "" : "disabled"} title="${nextStatus ? `Pasar a ${nextStatus}` : "No hay otro estado previo a la solución"}"><span>→</span> Avanzar</button>
          <button class="detail-action solve-action" id="solve-ticket" ${archived ? "disabled" : ""}><span>✓</span> ${archived ? "Archivado" : "Solucionar"}</button>
          <button class="detail-action edit-action" id="edit-ticket" aria-label="Editar ticket" title="Editar ticket">✎</button>
        </div>
      </div>`;

    target.querySelector(".close-detail").addEventListener("click", () => detailDialog.close());
    target.querySelector("#edit-ticket").addEventListener("click", renderEditView);
    target.querySelector("#advance-ticket").addEventListener("click", () => {
      if (!nextStatus) return;
      ticket.status = nextStatus;
      save();
      render();
      renderDetailView();
      showToast(`Ticket movido a ${nextStatus}`);
    });
    target.querySelector("#solve-ticket").addEventListener("click", () => {
      if (archived) return;
      ticket.status = "Archivado";
      ticket.resolvedAt ||= new Date().toISOString();
      save();
      detailDialog.close();
      render();
      showToast("Ticket solucionado y archivado");
    });
  }

  function renderEditView() {
    target.innerHTML = `<form id="detail-edit-form" class="detail-edit-form">
      <div class="dialog-head"><div><p class="eyebrow">EDITAR ${ticketCode(ticket)}</p><h2>Editar ticket</h2></div><button class="close-detail" type="button" aria-label="Cerrar">×</button></div>
      <label>Título<input name="title" value="${escapeHtml(ticket.title)}" required></label>
      <label>Descripción<textarea name="description" rows="5">${escapeHtml(ticket.description || "")}</textarea></label>
      <div class="form-grid">
        <label>Tipo<select name="type">${ticketTypeOptions(ticket.type)}</select></label>
        <label>Prioridad<select name="priority">${Object.keys(priorityColors).map(priority => `<option ${priority === ticket.priority ? "selected" : ""}>${priority}</option>`).join("")}</select></label>
      </div>
      <label>Estado<select name="status">${[...boardStatuses, "Archivado"].map(status => `<option ${status === ticket.status ? "selected" : ""}>${status}</option>`).join("")}</select></label>
      <div class="detail-edit-actions"><button class="danger-button" type="button" id="delete-ticket">Eliminar</button><span></span><button class="secondary-button" type="button" id="cancel-edit">Cancelar</button><button class="primary-button" type="submit">Guardar</button></div>
    </form>`;

    target.querySelector(".close-detail").addEventListener("click", () => detailDialog.close());
    target.querySelector("#cancel-edit").addEventListener("click", renderDetailView);
    target.querySelector("#detail-edit-form").addEventListener("submit", event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      ticket.title = data.get("title").trim();
      ticket.description = data.get("description").trim();
      ticket.type = data.get("type");
      ticket.priority = data.get("priority");
      ticket.status = data.get("status");
      save();
      render();
      renderDetailView();
      showToast("Ticket actualizado");
    });
    target.querySelector("#delete-ticket").addEventListener("click", () => {
      if (!confirm("¿Eliminar este ticket?")) return;
      tickets = tickets.filter(item => item.id !== id);
      save();
      detailDialog.close();
      render();
      showToast("Ticket eliminado");
    });
  }

  renderDetailView();
  detailDialog.showModal();
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

let typeMigrationQueue = [];
let typeMigrationIndex = 0;
let typeMigrationChanged = 0;

function renderTypeMigrationNotice() {
  const remaining = legacyTickets().length;
  const banner = document.querySelector("#type-migration-banner");
  const settings = document.querySelector("#type-migration-settings");
  banner.hidden = remaining === 0;
  settings.hidden = remaining === 0;
  if (!remaining) return;
  const text = `${remaining} ticket${remaining === 1 ? " conserva" : "s conservan"} un tipo anterior.`;
  document.querySelector("#type-migration-banner-text").textContent = text;
  document.querySelector("#type-migration-settings-text").textContent = text;
}

function renderTypeMigrationStep() {
  if (typeMigrationIndex >= typeMigrationQueue.length) {
    const remaining = legacyTickets().length;
    typeMigrationContent.innerHTML = `<div class="migration-dialog-body">
      <div class="dialog-head"><div><p class="eyebrow">MIGRACIÓN COMPLETA</p><h2>Tipos revisados</h2></div><button type="button" class="close-migration" aria-label="Cerrar">×</button></div>
      <p class="migration-summary">Se actualizaron <strong>${typeMigrationChanged}</strong> tickets. ${remaining ? `Quedan <strong>${remaining}</strong> pendientes para otra revisión.` : "Ya no quedan tipos anteriores."}</p>
      <div class="dialog-actions"><button type="button" class="primary-button close-migration">Cerrar</button></div>
    </div>`;
    typeMigrationContent.querySelectorAll(".close-migration").forEach(button => button.addEventListener("click", () => typeMigrationDialog.close()));
    renderTypeMigrationNotice();
    return;
  }

  const ticket = typeMigrationQueue[typeMigrationIndex];
  const suggestion = typeSuggestions[ticket.type];
  typeMigrationContent.innerHTML = `<div class="migration-dialog-body">
    <div class="dialog-head"><div><p class="eyebrow">MIGRAR TIPOS · ${typeMigrationIndex + 1}/${typeMigrationQueue.length}</p><h2>${ticketCode(ticket)} · ${escapeHtml(ticket.title)}</h2></div><button type="button" class="close-migration" aria-label="Cerrar">×</button></div>
    <div class="migration-current"><span>Tipo actual</span><strong>${escapeHtml(ticket.type)}</strong></div>
    ${suggestion ? `<p class="migration-suggestion">Sugerencia: <strong>${suggestion}</strong></p>` : `<p class="migration-suggestion">Este tipo necesita una decisión manual.</p>`}
    <div class="migration-options">
      ${ticketTypes.map(type => `<button type="button" data-migration-type="${type}" class="${type === suggestion ? "suggested" : ""}"><strong>${type}</strong><small>${type === "Fix" ? "Corrige un error" : type === "Feat" ? "Agrega funcionalidad" : type === "Refactor" ? "Cambia internamente el código" : type === "Config" ? "Configuración, servidor o deploy" : "Trabajo de servicio técnico"}</small></button>`).join("")}
    </div>
    <div class="dialog-actions"><button type="button" class="secondary-button" id="skip-type-migration">Omitir</button></div>
  </div>`;

  typeMigrationContent.querySelector(".close-migration").addEventListener("click", () => typeMigrationDialog.close());
  typeMigrationContent.querySelector("#skip-type-migration").addEventListener("click", () => {
    typeMigrationIndex += 1;
    renderTypeMigrationStep();
  });
  typeMigrationContent.querySelectorAll("[data-migration-type]").forEach(button => button.addEventListener("click", async () => {
    typeMigrationContent.querySelectorAll("button").forEach(item => { item.disabled = true; });
    ticket.type = button.dataset.migrationType;
    await save();
    typeMigrationChanged += 1;
    typeMigrationIndex += 1;
    render();
    renderTypeMigrationStep();
  }));
}

function openTypeMigration() {
  typeMigrationQueue = legacyTickets();
  typeMigrationIndex = 0;
  typeMigrationChanged = 0;
  renderTypeMigrationStep();
  typeMigrationDialog.showModal();
}

document.querySelector("#open-type-migration").addEventListener("click", openTypeMigration);
document.querySelector("#settings-type-migration").addEventListener("click", () => {
  settingsDialog.close();
  openTypeMigration();
});

function registerAgentTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const register = tool => Promise.resolve(context.registerTool(tool)).catch(() => {});

  register({
    name: "list_tickets",
    title: "Listar tickets",
    description: "Devuelve los tickets guardados, con filtros opcionales por estado y proyecto.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string" }, project: { type: "string" } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute(input = {}) {
      return tickets.filter(ticket => (!input.status || ticket.status === input.status) && (!input.project || ticket.project === input.project)).map(ticket => ({ ...ticket, code: ticketCode(ticket) }));
    }
  });

  register({
    name: "create_ticket",
    title: "Crear ticket",
    description: "Crea un ticket nuevo en la bitácora y actualiza el tablero.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, description: { type: "string" }, project: { type: "string" },
        type: { type: "string", enum: ["Fix", "Feat", "Refactor", "Config", "Mantenimiento"] },
        priority: { type: "string", enum: ["Baja", "Media", "Alta", "Urgente"] }
      },
      required: ["title", "project", "type"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!input?.title?.trim() || !projects.some(project => project.id === input.project)) throw new Error("Título o proyecto inválido");
      const id = tickets.length ? Math.max(...tickets.map(ticket => ticket.id)) + 1 : 1;
      const ticket = { id, projectNumber: nextProjectNumber(input.project), title: input.title.trim(), description: input.description?.trim() || "", project: input.project, type: input.type, priority: input.priority || "Media", status: "Pendiente", createdAt: new Date().toISOString(), resolvedAt: null };
      tickets.push(ticket);
      save();
      render();
      return { id, code: ticketCode(ticket), status: "Pendiente" };
    }
  });

  register({
    name: "update_ticket_status",
    title: "Actualizar estado del ticket",
    description: "Cambia el estado de un ticket existente y actualiza el tablero.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, status: { type: "string", enum: ["Pendiente", "En proceso", "Revisión", "Solucionado", "Archivado"] } },
      required: ["id", "status"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      const ticket = tickets.find(item => item.id === input.id);
      if (!ticket) throw new Error("Ticket inexistente");
      ticket.status = input.status === "Solucionado" ? "Archivado" : input.status;
      if (input.status === "Solucionado" && !ticket.resolvedAt) ticket.resolvedAt = new Date().toISOString();
      save();
      render();
      return { id: ticket.id, code: ticketCode(ticket), status: ticket.status };
    }
  });
}

document.querySelectorAll("[data-new-ticket]").forEach(button => button.addEventListener("click", () => ticketDialog.showModal()));
document.querySelectorAll(".close-dialog").forEach(button => button.addEventListener("click", () => ticketDialog.close()));
document.querySelector("#ticket-form").addEventListener("submit", event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const nextId = tickets.length ? Math.max(...tickets.map(ticket => ticket.id)) + 1 : 1;
  const ticket = {
    id: nextId,
    projectNumber: nextProjectNumber(data.get("project")),
    title: data.get("title").trim(),
    description: data.get("description").trim(),
    project: data.get("project"),
    type: data.get("type"),
    priority: data.get("priority"),
    status: data.get("status") === "Solucionado" ? "Archivado" : data.get("status"),
    createdAt: new Date().toISOString(),
    resolvedAt: data.get("status") === "Solucionado" ? new Date().toISOString() : null
  };
  tickets.push(ticket);
  save();
  event.currentTarget.reset();
  ticketDialog.close();
  navigate("project", ticket.project);
  showToast(`Ticket ${ticketCode(ticket)} creado`);
});

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
  navigate(button.dataset.view);
}));
document.querySelectorAll("[data-theme-toggle]").forEach(button => button.addEventListener("click", () => {
    document.body.classList.toggle("light");
    localStorage.setItem("bitacora-theme", document.body.classList.contains("light") ? "light" : "dark");
  }));
const spaceMenuToggle = document.querySelector("#space-menu-toggle");
const spaceMenu = document.querySelector("#space-menu");
const settingsForm = document.querySelector("#settings-form");
const settingsProjectList = document.querySelector("#settings-project-list");
const serviceStatusList = document.querySelector("#service-status-list");
let settingsProjectOrder = [];
let settingsWorkspacePaths = new Map();

function closeSpaceMenu() {
  spaceMenu.hidden = true;
  spaceMenuToggle.setAttribute("aria-expanded", "false");
}

spaceMenuToggle.addEventListener("click", event => {
  event.stopPropagation();
  spaceMenu.hidden = !spaceMenu.hidden;
  spaceMenuToggle.setAttribute("aria-expanded", String(!spaceMenu.hidden));
});
document.addEventListener("click", event => {
  if (!event.target.closest(".space-menu-wrap")) closeSpaceMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeSpaceMenu();
});

function renderSettingsProjects() {
  const projectMap = new Map(projects.map(project => [project.id, project]));
  settingsProjectList.innerHTML = settingsProjectOrder.map((id, index) => {
    const project = projectMap.get(id);
    if (!project) return "";
    return `<div class="settings-project-row">
      <span class="project-badge" style="--project-color:${project.color}">${project.prefix}</span>
      <span class="settings-project-info"><strong>${escapeHtml(project.name)}</strong><input data-workspace-project="${project.id}" value="${escapeHtml(settingsWorkspacePaths.get(project.id) || "")}" placeholder="Ruta local del proyecto" aria-label="Ruta local de ${escapeHtml(project.name)}"></span>
      <span class="project-order-actions">
        <button type="button" data-move-project="up" data-project-index="${index}" aria-label="Subir ${escapeHtml(project.name)}" ${index === 0 ? "disabled" : ""}>↑</button>
        <button type="button" data-move-project="down" data-project-index="${index}" aria-label="Bajar ${escapeHtml(project.name)}" ${index === settingsProjectOrder.length - 1 ? "disabled" : ""}>↓</button>
      </span>
    </div>`;
  }).join("");
}

function renderServiceStatus(items = []) {
  serviceStatusList.innerHTML = items.map(item => {
    const statusClass = item.status === "Conectado" ? "online" : item.status === "Conectando" || item.status === "Esperando QR" ? "waiting" : "offline";
    return `<div class="service-status-card ${statusClass}">
      <span class="service-status-icon">${item.service === "telegram" ? "T" : "W"}</span>
      <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.status)} · ${escapeHtml(item.detail)}</small></span>
      <i class="service-status-dot" title="${escapeHtml(item.status)}"></i>
    </div>`;
  }).join("");
}

async function refreshServiceStatus() {
  try {
    const data = await api("/api/services");
    renderServiceStatus(data.services);
  } catch {
    renderServiceStatus([
      { service: "telegram", label: "Telegram", status: "Desconectado", detail: "Sin respuesta" },
      { service: "whatsapp", label: "WhatsApp", status: "Desconectado", detail: "Sin respuesta" }
    ]);
  }
}

document.querySelector("#open-settings").addEventListener("click", () => {
  closeSpaceMenu();
  document.querySelector("#profile-first-name").value = profile.firstName;
  document.querySelector("#profile-last-name").value = profile.lastName;
  settingsProjectOrder = projects.map(project => project.id);
  settingsWorkspacePaths = new Map(projects.map(project => [project.id, project.workspacePath || ""]));
  renderSettingsProjects();
  refreshServiceStatus();
  settingsDialog.showModal();
});
setInterval(() => {
  if (settingsDialog.open) refreshServiceStatus();
}, 10000);
document.querySelectorAll(".close-settings").forEach(button => button.addEventListener("click", () => settingsDialog.close()));
settingsProjectList.addEventListener("click", event => {
  const button = event.target.closest("[data-move-project]");
  if (!button) return;
  const index = Number(button.dataset.projectIndex);
  const targetIndex = button.dataset.moveProject === "up" ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= settingsProjectOrder.length) return;
  [settingsProjectOrder[index], settingsProjectOrder[targetIndex]] = [settingsProjectOrder[targetIndex], settingsProjectOrder[index]];
  renderSettingsProjects();
});
settingsProjectList.addEventListener("input", event => {
  if (!event.target.matches("[data-workspace-project]")) return;
  settingsWorkspacePaths.set(event.target.dataset.workspaceProject, event.target.value);
});
settingsForm.addEventListener("submit", event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  profile = { firstName: data.get("firstName").trim(), lastName: data.get("lastName").trim() };
  const projectMap = new Map(projects.map(project => [project.id, project]));
  projects = settingsProjectOrder.map(id => projectMap.get(id)).filter(Boolean);
  projects.forEach(project => { project.workspacePath = (settingsWorkspacePaths.get(project.id) || "").trim(); });
  save();
  renderProfile();
  render();
  settingsDialog.close();
  showToast("Configuración guardada");
});
const projectForm = document.querySelector("#project-form");
const projectName = document.querySelector("#project-name");
const projectPrefix = document.querySelector("#project-prefix");
const projectColor = document.querySelector("#project-color");
const palette = ["#5bd6e8", "#a68cff", "#ff6b5f", "#f5b94c", "#d8ff47"];

function updateProjectPreview() {
  const name = projectName.value.trim() || "Nuevo proyecto";
  const prefix = projectPrefix.value || autoPrefix(name);
  const color = projectColor.value || palette[projects.length % palette.length];
  document.querySelector("#project-preview-name").textContent = name;
  document.querySelector("#project-preview-badge").textContent = prefix;
  document.querySelector("#project-preview-code").textContent = `${prefix}-001`;
  document.querySelector(".project-preview").style.setProperty("--preview-color", color);
}

function resetProjectForm() {
  projectForm.reset();
  projectPrefix.setCustomValidity("");
  projectColor.value = "";
  document.querySelectorAll(".color-option").forEach(button => {
    const active = button.dataset.color === "";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  updateProjectPreview();
}

function openProjectDialog() {
  resetProjectForm();
  projectDialog.showModal();
  projectName.focus();
}

document.querySelectorAll(".close-project").forEach(button => button.addEventListener("click", () => projectDialog.close()));
document.querySelectorAll(".color-option").forEach(button => button.addEventListener("click", () => {
  projectColor.value = button.dataset.color;
  document.querySelectorAll(".color-option").forEach(option => {
    const active = option === button;
    option.classList.toggle("active", active);
    option.setAttribute("aria-pressed", String(active));
  });
  updateProjectPreview();
}));
projectName.addEventListener("input", updateProjectPreview);
projectPrefix.addEventListener("input", () => {
  projectPrefix.value = projectPrefix.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  projectPrefix.setCustomValidity("");
  updateProjectPreview();
});
projectForm.addEventListener("submit", event => {
  event.preventDefault();
  const name = projectName.value.trim();
  const customPrefix = projectPrefix.value.trim();
  const prefix = customPrefix || uniquePrefix(autoPrefix(name));
  if (customPrefix && projects.some(project => project.prefix === customPrefix)) {
    projectPrefix.setCustomValidity("Estas iniciales ya están en uso.");
    projectPrefix.reportValidity();
    return;
  }
  const id = `${name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString().slice(-4)}`;
  projects.push({ id, name, prefix, color: projectColor.value || palette[projects.length % palette.length], workspacePath: event.currentTarget.elements.workspacePath.value.trim() });
  save();
  render();
  projectDialog.close();
  showToast(`Proyecto ${prefix} agregado`);
});

if (localStorage.getItem("bitacora-theme") === "light") document.body.classList.add("light");
window.addEventListener("popstate", applyRoute);

async function initializeApp() {
  try {
    const data = await api("/api/state");
    projects = data.projects || [];
    tickets = data.tickets || [];
    profile = data.profile || { firstName: "", lastName: "" };
    apiReady = true;
  } catch {
    showToast("No se pudo conectar con la base de datos");
  }
  renderProfile();
  applyRoute();
  registerAgentTools();
}

initializeApp();

async function refreshFromServer() {
  if (!apiReady || document.querySelector("dialog[open]")) return;
  try {
    const data = await api("/api/state");
    projects = data.projects || [];
    tickets = data.tickets || [];
    profile = data.profile || profile;
    renderProfile();
    render();
  } catch {}
}

window.addEventListener("focus", refreshFromServer);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshFromServer();
});
setInterval(refreshFromServer, 15000);
