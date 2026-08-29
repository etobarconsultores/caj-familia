import { supabase } from './supabaseClient.js';
import * as api from './lib/api.js';
import { SAJ_APP_URL, PJUD_APP_URL, GMAIL_URL } from './config.js';
import { jsPDF } from 'jspdf';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

// ============================================================================
// Estado
// ============================================================================
let CURRENT_USER = null;       // { id, email, nombre }
let CAUSAS = [];
let ENCARGOS = [];
let RECEPTORES = [];
let TURNOS = [];
let REVISIONES_SALA = [];
let GOOGLE_STATUS = { conectado: false };
let MODULE_ACCESOS = [];
let CURRENT_ORG_MODULE = null;

// Persistencia de la organización/módulo activos (localStorage). Nunca se
// confía ciegamente en este valor: siempre se valida contra los accesos
// reales obtenidos de fetchMisAccesos() antes de restaurarlo.
const ORG_MODULO_STORAGE_KEY = 'panelCausas.orgModuloActivo';

function guardarSeleccionModulo(acceso) {
  try {
    localStorage.setItem(ORG_MODULO_STORAGE_KEY, JSON.stringify({
      organizationId: acceso.organizationId, moduleId: acceso.moduleId
    }));
  } catch (e) { /* localStorage no disponible (modo privado, etc.): no es crítico */ }
}

function leerSeleccionModuloGuardada() {
  try {
    const raw = localStorage.getItem(ORG_MODULO_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function borrarSeleccionModuloGuardada() {
  try { localStorage.removeItem(ORG_MODULO_STORAGE_KEY); } catch (e) { /* no crítico */ }
}
let currentCat = 'centro-trabajo';
let currentSubcat = null;
let statFilter = null;
let activePriors = new Set();
let searchTerm = '';
let lastDetailTab = 'editar';
let agendaViewMode = 'lista';
let agendaFilters = { causaId: '', tipo: '', estado: '', prioridad: '', desde: '' };
let agendaCursor = new Date();

// ============================================================================
// Utilidades
// ============================================================================
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^\d{4}-\d{2}-\d{2}/);
  if (!m) return null;
  const target = new Date(m[0] + 'T00:00:00');
  if (isNaN(target)) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}

function priorClass(p) {
  if (p === 'Urgente') return 'urgente';
  if (p === 'Semi urgente') return 'semi';
  if (p === 'No prioritario') return 'noprior';
  return 'na';
}

function subcatClass(c) {
  const s = (c.subcategoria || c.materia || '').toLowerCase();
  if (s.includes('ejecutivo')) return 'sc-ejecutivo';
  if (s.includes('ordinario')) return 'sc-ordinario';
  if (s.includes('sumario')) return 'sc-sumario';
  if (s.includes('voluntari')) return 'sc-voluntario';
  if (s.includes('extrajudicial')) return 'sc-extrajudicial';
  return '';
}

function fmtFechaHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}`;
}

function findCausa(id) { return CAUSAS.find(c => c.id === id); }

async function refreshCausaLocal(id) {
  const fresh = await api.fetchCausaById(id);
  const idx = CAUSAS.findIndex(c => c.id === id);
  if (idx >= 0) CAUSAS[idx] = fresh;
  else CAUSAS.unshift(fresh);
  return fresh;
}

// ============================================================================
// AUTENTICACIÓN
// ============================================================================
function showAuthScreen() {
  document.getElementById('loading-screen').hidden = true;
  document.getElementById('app-root').hidden = true;
  document.getElementById('auth-screen').hidden = false;
}

function showApp() {
  document.getElementById('loading-screen').hidden = true;
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-root').hidden = false;
}

function switchAuthForm(which) {
  document.getElementById('form-login').hidden = which !== 'login';
  document.getElementById('form-register').hidden = which !== 'register';
  document.getElementById('form-forgot').hidden = which !== 'forgot';
  const titles = { login: 'Iniciar sesión', register: 'Crear cuenta', forgot: 'Recuperar contraseña' };
  document.getElementById('auth-title').textContent = titles[which];
  document.getElementById('auth-switch').style.display = which === 'login' ? '' : 'none';
}

function wireAuthUI() {
  document.getElementById('link-to-register').addEventListener('click', () => switchAuthForm('register'));
  document.getElementById('link-to-forgot').addEventListener('click', () => switchAuthForm('forgot'));

  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    try {
      const { signIn } = await import('./auth.js');
      await signIn(email, password);
    } catch (err) {
      errEl.textContent = traducirError(err.message);
    }
  });

  document.getElementById('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('register-error');
    const okEl = document.getElementById('register-success');
    errEl.textContent = ''; okEl.textContent = '';
    const nombre = document.getElementById('register-nombre').value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;
    try {
      const { signUp } = await import('./auth.js');
      await signUp(email, password, nombre);
      okEl.textContent = 'Cuenta creada. Revisa tu correo para confirmar (si tu proyecto lo requiere) y luego inicia sesión.';
      setTimeout(() => switchAuthForm('login'), 2500);
    } catch (err) {
      errEl.textContent = traducirError(err.message);
    }
  });

  document.getElementById('form-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('forgot-error');
    const okEl = document.getElementById('forgot-success');
    errEl.textContent = ''; okEl.textContent = '';
    const email = document.getElementById('forgot-email').value.trim();
    try {
      const { sendPasswordReset } = await import('./auth.js');
      await sendPasswordReset(email);
      okEl.textContent = 'Te enviamos un enlace para restablecer tu contraseña.';
    } catch (err) {
      errEl.textContent = traducirError(err.message);
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    const { signOut } = await import('./auth.js');
    await signOut();
  });

  const btnCambiarModulo = document.getElementById('btn-cambiar-modulo');
  if (btnCambiarModulo) btnCambiarModulo.addEventListener('click', () => volverASelectorModulo());

  const familiaCambiarModulo = document.getElementById('familia-cambiar-modulo');
  if (familiaCambiarModulo) familiaCambiarModulo.addEventListener('click', () => volverASelectorModulo());

  const familiaLogout = document.getElementById('familia-logout');
  if (familiaLogout) familiaLogout.addEventListener('click', async () => {
    const { signOut } = await import('./auth.js');
    await signOut();
  });
}

function traducirError(msg) {
  if (!msg) return 'Ocurrió un error. Intenta nuevamente.';
  if (msg.includes('Invalid login credentials')) return 'Correo o contraseña incorrectos.';
  if (msg.includes('User already registered')) return 'Ya existe una cuenta con ese correo.';
  if (msg.includes('Password should be')) return 'La contraseña debe tener al menos 6 caracteres.';
  return msg;
}

async function onSessionReady(session) {
  CURRENT_USER = { id: session.user.id, email: session.user.email, nombre: session.user.user_metadata?.nombre_completo || null };
  try {
    const { data: profile } = await supabase.from('profiles').select('nombre_completo').eq('id', CURRENT_USER.id).single();
    if (profile?.nombre_completo) CURRENT_USER.nombre = profile.nombre_completo;
  } catch (e) { /* perfil aún no creado por el trigger, no es crítico */ }

  document.getElementById('user-email').textContent = CURRENT_USER.nombre || CURRENT_USER.email;

  // CAJ-Civil independiente: sin arquitectura modular. Se entra directo al
  // flujo Civil, sin consultar user_modules/organizations/modules. Todo lo
  // que sigue debajo (fetchMisAccesos y el flujo de selector de
  // organización/módulo) queda dormido, nunca se ejecuta — se conserva para
  // minimizar el riesgo de este cambio, no porque siga en uso.
  entrarModuloCivilSinAcceso();
  return;

  try {
    MODULE_ACCESOS = await api.fetchMisAccesos(CURRENT_USER.id);
  } catch (e) {
    console.error('No se pudo cargar el acceso a organización/módulo:', e);
    MODULE_ACCESOS = [];
  }

  if (MODULE_ACCESOS.length === 0) {
    // Compatibilidad hacia atrás: cuentas Civil existentes que todavía no
    // tienen fila en user_modules (la nueva arquitectura de accesos es
    // aditiva) entran exactamente como siempre, sin selector ni bloqueo.
    entrarModuloCivilSinAcceso();
    return;
  }

  // Este método se vuelve a ejecutar ante cualquier evento de sesión de
  // Supabase — incluido TOKEN_REFRESHED, que se dispara al recuperar el
  // foco de la pestaña — no solo al iniciar sesión. Si ya hay una selección
  // activa EN MEMORIA y sigue siendo válida entre los accesos actuales, no
  // se hace nada más: ni se vuelve al selector, ni se recarga la app.
  if (CURRENT_ORG_MODULE) {
    const sigueVigente = MODULE_ACCESOS.some(a =>
      a.organizationId === CURRENT_ORG_MODULE.organizationId && a.moduleId === CURRENT_ORG_MODULE.moduleId);
    if (sigueVigente) return;
    // Perdió el acceso que tenía activo (ej. se lo revocaron): se limpia y
    // continúa el flujo normal de abajo para elegir uno válido.
    CURRENT_ORG_MODULE = null;
    borrarSeleccionModuloGuardada();
  }

  // Sin selección en memoria (primer login de la sesión, o la página se
  // recargó/reabrió): intentar restaurar desde localStorage, PERO siempre
  // validando contra los accesos reales recién obtenidos — nunca se confía
  // ciegamente en el valor guardado.
  const guardada = leerSeleccionModuloGuardada();
  if (guardada) {
    const coincide = MODULE_ACCESOS.find(a =>
      a.organizationId === guardada.organizationId && a.moduleId === guardada.moduleId);
    if (coincide) {
      await entrarAOrgModulo(coincide);
      return;
    }
    // Lo guardado ya no corresponde a un acceso real vigente: se descarta.
    borrarSeleccionModuloGuardada();
  }

  if (MODULE_ACCESOS.length === 1) {
    await entrarAOrgModulo(MODULE_ACCESOS[0]);
    return;
  }

  mostrarSelectorModulo();
}

// Ruta de compatibilidad para cuentas Civil sin fila en user_modules aún.
function entrarModuloCivilSinAcceso() {
  document.getElementById('familia-screen').hidden = true;
  document.getElementById('module-select-screen').hidden = true;
  document.getElementById('org-module-chip').hidden = true;
  document.getElementById('btn-cambiar-modulo').hidden = true;
  showApp();
  loadAll();
  procesarRetornoGoogleCalendar();
}

// Usada exclusivamente por el botón "Cambiar módulo": limpia la selección
// activa (memoria + localStorage) y muestra el selector, SIN cerrar sesión.
function volverASelectorModulo() {
  CURRENT_ORG_MODULE = null;
  borrarSeleccionModuloGuardada();
  mostrarSelectorModulo();
}

function mostrarSelectorModulo() {
  document.getElementById('loading-screen').hidden = true;
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-root').hidden = true;
  document.getElementById('familia-screen').hidden = true;

  const lista = document.getElementById('module-select-list');
  lista.innerHTML = MODULE_ACCESOS.map((acceso, i) => `
    <button class="module-select-item" data-idx="${i}" type="button">
      <span class="org-nombre">${escapeHtml(acceso.organizationNombre)}</span>
      <span class="modulo-nombre">${escapeHtml(acceso.moduleNombre)}</span>
      <span class="modulo-rol">${escapeHtml(acceso.role)}</span>
    </button>`).join('');
  lista.querySelectorAll('.module-select-item').forEach(btn => {
    btn.addEventListener('click', () => entrarAOrgModulo(MODULE_ACCESOS[parseInt(btn.dataset.idx, 10)]));
  });

  document.getElementById('module-select-screen').hidden = false;
}

async function entrarAOrgModulo(acceso) {
  CURRENT_ORG_MODULE = acceso;
  guardarSeleccionModulo(acceso);
  const mostrarSwitcher = MODULE_ACCESOS.length > 1;

  if (acceso.moduleId === 'familia') {
    document.getElementById('loading-screen').hidden = true;
    document.getElementById('auth-screen').hidden = true;
    document.getElementById('module-select-screen').hidden = true;
    document.getElementById('app-root').hidden = true;
    document.getElementById('familia-org-label').textContent = `${acceso.organizationNombre} · Familia`;
    document.getElementById('familia-cambiar-modulo').hidden = !mostrarSwitcher;
    document.getElementById('familia-screen').hidden = false;
    return;
  }

  // Módulo Civil: la aplicación existente, intacta.
  document.getElementById('module-select-screen').hidden = true;
  document.getElementById('familia-screen').hidden = true;
  const chip = document.getElementById('org-module-chip');
  const cambiarBtn = document.getElementById('btn-cambiar-modulo');
  chip.textContent = `${acceso.organizationNombre} · Civil`;
  chip.hidden = !mostrarSwitcher;
  cambiarBtn.hidden = !mostrarSwitcher;

  showApp();
  await loadAll();
  procesarRetornoGoogleCalendar();
}

// Si venimos de vuelta del flujo OAuth de Google (redirección desde
// api/google/callback.js), muestra el resultado, abre Integraciones y
// limpia la URL sin recargar la página.
function procesarRetornoGoogleCalendar() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('integraciones') !== 'google') return;

  const conectado = params.get('google_connected');
  const error = params.get('google_error');

  currentCat = 'integraciones';
  render();

  if (conectado) toast('Cuenta de Google conectada correctamente.');
  else if (error) toast('No se pudo conectar Google Calendar: ' + error);

  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url.toString());
}

// ============================================================================
// CARGA DE DATOS
// ============================================================================
async function loadAll() {
  document.getElementById('list-container').innerHTML = '<div class="loading-note">Cargando causas…</div>';

  const resultados = await Promise.allSettled([
    api.fetchCausas(), api.fetchEncargos(), api.fetchReceptores(), api.fetchTurnos(), api.fetchRevisionesSala(), api.googleGetStatus()
  ]);
  const [rCausas, rEncargos, rReceptores, rTurnos, rRevisionesSala, rGoogleStatus] = resultados;
  const nombres = ['causas', 'encargos', 'receptores', 'turnos', 'revisiones de sala', 'estado de Google Calendar'];

  resultados.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`No se pudo cargar "${nombres[i]}":`, r.reason);
  });

  CAUSAS = rCausas.status === 'fulfilled' ? rCausas.value : [];
  ENCARGOS = rEncargos.status === 'fulfilled' ? rEncargos.value : [];
  RECEPTORES = rReceptores.status === 'fulfilled' ? rReceptores.value : [];
  TURNOS = rTurnos.status === 'fulfilled' ? rTurnos.value : [];
  REVISIONES_SALA = rRevisionesSala.status === 'fulfilled' ? rRevisionesSala.value : [];
  GOOGLE_STATUS = rGoogleStatus.status === 'fulfilled' && rGoogleStatus.value ? rGoogleStatus.value : { conectado: false };

  if (rCausas.status === 'rejected') {
    document.getElementById('list-container').innerHTML = `<div class="empty-msg">No se pudieron cargar tus causas: ${escapeHtml(rCausas.reason?.message || 'error desconocido')}</div>`;
    return;
  }
  if (resultados.slice(0, 5).some(r => r.status === 'rejected')) {
    toast('Algunos datos secundarios no se pudieron cargar. Tus causas sí se cargaron correctamente.');
  }
  render();
}

// ============================================================================
// SIDEBAR / NAVEGACIÓN
// ============================================================================
const CAT_META = {
  tramitacion: { label: 'En tramitación' },
  nueva: { label: 'Nuevas (redacción)' },
  terminada: { label: 'Terminadas' }
};

function renderSidebarTabs() {
  const container = document.getElementById('tabs-container');
  let html = `<div class="tab-label">Carpetas</div>`;
  html += `<div class="folder-tab ${currentCat === 'todas' ? 'active' : ''}" data-cat="todas">Todas las causas <span class="count">${CAUSAS.length}</span></div>`;

  Object.keys(CAT_META).forEach(catKey => {
    const inCat = CAUSAS.filter(c => c.categoria === catKey);
    const isActive = currentCat === catKey;
    html += `<div class="folder-tab ${isActive ? 'active' : ''}" data-cat="${catKey}">
      <span style="display:flex;align-items:center;gap:7px;"><span class="chevron">&#9656;</span>${CAT_META[catKey].label}</span>
      <span class="count">${inCat.length}</span>
    </div>`;

    const subs = [];
    inCat.forEach(c => { const k = c.subcategoria || ''; if (k && !subs.includes(k)) subs.push(k); });

    html += `<div class="subtabs ${isActive ? 'open' : ''}" data-parent="${catKey}">`;
    html += `<div class="folder-tab sub ${isActive && !currentSubcat ? 'active' : ''}" data-cat="${catKey}" data-subcat="">Todas <span class="count">${inCat.length}</span></div>`;
    subs.forEach(sub => {
      const cnt = inCat.filter(c => c.subcategoria === sub).length;
      const scClass = subcatClass({ subcategoria: sub });
      const subActive = isActive && currentSubcat === sub;
      html += `<div class="folder-tab sub ${scClass} ${subActive ? 'active' : ''}" data-cat="${catKey}" data-subcat="${escapeHtml(sub)}">${escapeHtml(sub)} <span class="count">${cnt}</span></div>`;
    });
    html += `</div>`;
  });

  container.innerHTML = html;

  container.querySelectorAll('.folder-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      statFilter = null;
      const cat = tab.dataset.cat;
      if (tab.classList.contains('sub')) {
        currentCat = cat;
        currentSubcat = tab.dataset.subcat || null;
      } else if (cat === currentCat && cat !== 'todas') {
        currentSubcat = null;
      } else {
        currentCat = cat;
        currentSubcat = null;
      }
      closeMobileSidebar();
      render();
    });
  });
}

function updateRecordTabsUI() {
  const t1 = document.getElementById('tab-encargo');
  if (t1) { t1.classList.toggle('active', currentCat === 'encargo'); document.getElementById('cnt-encargo').textContent = ENCARGOS.length; }
  const t2 = document.getElementById('tab-agenda-global');
  if (t2) {
    t2.classList.toggle('active', currentCat === 'agenda-global');
    document.getElementById('cnt-agenda-global').textContent = allEventosFlat().filter(isEventoActivo).length;
  }
  const t3 = document.getElementById('tab-centro-trabajo');
  if (t3) {
    t3.classList.toggle('active', currentCat === 'centro-trabajo');
    document.getElementById('cnt-centro-trabajo').textContent = allGestionesActivasFlat().length;
  }
  const t4 = document.getElementById('tab-revision-pjud');
  if (t4) { t4.classList.toggle('active', currentCat === 'revision-pjud'); }
  const tSalas = document.getElementById('tab-programacion-salas');
  if (tSalas) {
    tSalas.classList.toggle('active', currentCat === 'programacion-salas');
    document.getElementById('cnt-programacion-salas').textContent = causasConApelacion().length;
  }
  const t5 = document.getElementById('tab-receptores');
  if (t5) { t5.classList.toggle('active', currentCat === 'receptores'); }
  const t6 = document.getElementById('tab-informe-final');
  if (t6) { t6.classList.toggle('active', currentCat === 'informe-final'); }
  const t7 = document.getElementById('tab-integraciones');
  if (t7) {
    t7.classList.toggle('active', currentCat === 'integraciones');
    const dot = document.getElementById('integraciones-dot');
    if (dot) {
      const hayErrores = GOOGLE_STATUS.conectado && allEventosFlat().some(e => e.googleSyncStatus === 'error');
      dot.hidden = !hayErrores;
    }
  }
}

// ============================================================================
// ESTADÍSTICAS Y LISTADO
// ============================================================================
function matchesFilters(c) {
  if (statFilter === 'activas' && c.categoria === 'terminada') return false;
  if (statFilter === 'urgente' && c.prioridad !== 'Urgente') return false;
  if (statFilter === 'semi' && c.prioridad !== 'Semi urgente') return false;
  if (statFilter === 'noprior' && c.prioridad !== 'No prioritario') return false;
  if (currentCat !== 'todas' && c.categoria !== currentCat) return false;
  if (currentCat !== 'todas' && currentSubcat && (c.subcategoria || '') !== currentSubcat) return false;
  if (activePriors.size > 0 && !activePriors.has(c.prioridad)) return false;
  if (searchTerm) {
    const hay = [c.titulo, c.patrocinado, c.demandanteNombre, c.demandadoNombre, c.rut, c.rol, c.materia, c.submateria, c.clave].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(searchTerm.toLowerCase())) return false;
  }
  return true;
}

function renderStats() {
  const activos = CAUSAS.filter(c => c.categoria !== 'terminada');
  document.getElementById('stat-total').textContent = activos.length;
  document.getElementById('stat-urgentes').textContent = activos.filter(c => c.prioridad === 'Urgente').length;
  document.getElementById('stat-semi').textContent = activos.filter(c => c.prioridad === 'Semi urgente').length;
  document.getElementById('stat-noprior').textContent = activos.filter(c => c.prioridad === 'No prioritario').length;
  document.getElementById('stat-agenda').textContent = allEventosFlat().filter(isEventoActivo).length;
  document.querySelectorAll('.stat-card[data-filter]').forEach(card => {
    card.classList.toggle('active', statFilter === card.dataset.filter);
  });
}

// Selecciona la gestión "activa" que debe representar a la causa en su
// tarjeta: nunca una gestión Realizada/Cancelada, y nunca datos de la
// instrucción del tutor (que es solo histórica) ni del campo c.plazo (modelo
// anterior).
function pickActiveGestion(c) {
  const activas = (c.gestionesPendientes || []).filter(g => g.estado === 'Pendiente' || g.estado === 'En espera');
  if (activas.length === 0) return null;

  const pendConFecha = activas
    .filter(g => g.estado === 'Pendiente' && g.fechaRevision)
    .sort((a, b) => a.fechaRevision.localeCompare(b.fechaRevision));
  if (pendConFecha.length) return pendConFecha[0];

  const esperaConFecha = activas
    .filter(g => g.estado === 'En espera' && g.fechaRevision)
    .sort((a, b) => a.fechaRevision.localeCompare(b.fechaRevision));
  if (esperaConFecha.length) return esperaConFecha[0];

  const sinFecha = activas.filter(g => !g.fechaRevision);
  if (sinFecha.length) return sinFecha[0];

  return null;
}

function gestionSideText(g) {
  if (!g) return '';
  if (g.estado === 'En espera') {
    return g.fechaRevision ? `En espera · Revisar el ${fmtFechaSolo(g.fechaRevision)}` : 'En espera';
  }
  // estado === 'Pendiente'
  if (!g.fechaRevision) return '';
  const d = daysUntil(g.fechaRevision);
  if (d === null) return '';
  if (d < 0) return `Revisión vencida hace ${Math.abs(d)} día${Math.abs(d) === 1 ? '' : 's'}`;
  if (d === 0) return 'Revisar hoy';
  return `Revisar en ${d} día${d === 1 ? '' : 's'}`;
}

function caseCardHtml(c) {
  const gestionActiva = pickActiveGestion(c);
  const plazoTxt = gestionSideText(gestionActiva);
  const gestion = gestionActiva ? gestionActiva.descripcion : '';
  const scClass = subcatClass(c);
  const scText = c.subcategoria || '';
  const tribunal = tribunalTexto(c);
  const partes = caratuladoTexto(c);
  return `
  <div class="case-card ${scClass}" data-id="${c.id}">
    <div class="case-main">
      <div class="titulo">${escapeHtml(c.titulo)}</div>
      <div class="meta">
        ${scText ? `<span class="sc-tag ${scClass}">${escapeHtml(scText)}</span>` : ''}
        ${tribunal ? `<span>${escapeHtml(tribunal)}</span>` : ''}
        ${c.etapa ? `<span>${escapeHtml(c.etapa)}</span>` : ''}
      </div>
      ${partes ? `<div class="case-partes">${escapeHtml(partes)}</div>` : ''}
      ${gestion ? `<div class="gestion">→ ${escapeHtml(gestion)}</div>` : ''}
    </div>
    <div class="case-side">${escapeHtml(plazoTxt)}</div>
  </div>`;
}

const STAT_LABELS = { activas: 'Causas activas', urgente: 'Urgente', semi: 'Semi urgente', noprior: 'No prioritario' };

function render() {
  renderSidebarTabs();
  updateRecordTabsUI();

  if (currentCat === 'encargo') {
    document.getElementById('stats-row').style.display = 'none';
    document.getElementById('dash-row').style.display = 'none';
    renderRecordsList();
    return;
  }

  if (currentCat === 'agenda-global') {
    document.getElementById('stats-row').style.display = 'none';
    document.getElementById('dash-row').style.display = 'none';
    renderAgendaGlobal();
    return;
  }

  if (currentCat === 'centro-trabajo') {
    document.getElementById('stats-row').style.display = 'none';
    document.getElementById('dash-row').style.display = 'none';
    renderCentroTrabajo();
    return;
  }

  if (currentCat === 'revision-pjud') {
    document.getElementById('stats-row').style.display = 'none';
    document.getElementById('dash-row').style.display = 'none';
    renderRevisionPjud();
    return;
  }

  if (currentCat === 'programacion-salas') {
    document.getElementById('stats-row').style.display = 'none';
    document.getElementById('dash-row').style.display = 'none';
    renderProgramacionSalas();
    return;
  }

  if (currentCat === 'receptores') {
    document.getElementById('stats-row').style.display = 'none';
    document.getElementById('dash-row').style.display = 'none';
    renderReceptoresAdmin();
    return;
  }

  if (currentCat === 'informe-final') {
    document.getElementById('stats-row').style.display = 'none';
    document.getElementById('dash-row').style.display = 'none';
    renderInformeFinal();
    return;
  }

  if (currentCat === 'integraciones') {
    document.getElementById('stats-row').style.display = 'none';
    document.getElementById('dash-row').style.display = 'none';
    renderIntegraciones();
    return;
  }

  document.getElementById('stats-row').style.display = '';
  document.getElementById('dash-row').style.display = '';
  renderDashBlocks();

  renderStats();
  const container = document.getElementById('list-container');
  const filtered = CAUSAS.filter(matchesFilters);

  if (statFilter) {
    const label = STAT_LABELS[statFilter];
    container.innerHTML = filtered.length
      ? `<div class="section-title">${label} <span class="n">${filtered.length}</span></div><div class="case-grid">${filtered.map(caseCardHtml).join('')}</div>`
      : `<div class="section-title">${label}</div><div class="empty-msg">No hay causas que coincidan con este filtro.</div>`;
  } else if (currentCat === 'todas') {
    const groups = [['tramitacion', 'En tramitación'], ['nueva', 'Nuevas (redacción)'], ['terminada', 'Terminadas']];
    let html = '';
    groups.forEach(([key, label]) => {
      const items = filtered.filter(c => c.categoria === key);
      if (items.length === 0) return;
      html += `<div class="section-title">${label} <span class="n">${items.length}</span></div>`;
      html += `<div class="case-grid">${items.map(caseCardHtml).join('')}</div>`;
    });
    container.innerHTML = html || `<div class="empty-msg">No hay causas que coincidan con la búsqueda.</div>`;
  } else {
    container.innerHTML = filtered.length
      ? `<div class="case-grid">${filtered.map(caseCardHtml).join('')}</div>`
      : `<div class="empty-msg">No hay causas en esta carpeta con los filtros actuales.</div>`;
  }

  container.querySelectorAll('.case-card').forEach(el => {
    el.addEventListener('click', () => openDetail(el.dataset.id));
  });
}

// ============================================================================
// PRÓXIMOS HITOS
// ============================================================================
function hitosHtml(c) {
  const hitos = c.hitos || [];
  if (hitos.length === 0) {
    return `<div style="color:var(--ink-faint); font-size:12.5px;">Aún no se han definido hitos para esta causa.</div>`;
  }
  return `<div class="hitos-list">${hitos.map(h => `
    <div class="hito-item ${h.completado ? 'completado' : ''}" data-hito-id="${h.id}">
      <input type="checkbox" ${h.completado ? 'checked' : ''} data-action="toggle-hito" data-id="${h.id}">
      <span class="hito-text">${escapeHtml(h.descripcion)}</span>
      <button class="hito-del" data-action="del-hito" data-id="${h.id}">&times;</button>
    </div>`).join('')}</div>`;
}

// ============================================================================
// FICHA DE CAUSA
// ============================================================================
function notifRowsHtml(c) {
  const rows = c.domicilios || [];
  const blank = { domicilio: '', estado: '', fecha: '', folio: '', informadoPor: '' };
  const list = rows.length ? rows : [blank];
  return list.map((d, i) => `
    <tr data-nd-idx="${i}">
      <td><input type="text" class="nd-domicilio" value="${escapeHtml(d.domicilio || '')}"></td>
      <td><select class="nd-estado">
        <option value="" ${!d.estado ? 'selected' : ''}>—</option>
        <option value="Negativa" ${d.estado === 'Negativa' ? 'selected' : ''}>Negativa</option>
        <option value="Señalar" ${d.estado === 'Señalar' ? 'selected' : ''}>Señalar</option>
        <option value="Señalado" ${d.estado === 'Señalado' ? 'selected' : ''}>Señalado</option>
      </select></td>
      <td><input type="date" class="nd-fecha" value="${escapeHtml(d.fecha || '')}"></td>
      <td><input type="text" class="nd-folio" value="${escapeHtml(d.folio || '')}"></td>
      <td><input type="text" class="nd-informado" value="${escapeHtml(d.informadoPor || '')}"></td>
      <td class="col-del"><button class="notif-row-del" data-action="del-domicilio" data-idx="${i}">&times;</button></td>
    </tr>`).join('');
}

const GESTION_ESTADOS = ['Pendiente', 'En espera', 'Realizada', 'Cancelada'];
const GESTION_PRIORIDADES = ['Urgente', 'Semi urgente', 'No prioritario'];

function gestionEstadoClass(estado) {
  if (estado === 'Realizada') return 'calm-estado';
  if (estado === 'Cancelada') return 'noprior';
  if (estado === 'En espera') return 'na';
  return 'semi';
}

function gestionCardHtml(c, g) {
  const vencida = g.estado === 'Pendiente' && g.fechaRevision && g.fechaRevision < todayISO();
  return `
    <div class="gestion-card" data-gestion-id="${g.id}">
      <div class="gestion-card-top">
        <div class="gestion-desc" data-view>${escapeHtml(g.descripcion)}</div>
        <div class="gestion-badges">
          ${g.prioridad ? `<span class="stamp ${priorClass(g.prioridad)}">${escapeHtml(g.prioridad)}</span>` : ''}
          <span class="stamp evento-estado-${gestionEstadoClass(g.estado)}">${escapeHtml(g.estado)}</span>
          ${vencida ? `<span class="stamp evento-estado-noprior" style="border-color:var(--urgent); color:var(--urgent);">Vencida</span>` : ''}
        </div>
      </div>
      <div class="gestion-meta">
        ${g.categoria ? `<span>${escapeHtml(g.categoria)}</span>` : ''}
        ${g.fechaRevision ? `<span>Revisar: ${escapeHtml(fmtFechaSolo(g.fechaRevision))}</span>` : ''}
        ${g.fechaLimite ? `<span>Plazo: ${escapeHtml(fmtFechaSolo(g.fechaLimite))}</span>` : ''}
        ${g.driveLink ? `<a href="${escapeHtml(g.driveLink)}" target="_blank" rel="noopener">Ver enlace ↗</a>` : ''}
      </div>
      ${g.observaciones ? `<div class="gestion-obs">${escapeHtml(g.observaciones)}</div>` : ''}
      <div class="gestion-actions">
        <button data-action="edit-gestion" data-id="${g.id}">Editar</button>
        <button data-action="agenda-gestion" data-id="${g.id}">+ Agenda</button>
        <button data-action="delete-gestion" data-id="${g.id}" style="border-color:var(--urgent); color:var(--urgent);">Eliminar</button>
      </div>
    </div>`;
}

function pendientesHtml(c) {
  const items = (c.gestionesPendientes || []).slice().sort((a, b) => {
    const order = { 'Pendiente': 0, 'En espera': 1, 'Realizada': 2, 'Cancelada': 3 };
    return (order[a.estado] ?? 9) - (order[b.estado] ?? 9);
  });
  if (items.length === 0) return '<div style="color:var(--ink-faint); font-size:13px;">Sin gestiones registradas.</div>';
  return `<div class="gestion-list">${items.map(g => gestionCardHtml(c, g)).join('')}</div>`;
}

function gestionFormHtml(g) {
  const e = g || { estado: 'Pendiente' };
  const prioridadOptions = ['', ...GESTION_PRIORIDADES].map(p => `<option value="${p}" ${(e.prioridad || '') === p ? 'selected' : ''}>${p || 'Sin definir'}</option>`).join('');
  const estadoOptions = GESTION_ESTADOS.map(s => `<option value="${s}" ${e.estado === s ? 'selected' : ''}>${s}</option>`).join('');
  return `
  <div class="agenda-form">
    <div class="subhead" style="margin-top:0;">${g ? 'Editar gestión' : 'Nueva gestión'}</div>
    <div><label>Descripción</label><textarea id="gf-descripcion">${escapeHtml(e.descripcion || '')}</textarea></div>
    <div class="form-grid2">
      <div><label>Categoría</label><input type="text" id="gf-categoria" value="${escapeHtml(e.categoria || '')}" placeholder="Ej: Notificación, Oficio, PJUD…"></div>
      <div><label>Prioridad</label><select id="gf-prioridad">${prioridadOptions}</select></div>
    </div>
    <div class="form-grid2">
      <div><label>Estado</label><select id="gf-estado">${estadoOptions}</select></div>
      <div><label>Fecha de revisión</label><input type="date" id="gf-fecharevision" value="${escapeHtml(e.fechaRevision || '')}"></div>
    </div>
    <div class="form-grid2">
      <div><label>Fecha límite (opcional)</label><input type="date" id="gf-fechalimite" value="${escapeHtml(e.fechaLimite || '')}"></div>
      <div><label>Enlace de Drive (opcional)</label><input type="text" id="gf-drivelink" value="${escapeHtml(e.driveLink || '')}"></div>
    </div>
    <div><label>Observaciones</label><textarea id="gf-observaciones">${escapeHtml(e.observaciones || '')}</textarea></div>
    <div style="display:flex; gap:8px; margin-top:6px;">
      <button class="btn primary" id="save-gestion" type="button">Guardar gestión</button>
      <button class="btn ghost" id="cancel-gestion" type="button">Cancelar</button>
    </div>
  </div>`;
}

function cronologiaHtml(c) {
  const items = c.cronologia || [];
  if (items.length === 0) return '<div style="color:var(--ink-faint); font-size:13px;">Aún no hay actuaciones registradas.</div>';
  return `<div class="cron-timeline">${items.map(g => `
    <div class="cron-item" data-cron-id="${g.id}">
      <div class="cron-body" style="flex:1;">
        <div class="desc" data-view>${escapeHtml(g.descripcion)}</div>
        <div class="txt" data-edit style="display:none;">
          <textarea class="cron-edit-input" style="width:100%; min-height:50px;">${escapeHtml(g.descripcion)}</textarea>
        </div>
        ${g.driveLink ? `<div class="meta"><a href="${escapeHtml(g.driveLink)}" target="_blank" rel="noopener">Ver documento ↗</a></div>` : ''}
      </div>
      <div style="display:flex; gap:6px; align-self:flex-start;">
        <button data-action="edit-cron" data-id="${g.id}">Editar</button>
        <button data-action="save-cron" data-id="${g.id}" style="display:none; border-color:var(--brass); color:var(--brass);">Guardar</button>
        <button data-action="delete-cron" data-id="${g.id}" style="border-color:var(--urgent); color:var(--urgent);">Eliminar</button>
      </div>
    </div>`).join('')}</div>`;
}

// ---------- Instrucciones del tutor (historial, no determina prioridad) ----------
function instruccionCardHtml(it) {
  const cumplida = it.estado === 'Cumplida';
  return `
    <div class="instr-card ${cumplida ? 'instr-cumplida' : ''}" data-instr-id="${it.id}">
      <div class="instr-top">
        <div class="instr-meta">${it.tutor ? escapeHtml(it.tutor) + ' · ' : ''}${escapeHtml(fmtFechaSolo(it.fecha))}${it.fechaLimite ? ' · Límite: ' + escapeHtml(fmtFechaSolo(it.fechaLimite)) : ''}</div>
        <span class="stamp evento-estado-${cumplida ? 'calm-estado' : 'semi'}">${escapeHtml(it.estado)}</span>
      </div>
      <div class="instr-texto">${escapeHtml(it.instruccion)}</div>
      <div class="gestion-actions">
        ${!cumplida ? `<button data-action="cumplir-instr" data-id="${it.id}">Marcar cumplida</button>` : ''}
        <button data-action="edit-instr" data-id="${it.id}">Editar</button>
        <button data-action="delete-instr" data-id="${it.id}" style="border-color:var(--urgent); color:var(--urgent);">Eliminar</button>
      </div>
    </div>`;
}

function instruccionesListHtml(c) {
  const items = c.instrucciones || [];
  if (items.length === 0) return '<div style="color:var(--ink-faint); font-size:13px;">Sin instrucciones registradas.</div>';
  return `<div class="gestion-list">${items.map(instruccionCardHtml).join('')}</div>`;
}

function instruccionFormHtml(it) {
  const e = it || {};
  return `
  <div class="agenda-form">
    <div class="subhead" style="margin-top:0;">${it ? 'Editar instrucción' : 'Nueva instrucción'}</div>
    <div class="form-grid2">
      <div><label>Tutor</label><input type="text" id="if-tutor" value="${escapeHtml(e.tutor || '')}"></div>
      <div><label>Fecha</label><input type="date" id="if-fecha" value="${escapeHtml(e.fecha || todayISO())}"></div>
    </div>
    <div><label>Instrucción</label><textarea id="if-instruccion">${escapeHtml(e.instruccion || '')}</textarea></div>
    <div class="form-grid2">
      <div><label>Fecha límite (opcional)</label><input type="date" id="if-fechalimite" value="${escapeHtml(e.fechaLimite || '')}"></div>
      <div><label>Estado</label>
        <select id="if-estado">
          <option value="Pendiente" ${(e.estado || 'Pendiente') === 'Pendiente' ? 'selected' : ''}>Pendiente</option>
          <option value="Cumplida" ${e.estado === 'Cumplida' ? 'selected' : ''}>Cumplida</option>
        </select>
      </div>
    </div>
    <div style="display:flex; gap:8px; margin-top:6px;">
      <button class="btn primary" id="save-instr" type="button">Guardar</button>
      <button class="btn ghost" id="cancel-instr" type="button">Cancelar</button>
    </div>
  </div>`;
}

const CATEGORIA_LABEL = { tramitacion: 'En tramitación', nueva: 'Nueva (redacción)', terminada: 'Terminada' };

const BAJ_OPCIONES = [
  ['acompanado', 'Acompañado'],
  ['solicitar', 'Solicitar'],
  ['no_acompanado', 'No acompañado']
];
const BAJ_LABEL = Object.fromEntries(BAJ_OPCIONES);

// Tolerante a mayúsculas/minúsculas y variaciones razonables del texto
// libre existente en "Recurso" (ej. "Apelación", "Recurso de apelación",
// "Apelación subsidiaria"). No crea un segundo campo: reutiliza c.recurso.
function esRecursoApelacion(recurso) {
  if (!recurso) return false;
  return /apelaci[oó]n/i.test(recurso);
}



function fmtFechaSolo(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(dateStr);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Construye un modelo de datos "limpio" de la ficha (sin campos/secciones
// vacías) que se usa tanto para la vista/impresión en HTML como para el PDF,
// de modo que ambos queden siempre consistentes entre sí.
function buildFichaData(c) {
  const now = new Date();
  const usuario = (CURRENT_USER && (CURRENT_USER.nombre || CURRENT_USER.email)) || 'Usuario no identificado';

  function kv(pairs) {
    const rows = [];
    pairs.forEach(([label, val]) => {
      if (val === null || val === undefined) return;
      const str = String(val).trim();
      if (str === '' || str === '—') return;
      rows.push([label, str]);
    });
    return rows;
  }

  const sections = [];

  const generales = kv([
    ['Título / referencia', c.titulo],
    ['ROL', c.rol],
    ['Caratulado', caratuladoTexto(c)],
    ['Tribunal', tribunalTexto(c)],
    ['Código SAJ', c.folio],
    ['ROL ingreso Corte', c.rolIngreso],
    ['Carpeta', CATEGORIA_LABEL[c.categoria] || c.categoria],
    ['Tipo de juicio', c.subcategoria],
    ['Etapa', c.etapa],
    ['Materia', c.materia],
    ['Patrocinado', patrocinadoEfectivo(c)],
    ['Recurso', c.recurso]
  ]);
  if (generales.length) sections.push({ title: 'Datos generales', kind: 'kv', rows: generales });

  const resumen = kv([
    ['Clave para recordar', c.clave],
    ['Estado actual', c.estado],
    ['Resumen de la causa', c.resumen],
    ['Comentarios', c.comentarios]
  ]);
  if (resumen.length) sections.push({ title: 'Resumen', kind: 'kv', rows: resumen });

  const instrucciones = (c.instrucciones || []);
  if (instrucciones.length) sections.push({
    title: 'Instrucciones del tutor (historial)', kind: 'table',
    headers: ['Tutor', 'Fecha', 'Instrucción', 'Fecha límite', 'Estado'], widths: [0.16, 0.12, 0.42, 0.12, 0.18],
    rows: instrucciones.map(it => [it.tutor || '', fmtFechaSolo(it.fecha), it.instruccion, fmtFechaSolo(it.fechaLimite), it.estado])
  });

  const gestionesActivas = (c.gestionesPendientes || []).filter(g => ['Pendiente', 'En espera'].includes(g.estado));
  if (gestionesActivas.length) sections.push({
    title: 'Gestiones pendientes', kind: 'table',
    headers: ['Descripción', 'Categoría', 'Prioridad', 'Estado', 'Revisión'], widths: [0.36, 0.16, 0.16, 0.16, 0.16],
    rows: gestionesActivas.map(g => [g.descripcion, g.categoria || '', g.prioridad || '', g.estado, fmtFechaSolo(g.fechaRevision)])
  });

  const cronologiaItems = (c.cronologia || []);
  if (cronologiaItems.length) sections.push({
    title: 'Historial de gestiones', kind: 'table',
    headers: ['Fecha', 'Actuación', 'Usuario'], widths: [0.26, 0.54, 0.20],
    rows: cronologiaItems.map(g => [fmtFechaHora(g.fecha), g.descripcion || '', g.usuarioNombre || ''])
  });

  const notificacion = kv([
    ['Estado de notificación', c.notifEstado],
    ['Persona a notificar', c.notifNombre]
  ]);
  if (notificacion.length) sections.push({ title: 'Notificación', kind: 'kv', rows: notificacion });

  const domiciliosConDatos = (c.domicilios || []).filter(d => d.domicilio || d.estado || d.fecha || d.folio || d.informadoPor);
  if (domiciliosConDatos.length) sections.push({
    title: 'Domicilios de notificación', kind: 'table',
    headers: ['Domicilio', 'Resultado', 'Fecha', 'Folio', 'Informado por'], widths: [0.34, 0.16, 0.14, 0.14, 0.22],
    rows: domiciliosConDatos.map(d => [d.domicilio || '', d.estado || '', fmtFechaSolo(d.fecha), d.folio || '', d.informadoPor || ''])
  });

  const contacto = kv([
    ['Patrocinado', c.patrocinado],
    ['RUT', c.rut],
    ['Correo', c.correo],
    ['Correo alternativo', c.correoAlt],
    ['Teléfono', c.telefono],
    ['Nota', c.nota],
    ['Tutor', c.tutor],
    ['Fecha de ingreso', fmtFechaSolo(c.fechaIngreso)]
  ]);
  if (contacto.length) sections.push({ title: 'Contacto', kind: 'kv', rows: contacto });

  const audiencia = kv([
    ['Fecha audiencia', fmtFechaSolo(c.fechaAudiencia)],
    ['Hora audiencia', c.hora],
    ['Modalidad', c.modalidad]
  ]);
  if (audiencia.length) sections.push({ title: 'Audiencia', kind: 'kv', rows: audiencia });

  const hoyIso = todayISO();
  const proximosEventos = (c.agendaEventos || [])
    .filter(e => e.fecha >= hoyIso && !['Realizado', 'Cancelado'].includes(e.estado))
    .sort((a, b) => `${a.fecha}${a.horaInicio || ''}`.localeCompare(`${b.fecha}${b.horaInicio || ''}`));
  if (proximosEventos.length) sections.push({
    title: 'Próximos eventos', kind: 'table',
    headers: ['Tipo', 'Fecha', 'Hora', 'Título', 'Estado'], widths: [0.18, 0.14, 0.12, 0.40, 0.16],
    rows: proximosEventos.map(e => [e.tipo, fmtFechaSolo(e.fecha), e.horaInicio || '', e.titulo, e.estado])
  });

  if (c.driveFolderUrl) sections.push({ title: 'Documentación', kind: 'link', label: 'Carpeta de Google Drive', url: c.driveFolderUrl });

  return {
    brand: 'Panel de Causas — CAJ Lo Prado',
    titulo: c.titulo || 'Ficha de causa',
    meta: `Generado el ${fmtFechaHora(now.toISOString())} por ${usuario}`,
    sections
  };
}

function renderFichaHtml(data) {
  const sectionsHtml = data.sections.map(sec => {
    if (sec.kind === 'kv') {
      const rows = sec.rows.map(([label, val]) => `<tr><td class="ficha-k">${escapeHtml(label)}</td><td class="ficha-v">${escapeHtml(val).replace(/\n/g, '<br>')}</td></tr>`).join('');
      return `<div class="ficha-section"><h3>${escapeHtml(sec.title)}</h3><table class="ficha-table"><tbody>${rows}</tbody></table></div>`;
    }
    if (sec.kind === 'list') {
      const items = sec.items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
      return `<div class="ficha-section"><h3>${escapeHtml(sec.title)}</h3><ul class="ficha-list">${items}</ul></div>`;
    }
    if (sec.kind === 'table') {
      const thead = `<tr>${sec.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
      const tbody = sec.rows.map(r => `<tr>${r.map(cell => `<td>${escapeHtml(String(cell || ''))}</td>`).join('')}</tr>`).join('');
      return `<div class="ficha-section"><h3>${escapeHtml(sec.title)}</h3><table class="ficha-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
    }
    if (sec.kind === 'link') {
      return `<div class="ficha-section"><h3>${escapeHtml(sec.title)}</h3><table class="ficha-table"><tbody><tr><td class="ficha-k">${escapeHtml(sec.label)}</td><td class="ficha-v"><a href="${escapeHtml(sec.url)}" target="_blank" rel="noopener">${escapeHtml(sec.url)}</a></td></tr></tbody></table></div>`;
    }
    return '';
  }).join('');

  return `
  <div class="ficha-doc">
    <div class="ficha-header">
      <div class="ficha-brand">${escapeHtml(data.brand)}</div>
      <h2>${escapeHtml(data.titulo)}</h2>
      <div class="ficha-meta">${escapeHtml(data.meta)}</div>
    </div>
    ${sectionsHtml}
  </div>`;
}

function fichaHtml(c) {
  return renderFichaHtml(buildFichaData(c));
}

// ---------- Generación de PDF con texto real (no captura de pantalla) ----------
// Márgenes tipo documento jurídico: 2,5 cm en los 4 lados. Controla saltos de
// página para no dejar encabezados solos y repite el encabezado de columnas
// cuando una tabla continúa en la página siguiente.
function wrapMultiline(pdf, text, maxWidth) {
  const paragraphs = String(text).split(/\r\n|\r|\n/);
  let lines = [];
  paragraphs.forEach(p => {
    if (p === '') { lines.push(''); return; }
    lines = lines.concat(pdf.splitTextToSize(p, maxWidth));
  });
  return lines;
}

function estimateSectionHeight(sec) {
  if (sec.kind === 'kv') return 12 + sec.rows.length * 9;
  if (sec.kind === 'list') return 12 + sec.items.length * 7;
  if (sec.kind === 'table') return 12 + 8 + sec.rows.length * 6.5;
  if (sec.kind === 'link') return 12 + 9;
  return 20;
}

// Escritor de PDF reutilizable: encapsula márgenes, paginación y las
// primitivas de dibujo (títulos, tablas clave/valor, listas, tablas) para
// que tanto la ficha individual como el Informe Final compartan exactamente
// el mismo formato profesional (márgenes 2,5 cm, numeración, control de
// saltos de página).
function crearEscritorPdf() {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 25; // 2,5 cm en los 4 lados
  const contentWidth = pageWidth - margin * 2;
  const bottomLimit = pageHeight - margin;
  let y = margin;

  function newPage() { pdf.addPage(); y = margin; }
  function ensure(h) { if (y + h > bottomLimit) newPage(); }

  function drawSectionTitle(title) {
    ensure(15);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10.5); pdf.setTextColor(20);
    pdf.text(title.toUpperCase(), margin, y + 3);
    y += 6;
    pdf.setDrawColor(190); pdf.setLineWidth(0.25);
    pdf.line(margin, y, margin + contentWidth, y);
    y += 6;
  }

  function drawKvRows(rows) {
    const keyWidth = 54;
    const valWidth = contentWidth - keyWidth - 2;
    rows.forEach(([label, val]) => {
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5);
      const valLines = wrapMultiline(pdf, val, valWidth);
      const rowH = Math.max(valLines.length * 4.7, 6) + 3;
      ensure(rowH);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5); pdf.setTextColor(95);
      pdf.text(label, margin, y + 4);
      pdf.setFont('helvetica', 'normal'); pdf.setTextColor(25);
      pdf.text(valLines, margin + keyWidth, y + 4);
      y += rowH;
      pdf.setDrawColor(230); pdf.setLineWidth(0.15);
      pdf.line(margin, y - 1.8, margin + contentWidth, y - 1.8);
    });
    y += 5;
  }

  function drawList(items) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); pdf.setTextColor(25);
    items.forEach(item => {
      const lines = wrapMultiline(pdf, '•  ' + item, contentWidth - 2);
      const rowH = lines.length * 4.7 + 2;
      ensure(rowH);
      pdf.text(lines, margin, y + 3.6);
      y += rowH;
    });
    y += 4;
  }

  function drawTable(headers, widthsRatio, rows) {
    const colWidths = widthsRatio.map(r => r * contentWidth);
    function header() {
      ensure(10);
      pdf.setFillColor(238, 238, 238);
      pdf.rect(margin, y, contentWidth, 7.5, 'F');
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.3); pdf.setTextColor(60);
      let x = margin;
      headers.forEach((h, i) => { pdf.text(h, x + 2, y + 5); x += colWidths[i]; });
      y += 7.5;
      pdf.setDrawColor(200); pdf.setLineWidth(0.2);
      pdf.line(margin, y, margin + contentWidth, y);
    }
    header();
    rows.forEach(cells => {
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.3); pdf.setTextColor(25);
      const wrapped = cells.map((cell, i) => wrapMultiline(pdf, cell || '', colWidths[i] - 4));
      const lineCount = Math.max(...wrapped.map(w => w.length), 1);
      const rowH = lineCount * 4.1 + 2.6;
      if (y + rowH > bottomLimit) { newPage(); header(); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.3); pdf.setTextColor(25); }
      let x = margin;
      wrapped.forEach((w, i) => { pdf.text(w, x + 2, y + 4); x += colWidths[i]; });
      y += rowH;
      pdf.setDrawColor(235); pdf.setLineWidth(0.15);
      pdf.line(margin, y - 1.3, margin + contentWidth, y - 1.3);
    });
    y += 5;
  }

  function drawSection(sec) {
    const estH = estimateSectionHeight(sec);
    const fitsWholePage = estH <= (bottomLimit - margin);
    const remaining = bottomLimit - y;
    if (fitsWholePage && estH > remaining) newPage();

    drawSectionTitle(sec.title);
    if (sec.kind === 'kv') drawKvRows(sec.rows);
    else if (sec.kind === 'list') drawList(sec.items);
    else if (sec.kind === 'table') drawTable(sec.headers, sec.widths, sec.rows);
    else if (sec.kind === 'link') drawKvRows([[sec.label, sec.url]]);
  }

  function finalizarPaginacion() {
    const totalPages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      pdf.setPage(i);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(130);
      pdf.text(`Página ${i} de ${totalPages}`, pageWidth - margin, pageHeight - 12, { align: 'right' });
    }
  }

  return {
    pdf, pageWidth, pageHeight, margin, contentWidth, bottomLimit,
    get y() { return y; }, set y(v) { y = v; },
    newPage, ensure, drawSectionTitle, drawKvRows, drawList, drawTable, drawSection,
    finalizarPaginacion
  };
}

function renderFichaPdf(data) {
  const w = crearEscritorPdf();
  const { pdf, margin, contentWidth } = w;

  // Encabezado del documento (solo primera página)
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(110);
  pdf.text(data.brand, margin, w.y); w.y += 7;

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15); pdf.setTextColor(20);
  const titleLines = wrapMultiline(pdf, data.titulo, contentWidth);
  pdf.text(titleLines, margin, w.y + 4);
  w.y += titleLines.length * 6.3 + 3;

  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(110);
  pdf.text(data.meta, margin, w.y); w.y += 5;

  pdf.setDrawColor(20); pdf.setLineWidth(0.5);
  pdf.line(margin, w.y, margin + contentWidth, w.y);
  w.y += 11;

  data.sections.forEach(sec => w.drawSection(sec));
  w.finalizarPaginacion();
  return pdf;
}



function headerSubline(c) {
  const parts = [];
  const tribunal = tribunalTexto(c);
  if (tribunal) parts.push(escapeHtml(tribunal));
  if (c.folio) parts.push(`SAJ: ${escapeHtml(c.folio)}`);
  return parts.join(' | ');
}

function quickActionsHtml(c) {
  return `<div class="quick-actions">
    <button class="btn small" data-action="qa-drive">Drive</button>
    <button class="btn small" data-action="qa-saj">SAJ</button>
    <button class="btn small" data-action="qa-pjud">OJV</button>
    <button class="btn small" data-action="qa-gmail">Correo</button>
    <span class="copy-feedback" id="qa-feedback"></span>
  </div>`;
}

// ============================================================================
// AGENDA JURÍDICA (por causa)
// ============================================================================
const AGENDA_TIPOS = [
  'Audiencia', 'Cita con usuario', 'Reunión con tutor', 'Llamada', 'Plazo procesal',
  'Presentación de escrito', 'Revisión de causa', 'Gestión importante', 'Recordatorio', 'Otro'
];
const AGENDA_ESTADOS = ['Pendiente', 'Confirmado', 'Realizado', 'Suspendido', 'Reprogramado', 'Cancelado'];
const AGENDA_ESTADOS_ACTIVOS = ['Pendiente', 'Confirmado', 'Reprogramado'];
const AGENDA_TIPO_ICONO = {
  'Audiencia': '⚖', 'Cita con usuario': '🙋', 'Reunión con tutor': '👤', 'Llamada': '☎',
  'Plazo procesal': '⏱', 'Presentación de escrito': '📝', 'Revisión de causa': '🔍',
  'Gestión importante': '★', 'Recordatorio': '🔔', 'Otro': '•'
};

function todayISO() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function tomorrowISO() {
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function isEventoActivo(e) { return AGENDA_ESTADOS_ACTIVOS.includes(e.estado); }
function eventoEstadoClass(estado) {
  if (estado === 'Cancelado' || estado === 'Suspendido') return 'noprior';
  if (estado === 'Realizado') return 'calm-estado';
  return 'semi';
}

function allEventosFlat() {
  const out = [];
  CAUSAS.forEach(c => {
    (c.agendaEventos || []).forEach(e => out.push({ ...e, causa: c }));
  });
  return out;
}

function agendaEventCardHtml(e) {
  const icono = AGENDA_TIPO_ICONO[e.tipo] || '•';
  const horas = [e.horaInicio, e.horaTermino].filter(Boolean).join(' – ');
  return `<div class="evento-card" data-evento-id="${e.id}">
    <div class="evento-icono">${icono}</div>
    <div class="evento-main">
      <div class="evento-titulo">${escapeHtml(e.titulo)}</div>
      <div class="evento-meta">
        <span class="evento-tipo-tag">${escapeHtml(e.tipo)}</span>
        <span>${escapeHtml(fmtFechaSolo(e.fecha))}</span>
        ${horas ? `<span>${escapeHtml(horas)}</span>` : ''}
        ${e.modalidad ? `<span>${escapeHtml(e.modalidad)}</span>` : ''}
      </div>
    </div>
    <div class="evento-badges">
      <span class="stamp evento-estado-${eventoEstadoClass(e.estado)}">${escapeHtml(e.estado)}</span>
      ${e.prioridad ? `<span class="stamp ${priorClass(e.prioridad)}">${escapeHtml(e.prioridad)}</span>` : ''}
      ${googleSyncBadgeHtml(e)}
    </div>
    <div class="evento-actions">
      <button class="btn small" data-action="edit-evento" data-id="${e.id}">Editar</button>
      ${e.googleSyncStatus === 'error' ? `<button class="btn small" data-action="reintentar-sync-evento" data-id="${e.id}">Reintentar sincronización</button>` : ''}
      <button class="btn small" data-action="delete-evento" data-id="${e.id}" style="border-color:var(--urgent); color:var(--urgent);">Eliminar</button>
    </div>
  </div>`;
}

function agendaListHtml(c) {
  const eventos = (c.agendaEventos || []);
  if (eventos.length === 0) {
    return `<div class="empty-msg" style="margin-top:10px;">Aún no hay eventos registrados para esta causa.</div>`;
  }
  const hoy = todayISO();
  const proximos = eventos.filter(e => !(['Realizado', 'Cancelado'].includes(e.estado)) && e.fecha >= hoy)
    .sort((a, b) => `${a.fecha}${a.horaInicio || ''}`.localeCompare(`${b.fecha}${b.horaInicio || ''}`));
  const pasados = eventos.filter(e => (['Realizado', 'Cancelado'].includes(e.estado)) || e.fecha < hoy)
    .sort((a, b) => `${b.fecha}${b.horaInicio || ''}`.localeCompare(`${a.fecha}${a.horaInicio || ''}`));

  let html = '';
  if (proximos.length) {
    html += `<div class="subhead" style="margin-top:16px;">Próximos</div><div class="evento-list">${proximos.map(agendaEventCardHtml).join('')}</div>`;
  }
  if (pasados.length) {
    html += `<div class="subhead" style="margin-top:20px;">Realizados / pasados</div><div class="evento-list">${pasados.map(agendaEventCardHtml).join('')}</div>`;
  }
  return html;
}

function agendaFormHtml(evento) {
  const e = evento || { tipo: 'Audiencia', estado: 'Pendiente' };
  const tipoOptions = AGENDA_TIPOS.map(t => `<option value="${t}" ${e.tipo === t ? 'selected' : ''}>${t}</option>`).join('');
  const estadoOptions = AGENDA_ESTADOS.map(s => `<option value="${s}" ${e.estado === s ? 'selected' : ''}>${s}</option>`).join('');
  const prioridadOptions = ['', 'No prioritario', 'Semi urgente', 'Urgente'].map(p => `<option value="${p}" ${(e.prioridad || '') === p ? 'selected' : ''}>${p || 'Sin definir'}</option>`).join('');
  return `
  <div class="agenda-form">
    <div class="subhead" style="margin-top:0;">${evento ? 'Editar evento' : 'Nuevo evento'}</div>
    <div class="form-grid2">
      <div><label>Tipo de evento</label><select id="ev-tipo">${tipoOptions}</select></div>
      <div><label>Estado</label><select id="ev-estado">${estadoOptions}</select></div>
    </div>
    <div><label>Título</label><input type="text" id="ev-titulo" value="${escapeHtml(e.titulo || '')}" placeholder="Ej: Audiencia de contestación"></div>
    <div><label>Descripción</label><textarea id="ev-descripcion">${escapeHtml(e.descripcion || '')}</textarea></div>
    <div class="form-grid2">
      <div><label>Fecha</label><input type="date" id="ev-fecha" value="${escapeHtml(e.fecha || '')}"></div>
      <div><label>Prioridad</label><select id="ev-prioridad">${prioridadOptions}</select></div>
    </div>
    <div class="form-grid2">
      <div><label>Hora de inicio</label><input type="text" id="ev-horaInicio" value="${escapeHtml(e.horaInicio || '')}" placeholder="HH:MM"></div>
      <div><label>Hora de término</label><input type="text" id="ev-horaTermino" value="${escapeHtml(e.horaTermino || '')}" placeholder="HH:MM"></div>
    </div>
    <div class="form-grid2">
      <div><label>Modalidad</label><input type="text" id="ev-modalidad" value="${escapeHtml(e.modalidad || '')}" placeholder="Presencial / Remota"></div>
      <div><label>Ubicación</label><input type="text" id="ev-ubicacion" value="${escapeHtml(e.ubicacion || '')}"></div>
    </div>
    <div><label>Enlace de videoconferencia</label><input type="text" id="ev-enlace" value="${escapeHtml(e.enlace || '')}" placeholder="https://…"></div>
    <div><label>Observaciones</label><textarea id="ev-observaciones">${escapeHtml(e.observaciones || '')}</textarea></div>
    <div style="display:flex; gap:8px; margin-top:6px;">
      <button class="btn primary" id="save-evento" type="button">Guardar evento</button>
      <button class="btn ghost" id="cancel-evento" type="button">Cancelar</button>
    </div>
  </div>`;
}

function wireAgendaTab(c, panel) {
  const formWrap = panel.querySelector('#agenda-form-wrap');
  const listWrap = panel.querySelector('#agenda-list-wrap');

  function closeForm() {
    formWrap.hidden = true;
    formWrap.innerHTML = '';
  }

  function openForm(evento) {
    formWrap.innerHTML = agendaFormHtml(evento);
    formWrap.hidden = false;
    formWrap.querySelector('#cancel-evento').addEventListener('click', closeForm);
    formWrap.querySelector('#save-evento').addEventListener('click', async () => {
      const patch = {
        tipo: formWrap.querySelector('#ev-tipo').value,
        titulo: formWrap.querySelector('#ev-titulo').value.trim(),
        descripcion: formWrap.querySelector('#ev-descripcion').value.trim() || null,
        fecha: formWrap.querySelector('#ev-fecha').value || null,
        horaInicio: formWrap.querySelector('#ev-horaInicio').value.trim() || null,
        horaTermino: formWrap.querySelector('#ev-horaTermino').value.trim() || null,
        modalidad: formWrap.querySelector('#ev-modalidad').value.trim() || null,
        ubicacion: formWrap.querySelector('#ev-ubicacion').value.trim() || null,
        enlace: formWrap.querySelector('#ev-enlace').value.trim() || null,
        estado: formWrap.querySelector('#ev-estado').value,
        prioridad: formWrap.querySelector('#ev-prioridad').value || null,
        observaciones: formWrap.querySelector('#ev-observaciones').value.trim() || null
      };
      if (!patch.titulo) { toast('El evento necesita un título'); return; }
      if (!patch.fecha) { toast('Selecciona una fecha para el evento'); return; }
      try {
        let eventoGuardado;
        if (evento) {
          const actualizado = await api.updateAgendaEvento(evento.id, patch);
          const idx = c.agendaEventos.findIndex(x => x.id === evento.id);
          if (idx >= 0) c.agendaEventos[idx] = actualizado;
          eventoGuardado = actualizado;
          toast('Evento actualizado');
        } else {
          patch.creadoPor = (CURRENT_USER && (CURRENT_USER.nombre || CURRENT_USER.email)) || null;
          const nuevo = await api.createAgendaEvento(CURRENT_USER.id, c.id, patch);
          c.agendaEventos = c.agendaEventos || [];
          c.agendaEventos.push(nuevo);
          eventoGuardado = nuevo;
          toast('Evento creado');
        }
        closeForm();
        listWrap.innerHTML = agendaListHtml(c);
        wireAgendaListButtons(c, panel, openForm, listWrap);
        render();
        // Sincronización con Google Calendar: no bloquea la interfaz; si
        // falla, el evento queda marcado "error" pero sigue en la Agenda.
        intentarSincronizarEventoGoogle(eventoGuardado, () => {
          listWrap.innerHTML = agendaListHtml(c);
          wireAgendaListButtons(c, panel, openForm, listWrap);
        });
      } catch (err) { toast('No se pudo guardar el evento: ' + err.message); }
    });
  }

  panel.querySelector('#add-evento').addEventListener('click', () => openForm(null));
  wireAgendaListButtons(c, panel, openForm, listWrap);
}

function wireAgendaListButtons(c, panel, openForm, listWrap) {
  listWrap.querySelectorAll('[data-action="edit-evento"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ev = (c.agendaEventos || []).find(x => x.id === btn.dataset.id);
      if (ev) openForm(ev);
    });
  });
  listWrap.querySelectorAll('[data-action="delete-evento"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este evento de la agenda?')) return;
      const ev = (c.agendaEventos || []).find(x => x.id === btn.dataset.id);
      try {
        if (ev && ev.googleEventId && GOOGLE_STATUS.conectado) {
          try { await api.googleDeleteEvent(ev.googleEventId, ev.googleCalendarId); }
          catch (eGoogle) { toast('No se pudo eliminar el evento en Google Calendar: ' + eGoogle.message); }
        }
        await api.deleteAgendaEvento(btn.dataset.id);
        c.agendaEventos = (c.agendaEventos || []).filter(x => x.id !== btn.dataset.id);
        listWrap.innerHTML = agendaListHtml(c);
        wireAgendaListButtons(c, panel, openForm, listWrap);
        toast('Evento eliminado');
        render();
      } catch (err) { toast('No se pudo eliminar: ' + err.message); }
    });
  });
  listWrap.querySelectorAll('[data-action="reintentar-sync-evento"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ev = (c.agendaEventos || []).find(x => x.id === btn.dataset.id);
      if (!ev) return;
      toast('Reintentando sincronización…');
      sincronizarEventoGoogleAhora(ev, () => {
        listWrap.innerHTML = agendaListHtml(c);
        wireAgendaListButtons(c, panel, openForm, listWrap);
      });
    });
  });
}


// ============================================================================
// DASHBOARD: "Hoy" y "Próximos compromisos"
// ============================================================================
// Tribunales que no llevan número ordinal (Corte Suprema, y "Otro" si no se
// especifica número).
const TRIBUNAL_SIN_NUMERO = ['Corte Suprema'];

// Fuente única para el texto del tribunal en toda la aplicación: se
// construye siempre desde los campos normalizados de la causa; si aún no
// se han completado (causas antiguas sin migrar manualmente), cae de
// respaldo al texto libre histórico c.tribunal.
function tribunalTexto(c) {
  if (!c) return '';
  if (c.tipoTribunal) {
    const necesitaNumero = !TRIBUNAL_SIN_NUMERO.includes(c.tipoTribunal);
    const numero = necesitaNumero && c.numeroTribunal ? `${c.numeroTribunal}° ` : '';
    const ciudad = c.ciudadTribunal ? ` de ${c.ciudadTribunal}` : '';
    return `${numero}${c.tipoTribunal}${ciudad}`.trim();
  }
  return c.tribunal || '';
}

// Quita un prefijo "ROL <rol> / " o "ROL <rol>" redundante del título, para
// vistas compactas donde el ROL ya se muestra por separado.
function tituloSinRol(c) {
  if (!c.titulo) return '';
  if (!c.rol) return c.titulo;
  const rolEscapado = c.rol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patron = new RegExp(`^\\s*ROL\\s+${rolEscapado}\\s*[\\/\\-–—]?\\s*`, 'i');
  const limpio = c.titulo.replace(patron, '').trim();
  return limpio || c.titulo;
}

// Nombre corto para identificación visual: para personas naturales usa el
// apellido paterno (heurística: penúltima palabra de un nombre chileno
// típico); para instituciones conserva el nombre completo reconocible.
const INSTITUCION_KEYWORDS = [
  'municipalidad', 'banco', 'servicio', 'sociedad', 'spa', 'ltda', 's.a.', 'sa',
  'inmobiliaria', 'empresa', 'compañía', 'compania', 'cooperativa', 'fisco',
  'ministerio', 'universidad', 'corporación', 'corporacion', 'fundación', 'fundacion',
  'isapre', 'afp', 'clínica', 'clinica', 'hospital', 'tesorería', 'tesoreria',
  'caja', 'notaría', 'notaria', 'inversiones', 'constructora', 'comercial', 'ee.uu'
];

function esNombreInstitucional(nombre) {
  const low = nombre.toLowerCase();
  return INSTITUCION_KEYWORDS.some(kw => low.includes(kw)) || /\b(spa|ltda|s\.a\.)\b/i.test(nombre);
}

function nombreCorto(nombreCompleto) {
  if (!nombreCompleto) return null;
  const nombre = nombreCompleto.trim();
  if (esNombreInstitucional(nombre)) return nombre;
  const partes = nombre.split(/\s+/).filter(Boolean);
  if (partes.length <= 1) return nombre;
  if (partes.length === 2) return partes[1];
  // Nombre chileno típico "Nombre(s) ApellidoPaterno ApellidoMaterno": el
  // apellido paterno es la penúltima palabra.
  return partes[partes.length - 2];
}

// Identificador abreviado de partes para vistas compactas: "Apellido /
// Contraparte". Nunca inventa datos: si no hay contraparte registrada,
// muestra solo la parte disponible. Se usa como respaldo para causas
// antiguas que aún no tienen demandante/demandado definidos.
function partesAbreviadas(c) {
  const p1 = nombreCorto(c.patrocinado);
  const p2 = nombreCorto(c.contraparteNombre);
  if (p1 && p2) return `${p1} / ${p2}`;
  if (p1) return p1;
  if (p2) return p2;
  return null;
}

// El caratulado nunca depende de a quién representamos: siempre respeta el
// orden procesal Demandante / Demandado, aunque representemos al demandado.
function tieneRolProcesalDefinido(c) {
  return !!(c.demandanteNombre || c.demandadoNombre);
}

function caratuladoTexto(c) {
  if (tieneRolProcesalDefinido(c)) {
    const dte = nombreCorto(c.demandanteNombre);
    const ddo = nombreCorto(c.demandadoNombre);
    if (dte && ddo) return `${dte} / ${ddo}`;
    if (dte) return dte;
    if (ddo) return ddo;
  }
  // Causa antigua sin posición procesal definida: se muestra el respaldo
  // (patrocinado/contraparte) sin garantía de orden procesal.
  return partesAbreviadas(c);
}

// Nombre completo de la parte que efectivamente representamos, derivado de
// parte_representada + demandante/demandado. Si aún no está definido, cae
// de respaldo al campo "patrocinado" histórico.
function patrocinadoEfectivo(c) {
  if (c.parteRepresentada === 'Demandante' && c.demandanteNombre) return c.demandanteNombre;
  if (c.parteRepresentada === 'Demandado' && c.demandadoNombre) return c.demandadoNombre;
  return c.patrocinado || null;
}


function causaShortLabel(c) {
  return c.rol || c.folio || c.titulo || 'Causa';
}

function goToCausaAgenda(causaId) {
  currentCat = 'todas'; statFilter = null;
  render();
  openDetail(causaId, 'agenda');
}


// ============================================================================
// CENTRO DE TRABAJO — organiza el trabajo diario a partir de las gestiones
// ============================================================================
function allGestionesActivasFlat() {
  const out = [];
  CAUSAS.forEach(c => {
    (c.gestionesPendientes || []).forEach(g => {
      if (g.estado === 'Pendiente' || g.estado === 'En espera') out.push({ ...g, causa: c });
    });
  });
  return out;
}

function centroTrabajoBuckets() {
  const hoy = todayISO();
  const en7dias = new Date(); en7dias.setDate(en7dias.getDate() + 7);
  const en7iso = toISO(en7dias);

  const activas = allGestionesActivasFlat();
  const buckets = { hoy: [], proximos7: [], enEspera: [], vencidas: [], sinFecha: [] };

  activas.forEach(g => {
    if (g.estado === 'En espera') { buckets.enEspera.push(g); return; }
    // estado === 'Pendiente' desde aquí
    if (!g.fechaRevision) { buckets.sinFecha.push(g); return; }
    if (g.fechaRevision < hoy) { buckets.vencidas.push(g); return; }
    if (g.fechaRevision === hoy) { buckets.hoy.push(g); return; }
    if (g.fechaRevision <= en7iso) { buckets.proximos7.push(g); return; }
  });

  const byFecha = (a, b) => (a.fechaRevision || '').localeCompare(b.fechaRevision || '');
  buckets.hoy.sort(byFecha);
  buckets.proximos7.sort(byFecha);
  buckets.vencidas.sort(byFecha);
  buckets.enEspera.sort(byFecha);

  return buckets;
}

function workCardHtml(g) {
  return `<div class="work-card" data-causa-id="${g.causaId || g.causa.id}">
    <div class="work-card-top">
      ${g.prioridad ? `<span class="stamp ${priorClass(g.prioridad)}">${escapeHtml(g.prioridad)}</span>` : ''}
      <span class="stamp evento-estado-${gestionEstadoClass(g.estado)}">${escapeHtml(g.estado)}</span>
      ${g.fechaRevision ? `<span class="work-fecha">${escapeHtml(fmtFechaSolo(g.fechaRevision))}</span>` : ''}
    </div>
    <div class="work-desc">${escapeHtml(g.descripcion)}</div>
    <div class="work-meta">${escapeHtml(causaShortLabel(g.causa))}${caratuladoTexto(g.causa) ? ' · ' + escapeHtml(caratuladoTexto(g.causa)) : ''}</div>
  </div>`;
}

function workBucketHtml(title, items, emptyMsg) {
  return `
  <div class="work-bucket">
    <div class="work-bucket-h">${title} <span class="n">${items.length}</span></div>
    ${items.length ? `<div class="work-grid">${items.map(workCardHtml).join('')}</div>` : `<div class="dash-empty">${emptyMsg}</div>`}
  </div>`;
}

function renderCentroTrabajo() {
  const b = centroTrabajoBuckets();
  const container = document.getElementById('list-container');
  container.innerHTML = `
    <div class="section-title">Centro de Trabajo</div>
    <div style="color:var(--ink-dim); font-size:12.5px; margin:-6px 0 18px;">¿Qué debo hacer hoy? — reúne automáticamente las gestiones pendientes de todas tus causas.</div>
    ${workBucketHtml('Hoy', b.hoy, 'No tienes gestiones para revisar hoy.')}
    ${workBucketHtml('Próximos 7 días', b.proximos7, 'Nada programado para los próximos 7 días.')}
    ${workBucketHtml('En espera', b.enEspera, 'No hay gestiones en espera.')}
    ${workBucketHtml('Vencidas', b.vencidas, 'No tienes gestiones vencidas. Al día 🎉')}
    ${workBucketHtml('Sin fecha', b.sinFecha, 'No hay gestiones sin fecha de revisión.')}
  `;
  container.querySelectorAll('[data-causa-id]').forEach(el => {
    el.addEventListener('click', () => {
      currentCat = 'todas';
      render();
      openDetail(el.dataset.causaId, 'gestiones');
    });
  });
}

// ============================================================================
// REVISIÓN PJUD — control interno, no genera gestiones ni eventos
// ============================================================================

// ============================================================================
// ============================================================================
// PROGRAMACIÓN DE SALAS — control periódico de causas con recurso de
// apelación, para decidir si aparecen en tabla de alegatos. Control
// independiente de Revisión PJUD: no comparte checkbox ni fecha de revisión.
// ============================================================================
let programacionSalasFiltro = 'todas'; // todas | pendientes | revisadas | entabla | vistas
let programacionSalasBusqueda = '';
let programacionSalasHistorialAbierto = null; // id de causa con historial expandido

const SALA_RESULTADO_OPCIONES = ['Sin programación', 'En tabla', 'Suspendida', 'Reprogramada', 'Vista', 'Otro'];

function causasConApelacion() {
  return CAUSAS.filter(c => esRecursoApelacion(c.recurso));
}

function historialSalaPorCausa(causaId) {
  return REVISIONES_SALA
    .filter(r => r.causaId === causaId)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// El período de revisión comienza cada viernes (ver periodicidad: viernes y
// sábado después de las 17:00). Devuelve la fecha ISO del viernes más
// reciente (hoy mismo si hoy es viernes).
function calcularInicioPeriodoActual(ref) {
  const d = ref ? new Date(ref) : new Date();
  d.setHours(0, 0, 0, 0);
  const dia = d.getDay(); // 0=domingo … 5=viernes … 6=sábado
  const diffAlViernes = (dia - 5 + 7) % 7;
  d.setDate(d.getDate() - diffAlViernes);
  return toISO(d);
}

const SALA_RESULTADO_A_ESTADO = {
  'Sin programación': 'sin-programacion', 'En tabla': 'en-tabla', 'Suspendida': 'suspendida',
  'Reprogramada': 'reprogramada', 'Otro': 'otro'
};

// Determina el estado de revisión de una causa: nunca borra la fecha/resultado
// histórico — solo vuelve a "pendiente" cuando corresponde un nuevo período,
// salvo que el último resultado sea "Vista" (deja de pedir revisión semanal).
function estadoRevisionSala(causa) {
  const historial = historialSalaPorCausa(causa.id);
  const ultima = historial[0] || null;
  if (!ultima) return { estado: 'pendiente', ultima: null, historial };
  if (ultima.resultado === 'Vista') return { estado: 'vista', ultima, historial };
  const inicioPeriodo = calcularInicioPeriodoActual();
  if (ultima.fecha < inicioPeriodo) return { estado: 'pendiente', ultima, historial };
  return { estado: SALA_RESULTADO_A_ESTADO[ultima.resultado] || 'sin-programacion', ultima, historial };
}

const SALA_ESTADO_LABEL = {
  'pendiente': 'Pendiente de revisión', 'en-tabla': 'En tabla', 'suspendida': 'Suspendida',
  'reprogramada': 'Reprogramada', 'vista': 'Vista', 'otro': 'Otro', 'sin-programacion': 'Sin programación'
};
const SALA_ESTADO_CLASE = {
  'pendiente': 'semi', 'en-tabla': 'urgente', 'suspendida': 'noprior', 'reprogramada': 'semi',
  'vista': 'calm-estado', 'otro': 'noprior', 'sin-programacion': 'noprior'
};

function salaCardHtml(c) {
  const { estado, ultima, historial } = estadoRevisionSala(c);
  const tribunal = tribunalTexto(c);
  const caratulado = caratuladoTexto(c);
  const historialAbierto = programacionSalasHistorialAbierto === c.id;

  return `<div class="sala-card" data-causa-id="${c.id}">
    <div class="sala-card-top">
      <div>
        <div class="sala-rol">${escapeHtml(c.rol || causaShortLabel(c))}${c.rolIngreso ? ` · Corte: ${escapeHtml(c.rolIngreso)}` : ''}</div>
        <div class="sala-caratulado">${escapeHtml(caratulado || c.titulo)}</div>
        <div class="ficha-empty" style="color:var(--ink-faint);">${tribunal ? escapeHtml(tribunal) + ' · ' : ''}${escapeHtml(c.recurso || '')}</div>
      </div>
      <span class="stamp evento-estado-${SALA_ESTADO_CLASE[estado]}" style="${estado === 'pendiente' ? 'border-color:var(--semi); color:var(--semi);' : ''}">${SALA_ESTADO_LABEL[estado]}</span>
    </div>

    <div class="sala-meta">
      Última revisión: ${ultima ? `${escapeHtml(fmtFechaSolo(ultima.fecha))}${ultima.hora ? ' ' + escapeHtml(ultima.hora) : ''} — ${escapeHtml(ultima.resultado)}` : 'Sin revisiones registradas'}
      ${ultima && ultima.observacion ? `<div class="ficha-empty" style="color:var(--ink-faint); margin-top:2px;">${escapeHtml(ultima.observacion)}</div>` : ''}
      ${ultima && ultima.resultado === 'En tabla' && (ultima.fechaAlegato || ultima.sala || ultima.numeroTabla) ? `<div class="ficha-empty" style="color:var(--ink-faint); margin-top:2px;">${[ultima.fechaAlegato ? 'Alegato: ' + fmtFechaSolo(ultima.fechaAlegato) : '', ultima.sala ? 'Sala ' + ultima.sala : '', ultima.numeroTabla ? 'Tabla N° ' + ultima.numeroTabla : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>` : ''}
    </div>

    <div class="gestion-actions">
      <button data-action="marcar-revisado-sala" data-id="${c.id}">Marcar revisado</button>
      ${historial.length ? `<button data-action="toggle-historial-sala" data-id="${c.id}">${historialAbierto ? 'Ocultar historial' : `Ver historial (${historial.length})`}</button>` : ''}
      ${ultima && ultima.resultado === 'En tabla' && ultima.fechaAlegato ? `<button data-action="agregar-alegato-agenda" data-id="${c.id}" data-revision-id="${ultima.id}">Agregar alegato a Agenda</button>` : ''}
    </div>

    <div id="sala-form-${c.id}" class="agenda-form-wrap" hidden></div>

    ${historialAbierto ? `<div class="sala-historial">
      ${historial.map(r => `<div class="sala-historial-item">
        <strong>${escapeHtml(fmtFechaSolo(r.fecha))}${r.hora ? ' ' + escapeHtml(r.hora) : ''}</strong> — ${escapeHtml(r.resultado)}
        ${r.observacion ? `<div class="ficha-empty" style="color:var(--ink-faint);">${escapeHtml(r.observacion)}</div>` : ''}
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}

function salaFormHtml(c) {
  const { ultima } = estadoRevisionSala(c);
  return `<div class="agenda-form">
    <div class="form-grid2">
      <div>
        <label>Resultado</label>
        <select id="sf-resultado-${c.id}">
          ${SALA_RESULTADO_OPCIONES.map(o => `<option value="${o}" ${(!ultima && o === 'Sin programación') || (ultima && ultima.resultado === o) ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>
      <div id="sf-entabla-wrap-${c.id}" style="display:none;">
        <label>N° de tabla</label>
        <input type="text" id="sf-numerotabla-${c.id}" value="${escapeHtml(ultima?.numeroTabla || '')}">
      </div>
    </div>
    <div class="form-grid2" id="sf-entabla-wrap2-${c.id}" style="display:none;">
      <div>
        <label>Fecha de alegato</label>
        <input type="date" id="sf-fechaalegato-${c.id}" value="${escapeHtml(ultima?.fechaAlegato || '')}">
      </div>
      <div>
        <label>Sala</label>
        <input type="text" id="sf-sala-${c.id}" value="${escapeHtml(ultima?.sala || '')}">
      </div>
    </div>
    <div>
      <label>Observación</label>
      <textarea id="sf-observacion-${c.id}" placeholder="Opcional">${escapeHtml(ultima?.observacion || '')}</textarea>
    </div>
    <div style="display:flex; gap:8px;">
      <button class="btn primary" data-action="guardar-revision-sala" data-id="${c.id}" type="button">Guardar revisión</button>
      <button class="btn ghost" data-action="cancelar-revision-sala" data-id="${c.id}" type="button">Cancelar</button>
    </div>
  </div>`;
}

function renderProgramacionSalas() {
  const container = document.getElementById('list-container');
  const todas = causasConApelacion();

  const conEstado = todas.map(c => ({ c, ...estadoRevisionSala(c) }));
  const apelacionesActivas = todas.length;
  const pendientes = conEstado.filter(x => x.estado === 'pendiente').length;
  const enTabla = conEstado.filter(x => x.estado === 'en-tabla').length;
  const vistas = conEstado.filter(x => x.estado === 'vista').length;

  let filtradas = conEstado;
  if (programacionSalasFiltro === 'pendientes') filtradas = filtradas.filter(x => x.estado === 'pendiente');
  else if (programacionSalasFiltro === 'revisadas') filtradas = filtradas.filter(x => x.estado !== 'pendiente');
  else if (programacionSalasFiltro === 'entabla') filtradas = filtradas.filter(x => x.estado === 'en-tabla');
  else if (programacionSalasFiltro === 'vistas') filtradas = filtradas.filter(x => x.estado === 'vista');

  if (programacionSalasBusqueda.trim()) {
    const q = programacionSalasBusqueda.trim().toLowerCase();
    filtradas = filtradas.filter(x => [x.c.rol, x.c.rolIngreso, caratuladoTexto(x.c), tribunalTexto(x.c)].filter(Boolean).join(' ').toLowerCase().includes(q));
  }

  const filtrosOpciones = [
    ['todas', 'Todas'], ['pendientes', 'Pendientes de revisión'], ['revisadas', 'Revisadas'],
    ['entabla', 'En tabla'], ['vistas', 'Vistas']
  ];

  container.innerHTML = `
    <div class="section-title">Programación de salas</div>
    <div style="color:var(--ink-dim); font-size:12.5px; margin:-6px 0 18px;">
      Causas con recurso de apelación que deben revisarse periódicamente (viernes y sábado, después de las 17:00) para determinar si aparecen en tabla de alegatos. Se alimenta automáticamente de Antecedentes → Recurso; no modifica la tramitación, la Agenda ni el Centro de Trabajo.
    </div>

    <div class="stats-row sala-stats-row">
      <div class="stat-card"><div class="num">${apelacionesActivas}</div><div class="lbl">Apelaciones activas</div></div>
      <div class="stat-card semi"><div class="num">${pendientes}</div><div class="lbl">Pendientes de revisión</div></div>
      <div class="stat-card urgent"><div class="num">${enTabla}</div><div class="lbl">En tabla</div></div>
      <div class="stat-card calm"><div class="num">${vistas}</div><div class="lbl">Vistas</div></div>
    </div>

    <div class="agenda-toolbar" style="flex-wrap:wrap; gap:8px;">
      ${filtrosOpciones.map(([v, l]) => `<button class="btn small ${programacionSalasFiltro === v ? 'primary' : ''}" data-sala-filtro="${v}">${l}</button>`).join('')}
      <input type="text" id="sala-buscador" placeholder="Buscar por ROL, ROL Corte, caratulado o tribunal…" value="${escapeHtml(programacionSalasBusqueda)}" style="flex:1; min-width:220px; margin-left:auto;">
    </div>

    ${todas.length === 0
      ? `<div class="empty-msg">No hay causas con recurso de apelación registrado. Se agregan automáticamente cuando el campo "Recurso" en Antecedentes indica una apelación.</div>`
      : filtradas.length === 0
        ? `<div class="empty-msg">Ninguna causa coincide con este filtro o búsqueda.</div>`
        : `<div class="gestion-list" style="margin-top:14px;">${filtradas.map(x => salaCardHtml(x.c)).join('')}</div>`
    }
  `;

  wireProgramacionSalas(container);
}

function wireProgramacionSalas(container) {
  container.querySelectorAll('[data-sala-filtro]').forEach(btn => {
    btn.addEventListener('click', () => { programacionSalasFiltro = btn.dataset.salaFiltro; renderProgramacionSalas(); });
  });
  const buscador = container.querySelector('#sala-buscador');
  if (buscador) {
    buscador.addEventListener('input', () => { programacionSalasBusqueda = buscador.value; });
    buscador.addEventListener('keydown', e => { if (e.key === 'Enter') renderProgramacionSalas(); });
    buscador.addEventListener('blur', () => renderProgramacionSalas());
  }

  container.querySelectorAll('[data-action="toggle-historial-sala"]').forEach(btn => {
    btn.addEventListener('click', () => {
      programacionSalasHistorialAbierto = programacionSalasHistorialAbierto === btn.dataset.id ? null : btn.dataset.id;
      renderProgramacionSalas();
    });
  });

  container.querySelectorAll('[data-action="marcar-revisado-sala"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const causa = CAUSAS.find(c => c.id === btn.dataset.id);
      const wrap = container.querySelector(`#sala-form-${btn.dataset.id}`);
      if (!causa || !wrap) return;
      wrap.innerHTML = salaFormHtml(causa);
      wrap.hidden = false;
      wireSalaForm(container, wrap, causa);
    });
  });

  container.querySelectorAll('[data-action="agregar-alegato-agenda"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const causa = CAUSAS.find(c => c.id === btn.dataset.id);
      const revision = REVISIONES_SALA.find(r => r.id === btn.dataset.revisionId);
      if (!causa || !revision || !revision.fechaAlegato) return;
      const detalle = [revision.sala ? `Sala ${revision.sala}` : '', revision.numeroTabla ? `Tabla N° ${revision.numeroTabla}` : ''].filter(Boolean).join(' · ');
      const patch = {
        tipo: 'Audiencia',
        titulo: `Alegato — ${causa.rol || causaShortLabel(causa)}`,
        descripcion: detalle || null,
        fecha: revision.fechaAlegato,
        estado: 'Confirmado',
        creadoPor: (CURRENT_USER && (CURRENT_USER.nombre || CURRENT_USER.email)) || null
      };
      try {
        const nuevo = await api.createAgendaEvento(CURRENT_USER.id, causa.id, patch);
        causa.agendaEventos = causa.agendaEventos || [];
        causa.agendaEventos.push(nuevo);
        toast('Alegato agregado a la Agenda');
        intentarSincronizarEventoGoogle(nuevo, () => {});
      } catch (e) { toast('No se pudo agregar a la Agenda: ' + e.message); }
    });
  });
}

function wireSalaForm(container, wrap, causa) {
  const id = causa.id;
  const resultadoSel = wrap.querySelector(`#sf-resultado-${id}`);
  const entablaWrap1 = wrap.querySelector(`#sf-entabla-wrap-${id}`);
  const entablaWrap2 = wrap.querySelector(`#sf-entabla-wrap2-${id}`);

  function actualizarVisibilidadEnTabla() {
    const esEnTabla = resultadoSel.value === 'En tabla';
    entablaWrap1.style.display = esEnTabla ? '' : 'none';
    entablaWrap2.style.display = esEnTabla ? '' : 'none';
  }
  actualizarVisibilidadEnTabla();
  resultadoSel.addEventListener('change', actualizarVisibilidadEnTabla);

  wrap.querySelector('[data-action="cancelar-revision-sala"]').addEventListener('click', () => {
    wrap.hidden = true; wrap.innerHTML = '';
  });

  wrap.querySelector('[data-action="guardar-revision-sala"]').addEventListener('click', async () => {
    const ahora = new Date();
    const patch = {
      fecha: todayISO(),
      hora: `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`,
      resultado: resultadoSel.value,
      observacion: wrap.querySelector(`#sf-observacion-${id}`).value.trim() || null,
      fechaAlegato: resultadoSel.value === 'En tabla' ? (wrap.querySelector(`#sf-fechaalegato-${id}`).value || null) : null,
      sala: resultadoSel.value === 'En tabla' ? (wrap.querySelector(`#sf-sala-${id}`).value.trim() || null) : null,
      numeroTabla: resultadoSel.value === 'En tabla' ? (wrap.querySelector(`#sf-numerotabla-${id}`).value.trim() || null) : null
    };
    try {
      const nueva = await api.createRevisionSala(CURRENT_USER.id, id, patch);
      REVISIONES_SALA.unshift(nueva);
      toast('Revisión registrada');
      renderProgramacionSalas();
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });
}


// ADMINISTRACIÓN DE RECEPTORES — catálogo, turnos e importación de PDF/CSV
// ============================================================================
let receptoresAdminTab = 'receptores';
let receptoresSeleccionados = new Set();
let turnosSeleccionados = new Set();
let importPreviewRows = [];
let importFormato = 'csv-turno'; // 'csv-turno' | 'pdf-listado' | 'pdf-turno-mensual'
let importLineasPdf = []; // líneas reconstruidas del último PDF leído, para poder reprocesar si se corrige el tipo

function normalizarTexto(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function encontrarOCrearReceptorLocal(nombre) {
  const norm = normalizarTexto(nombre);
  return RECEPTORES.find(r => normalizarTexto(r.nombreCompleto) === norm) || null;
}

// ---------- Sub-vista: catálogo de receptores ----------
function receptorCardHtml(r) {
  return `<div class="receptor-card" data-receptor-id="${r.id}">
    <div class="receptor-card-top">
      <label style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer;">
        <input type="checkbox" class="receptor-check" data-id="${r.id}" ${receptoresSeleccionados.has(r.id) ? 'checked' : ''}>
        <strong>${escapeHtml(r.nombreCompleto)}</strong>
      </label>
      <span class="stamp evento-estado-${r.activo ? 'calm-estado' : 'noprior'}">${r.activo ? 'Activo' : 'Inactivo'}</span>
    </div>
    <div class="gestion-meta">
      ${r.telefono ? `<span>${escapeHtml(r.telefono)}</span>` : ''}
      ${r.correo ? `<span>${escapeHtml(r.correo)}</span>` : ''}
      ${r.jurisdiccion ? `<span>${escapeHtml(r.jurisdiccion)}</span>` : ''}
    </div>
    ${r.domicilio ? `<div class="gestion-meta">${escapeHtml(r.domicilio)}</div>` : ''}
    ${r.fuenteOficial ? `<div class="ficha-empty" style="color:var(--ink-faint);">Fuente: ${escapeHtml(r.fuenteOficial)}</div>` : ''}
    <div class="gestion-actions">
      <button data-action="edit-receptor" data-id="${r.id}">Editar</button>
      <button data-action="toggle-receptor" data-id="${r.id}">${r.activo ? 'Marcar inactivo' : 'Marcar activo'}</button>
      <button data-action="delete-receptor" data-id="${r.id}" style="border-color:var(--urgent); color:var(--urgent);">Eliminar</button>
    </div>
  </div>`;
}

function receptorFormHtml(r) {
  const e = r || {};
  return `
  <div class="agenda-form">
    <div class="subhead" style="margin-top:0;">${r ? 'Editar receptor' : 'Nuevo receptor'}</div>
    <div><label>Nombre completo</label><input type="text" id="rf-nombre" value="${escapeHtml(e.nombreCompleto || '')}"></div>
    <div class="form-grid2">
      <div><label>Teléfono</label><input type="text" id="rf-telefono" value="${escapeHtml(e.telefono || '')}"></div>
      <div><label>Correo</label><input type="text" id="rf-correo" value="${escapeHtml(e.correo || '')}"></div>
    </div>
    <div><label>Domicilio</label><input type="text" id="rf-domicilio" value="${escapeHtml(e.domicilio || '')}"></div>
    <div class="form-grid2">
      <div><label>Jurisdicción</label><input type="text" id="rf-jurisdiccion" value="${escapeHtml(e.jurisdiccion || '')}" placeholder="Ej: Santiago"></div>
      <div><label>Materia / ámbito</label><input type="text" id="rf-materia" value="${escapeHtml(e.materia || 'Civil')}"></div>
    </div>
    <div class="form-grid2">
      <div><label>Fuente oficial</label><input type="text" id="rf-fuente" value="${escapeHtml(e.fuenteOficial || '')}"></div>
      <div><label>Activo</label>
        <select id="rf-activo">
          <option value="true" ${e.activo !== false ? 'selected' : ''}>Activo</option>
          <option value="false" ${e.activo === false ? 'selected' : ''}>Inactivo</option>
        </select>
      </div>
    </div>
    <div><label>Observaciones</label><textarea id="rf-observaciones">${escapeHtml(e.observaciones || '')}</textarea></div>
    <div style="display:flex; gap:8px;">
      <button class="btn primary" id="save-receptor" type="button">Guardar receptor</button>
      <button class="btn ghost" id="cancel-receptor" type="button">Cancelar</button>
    </div>
  </div>`;
}

function bulkSelectBarHtml(seleccionados, total, tipo) {
  const n = seleccionados.size;
  return `<div class="bulk-bar">
    <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
      <input type="checkbox" id="select-all-${tipo}" ${total > 0 && n === total ? 'checked' : ''}>
      Seleccionar todos
    </label>
    <span class="bulk-counter">${n} seleccionado${n === 1 ? '' : 's'}</span>
    <button class="btn small" id="delete-selected-${tipo}" ${n === 0 ? 'disabled' : ''} style="border-color:var(--urgent); color:var(--urgent);">Eliminar seleccionados</button>
  </div>`;
}

function renderReceptoresTab() {
  // Limpia selecciones de receptores que ya no existen en la lista
  receptoresSeleccionados.forEach(id => { if (!RECEPTORES.find(r => r.id === id)) receptoresSeleccionados.delete(id); });

  const activos = RECEPTORES.filter(r => r.activo);
  const inactivos = RECEPTORES.filter(r => !r.activo);
  let html = `<div class="agenda-toolbar"><button class="btn small primary" id="add-receptor">+ Nuevo receptor</button></div>
  <div id="receptor-form-wrap" class="agenda-form-wrap" hidden></div>`;
  if (RECEPTORES.length === 0) {
    html += `<div class="empty-msg">Aún no hay receptores en el catálogo. Agrega uno manualmente o usa "Importar PDF / CSV".</div>`;
  } else {
    html += bulkSelectBarHtml(receptoresSeleccionados, RECEPTORES.length, 'receptores');
    html += `<div class="gestion-list">${activos.map(receptorCardHtml).join('')}${inactivos.map(receptorCardHtml).join('')}</div>`;
  }
  return html;
}

function wireReceptoresTab(container) {
  const formWrap = container.querySelector('#receptor-form-wrap');
  function closeForm() { formWrap.hidden = true; formWrap.innerHTML = ''; }
  function openForm(r) {
    formWrap.innerHTML = receptorFormHtml(r);
    formWrap.hidden = false;
    formWrap.querySelector('#cancel-receptor').addEventListener('click', closeForm);
    formWrap.querySelector('#save-receptor').addEventListener('click', async () => {
      const patch = {
        nombreCompleto: formWrap.querySelector('#rf-nombre').value.trim(),
        telefono: formWrap.querySelector('#rf-telefono').value.trim() || null,
        correo: formWrap.querySelector('#rf-correo').value.trim() || null,
        domicilio: formWrap.querySelector('#rf-domicilio').value.trim() || null,
        jurisdiccion: formWrap.querySelector('#rf-jurisdiccion').value.trim() || null,
        materia: formWrap.querySelector('#rf-materia').value.trim() || 'Civil',
        fuenteOficial: formWrap.querySelector('#rf-fuente').value.trim() || null,
        activo: formWrap.querySelector('#rf-activo').value === 'true',
        observaciones: formWrap.querySelector('#rf-observaciones').value.trim() || null,
        fechaActualizacion: todayISO()
      };
      if (!patch.nombreCompleto) { toast('El receptor necesita un nombre'); return; }
      try {
        if (r) {
          const actualizado = await api.updateReceptor(r.id, patch);
          const idx = RECEPTORES.findIndex(x => x.id === r.id);
          if (idx >= 0) RECEPTORES[idx] = actualizado;
          toast('Receptor actualizado');
        } else {
          const nuevo = await api.createReceptor(CURRENT_USER.id, patch);
          RECEPTORES.unshift(nuevo);
          toast('Receptor agregado');
        }
        closeForm();
        renderReceptoresAdmin();
      } catch (e) { toast('No se pudo guardar: ' + e.message); }
    });
  }
  const addBtn = container.querySelector('#add-receptor');
  if (addBtn) addBtn.addEventListener('click', () => openForm(null));
  container.querySelectorAll('[data-action="edit-receptor"]').forEach(btn => {
    btn.addEventListener('click', () => openForm(RECEPTORES.find(r => r.id === btn.dataset.id)));
  });
  container.querySelectorAll('[data-action="toggle-receptor"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const r = RECEPTORES.find(x => x.id === btn.dataset.id);
      if (!r) return;
      try {
        const actualizado = await api.updateReceptor(r.id, { activo: !r.activo });
        Object.assign(r, actualizado);
        toast(r.activo ? 'Receptor marcado activo' : 'Receptor marcado inactivo');
        renderReceptoresAdmin();
      } catch (e) { toast('No se pudo actualizar: ' + e.message); }
    });
  });
  container.querySelectorAll('[data-action="delete-receptor"]').forEach(btn => {
    btn.addEventListener('click', () => eliminarReceptoresConVerificacion([btn.dataset.id]));
  });

  // ---------- Selección y eliminación masiva ----------
  container.querySelectorAll('.receptor-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) receptoresSeleccionados.add(chk.dataset.id);
      else receptoresSeleccionados.delete(chk.dataset.id);
      renderReceptoresAdmin();
    });
  });
  const selectAll = container.querySelector('#select-all-receptores');
  if (selectAll) selectAll.addEventListener('change', () => {
    if (selectAll.checked) RECEPTORES.forEach(r => receptoresSeleccionados.add(r.id));
    else receptoresSeleccionados.clear();
    renderReceptoresAdmin();
  });
  const deleteSelectedBtn = container.querySelector('#delete-selected-receptores');
  if (deleteSelectedBtn) deleteSelectedBtn.addEventListener('click', () => {
    eliminarReceptoresConVerificacion([...receptoresSeleccionados]);
  });
}

// Verifica si los receptores indicados están vinculados a encargos (que no
// deben perder su historial) antes de eliminar. Los turnos asociados sí se
// eliminan junto con el receptor (comportamiento ya existente y esperado).
async function eliminarReceptoresConVerificacion(ids) {
  if (ids.length === 0) return;

  const info = ids.map(id => {
    const r = RECEPTORES.find(x => x.id === id);
    const turnos = TURNOS.filter(t => t.receptorId === id).length;
    const encargos = ENCARGOS.filter(e => e.receptorSugeridoId === id || e.receptorConfirmadoId === id).length;
    return { id, nombre: r ? r.nombreCompleto : id, turnos, encargos };
  });

  const bloqueados = info.filter(i => i.encargos > 0);
  const permitidos = info.filter(i => i.encargos === 0);

  if (bloqueados.length > 0) {
    const detalle = bloqueados.map(b => `• ${b.nombre}: vinculado a ${b.encargos} encargo(s) receptor.`).join('\n');
    const mensaje = `Los siguientes receptores no se pueden eliminar porque están vinculados a encargos existentes (no se pierde el historial):\n\n${detalle}` +
      (permitidos.length > 0
        ? `\n\n¿Eliminar de todas formas los ${permitidos.length} receptor(es) restante(s) que no tienen relaciones? Los ${bloqueados.length} vinculados no se tocarán.`
        : `\n\nNinguno de los seleccionados se puede eliminar por ahora.`);
    if (permitidos.length === 0) { alert(mensaje); return; }
    if (!confirm(mensaje)) { toast('Eliminación cancelada'); return; }
  } else {
    const turnosTotal = info.reduce((sum, i) => sum + i.turnos, 0);
    const mensaje = `¿Eliminar ${permitidos.length} receptor(es)?` +
      (turnosTotal > 0 ? ` Se eliminarán también sus ${turnosTotal} turno(s) asociado(s).` : '') +
      ' Esta acción no se puede deshacer.';
    if (!confirm(mensaje)) { toast('Eliminación cancelada'); return; }
  }

  let eliminados = 0;
  for (const item of permitidos) {
    try {
      await api.deleteReceptor(item.id);
      RECEPTORES = RECEPTORES.filter(r => r.id !== item.id);
      TURNOS = TURNOS.filter(t => t.receptorId !== item.id);
      receptoresSeleccionados.delete(item.id);
      eliminados++;
    } catch (e) {
      toast(`No se pudo eliminar "${item.nombre}": ${e.message}`);
    }
  }
  if (eliminados > 0) toast(`${eliminados} receptor(es) eliminado(s).`);
  renderReceptoresAdmin();
}

// ---------- Sub-vista: turnos ----------
function turnoRowHtml(t) {
  return `<div class="pjud-row" data-turno-id="${t.id}" style="grid-template-columns:auto 1.6fr 1fr 1fr 1fr auto;">
    <div><input type="checkbox" class="turno-check" data-id="${t.id}" ${turnosSeleccionados.has(t.id) ? 'checked' : ''}></div>
    <div>${escapeHtml(t.receptor ? t.receptor.nombreCompleto : 'Receptor eliminado')}</div>
    <div>${escapeHtml(fmtFechaSolo(t.fechaInicio))} — ${escapeHtml(fmtFechaSolo(t.fechaFin))}</div>
    <div>${escapeHtml(t.jurisdiccion || '—')}</div>
    <div>${escapeHtml(t.fuenteOficial || '—')}</div>
    <div><button class="btn small" data-action="delete-turno" data-id="${t.id}" style="border-color:var(--urgent); color:var(--urgent);">Eliminar</button></div>
  </div>`;
}

function turnoFormHtml() {
  const opciones = RECEPTORES.filter(r => r.activo).map(r => `<option value="${r.id}">${escapeHtml(r.nombreCompleto)}</option>`).join('');
  return `
  <div class="agenda-form">
    <div class="subhead" style="margin-top:0;">Nuevo turno</div>
    <div><label>Receptor</label><select id="tf-receptor"><option value="">— Selecciona —</option>${opciones}</select></div>
    <div class="form-grid2">
      <div><label>Fecha inicio</label><input type="date" id="tf-inicio"></div>
      <div><label>Fecha fin</label><input type="date" id="tf-fin"></div>
    </div>
    <div class="form-grid2">
      <div><label>Jurisdicción</label><input type="text" id="tf-jurisdiccion" placeholder="Ej: Santiago"></div>
      <div><label>Materia</label><input type="text" id="tf-materia" value="Civil"></div>
    </div>
    <div><label>Fuente oficial</label><input type="text" id="tf-fuente" placeholder="Ej: PJUD — turnos julio 2026"></div>
    <div style="display:flex; gap:8px;">
      <button class="btn primary" id="save-turno" type="button">Guardar turno</button>
      <button class="btn ghost" id="cancel-turno" type="button">Cancelar</button>
    </div>
  </div>`;
}

function detectarSuperposicion(receptorId, fechaInicio, fechaFin, excluirId) {
  return TURNOS.filter(t => t.receptorId === receptorId && t.id !== excluirId)
    .some(t => fechaInicio <= t.fechaFin && fechaFin >= t.fechaInicio);
}

function renderTurnosTab() {
  turnosSeleccionados.forEach(id => { if (!TURNOS.find(t => t.id === id)) turnosSeleccionados.delete(id); });

  let html = `<div class="agenda-toolbar"><button class="btn small primary" id="add-turno">+ Nuevo turno</button></div>
  <div id="turno-form-wrap" class="agenda-form-wrap" hidden></div>`;
  if (TURNOS.length === 0) {
    html += `<div class="empty-msg">Aún no hay turnos cargados. Agrega uno manualmente o usa "Importar PDF / CSV".</div>`;
  } else {
    html += bulkSelectBarHtml(turnosSeleccionados, TURNOS.length, 'turnos');
    const ordenados = TURNOS.slice().sort((a, b) => b.fechaInicio.localeCompare(a.fechaInicio));
    html += `<div class="pjud-table">
      <div class="pjud-row pjud-head" style="grid-template-columns:auto 1.6fr 1fr 1fr 1fr auto;"><div></div><div>Receptor</div><div>Período</div><div>Jurisdicción</div><div>Fuente</div><div></div></div>
      ${ordenados.map(turnoRowHtml).join('')}
    </div>`;
  }
  return html;
}

function wireTurnosTab(container) {
  const formWrap = container.querySelector('#turno-form-wrap');
  function closeForm() { formWrap.hidden = true; formWrap.innerHTML = ''; }
  const addBtn = container.querySelector('#add-turno');
  if (addBtn) addBtn.addEventListener('click', () => {
    formWrap.innerHTML = turnoFormHtml();
    formWrap.hidden = false;
    formWrap.querySelector('#cancel-turno').addEventListener('click', closeForm);
    formWrap.querySelector('#save-turno').addEventListener('click', async () => {
      const receptorId = formWrap.querySelector('#tf-receptor').value;
      const fechaInicio = formWrap.querySelector('#tf-inicio').value;
      const fechaFin = formWrap.querySelector('#tf-fin').value;
      if (!receptorId) { toast('Selecciona un receptor'); return; }
      if (!fechaInicio || !fechaFin) { toast('Ingresa fecha de inicio y fin'); return; }
      if (fechaFin < fechaInicio) { toast('La fecha final no puede ser anterior a la fecha inicial'); return; }
      if (detectarSuperposicion(receptorId, fechaInicio, fechaFin, null)) {
        if (!confirm('Este receptor ya tiene un turno que se superpone con estas fechas. ¿Guardar de todas formas?')) return;
      }
      try {
        const nuevo = await api.createTurno(CURRENT_USER.id, {
          receptorId, fechaInicio, fechaFin,
          jurisdiccion: formWrap.querySelector('#tf-jurisdiccion').value.trim() || null,
          materia: formWrap.querySelector('#tf-materia').value.trim() || 'Civil',
          fuenteOficial: formWrap.querySelector('#tf-fuente').value.trim() || null
        });
        TURNOS.unshift(nuevo);
        toast('Turno agregado');
        closeForm();
        renderReceptoresAdmin();
      } catch (e) { toast('No se pudo guardar: ' + e.message); }
    });
  });
  container.querySelectorAll('[data-action="delete-turno"]').forEach(btn => {
    btn.addEventListener('click', () => eliminarTurnosSeleccionados([btn.dataset.id]));
  });

  container.querySelectorAll('.turno-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) turnosSeleccionados.add(chk.dataset.id);
      else turnosSeleccionados.delete(chk.dataset.id);
      renderReceptoresAdmin();
    });
  });
  const selectAllTurnos = container.querySelector('#select-all-turnos');
  if (selectAllTurnos) selectAllTurnos.addEventListener('change', () => {
    if (selectAllTurnos.checked) TURNOS.forEach(t => turnosSeleccionados.add(t.id));
    else turnosSeleccionados.clear();
    renderReceptoresAdmin();
  });
  const deleteSelectedTurnos = container.querySelector('#delete-selected-turnos');
  if (deleteSelectedTurnos) deleteSelectedTurnos.addEventListener('click', () => {
    eliminarTurnosSeleccionados([...turnosSeleccionados]);
  });
}

// Elimina turnos seleccionados. No afecta la ficha del receptor ni los
// encargos históricos (el vínculo encargo → turno simplemente queda vacío).
async function eliminarTurnosSeleccionados(ids) {
  if (ids.length === 0) return;
  const mensaje = `¿Eliminar ${ids.length} turno(s) seleccionado(s)? Esta acción no se puede deshacer. Los receptores y los encargos ya confirmados no se ven afectados.`;
  if (!confirm(mensaje)) { toast('Eliminación cancelada'); return; }

  let eliminados = 0;
  for (const id of ids) {
    try {
      await api.deleteTurno(id);
      TURNOS = TURNOS.filter(t => t.id !== id);
      turnosSeleccionados.delete(id);
      eliminados++;
    } catch (e) {
      toast(`No se pudo eliminar un turno: ${e.message}`);
    }
  }
  if (eliminados > 0) toast(`${eliminados} turno(s) eliminado(s).`);
  renderReceptoresAdmin();
}

// ---------- Sub-vista: importar PDF / CSV ----------
const FUENTE_TURNOS_URL = 'https://cloud.pjud.cl/index.php/s/NwN43ExL6nQMxjr';
const FUENTE_CONTACTO_URL = 'https://cortesantiago.cl/listado-receptores-judiciales-santiago/#page-content';

function renderImportarTab() {
  return `
  <div class="import-box">
    <p style="font-size:12.5px; color:var(--ink-dim);">
      Sube el PDF oficial de la Corte de Apelaciones de Santiago (listado de receptores o turno mensual),
      o un archivo CSV/TXT. La aplicación intenta detectar automáticamente el tipo de documento — siempre
      puedes corregirlo manualmente. Nada se guarda sin tu confirmación en la vista previa.
    </p>
    <p style="font-size:11.5px; color:var(--ink-faint);">
      Formato CSV/TXT alternativo (columnas): <code>nombre,telefono,correo,domicilio,jurisdiccion,fecha_inicio,fecha_fin</code>
      (fechas en AAAA-MM-DD).
    </p>
    <p style="font-size:11.5px; color:var(--ink-faint);">
      Fuentes oficiales de referencia: <a href="${FUENTE_TURNOS_URL}" target="_blank" rel="noopener">turnos de receptores (PJUD)</a> ·
      <a href="${FUENTE_CONTACTO_URL}" target="_blank" rel="noopener">datos de contacto (Corte de Santiago)</a>.
    </p>
    <div class="import-dropzone" id="import-dropzone">
      <input type="file" id="import-file" accept=".pdf,.csv,.txt" hidden>
      <div>Arrastra aquí el PDF o CSV, o <button class="btn small" id="import-browse" type="button">elegir archivo</button></div>
    </div>
    <div id="import-status" style="font-size:12px; color:var(--ink-faint); margin-top:8px;"></div>
    <div id="import-preview-wrap" style="margin-top:16px;"></div>
  </div>`;
}

function previewFilaTurnoFechaHtml(row, idx) {
  const incompleta = row.incompleta || !row.nombre || !row.fechaInicio || !row.fechaFin;
  return `<div class="pjud-row import-preview-row ${incompleta ? 'import-row-incompleta' : ''}" data-preview-idx="${idx}" style="grid-template-columns:auto 1.4fr 1fr 1fr 1fr auto;">
    <div>${incompleta ? '<span class="stamp evento-estado-noprior" style="border-color:var(--urgent); color:var(--urgent);">Revisar</span>' : '<span class="stamp evento-estado-calm-estado">OK</span>'}</div>
    <div><input type="text" class="ip-nombre" value="${escapeHtml(row.nombre || '')}" placeholder="Nombre del receptor"></div>
    <div><input type="date" class="ip-inicio" value="${escapeHtml(row.fechaInicio || '')}"></div>
    <div><input type="date" class="ip-fin" value="${escapeHtml(row.fechaFin || '')}"></div>
    <div><input type="text" class="ip-jurisdiccion" value="${escapeHtml(row.jurisdiccion || '')}" placeholder="Jurisdicción / observación"></div>
    <div><button class="btn small" data-action="quitar-fila-preview" data-idx="${idx}" style="border-color:var(--urgent); color:var(--urgent);">Quitar</button></div>
  </div>`;
}

function previewFilaListadoHtml(row, idx) {
  const incompleta = row.incompleta || !row.nombre;
  const estado = incompleta ? 'Incompleta' : ((row.telefono || row.celular || row.correo) ? 'Correcta' : 'Revisar');
  return `<div class="pjud-row import-preview-row ${incompleta ? 'import-row-incompleta' : ''}" data-preview-idx="${idx}" style="grid-template-columns:auto 1.2fr 1.3fr .9fr .9fr 1.1fr auto;">
    <div><span class="stamp evento-estado-${incompleta ? 'noprior' : 'calm-estado'}" ${incompleta ? 'style="border-color:var(--urgent); color:var(--urgent);"' : ''}>${estado}</span></div>
    <div><input type="text" class="il-nombre" value="${escapeHtml(row.nombre || '')}" placeholder="Nombre completo"></div>
    <div><input type="text" class="il-domicilio" value="${escapeHtml(row.domicilio || '')}" placeholder="Domicilio"></div>
    <div><input type="text" class="il-telefono" value="${escapeHtml(row.telefono || '')}" placeholder="Teléfono"></div>
    <div><input type="text" class="il-celular" value="${escapeHtml(row.celular || '')}" placeholder="Celular"></div>
    <div><input type="text" class="il-correo" value="${escapeHtml(row.correo || '')}" placeholder="Correo"></div>
    <div><button class="btn small" data-action="quitar-fila-preview" data-idx="${idx}" style="border-color:var(--urgent); color:var(--urgent);">Quitar</button></div>
  </div>`;
}

function previewFilaTurnoMensualHtml(row, idx) {
  const incompleta = row.incompleta || !row.receptor;
  return `<div class="pjud-row import-preview-row ${incompleta ? 'import-row-incompleta' : ''}" data-preview-idx="${idx}" style="grid-template-columns:auto .8fr .6fr 1.2fr 1.2fr 1.2fr auto;">
    <div>${incompleta ? '<span class="stamp evento-estado-noprior" style="border-color:var(--urgent); color:var(--urgent);">Revisar</span>' : '<span class="stamp evento-estado-calm-estado">OK</span>'}</div>
    <div><input type="text" class="it-mes" value="${escapeHtml(row.mes || '')}" placeholder="Mes"></div>
    <div><input type="text" class="it-anio" value="${escapeHtml(row.anio || '')}" placeholder="Año"></div>
    <div><input type="text" class="it-tribunal" value="${escapeHtml(row.tribunal || '')}" placeholder="Tribunal"></div>
    <div><input type="text" class="it-receptor" value="${escapeHtml(row.receptor || '')}" placeholder="Receptor"></div>
    <div><input type="text" class="it-correo" value="${escapeHtml(row.correo || '')}" placeholder="Correo"></div>
    <div><button class="btn small" data-action="quitar-fila-preview" data-idx="${idx}" style="border-color:var(--urgent); color:var(--urgent);">Quitar</button></div>
  </div>`;
}

const IMPORT_FORMATOS_META = {
  'csv-turno': { headers: ['Estado', 'Nombre', 'Inicio', 'Fin', 'Jurisdicción', ''], render: previewFilaTurnoFechaHtml, cols: 'auto 1.4fr 1fr 1fr 1fr auto' },
  'pdf-listado': { headers: ['Estado', 'Nombre', 'Domicilio', 'Teléfono', 'Celular', 'Correo', ''], render: previewFilaListadoHtml, cols: 'auto 1.2fr 1.3fr .9fr .9fr 1.1fr auto' },
  'pdf-turno-mensual': { headers: ['Estado', 'Mes', 'Año', 'Tribunal', 'Receptor', 'Correo', ''], render: previewFilaTurnoMensualHtml, cols: 'auto .8fr .6fr 1.2fr 1.2fr 1.2fr auto' }
};

function selectorTipoDocumentoHtml() {
  if (importLineasPdf.length === 0) return '';
  return `<div style="margin:10px 0;">
    <label style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-faint); display:block; margin-bottom:4px;">Tipo de documento detectado</label>
    <select id="import-tipo-doc">
      <option value="pdf-listado" ${importFormato === 'pdf-listado' ? 'selected' : ''}>Listado de receptores</option>
      <option value="pdf-turno-mensual" ${importFormato === 'pdf-turno-mensual' ? 'selected' : ''}>Turno mensual (juzgados civiles)</option>
    </select>
  </div>`;
}

function renderImportPreview(container, archivoNombre) {
  const wrap = container.querySelector('#import-preview-wrap');
  const meta = IMPORT_FORMATOS_META[importFormato];
  const selectorHtml = selectorTipoDocumentoHtml();

  if (importPreviewRows.length === 0) {
    wrap.innerHTML = `${selectorHtml}<div class="empty-msg">No se detectaron filas. Agrega una manualmente para continuar.</div>
      <div class="agenda-toolbar" style="margin-top:10px;"><button class="btn small" id="import-add-row" type="button">+ Agregar fila manual</button></div>`;
  } else {
    const completas = importPreviewRows.filter(r => !r.incompleta).length;
    wrap.innerHTML = `
      ${selectorHtml}
      <div class="subhead">Vista previa — revisa y corrige antes de confirmar</div>
      <div style="font-size:11.5px; color:var(--ink-faint); margin-bottom:8px;">
        ${importPreviewRows.length} fila(s) en total · ${completas} completa(s) · ${importPreviewRows.length - completas} requieren revisión (marcadas en rojo).
      </div>
      <div class="pjud-table">
        <div class="pjud-row pjud-head" style="grid-template-columns:${meta.cols};">${meta.headers.map(h => `<div>${h}</div>`).join('')}</div>
        ${importPreviewRows.map(meta.render).join('')}
      </div>
      <div class="agenda-toolbar" style="margin-top:10px;">
        <button class="btn small" id="import-add-row" type="button">+ Agregar fila manual</button>
        <button class="btn small primary" id="import-confirm" type="button">Confirmar importación</button>
      </div>
      <div id="import-warnings" style="margin-top:8px;"></div>`;
  }
  wireImportPreview(container, archivoNombre);

  const tipoSel = wrap.querySelector('#import-tipo-doc');
  if (tipoSel) tipoSel.addEventListener('change', () => {
    reparsearPdfComoFormato(tipoSel.value);
    renderImportPreview(container, archivoNombre);
  });
}

function wireImportPreview(container, archivoNombre) {
  const wrap = container.querySelector('#import-preview-wrap');
  wrap.querySelectorAll('[data-action="quitar-fila-preview"]').forEach(btn => {
    btn.addEventListener('click', () => {
      importPreviewRows.splice(parseInt(btn.dataset.idx, 10), 1);
      renderImportPreview(container, archivoNombre);
    });
  });

  const addRowBtn = wrap.querySelector('#import-add-row');
  if (addRowBtn) addRowBtn.addEventListener('click', () => {
    const filaVacia = {
      'csv-turno': { nombre: '', fechaInicio: '', fechaFin: '', jurisdiccion: '', incompleta: true },
      'pdf-listado': { nombre: '', domicilio: '', telefono: '', celular: '', correo: '', incompleta: true },
      'pdf-turno-mensual': { mes: '', anio: '', tribunal: '', receptor: '', correo: '', incompleta: true }
    }[importFormato];
    importPreviewRows.push(filaVacia);
    renderImportPreview(container, archivoNombre);
  });

  // Marca cada fila como OK / Revisar en vivo mientras se corrige, sin
  // perder el foco del campo que se está editando.
  wrap.querySelectorAll('.import-preview-row').forEach(row => {
    const actualizarEstadoFila = () => {
      let ok;
      if (importFormato === 'csv-turno') {
        ok = !!(row.querySelector('.ip-nombre').value.trim() && row.querySelector('.ip-inicio').value && row.querySelector('.ip-fin').value);
      } else if (importFormato === 'pdf-listado') {
        ok = !!row.querySelector('.il-nombre').value.trim();
      } else {
        ok = !!row.querySelector('.it-receptor').value.trim();
      }
      row.classList.toggle('import-row-incompleta', !ok);
      const badgeCell = row.children[0];
      badgeCell.innerHTML = ok
        ? '<span class="stamp evento-estado-calm-estado">OK</span>'
        : '<span class="stamp evento-estado-noprior" style="border-color:var(--urgent); color:var(--urgent);">Revisar</span>';
    };
    row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', actualizarEstadoFila));
  });

  const confirmBtn = wrap.querySelector('#import-confirm');
  if (!confirmBtn) return;
  confirmBtn.addEventListener('click', async () => {
    if (importFormato === 'csv-turno') return confirmarImportacionTurnoFechas(container, wrap, archivoNombre);
    if (importFormato === 'pdf-listado') return confirmarImportacionListado(container, wrap, archivoNombre);
    return confirmarImportacionTurnoMensual(container, wrap, archivoNombre);
  });
}

async function confirmarImportacionTurnoFechas(container, wrap, archivoNombre) {
  wrap.querySelectorAll('[data-preview-idx]').forEach(row => {
    const idx = parseInt(row.dataset.previewIdx, 10);
    const nombre = row.querySelector('.ip-nombre').value.trim();
    const fechaInicio = row.querySelector('.ip-inicio').value;
    const fechaFin = row.querySelector('.ip-fin').value;
    importPreviewRows[idx] = {
      nombre, fechaInicio, fechaFin,
      jurisdiccion: row.querySelector('.ip-jurisdiccion').value.trim(),
      incompleta: !(nombre && fechaInicio && fechaFin)
    };
  });

  const errores = [];
  const validas = [];
  importPreviewRows.forEach((row, i) => {
    if (!row.nombre) { errores.push(`Fila ${i + 1}: falta el nombre del receptor.`); return; }
    if (!row.fechaInicio || !row.fechaFin) { errores.push(`Fila ${i + 1}: faltan fechas.`); return; }
    if (row.fechaFin < row.fechaInicio) { errores.push(`Fila ${i + 1}: la fecha final es anterior a la inicial.`); return; }
    validas.push(row);
  });

  const warningsEl = container.querySelector('#import-warnings');
  if (errores.length) {
    warningsEl.innerHTML = `<div class="ficha-empty" style="color:var(--urgent);">${errores.map(e => escapeHtml(e)).join('<br>')}</div>`;
    if (validas.length === 0) return;
    if (!confirm(`Hay ${errores.length} fila(s) con problemas que no se importarán. ¿Continuar con las ${validas.length} filas válidas?`)) return;
  }

  const confirmBtn = wrap.querySelector('#import-confirm');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Importando…'; }

  const resumen = await importarTurnosPorLotes(validas, archivoNombre, (procesadas, total) => {
    if (warningsEl) warningsEl.innerHTML = `<div class="ficha-empty" style="color:var(--ink-dim);">Importando… ${procesadas} de ${total} filas procesadas.</div>`;
  });

  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirmar importación'; }

  mostrarResumenImportacion(warningsEl, resumen, validas.length);
  toast(`Importación finalizada: ${resumen.turnosCreados} turno(s) guardado(s) de ${validas.length} fila(s) procesadas.`);
  importPreviewRows = [];
  renderReceptoresAdmin();
}

// Procesa TODAS las filas válidas, sin excepción, en lotes (para no saturar
// la conexión con cientos de solicitudes simultáneas) pero siempre de forma
// secuencial fila por fila dentro de cada lote — así dos filas que crean el
// mismo receptor nuevo nunca compiten entre sí y generan un duplicado.
// Ninguna fila detiene a las demás: los errores se registran y se continúa.
async function importarTurnosPorLotes(validas, archivoNombre, onProgreso) {
  const TAMANO_LOTE = 50;
  const resumen = {
    filasProcesadas: 0,
    receptoresCreados: 0,
    receptoresExistentes: 0,
    turnosCreados: 0,
    duplicadosOmitidos: 0,
    errores: []
  };

  for (let inicio = 0; inicio < validas.length; inicio += TAMANO_LOTE) {
    const lote = validas.slice(inicio, inicio + TAMANO_LOTE);

    for (const row of lote) {
      resumen.filasProcesadas++;
      try {
        // 1) Localizar o crear el receptor.
        let receptor = encontrarOCrearReceptorLocal(row.nombre);
        let esNuevo = false;
        if (!receptor) {
          receptor = await crearConReintento(() => api.createReceptor(CURRENT_USER.id, {
            nombreCompleto: row.nombre, jurisdiccion: row.jurisdiccion || null,
            materia: 'Civil', activo: true, fuenteOficial: archivoNombre, fechaActualizacion: todayISO()
          }));
          RECEPTORES.unshift(receptor);
          esNuevo = true;
        }
        if (esNuevo) resumen.receptoresCreados++; else resumen.receptoresExistentes++;

        // 2) Evitar duplicados: mismo receptor_id + fecha_inicio + fecha_fin
        // + jurisdicción ya guardado (incluye turnos de una importación
        // anterior, no solo los del archivo actual).
        const yaExiste = TURNOS.some(t =>
          t.receptorId === receptor.id &&
          t.fechaInicio === row.fechaInicio &&
          t.fechaFin === row.fechaFin &&
          normalizarTexto(t.jurisdiccion || '') === normalizarTexto(row.jurisdiccion || '')
        );
        if (yaExiste) { resumen.duplicadosOmitidos++; continue; }

        // 3) Crear el turno vinculado al receptor.
        const turno = await crearConReintento(() => api.createTurno(CURRENT_USER.id, {
          receptorId: receptor.id, fechaInicio: row.fechaInicio, fechaFin: row.fechaFin,
          jurisdiccion: row.jurisdiccion || null, materia: 'Civil',
          fuenteOficial: archivoNombre, archivoNombre
        }));
        TURNOS.unshift(turno);
        resumen.turnosCreados++;
      } catch (e) {
        resumen.errores.push({ nombre: row.nombre, jurisdiccion: row.jurisdiccion, mensaje: e.message });
      }
    }

    if (onProgreso) onProgreso(resumen.filasProcesadas, validas.length);
  }

  return resumen;
}

// Reintenta una vez ante un fallo transitorio (por ejemplo, un corte de red
// puntual) antes de dar la fila por fallida definitivamente.
async function crearConReintento(fn) {
  try {
    return await fn();
  } catch (primerError) {
    try {
      return await fn();
    } catch (segundoError) {
      throw segundoError;
    }
  }
}

function mostrarResumenImportacion(warningsEl, resumen, totalFilas) {
  if (!warningsEl) return;
  const listaErrores = resumen.errores.length
    ? `<div style="margin-top:8px; max-height:160px; overflow-y:auto; font-size:11.5px; color:var(--urgent);">
        ${resumen.errores.map(e => `• ${escapeHtml(e.nombre || '(sin nombre)')}${e.jurisdiccion ? ' — ' + escapeHtml(e.jurisdiccion) : ''}: ${escapeHtml(e.mensaje)}`).join('<br>')}
      </div>`
    : '';
  warningsEl.innerHTML = `
    <div class="receptor-sugerido-box">
      <div class="subhead" style="margin-top:0;">Resumen de la importación</div>
      <div style="font-size:12.5px; color:var(--ink-dim); line-height:1.7;">
        Filas procesadas: <strong>${resumen.filasProcesadas}</strong> de ${totalFilas}<br>
        Receptores creados: <strong>${resumen.receptoresCreados}</strong><br>
        Receptores existentes (reutilizados): <strong>${resumen.receptoresExistentes}</strong><br>
        Turnos creados: <strong>${resumen.turnosCreados}</strong><br>
        Duplicados omitidos (ya existían): <strong>${resumen.duplicadosOmitidos}</strong><br>
        Errores: <strong style="color:${resumen.errores.length ? 'var(--urgent)' : 'inherit'};">${resumen.errores.length}</strong>
      </div>
      ${listaErrores}
    </div>`;
}

// Tipo A: listado de receptores → crea o actualiza registros en el catálogo
// (RECEPTORES), sin crear turnos. Si el nombre normalizado ya existe, se
// actualizan sus datos de contacto en vez de duplicarlo.
async function confirmarImportacionListado(container, wrap, archivoNombre) {
  wrap.querySelectorAll('[data-preview-idx]').forEach(row => {
    const idx = parseInt(row.dataset.previewIdx, 10);
    importPreviewRows[idx] = {
      nombre: row.querySelector('.il-nombre').value.trim(),
      domicilio: row.querySelector('.il-domicilio').value.trim(),
      telefono: row.querySelector('.il-telefono').value.trim(),
      celular: row.querySelector('.il-celular').value.trim(),
      correo: row.querySelector('.il-correo').value.trim()
    };
    importPreviewRows[idx].incompleta = !importPreviewRows[idx].nombre;
  });

  const errores = [];
  const validas = [];
  importPreviewRows.forEach((row, i) => {
    if (!row.nombre) { errores.push(`Fila ${i + 1}: falta el nombre del receptor.`); return; }
    validas.push(row);
  });

  const warningsEl = container.querySelector('#import-warnings');
  if (errores.length) {
    warningsEl.innerHTML = `<div class="ficha-empty" style="color:var(--urgent);">${errores.map(e => escapeHtml(e)).join('<br>')}</div>`;
    if (validas.length === 0) return;
    if (!confirm(`Hay ${errores.length} fila(s) sin nombre que no se importarán. ¿Continuar con las ${validas.length} filas restantes?`)) return;
  }

  let creados = 0, actualizados = 0;
  for (const row of validas) {
    const telefono = [row.telefono, row.celular].filter(Boolean).join(' / ') || null;
    try {
      const existente = encontrarOCrearReceptorLocal(row.nombre);
      if (existente) {
        const actualizado = await api.updateReceptor(existente.id, {
          telefono: telefono || existente.telefono,
          correo: row.correo || existente.correo,
          domicilio: row.domicilio || existente.domicilio,
          fuenteOficial: archivoNombre, fechaActualizacion: todayISO()
        });
        Object.assign(existente, actualizado);
        actualizados++;
      } else {
        const nuevo = await api.createReceptor(CURRENT_USER.id, {
          nombreCompleto: row.nombre, telefono, correo: row.correo || null, domicilio: row.domicilio || null,
          materia: 'Civil', activo: true, fuenteOficial: archivoNombre, fechaActualizacion: todayISO()
        });
        RECEPTORES.unshift(nuevo);
        creados++;
      }
    } catch (e) {
      toast(`No se pudo guardar "${row.nombre}": ${e.message}`);
    }
  }

  toast(`Importación confirmada: ${creados} receptor(es) nuevo(s), ${actualizados} actualizado(s).`);
  importPreviewRows = [];
  renderReceptoresAdmin();
}

// Tipo B: turno mensual (juzgados civiles de Santiago) → crea/vincula el
// receptor y crea un turno por tribunal, con el mes completo como período.
async function confirmarImportacionTurnoMensual(container, wrap, archivoNombre) {
  wrap.querySelectorAll('[data-preview-idx]').forEach(row => {
    const idx = parseInt(row.dataset.previewIdx, 10);
    importPreviewRows[idx] = {
      mes: row.querySelector('.it-mes').value.trim(),
      anio: row.querySelector('.it-anio').value.trim(),
      tribunal: row.querySelector('.it-tribunal').value.trim(),
      receptor: row.querySelector('.it-receptor').value.trim(),
      correo: row.querySelector('.it-correo').value.trim()
    };
    importPreviewRows[idx].incompleta = !importPreviewRows[idx].receptor;
  });

  const errores = [];
  const validas = [];
  importPreviewRows.forEach((row, i) => {
    if (!row.receptor) { errores.push(`Fila ${i + 1}: falta el nombre del receptor.`); return; }
    if (!row.mes || !row.anio) { errores.push(`Fila ${i + 1} (${row.receptor}): falta mes o año del turno.`); return; }
    validas.push(row);
  });

  const warningsEl = container.querySelector('#import-warnings');
  if (errores.length) {
    warningsEl.innerHTML = `<div class="ficha-empty" style="color:var(--urgent);">${errores.map(e => escapeHtml(e)).join('<br>')}</div>`;
    if (validas.length === 0) return;
    if (!confirm(`Hay ${errores.length} fila(s) con problemas que no se importarán. ¿Continuar con las ${validas.length} filas válidas?`)) return;
  }

  const mesIndice = (mesNombre) => MESES_ES.indexOf((mesNombre || '').toLowerCase());

  let creados = 0, receptoresNuevos = 0, omitidos = 0;
  for (const row of validas) {
    const idxMes = mesIndice(row.mes);
    if (idxMes < 0) { toast(`Mes no reconocido para "${row.receptor}": "${row.mes}"`); omitidos++; continue; }
    const anio = parseInt(row.anio, 10);
    const fechaInicio = `${anio}-${String(idxMes + 1).padStart(2, '0')}-01`;
    const ultimoDia = new Date(anio, idxMes + 1, 0).getDate();
    const fechaFin = `${anio}-${String(idxMes + 1).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;

    let receptor = encontrarOCrearReceptorLocal(row.receptor);
    try {
      if (!receptor) {
        receptor = await api.createReceptor(CURRENT_USER.id, {
          nombreCompleto: row.receptor, correo: row.correo || null, jurisdiccion: 'Santiago',
          materia: 'Civil', activo: true, fuenteOficial: archivoNombre, fechaActualizacion: todayISO()
        });
        RECEPTORES.unshift(receptor);
        receptoresNuevos++;
      } else if (row.correo && !receptor.correo) {
        const actualizado = await api.updateReceptor(receptor.id, { correo: row.correo });
        Object.assign(receptor, actualizado);
      }
      const turno = await api.createTurno(CURRENT_USER.id, {
        receptorId: receptor.id, fechaInicio, fechaFin,
        jurisdiccion: row.tribunal || null, materia: 'Civil',
        fuenteOficial: archivoNombre, archivoNombre,
        observaciones: `Turno mensual — ${row.mes} ${row.anio}`
      });
      TURNOS.unshift(turno);
      creados++;
    } catch (e) {
      toast(`No se pudo guardar "${row.receptor}": ${e.message}`);
    }
  }

  toast(`Importación confirmada: ${creados} turno(s) guardado(s)${receptoresNuevos ? `, ${receptoresNuevos} receptor(es) nuevo(s)` : ''}${omitidos ? `. ${omitidos} fila(s) omitida(s) por mes inválido` : ''}.`);
  importPreviewRows = [];
  renderReceptoresAdmin();
}

// Heurística de extracción de texto de PDF: busca líneas con dos fechas
// (rango de turno) y toma el resto de la línea como nombre candidato.
// Siempre requiere revisión y confirmación humana antes de guardar nada.
// Agrupa los TextItem de una página por su posición vertical (transform[5])
// para reconstruir cada fila visual del PDF, y los ordena horizontalmente
// (transform[4]) dentro de la fila. Inserta separadores de columna cuando
// hay un salto horizontal grande entre elementos, para poder distinguir
// nombre / fechas / jurisdicción más adelante.
function reconstruirLineasPagina(items) {
  const TOLERANCIA_Y = 2.5;
  const UMBRAL_COLUMNA = 12;

  const filas = [];
  items.forEach(item => {
    if (!item.str || !item.str.trim()) return;
    const y = item.transform[5];
    let fila = filas.find(f => Math.abs(f.y - y) <= TOLERANCIA_Y);
    if (!fila) { fila = { y, items: [] }; filas.push(fila); }
    fila.items.push(item);
  });

  // Orden visual: de arriba hacia abajo (en PDF, y mayor = más arriba)
  filas.sort((a, b) => b.y - a.y);

  return filas.map(fila => {
    fila.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let texto = '';
    let finAnterior = null;
    const columnas = [];
    let columnaActual = '';
    fila.items.forEach(it => {
      const x = it.transform[4];
      const ancho = it.width || (it.str.length * (it.transform[0] || 5));
      if (finAnterior !== null) {
        const brecha = x - finAnterior;
        if (brecha > UMBRAL_COLUMNA) {
          texto += '   ';
          if (columnaActual.trim()) columnas.push(columnaActual.trim());
          columnaActual = '';
        } else if (brecha > 1) {
          texto += ' ';
          columnaActual += ' ';
        }
      }
      texto += it.str;
      columnaActual += it.str;
      finAnterior = x + ancho;
    });
    if (columnaActual.trim()) columnas.push(columnaActual.trim());
    return { texto: texto.trim(), columnas };
  });
}

async function extraerLineasPdf(pdf) {
  const lineas = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const lineasPagina = reconstruirLineasPagina(content.items);
    lineasPagina.forEach(l => lineas.push({ pagina: i, ...l }));
  }
  return lineas;
}

const FECHA_REGEX = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/g;

function fechaAIso(m) {
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isNaN(new Date(iso).getTime()) ? null : iso;
}

// Analiza cada línea reconstruida (una por fila visual del PDF) y extrae
// fecha inicial, fecha final, nombre y jurisdicción/observación cuando
// existan. Nunca inventa un nombre: si no hay texto además de las fechas,
// la fila queda marcada como incompleta para revisión manual.
function analizarLineaTurno(linea) {
  const texto = linea.texto;
  const fechas = [...texto.matchAll(FECHA_REGEX)];
  if (fechas.length === 0) return null; // no hay ninguna fecha: no parece una fila de turno

  const limpiar = (s) => s.replace(/^[\s\-–—:•.]+|[\s\-–—:•.]+$/g, '').replace(/\s{2,}/g, ' ').trim();

  if (fechas.length === 1) {
    // Solo una fecha detectada: puede ser un turno con un dato incompleto en
    // el PDF (o mal reconocido). No se descarta ni se inventa la fecha que
    // falta: se deja visible para revisión y corrección manual.
    const nombre = limpiar(texto.slice(0, fechas[0].index));
    if (!nombre) return null; // sin texto y sin segunda fecha: probablemente no es una fila real
    return {
      nombre,
      fechaInicio: fechaAIso(fechas[0]) || '',
      fechaFin: '',
      jurisdiccion: limpiar(texto.slice(fechas[0].index + fechas[0][0].length)),
      pagina: linea.pagina,
      incompleta: true
    };
  }

  const fechaInicio = fechaAIso(fechas[0]);
  const fechaFin = fechaAIso(fechas[1]);

  // Robusto frente a cualquier espaciado/columna del PDF: el nombre es el
  // texto antes de la primera fecha; la jurisdicción/observación es el
  // texto después de la segunda fecha. Las fechas se detectan igual sin
  // importar cómo esté distribuido el resto del texto.
  const finPrimeraFecha = fechas[0].index + fechas[0][0].length;
  const inicioSegundaFecha = fechas[1].index;
  const finSegundaFecha = fechas[1].index + fechas[1][0].length;

  let nombre = limpiar(texto.slice(0, fechas[0].index));
  // Si entre la primera y segunda fecha queda texto (poco común, pero
  // posible en algunos formatos), se agrega como parte del nombre.
  const entreFechas = limpiar(texto.slice(finPrimeraFecha, inicioSegundaFecha));
  if (entreFechas) nombre = nombre ? `${nombre} ${entreFechas}` : entreFechas;

  const jurisdiccion = limpiar(texto.slice(finSegundaFecha));

  const incompleta = !nombre || !fechaInicio || !fechaFin;

  return {
    nombre,
    fechaInicio: fechaInicio || '',
    fechaFin: fechaFin || '',
    jurisdiccion,
    pagina: linea.pagina,
    incompleta
  };
}

function parsearLineasTurnosPdf(lineas) {
  const filas = [];
  lineas.forEach(linea => {
    const fila = analizarLineaTurno(linea);
    if (fila) filas.push(fila);
  });
  return filas;
}

// Compatibilidad: analiza texto plano (usado también como respaldo simple).
function parsearLineasTurnos(texto) {
  const lineas = texto.split(/\r?\n/).map(t => ({ texto: t, columnas: [t] }));
  return parsearLineasTurnosPdf(lineas).map(({ nombre, fechaInicio, fechaFin, jurisdiccion, incompleta }) =>
    ({ nombre, fechaInicio, fechaFin, jurisdiccion, incompleta }));
}

// ============================================================================
// Formatos reales de la Corte de Apelaciones de Santiago:
//   Tipo A — Listado de receptores (bloques: nombre, domicilio, teléfonos, correo)
//   Tipo B — Turno mensual (por tribunal: "N° Juzgado Civil de Santiago" + receptor)
// ============================================================================
const EMAIL_REGEX = /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/;
const TELEFONO_REGEX = /(\+?56\s?)?(\(?0?9\)?[\s.-]?\d{4}[\s.-]?\d{4}|\(?2\)?[\s.-]?\d{3,4}[\s.-]?\d{4}|\d{2,3}[\s.-]?\d{6,7})/;
const TRIBUNAL_CIVIL_SANTIAGO_REGEX = /(\d{1,2})\s*°?\s*Juzgado\s+Civil\s+de\s+Santiago/i;
const EXCLUIR_TRIBUNAL_REGEX = /Corte\s+Suprema|Corte\s+de\s+Apelaciones|Cobranza\s+Laboral|Juzgado\s+de\s+Familia|Juzgado\s+de\s+Letras\s+del\s+Trabajo|Juzgado\s+de\s+Polic[íi]a\s+Local|Tributario\s+y\s+Aduanero/i;
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function limpiarTexto(s) {
  return String(s || '').replace(/^[\s\-–—:•.,]+|[\s\-–—:•.,]+$/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Detecta automáticamente si el PDF corresponde a un listado de receptores
// o a un turno mensual. Siempre puede corregirse manualmente en la vista
// previa: esto es solo una sugerencia inicial, nunca una decisión final.
function detectarTipoDocumento(lineas) {
  const textoCompleto = lineas.map(l => l.texto).join(' ');
  const coincidenciasTribunalCivil = (textoCompleto.match(new RegExp(TRIBUNAL_CIVIL_SANTIAGO_REGEX, 'gi')) || []).length;
  const coincidenciasEmail = (textoCompleto.match(new RegExp(EMAIL_REGEX, 'g')) || []).length;
  const coincidenciasTelefono = (textoCompleto.match(new RegExp(TELEFONO_REGEX, 'g')) || []).length;
  if (coincidenciasTribunalCivil >= 2) return 'turno';
  if (coincidenciasEmail >= 2 || coincidenciasTelefono >= 3) return 'listado';
  return coincidenciasTribunalCivil > 0 ? 'turno' : 'listado';
}

function extraerMesAnioDocumento(lineas) {
  for (const l of lineas) {
    const texto = l.texto.toLowerCase();
    for (let i = 0; i < MESES_ES.length; i++) {
      const m = texto.match(new RegExp(`\\b${MESES_ES[i]}\\b\\D{0,3}(\\d{4})`, 'i'));
      if (m) return { mes: MESES_ES[i], anio: m[1] };
    }
  }
  return { mes: '', anio: '' };
}

// ---------- Tipo A: listado de receptores (formato en bloques) ----------
// Una línea "tipo nombre" (varias palabras con mayúscula inicial, sin
// dígitos, sin correo ni teléfono) abre un nuevo receptor; las líneas
// siguientes se van clasificando como correo, teléfono/celular o domicilio,
// hasta la próxima línea que parezca un nombre.
function pareceNombrePersona(texto) {
  if (EMAIL_REGEX.test(texto) || TELEFONO_REGEX.test(texto)) return false;
  if (/\d/.test(texto)) return false;
  const palabras = texto.trim().split(/\s+/).filter(Boolean);
  if (palabras.length < 2 || palabras.length > 6) return false;
  // Formato "Nombre Apellido" (mayúscula inicial + minúsculas), no encabezados
  // EN MAYÚSCULAS SOSTENIDAS como "LISTADO DE RECEPTORES".
  return palabras.every(p => /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ'.-]*$/.test(p));
}

function parsearListadoReceptoresPdf(lineas) {
  const registros = [];
  let actual = null;

  function cerrar() {
    if (actual && (actual.nombre || actual.correo || actual.telefono)) registros.push(actual);
  }

  lineas.forEach(l => {
    const texto = limpiarTexto(l.texto);
    if (!texto) return;

    if (pareceNombrePersona(texto)) {
      cerrar();
      actual = { nombre: texto, domicilio: '', telefono: '', celular: '', correo: '' };
      return;
    }
    if (!actual) actual = { nombre: '', domicilio: '', telefono: '', celular: '', correo: '' };

    const email = texto.match(new RegExp(EMAIL_REGEX));
    if (email) { actual.correo = actual.correo ? `${actual.correo}; ${email[0]}` : email[0]; return; }

    const telefonos = texto.match(new RegExp(TELEFONO_REGEX, 'g'));
    if (telefonos && telefonos.length) {
      telefonos.forEach(t => {
        const limpio = t.trim();
        if (!actual.telefono) actual.telefono = limpio;
        else if (!actual.celular) actual.celular = limpio;
      });
      return;
    }

    actual.domicilio = actual.domicilio ? `${actual.domicilio}, ${texto}` : texto;
  });
  cerrar();

  return registros.map(r => ({ ...r, incompleta: !r.nombre || (!r.telefono && !r.celular && !r.correo) }));
}

// ---------- Tipo B: turno mensual — juzgados civiles de Santiago (1° a 30°) ----------
function parsearTurnoMensualCivilPdf(lineas) {
  const { mes, anio } = extraerMesAnioDocumento(lineas);
  const filas = [];

  lineas.forEach(l => {
    const texto = l.texto;
    if (EXCLUIR_TRIBUNAL_REGEX.test(texto)) return;
    const m = texto.match(TRIBUNAL_CIVIL_SANTIAGO_REGEX);
    if (!m) return;

    const numeroJuzgado = m[1];
    const tribunal = `${numeroJuzgado}° Juzgado Civil de Santiago`;
    const emailMatch = texto.match(new RegExp(EMAIL_REGEX));
    const correo = emailMatch ? emailMatch[0] : '';

    let resto = texto.replace(m[0], '');
    if (correo) resto = resto.replace(correo, '');
    const receptor = limpiarTexto(resto);

    filas.push({
      tribunal, receptor, correo, mes, anio,
      incompleta: !receptor
    });
  });

  return filas;
}

// Alias reconocidos para cada columna del CSV de turnos. La lectura es por
// nombre de encabezado (no por posición), así que el orden de las columnas
// en el archivo no importa.
const CSV_ALIAS_NOMBRE = ['nombre', 'receptor', 'receptor_nombre'];
const CSV_ALIAS_INICIO = ['inicio', 'fecha_inicio'];
const CSV_ALIAS_FIN = ['fin', 'fecha_fin'];
const CSV_ALIAS_JURISDICCION = ['jurisdiccion', 'jurisdicción', 'tribunal'];

function normalizarEncabezadoCsv(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Acepta directamente AAAA-MM-DD (formato nativo de <input type="date">).
// Si viene en dd/mm/aaaa o dd-mm-aaaa, la convierte; en cualquier otro caso
// deja el valor tal cual para que la usuaria lo corrija en la vista previa.
function normalizarFechaCsv(valor) {
  const v = String(valor || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return v;
}

// Separador de línea CSV tolerante a campos entre comillas ("Apellido, Nombre").
function separarLineaCsv(linea) {
  const cols = [];
  let actual = '';
  let dentroComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (ch === '"') { dentroComillas = !dentroComillas; continue; }
    if (ch === ',' && !dentroComillas) { cols.push(actual.trim()); actual = ''; continue; }
    actual += ch;
  }
  cols.push(actual.trim());
  return cols;
}

function parsearCsv(texto) {
  const lineas = texto.split(/\r?\n/).filter(l => l.trim());
  if (lineas.length === 0) return [];

  // La primera fila siempre se trata como encabezado y nunca se importa
  // como registro.
  const encabezados = separarLineaCsv(lineas[0]).map(normalizarEncabezadoCsv);
  const idx = {
    nombre: encabezados.findIndex(h => CSV_ALIAS_NOMBRE.includes(h)),
    fechaInicio: encabezados.findIndex(h => CSV_ALIAS_INICIO.includes(h)),
    fechaFin: encabezados.findIndex(h => CSV_ALIAS_FIN.includes(h)),
    jurisdiccion: encabezados.findIndex(h => CSV_ALIAS_JURISDICCION.includes(h))
  };

  // Si no se reconoce ningún encabezado válido, se asume el formato
  // posicional histórico (nombre, telefono, correo, domicilio, jurisdiccion,
  // fecha_inicio, fecha_fin) para no romper cargas ya existentes.
  const sinEncabezadosReconocidos = idx.nombre === -1 && idx.fechaInicio === -1 && idx.fechaFin === -1 && idx.jurisdiccion === -1;

  const filas = [];
  for (let i = 1; i < lineas.length; i++) {
    const cols = separarLineaCsv(lineas[i]);
    if (cols.length < 2) continue;

    let nombre, fechaInicio, fechaFin, jurisdiccion;
    if (sinEncabezadosReconocidos) {
      [nombre, , , , jurisdiccion, fechaInicio, fechaFin] = cols;
    } else {
      nombre = idx.nombre >= 0 ? cols[idx.nombre] : '';
      fechaInicio = idx.fechaInicio >= 0 ? cols[idx.fechaInicio] : '';
      fechaFin = idx.fechaFin >= 0 ? cols[idx.fechaFin] : '';
      jurisdiccion = idx.jurisdiccion >= 0 ? cols[idx.jurisdiccion] : '';
    }

    nombre = (nombre || '').trim();
    if (!nombre) continue;
    const fi = normalizarFechaCsv(fechaInicio);
    const ff = normalizarFechaCsv(fechaFin);
    filas.push({ nombre, fechaInicio: fi, fechaFin: ff, jurisdiccion: (jurisdiccion || '').trim(), incompleta: !nombre || !fi || !ff });
  }
  return filas;
}

function reparsearPdfComoFormato(formato) {
  importFormato = formato;
  if (formato === 'pdf-listado') importPreviewRows = parsearListadoReceptoresPdf(importLineasPdf);
  else if (formato === 'pdf-turno-mensual') importPreviewRows = parsearTurnoMensualCivilPdf(importLineasPdf);
}

async function procesarArchivoImportado(file, container) {
  const statusEl = container.querySelector('#import-status');
  statusEl.textContent = 'Leyendo archivo…';
  importPreviewRows = [];
  importLineasPdf = [];

  try {
    if (file.type === 'text/csv' || /\.csv$|\.txt$/i.test(file.name)) {
      importFormato = 'csv-turno';
      importPreviewRows = parsearCsv(await file.text());
      const completas = importPreviewRows.filter(r => !r.incompleta).length;
      statusEl.innerHTML = importPreviewRows.length
        ? `Archivo leído. Filas detectadas: <strong>${importPreviewRows.length}</strong> · completas: <strong>${completas}</strong> · requieren revisión: <strong>${importPreviewRows.length - completas}</strong>.`
        : 'No se detectaron filas en el archivo. Puedes agregarlas manualmente.';
    } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

      const lineas = await extraerLineasPdf(pdf);
      const totalCaracteres = lineas.reduce((sum, l) => sum + l.texto.length, 0);
      const caracteresPorPagina = totalCaracteres / Math.max(pdf.numPages, 1);

      if (caracteresPorPagina < 15) {
        // El PDF no tiene una capa de texto útil (probablemente escaneado):
        // nunca se muestra simplemente "no reconocido". Se ofrece una
        // alternativa funcional en vez de forzar un reconocimiento poco
        // confiable de imagen.
        importLineasPdf = [];
        importPreviewRows = [];
        statusEl.innerHTML = `
          Este PDF parece ser una imagen escaneada, sin texto que se pueda leer automáticamente
          (se detectaron ${totalCaracteres} caracteres en ${pdf.numPages} página(s)).<br>
          Puedes: agregar los registros manualmente en la vista previa, o volver a intentarlo con un archivo CSV/TXT
          con las columnas correspondientes.
        `;
        renderImportPreview(container, file.name);
        return;
      }

      importLineasPdf = lineas;
      const tipoDetectado = detectarTipoDocumento(lineas);
      reparsearPdfComoFormato(tipoDetectado === 'turno' ? 'pdf-turno-mensual' : 'pdf-listado');

      const completas = importPreviewRows.filter(r => !r.incompleta).length;
      const requierenRevision = importPreviewRows.length - completas;
      const etiquetaTipo = importFormato === 'pdf-turno-mensual' ? 'Turno mensual (juzgados civiles)' : 'Listado de receptores';
      statusEl.innerHTML = `
        Tipo de documento detectado: <strong>${etiquetaTipo}</strong> (puedes corregirlo abajo).<br>
        Páginas analizadas: <strong>${pdf.numPages}</strong> ·
        filas detectadas: <strong>${importPreviewRows.length}</strong> ·
        completas: <strong>${completas}</strong> ·
        requieren revisión: <strong>${requierenRevision}</strong>.
        ${importPreviewRows.length === 0 ? '<br>No se pudo detectar información automáticamente en este archivo. Puedes agregar las filas manualmente, o intentar con un CSV.' : ''}
      `;
    } else {
      statusEl.textContent = 'Formato no reconocido. Usa PDF, CSV o TXT.';
      renderImportPreview(container, file.name);
      return;
    }
  } catch (e) {
    console.error(e);
    statusEl.innerHTML = `No se pudo leer el archivo automáticamente (${escapeHtml(e.message)}). Puedes ingresar los turnos manualmente en la vista previa, o intentar con un archivo CSV.`;
    importPreviewRows = [];
  }

  renderImportPreview(container, file.name);
}

function wireImportarTab(container) {
  const fileInput = container.querySelector('#import-file');
  const browseBtn = container.querySelector('#import-browse');
  const dropzone = container.querySelector('#import-dropzone');
  if (browseBtn) browseBtn.addEventListener('click', () => fileInput.click());
  if (fileInput) fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) procesarArchivoImportado(fileInput.files[0], container);
  });
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) procesarArchivoImportado(e.dataTransfer.files[0], container);
    });
  }
}

// ---------- Vista principal: Administración de receptores ----------
function renderReceptoresAdmin() {
  const container = document.getElementById('list-container');
  const tabs = [
    ['receptores', 'Receptores'], ['turnos', 'Turnos'], ['importar', 'Importar PDF / CSV']
  ];
  let bodyHtml = '';
  if (receptoresAdminTab === 'receptores') bodyHtml = renderReceptoresTab();
  else if (receptoresAdminTab === 'turnos') bodyHtml = renderTurnosTab();
  else bodyHtml = renderImportarTab();

  container.innerHTML = `
    <div class="section-title">Administración de receptores</div>
    <div style="color:var(--ink-dim); font-size:12.5px; margin:-6px 0 18px;">
      Catálogo de receptores judiciales y sus periodos de turno (Región Metropolitana, área civil, encargos con beneficio de asistencia judicial). Independiente de Encargo receptor, que solo consulta esta información.
    </div>
    <div class="agenda-viewtabs">${tabs.map(([k, l]) => `<button class="btn small ${receptoresAdminTab === k ? 'primary' : ''}" data-radm-tab="${k}">${l}</button>`).join('')}</div>
    <div>${bodyHtml}</div>
  `;

  container.querySelectorAll('[data-radm-tab]').forEach(btn => {
    btn.addEventListener('click', () => { receptoresAdminTab = btn.dataset.radmTab; importPreviewRows = []; importLineasPdf = []; renderReceptoresAdmin(); });
  });

  if (receptoresAdminTab === 'receptores') wireReceptoresTab(container);
  else if (receptoresAdminTab === 'turnos') wireTurnosTab(container);
  else wireImportarTab(container);
}


// ============================================================================
// INFORME FINAL — informe de cierre de práctica, generado solo en modo lectura
// ============================================================================
let informeFinalEtapa = 'configurar'; // 'configurar' | 'preview'
let informeFinalFiltro = 'todas'; // todas | tramitacion | nueva | terminada | manual
let informeFinalSeleccion = new Set(); // usado cuando el filtro es "manual"
let informeFinalOrden = 'agrupar-estado';

const INFORME_CAMPOS_DEFAULT = {
  rol: true, tribunal: true, caratulado: true, materia: true, tipoJuicio: true,
  patrocinado: true, carpeta: true, etapa: true, estadoActual: true, resumen: false,
  gestionesRealizadas: true, resultadoBeneficio: true, gestionesPendientes: true,
  gestionesEnEspera: false, ultimaRevisionPjud: false, proximaActuacion: false,
  observacionesTraspaso: true, cronologia: false, instruccionesTutor: false,
  proximosEventos: false, audienciasFuturas: false
};
let informeFinalCampos = { ...INFORME_CAMPOS_DEFAULT };

const INFORME_CAMPOS_GRUPOS = [
  ['Datos básicos', [
    ['rol', 'ROL / RIT'], ['tribunal', 'Tribunal'], ['caratulado', 'Caratulado'],
    ['materia', 'Materia'], ['tipoJuicio', 'Tipo de juicio'], ['patrocinado', 'Parte patrocinada'],
    ['carpeta', 'Estado / carpeta de la causa'], ['etapa', 'Etapa procesal'],
    ['estadoActual', 'Estado actual'], ['resumen', 'Resumen de la causa']
  ]],
  ['Gestión', [
    ['gestionesRealizadas', 'Gestiones realizadas'], ['resultadoBeneficio', 'Resultado o beneficio obtenido'],
    ['gestionesPendientes', 'Gestiones pendientes'], ['gestionesEnEspera', 'Gestiones en espera'],
    ['ultimaRevisionPjud', 'Última revisión PJUD'], ['proximaActuacion', 'Próxima actuación'],
    ['observacionesTraspaso', 'Observaciones de traspaso'], ['cronologia', 'Cronología jurídica'],
    ['instruccionesTutor', 'Instrucciones del tutor']
  ]],
  ['Agenda (opcional)', [
    ['proximosEventos', 'Próximos eventos pendientes'], ['audienciasFuturas', 'Audiencias futuras']
  ]]
];

const INFORME_ORDEN_OPCIONES = [
  ['agrupar-estado', 'Agrupar por estado (recomendado)'],
  ['rol', 'Por ROL'], ['tribunal', 'Por tribunal'], ['caratulado', 'Por caratulado'],
  ['estado', 'Por estado de causa'], ['fechaIngreso', 'Por fecha de ingreso'], ['prioridad', 'Por prioridad']
];

function informeFinalCausasFiltradas() {
  if (informeFinalFiltro === 'manual') return CAUSAS.filter(c => informeFinalSeleccion.has(c.id));
  if (informeFinalFiltro === 'todas') return CAUSAS.slice();
  return CAUSAS.filter(c => c.categoria === informeFinalFiltro);
}

function ordenarCausasInforme(causas) {
  const copia = causas.slice();
  const cmp = {
    rol: (a, b) => (a.rol || '').localeCompare(b.rol || ''),
    tribunal: (a, b) => tribunalTexto(a).localeCompare(tribunalTexto(b)),
    caratulado: (a, b) => (caratuladoTexto(a) || '').localeCompare(caratuladoTexto(b) || ''),
    estado: (a, b) => (a.categoria || '').localeCompare(b.categoria || ''),
    fechaIngreso: (a, b) => (a.fechaIngreso || '').localeCompare(b.fechaIngreso || ''),
    prioridad: (a, b) => { const ord = { Urgente: 0, 'Semi urgente': 1, 'No prioritario': 2 }; return (ord[a.prioridad] ?? 9) - (ord[b.prioridad] ?? 9); }
  };
  if (informeFinalOrden === 'agrupar-estado') {
    const ordenCat = { tramitacion: 0, nueva: 1, terminada: 2 };
    copia.sort((a, b) => (ordenCat[a.categoria] ?? 9) - (ordenCat[b.categoria] ?? 9) || (a.rol || '').localeCompare(b.rol || ''));
  } else if (cmp[informeFinalOrden]) {
    copia.sort(cmp[informeFinalOrden]);
  }
  return copia;
}

// ============================================================================
// INTEGRACIONES — Google Calendar (Agenda APP → Google Calendar)
// ============================================================================
const GOOGLE_TIPOS_EVENTO = [
  'Audiencia', 'Cita con usuario', 'Reunión con tutor', 'Llamada', 'Plazo procesal',
  'Presentación de escrito', 'Revisión de causa', 'Gestión importante', 'Recordatorio', 'Otro'
];
const RECORDATORIO_OPCIONES = [
  [15, '15 minutos antes'], [30, '30 minutos antes'], [60, '1 hora antes'], [120, '2 horas antes'],
  [1440, '1 día antes'], [2880, '2 días antes'], [10080, '1 semana antes']
];

function etiquetaRecordatorio(minutos) {
  const encontrado = RECORDATORIO_OPCIONES.find(([m]) => m === minutos);
  return encontrado ? encontrado[1] : `${minutos} min. antes`;
}

async function refrescarGoogleStatus() {
  try { GOOGLE_STATUS = await api.googleGetStatus(); }
  catch (e) { GOOGLE_STATUS = { conectado: false }; console.error(e); }
}

function renderIntegraciones() {
  const container = document.getElementById('list-container');
  const g = GOOGLE_STATUS || { conectado: false };

  container.innerHTML = `
    <div class="section-title">Integraciones</div>
    <div style="color:var(--ink-dim); font-size:12.5px; margin:-6px 0 18px;">
      Sincroniza tu Agenda con Google Calendar para recibir avisos y recordatorios. La Agenda de la aplicación sigue siendo la fuente principal: si Google falla, tu información nunca se pierde de aquí.
    </div>

    <div class="integ-card">
      <div class="integ-card-top">
        <div class="integ-icon">G</div>
        <div style="flex:1;">
          <div class="subhead" style="margin-top:0;">Google Calendar</div>
          <div class="ficha-empty" style="color:${g.conectado ? 'var(--calm)' : 'var(--ink-faint)'};">
            Estado: <strong>${g.conectado ? 'Conectado' : 'No conectado'}</strong>
          </div>
        </div>
      </div>

      ${g.conectado ? `
        <div class="gestion-meta" style="margin-top:10px;">
          <span>Cuenta: ${escapeHtml(g.cuenta || '—')}</span>
          <span>Calendario: ${escapeHtml(g.calendarNombre || 'Sin seleccionar')}</span>
          <span>Última sincronización: ${g.ultimaSincronizacion ? escapeHtml(fmtFechaHora(g.ultimaSincronizacion)) : 'Nunca'}</span>
        </div>

        <div style="margin-top:14px; display:flex; align-items:center; gap:8px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
            <input type="checkbox" id="integ-sync-auto" ${g.syncAutomatica ? 'checked' : ''}>
            Sincronización automática
          </label>
        </div>

        <div class="subhead" style="margin-top:16px;">Calendario a usar</div>
        <div id="integ-calendarios-wrap"><button class="btn small" id="integ-cargar-calendarios" type="button">Elegir / cambiar calendario</button></div>

        <div class="agenda-toolbar" style="margin-top:16px;">
          <button class="btn small" id="integ-probar-conexion" type="button">Probar conexión</button>
          <button class="btn small" id="integ-reintentar-pendientes" type="button">Reintentar pendientes</button>
          <button class="btn small" id="integ-sincronizar-existentes" type="button">Sincronizar eventos existentes</button>
          <button class="btn small" id="integ-desconectar" type="button" style="border-color:var(--urgent); color:var(--urgent); margin-left:auto;">Desconectar Google Calendar</button>
        </div>
        <div id="integ-mensaje" style="margin-top:10px;"></div>

        <div class="subhead" style="margin-top:20px;">Recordatorios predeterminados</div>
        <div class="ficha-empty" style="color:var(--ink-faint); margin-bottom:8px;">Se usan cuando un evento o su tipo no tienen recordatorios propios configurados.</div>
        <div class="integ-recordatorios-grid" id="integ-recordatorios-default">
          ${RECORDATORIO_OPCIONES.map(([min, label]) => `
            <label><input type="checkbox" class="integ-rec-default" value="${min}" ${(g.recordatoriosDefault || []).some(r => r.minutos === min) ? 'checked' : ''}> ${label}</label>`).join('')}
        </div>
        <button class="btn small" id="integ-guardar-recordatorios" type="button" style="margin-top:10px;">Guardar recordatorios predeterminados</button>

      ` : `
        <div style="margin-top:14px;">
          <button class="btn primary" id="integ-conectar" type="button">Conectar con Google Calendar</button>
        </div>
        <div class="ficha-empty" style="color:var(--ink-faint); margin-top:10px;">
          Se te pedirá iniciar sesión en Google y autorizar acceso únicamente al calendario que elijas (crear, modificar y eliminar eventos). No se solicita acceso a Gmail, Drive ni Contactos. Tu inicio de sesión en esta aplicación no cambia.
        </div>
        <div id="integ-mensaje" style="margin-top:10px;"></div>
      `}
    </div>
  `;

  wireIntegraciones(container);
}

function wireIntegraciones(container) {
  const msgEl = () => container.querySelector('#integ-mensaje');
  const mostrarMensaje = (texto, esError) => {
    const el = msgEl();
    if (el) el.innerHTML = `<div class="ficha-empty" style="color:${esError ? 'var(--urgent)' : 'var(--calm)'};">${escapeHtml(texto)}</div>`;
  };

  const btnConectar = container.querySelector('#integ-conectar');
  if (btnConectar) btnConectar.addEventListener('click', async () => {
    try {
      const { url } = await api.googleGetAuthUrl();
      window.location.href = url;
    } catch (e) { mostrarMensaje('No se pudo iniciar la conexión: ' + e.message, true); }
  });

  const btnDesconectar = container.querySelector('#integ-desconectar');
  if (btnDesconectar) btnDesconectar.addEventListener('click', async () => {
    if (!confirm('¿Desconectar Google Calendar? Tus eventos de Agenda no se eliminarán, y los eventos ya creados en Google Calendar tampoco se borrarán automáticamente. Tendrás que volver a conectar tu cuenta para reanudar la sincronización.')) return;
    try {
      await api.googleDisconnect();
      await refrescarGoogleStatus();
      toast('Google Calendar desconectado');
      renderIntegraciones();
    } catch (e) { mostrarMensaje('No se pudo desconectar: ' + e.message, true); }
  });

  const syncAutoChk = container.querySelector('#integ-sync-auto');
  if (syncAutoChk) syncAutoChk.addEventListener('change', async () => {
    try {
      await api.googleSavePreferences({ syncAutomatica: syncAutoChk.checked });
      GOOGLE_STATUS.syncAutomatica = syncAutoChk.checked;
      toast('Preferencia guardada');
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });

  const btnCargarCalendarios = container.querySelector('#integ-cargar-calendarios');
  if (btnCargarCalendarios) btnCargarCalendarios.addEventListener('click', async () => {
    const wrap = container.querySelector('#integ-calendarios-wrap');
    wrap.innerHTML = 'Cargando calendarios…';
    try {
      const { calendarios } = await api.googleListCalendars();
      wrap.innerHTML = `
        <select id="integ-calendario-select">
          ${calendarios.map(c => `<option value="${escapeHtml(c.id)}" data-nombre="${escapeHtml(c.summary)}" ${c.id === GOOGLE_STATUS.calendarId ? 'selected' : ''}>${escapeHtml(c.summary)}${c.primary ? ' (principal)' : ''}</option>`).join('')}
        </select>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="btn small primary" id="integ-guardar-calendario" type="button">Usar este calendario</button>
          <button class="btn small" id="integ-crear-calendario" type="button">Crear calendario "Agenda CAJ"</button>
        </div>`;
      wrap.querySelector('#integ-guardar-calendario').addEventListener('click', async () => {
        const sel = wrap.querySelector('#integ-calendario-select');
        const opt = sel.options[sel.selectedIndex];
        try {
          await api.googleSelectCalendar({ calendarId: sel.value, calendarSummary: opt.dataset.nombre });
          await refrescarGoogleStatus();
          toast('Calendario guardado');
          renderIntegraciones();
        } catch (e) { mostrarMensaje('No se pudo guardar el calendario: ' + e.message, true); }
      });
      wrap.querySelector('#integ-crear-calendario').addEventListener('click', async () => {
        if (!confirm('¿Crear un nuevo calendario llamado "Agenda CAJ" en tu cuenta de Google?')) return;
        try {
          await api.googleSelectCalendar({ crearNuevo: true });
          await refrescarGoogleStatus();
          toast('Calendario creado y seleccionado');
          renderIntegraciones();
        } catch (e) { mostrarMensaje('No se pudo crear el calendario: ' + e.message, true); }
      });
    } catch (e) {
      wrap.innerHTML = `<div class="ficha-empty" style="color:var(--urgent);">No se pudieron cargar los calendarios: ${escapeHtml(e.message)}</div>`;
    }
  });

  const btnProbar = container.querySelector('#integ-probar-conexion');
  if (btnProbar) btnProbar.addEventListener('click', async () => {
    mostrarMensaje('Probando conexión…', false);
    try {
      await api.googleListCalendars();
      mostrarMensaje('Conexión correcta: se pudo listar tus calendarios de Google.', false);
    } catch (e) { mostrarMensaje('La conexión falló: ' + e.message, true); }
  });

  const btnReintentar = container.querySelector('#integ-reintentar-pendientes');
  if (btnReintentar) btnReintentar.addEventListener('click', async () => {
    mostrarMensaje('Reintentando eventos pendientes o con error…', false);
    try {
      const r = await api.googleSyncBatch({ modo: 'reintentar-pendientes' });
      mostrarMensaje(`Procesados: ${r.procesados} · Sincronizados: ${r.sincronizados} · Errores: ${r.errores}`, r.errores > 0);
      await refrescarAgendaDeCausasAbiertas();
      renderProgramacionSalasSiCorresponde();
    } catch (e) { mostrarMensaje('No se pudo reintentar: ' + e.message, true); }
  });

  const btnSincronizarExistentes = container.querySelector('#integ-sincronizar-existentes');
  if (btnSincronizarExistentes) btnSincronizarExistentes.addEventListener('click', () => abrirDialogoSincronizarExistentes(container));

  const btnGuardarRecordatorios = container.querySelector('#integ-guardar-recordatorios');
  if (btnGuardarRecordatorios) btnGuardarRecordatorios.addEventListener('click', async () => {
    const minutos = [...container.querySelectorAll('.integ-rec-default:checked')].map(chk => ({ minutos: parseInt(chk.value, 10) }));
    if (minutos.length === 0) { toast('Selecciona al menos un recordatorio'); return; }
    try {
      await api.googleSavePreferences({ recordatoriosDefault: minutos });
      GOOGLE_STATUS.recordatoriosDefault = minutos;
      toast('Recordatorios predeterminados guardados');
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });
}

async function abrirDialogoSincronizarExistentes(container) {
  const msgEl = container.querySelector('#integ-mensaje');
  msgEl.innerHTML = 'Consultando eventos pendientes…';
  try {
    const info = await api.googlePendingCount();
    if (info.total === 0) { msgEl.innerHTML = '<div class="ficha-empty" style="color:var(--ink-faint);">No hay eventos existentes sin sincronizar.</div>'; return; }
    msgEl.innerHTML = `
      <div class="receptor-sugerido-box">
        <div class="subhead" style="margin-top:0;">Sincronizar eventos existentes</div>
        <div style="font-size:12.5px; color:var(--ink-dim);">
          Hay <strong>${info.total}</strong> evento(s) de Agenda que nunca se han sincronizado
          (<strong>${info.futuros}</strong> de ellos futuros), entre ${escapeHtml(fmtFechaSolo(info.fechaMin))} y ${escapeHtml(fmtFechaSolo(info.fechaMax))}.
          Nada se sincroniza automáticamente: elige qué hacer.
        </div>
        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
          <button class="btn small primary" id="integ-sync-futuros" type="button">Sincronizar solo futuros (${info.futuros})</button>
          <button class="btn small" id="integ-sync-todos" type="button">Sincronizar todos (${info.total})</button>
          <button class="btn small ghost" id="integ-sync-cancelar" type="button">Cancelar</button>
        </div>
      </div>`;
    msgEl.querySelector('#integ-sync-cancelar').addEventListener('click', () => { msgEl.innerHTML = ''; });
    msgEl.querySelector('#integ-sync-futuros').addEventListener('click', () => confirmarSincronizarExistentes(msgEl, 'futuros'));
    msgEl.querySelector('#integ-sync-todos').addEventListener('click', () => confirmarSincronizarExistentes(msgEl, 'todos'));
  } catch (e) {
    msgEl.innerHTML = `<div class="ficha-empty" style="color:var(--urgent);">No se pudo consultar: ${escapeHtml(e.message)}</div>`;
  }
}

async function confirmarSincronizarExistentes(msgEl, rango) {
  msgEl.innerHTML = 'Sincronizando… esto puede tardar unos segundos.';
  try {
    const r = await api.googleSyncBatch({ modo: 'sincronizar-existentes', rango });
    msgEl.innerHTML = `<div class="ficha-empty" style="color:${r.errores ? 'var(--urgent)' : 'var(--calm)'};">Procesados: ${r.procesados} · Sincronizados: ${r.sincronizados} · Errores: ${r.errores}</div>`;
    await refrescarGoogleStatus();
    await refrescarAgendaDeCausasAbiertas();
  } catch (e) {
    msgEl.innerHTML = `<div class="ficha-empty" style="color:var(--urgent);">${escapeHtml(e.message)}</div>`;
  }
}

// Tras reintentar/sincronizar en bloque, recarga los eventos desde Supabase
// para reflejar los nuevos estados de sincronización en toda la app.
async function refrescarAgendaDeCausasAbiertas() {
  // Recarga completa de causas: forma simple y confiable de reflejar los
  // nuevos estados de sincronización sin duplicar lógica de fusión por causa.
  try {
    CAUSAS = await api.fetchCausas();
    render();
  } catch (_) { /* si falla, la próxima recarga manual lo actualizará */ }
}

function renderProgramacionSalasSiCorresponde() {
  if (currentCat === 'programacion-salas') renderProgramacionSalas();
}

// Indicador visual del estado de sincronización de un evento (para las
// listas de Agenda). Solo se muestra si hay una conexión activa.
function googleSyncBadgeHtml(evento) {
  if (!GOOGLE_STATUS.conectado) return '';
  const estado = evento.googleSyncStatus;
  if (estado === 'synced') return `<span class="gcal-badge gcal-ok" title="Sincronizado con Google Calendar">✓ Sincronizado</span>`;
  if (estado === 'pending') return `<span class="gcal-badge gcal-pending" title="Pendiente de sincronizar">⏳ Pendiente</span>`;
  if (estado === 'error') return `<span class="gcal-badge gcal-error" title="${escapeHtml(evento.googleSyncError || 'Error de sincronización')}">⚠ Error</span>`;
  return `<span class="gcal-badge gcal-none">No sincronizado</span>`;
}

// Se llama después de crear/actualizar un evento en Agenda. Si hay
// sincronización automática activada, intenta sincronizar en segundo plano
// sin bloquear la interfaz; si falla, el evento queda marcado como error
// pero permanece guardado en la Agenda.
// Ejecuta la sincronización en sí (usada tanto por el guardado automático
// como por "Reintentar sincronización"). No bloquea la interfaz.
async function sincronizarEventoGoogleAhora(evento, actualizarUiCallback) {
  if (!GOOGLE_STATUS.conectado) return;
  try {
    await api.updateAgendaEvento(evento.id, { googleSyncStatus: 'pending' });
  } catch (_) { /* no crítico */ }
  try {
    const r = await api.googleSyncEvent(evento.id);
    evento.googleSyncStatus = 'synced';
    evento.googleEventId = r.googleEventId;
    evento.googleSyncError = null;
  } catch (e) {
    evento.googleSyncStatus = 'error';
    evento.googleSyncError = e.message;
    toast('No se pudo sincronizar con Google Calendar. El evento permanece guardado en la Agenda.');
  }
  if (actualizarUiCallback) actualizarUiCallback();
}

// Se llama después de crear/actualizar un evento en Agenda. Solo sincroniza
// si la sincronización automática está activada (la usaria puede
// desactivarla y seguir sincronizando manualmente con "Reintentar").
async function intentarSincronizarEventoGoogle(evento, actualizarUiCallback) {
  if (!GOOGLE_STATUS.conectado || GOOGLE_STATUS.syncAutomatica === false) return;
  return sincronizarEventoGoogleAhora(evento, actualizarUiCallback);
}


function renderInformeFinal() {
  const container = document.getElementById('list-container');
  if (informeFinalEtapa === 'configurar') {
    container.innerHTML = informeFinalConfiguradorHtml();
    wireInformeFinalConfigurador(container);
  } else {
    container.innerHTML = informeFinalPreviewHtml();
    wireInformeFinalPreview(container);
  }
}

function informeFinalConfiguradorHtml() {
  const causas = informeFinalCausasFiltradas();
  const opcionesFiltro = [
    ['todas', 'Todas las causas'], ['tramitacion', 'Solo en tramitación'],
    ['nueva', 'Solo nuevas / redacción'], ['terminada', 'Solo terminadas'], ['manual', 'Selección manual']
  ];

  let manualHtml = '';
  if (informeFinalFiltro === 'manual') {
    manualHtml = `
    <div class="bulk-bar" style="margin-top:10px;">
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" id="informe-select-all"> Seleccionar todas</label>
      <button class="btn small ghost" id="informe-deselect-all" type="button">Deseleccionar todas</button>
      <span class="bulk-counter">${informeFinalSeleccion.size} causa(s) seleccionada(s)</span>
    </div>
    <div class="gestion-list" style="max-height:340px; overflow-y:auto;">
      ${CAUSAS.map(c => `
        <label class="receptor-card" style="display:flex; align-items:center; gap:10px; cursor:pointer;">
          <input type="checkbox" class="informe-causa-check" data-id="${c.id}" ${informeFinalSeleccion.has(c.id) ? 'checked' : ''}>
          <div>
            <strong>${escapeHtml(c.titulo)}</strong>
            <div class="ficha-empty" style="color:var(--ink-faint);">${escapeHtml(CATEGORIA_LABEL[c.categoria] || c.categoria)}${c.rol ? ' · ' + escapeHtml(c.rol) : ''}</div>
          </div>
        </label>`).join('')}
    </div>`;
  }

  const camposHtml = INFORME_CAMPOS_GRUPOS.map(([grupo, campos]) => `
    <div class="subhead" style="margin-top:14px;">${grupo}</div>
    <div class="informe-campos-grid">
      ${campos.map(([key, label]) => `
        <label style="display:flex; align-items:center; gap:7px; font-size:12.5px; cursor:pointer;">
          <input type="checkbox" class="informe-campo-check" data-campo="${key}" ${informeFinalCampos[key] ? 'checked' : ''}> ${label}
        </label>`).join('')}
    </div>`).join('');

  return `
  <div class="section-title">Informe Final</div>
  <div style="color:var(--ink-dim); font-size:12.5px; margin:-6px 0 18px;">
    Genera el informe de cierre de práctica con las causas tramitadas, para traspasarlas correctamente al siguiente postulante. Es una operación de solo lectura: no modifica ninguna causa, gestión, estado ni la Agenda.
  </div>

  <div class="subhead" style="margin-top:0;">Causas a incluir</div>
  <select id="informe-filtro">
    ${opcionesFiltro.map(([v, l]) => `<option value="${v}" ${informeFinalFiltro === v ? 'selected' : ''}>${l}</option>`).join('')}
  </select>
  <div class="ficha-empty" style="color:var(--ink-faint); margin-top:4px;">${causas.length} causa(s) coinciden con este filtro.</div>
  ${manualHtml}

  <div class="subhead" style="margin-top:18px;">Orden del informe</div>
  <select id="informe-orden">
    ${INFORME_ORDEN_OPCIONES.map(([v, l]) => `<option value="${v}" ${informeFinalOrden === v ? 'selected' : ''}>${l}</option>`).join('')}
  </select>

  <div class="subhead" style="margin-top:18px;">Campos a incluir</div>
  ${camposHtml}

  <div class="agenda-toolbar" style="margin-top:20px;">
    <button class="btn small primary" id="informe-ver-preview">Vista previa</button>
  </div>`;
}

function wireInformeFinalConfigurador(container) {
  const filtroSel = container.querySelector('#informe-filtro');
  filtroSel.addEventListener('change', () => { informeFinalFiltro = filtroSel.value; renderInformeFinal(); });

  const ordenSel = container.querySelector('#informe-orden');
  ordenSel.addEventListener('change', () => { informeFinalOrden = ordenSel.value; });

  container.querySelectorAll('.informe-campo-check').forEach(chk => {
    chk.addEventListener('change', () => { informeFinalCampos[chk.dataset.campo] = chk.checked; });
  });

  container.querySelectorAll('.informe-causa-check').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) informeFinalSeleccion.add(chk.dataset.id);
      else informeFinalSeleccion.delete(chk.dataset.id);
      renderInformeFinal();
    });
  });
  const selectAll = container.querySelector('#informe-select-all');
  if (selectAll) selectAll.addEventListener('change', () => {
    if (selectAll.checked) CAUSAS.forEach(c => informeFinalSeleccion.add(c.id));
    else informeFinalSeleccion.clear();
    renderInformeFinal();
  });
  const deselectAll = container.querySelector('#informe-deselect-all');
  if (deselectAll) deselectAll.addEventListener('click', () => { informeFinalSeleccion.clear(); renderInformeFinal(); });

  container.querySelector('#informe-ver-preview').addEventListener('click', () => {
    informeFinalEtapa = 'preview';
    renderInformeFinal();
  });
}

function informeFinalPreviewHtml() {
  const causas = informeFinalCausasFiltradas();
  const campos = Object.entries(informeFinalCampos).filter(([, v]) => v).map(([k]) => k);
  const camposLabels = INFORME_CAMPOS_GRUPOS.flatMap(([, c]) => c).filter(([k]) => campos.includes(k)).map(([, l]) => l);

  return `
  <div class="section-title">Informe Final — Vista previa</div>
  <div class="stats-row" style="grid-template-columns:repeat(4,1fr); margin-bottom:18px;">
    <div class="stat-card"><div class="num">${causas.length}</div><div class="lbl">Causas totales</div></div>
    <div class="stat-card info"><div class="num">${causas.filter(c => c.categoria === 'tramitacion').length}</div><div class="lbl">En tramitación</div></div>
    <div class="stat-card semi"><div class="num">${causas.filter(c => c.categoria === 'nueva').length}</div><div class="lbl">Nuevas / redacción</div></div>
    <div class="stat-card calm"><div class="num">${causas.filter(c => c.categoria === 'terminada').length}</div><div class="lbl">Terminadas</div></div>
  </div>
  <div class="subhead">Campos seleccionados</div>
  <div class="ficha-empty" style="color:var(--ink-dim); margin-bottom:16px;">${camposLabels.length ? escapeHtml(camposLabels.join(' · ')) : 'Ningún campo adicional seleccionado (solo datos básicos del bloque).'}</div>
  ${causas.length === 0 ? '<div class="empty-msg">No hay causas que coincidan con el filtro elegido.</div>' : ''}
  <div class="agenda-toolbar">
    <button class="btn small primary" id="informe-generar-pdf" ${causas.length === 0 ? 'disabled' : ''}>Generar PDF</button>
    <button class="btn small" id="informe-volver">Volver a configurar</button>
  </div>`;
}

function wireInformeFinalPreview(container) {
  container.querySelector('#informe-volver').addEventListener('click', () => {
    informeFinalEtapa = 'configurar';
    renderInformeFinal();
  });
  const genBtn = container.querySelector('#informe-generar-pdf');
  if (genBtn) genBtn.addEventListener('click', () => {
    genBtn.disabled = true;
    const original = genBtn.textContent;
    genBtn.textContent = 'Generando…';
    try {
      const causas = ordenarCausasInforme(informeFinalCausasFiltradas());
      const pdf = generarInformeFinalPdf(causas, informeFinalCampos);
      pdf.save('informe-final-practica.pdf');
      toast('Informe generado');
    } catch (e) {
      toast('No se pudo generar el informe: ' + e.message);
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = original;
    }
  });
}

// Construye, para una causa y el set de campos activados, los mismos
// bloques kv/list/table que usa la ficha individual, filtrando lo que no
// tenga contenido real (nunca se muestran campos vacíos).
function construirBloqueCausaInforme(c, campos) {
  const filas = [];
  const add = (campo, label, valor) => {
    if (!campos[campo]) return;
    if (valor === null || valor === undefined) return;
    const str = String(valor).trim();
    if (!str) return;
    filas.push([label, str]);
  };

  add('rol', 'ROL / RIT', c.rol);
  add('tribunal', 'Tribunal', tribunalTexto(c));
  add('caratulado', 'Caratulado', caratuladoTexto(c));
  add('materia', 'Materia', c.materia);
  add('tipoJuicio', 'Tipo de juicio', c.subcategoria);
  add('patrocinado', 'Parte patrocinada', patrocinadoEfectivo(c));
  add('carpeta', 'Estado / carpeta', CATEGORIA_LABEL[c.categoria] || c.categoria);
  add('etapa', 'Etapa procesal', c.etapa);
  add('estadoActual', 'Estado actual', c.estado);
  add('resumen', 'Resumen de la causa', c.resumen);
  add('resultadoBeneficio', 'Resultado o beneficio obtenido', c.resultadoBeneficio);
  add('ultimaRevisionPjud', 'Última revisión PJUD', c.ultimaRevisionAt ? fmtFechaHora(c.ultimaRevisionAt) : null);
  add('observacionesTraspaso', 'Observaciones de traspaso', c.observacionesTraspaso);

  if (campos.proximaActuacion) {
    const activa = pickActiveGestion(c);
    add('proximaActuacion', 'Próxima actuación', activa ? `${activa.descripcion}${activa.fechaRevision ? ' (revisar ' + fmtFechaSolo(activa.fechaRevision) + ')' : ''}` : null);
  }

  const tituloBloque = `Causa ROL/RIT N° ${c.rol || '(sin ROL)'}`;
  const secciones = [{ title: tituloBloque, kind: 'kv', rows: [['Referencia', c.titulo], ...filas] }];

  if (campos.gestionesRealizadas) {
    const realizadas = (c.gestionesPendientes || []).filter(g => g.estado === 'Realizada').map(g => g.descripcion);
    if (realizadas.length) secciones.push({ title: 'Gestiones realizadas por la postulante', kind: 'list', items: realizadas });
  }
  if (campos.gestionesPendientes || campos.gestionesEnEspera) {
    const estados = [];
    if (campos.gestionesPendientes) estados.push('Pendiente');
    if (campos.gestionesEnEspera) estados.push('En espera');
    const pendientes = (c.gestionesPendientes || []).filter(g => estados.includes(g.estado)).map(g => `${g.descripcion}${g.estado === 'En espera' ? ' (en espera)' : ''}`);
    if (pendientes.length) secciones.push({ title: 'Gestiones pendientes por realizar', kind: 'list', items: pendientes });
  }
  if (campos.cronologia) {
    const items = (c.cronologia || []).map(g => g.descripcion);
    if (items.length) secciones.push({ title: 'Cronología jurídica', kind: 'list', items });
  }
  if (campos.instruccionesTutor) {
    const items = (c.instrucciones || []).map(it => `${it.tutor ? it.tutor + ' — ' : ''}${it.instruccion} (${it.estado})`);
    if (items.length) secciones.push({ title: 'Instrucciones del tutor', kind: 'list', items });
  }
  if (campos.proximosEventos || campos.audienciasFuturas) {
    const hoy = todayISO();
    let eventos = (c.agendaEventos || []).filter(e => e.fecha >= hoy && !['Realizado', 'Cancelado'].includes(e.estado));
    if (campos.audienciasFuturas && !campos.proximosEventos) eventos = eventos.filter(e => e.tipo === 'Audiencia');
    if (eventos.length) secciones.push({
      title: campos.proximosEventos ? 'Próximos eventos' : 'Audiencias futuras',
      kind: 'table', headers: ['Tipo', 'Fecha', 'Título'], widths: [0.2, 0.2, 0.6],
      rows: eventos.map(e => [e.tipo, fmtFechaSolo(e.fecha), e.titulo])
    });
  }

  return secciones.filter(s => (s.kind === 'kv' && s.rows.length) || (s.kind === 'list' && s.items.length) || (s.kind === 'table' && s.rows.length));
}


function generarInformeFinalPdf(causas, campos) {
  const w = crearEscritorPdf();
  const { pdf, margin, contentWidth, pageWidth, pageHeight } = w;
  const usuario = (CURRENT_USER && (CURRENT_USER.nombre || CURRENT_USER.email)) || 'Postulante';

  // ---------- Portada ----------
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(24); pdf.setTextColor(20);
  pdf.text('Informe de práctica', pageWidth / 2, 110, { align: 'center' });

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15); pdf.setTextColor(40);
  pdf.text(usuario.toUpperCase(), pageWidth / 2, 128, { align: 'center' });

  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.setTextColor(80);
  pdf.text('Área Civil', pageWidth / 2, 140, { align: 'center' });
  pdf.text('CAJ Lo Prado', pageWidth / 2, 148, { align: 'center' });

  pdf.setFontSize(9.5); pdf.setTextColor(120);
  pdf.text(`Fecha de generación: ${fmtFechaHora(new Date().toISOString())}`, pageWidth / 2, 165, { align: 'center' });
  pdf.text(`${causas.length} causa(s) incluida(s) en este informe`, pageWidth / 2, 172, { align: 'center' });

  w.newPage();

  // ---------- Bloques por causa ----------
  causas.forEach((c, idx) => {
    const secciones = construirBloqueCausaInforme(c, campos);
    if (secciones.length === 0) return;

    // Evita dejar un título de causa solo al final de la página.
    w.ensure(22);
    if (idx > 0) w.y += 4;

    secciones.forEach(sec => w.drawSection(sec));

    // separador visual sutil entre causas
    w.ensure(6);
    pdf.setDrawColor(210); pdf.setLineWidth(0.3);
    pdf.line(margin, w.y, margin + contentWidth, w.y);
    w.y += 8;
  });

  w.finalizarPaginacion();
  return pdf;
}


function renderRevisionPjud() {
  const causas = CAUSAS.filter(c => c.categoria === 'tramitacion')
    .slice()
    .sort((a, b) => {
      const fa = a.ultimaRevisionAt || '';
      const fb = b.ultimaRevisionAt || '';
      return fa.localeCompare(fb); // sin revisar / más antiguas primero
    });

  const container = document.getElementById('list-container');
  let html = `<div class="section-title">Revisión PJUD <span class="n">${causas.length}</span></div>
  <div style="color:var(--ink-dim); font-size:12.5px; margin:-6px 0 18px;">Control interno: recuerda cuándo revisaste por última vez cada causa en el Poder Judicial. No genera gestiones ni eventos.</div>`;

  if (causas.length === 0) {
    html += `<div class="empty-msg">No hay causas en tramitación.</div>`;
  } else {
    html += `<div class="pjud-table">
      <div class="pjud-row pjud-head"><div>ROL</div><div>Partes</div><div>Tribunal</div><div>Última revisión</div><div></div></div>
      ${causas.map(c => `
        <div class="pjud-row" data-causa-id="${c.id}">
          <div>${escapeHtml(c.rol || causaShortLabel(c))}</div>
          <div>${escapeHtml(caratuladoTexto(c) || '—')}</div>
          <div>${escapeHtml(tribunalTexto(c) || '—')}</div>
          <div>${c.ultimaRevisionAt ? escapeHtml(fmtFechaHora(c.ultimaRevisionAt)) : '<span class="ficha-empty" style="color:var(--ink-faint); font-style:italic;">Nunca</span>'}</div>
          <div><button class="btn small primary" data-action="revisar-pjud" data-id="${c.id}">Revisado</button></div>
        </div>`).join('')}
    </div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('[data-action="revisar-pjud"]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const causa = CAUSAS.find(c => c.id === btn.dataset.id);
      if (!causa) return;
      try {
        const now = new Date().toISOString();
        await api.updateCausa(causa.id, { ultimaRevisionAt: now });
        causa.ultimaRevisionAt = now;
        toast('Revisión actualizada');
        renderRevisionPjud();
      } catch (e) { toast('No se pudo actualizar: ' + e.message); }
    });
  });

  container.querySelectorAll('.pjud-row[data-causa-id]').forEach(row => {
    row.addEventListener('click', () => {
      currentCat = 'todas';
      render();
      openDetail(row.dataset.causaId, 'resumen');
    });
  });
}


function renderDashBlocks() {
  const hoy = todayISO();
  const manana = tomorrowISO();
  const eventos = allEventosFlat();

  // ---------- Próximos compromisos: top 5 ----------
  const proximos = eventos
    .filter(e => isEventoActivo(e) && e.fecha >= hoy)
    .sort((a, b) => `${a.fecha}${a.horaInicio || ''}`.localeCompare(`${b.fecha}${b.horaInicio || ''}`))
    .slice(0, 5);

  const proximosBody = document.getElementById('dash-proximos-body');
  if (proximos.length === 0) {
    proximosBody.innerHTML = `<div class="dash-empty">No hay próximos compromisos registrados.</div>`;
  } else {
    proximosBody.innerHTML = proximos.map(e => `
      <div class="dash-row-item" data-causa-id="${e.causaId}">
        <span class="dash-icono">${AGENDA_TIPO_ICONO[e.tipo] || '•'}</span>
        <div class="dash-row-txt">
          <div class="dash-row-title">${escapeHtml(e.titulo)}</div>
          <div class="dash-row-sub">${escapeHtml(fmtFechaSolo(e.fecha))}${e.horaInicio ? ' · ' + escapeHtml(e.horaInicio) : ''} · ${escapeHtml(causaShortLabel(e.causa))}${caratuladoTexto(e.causa) ? ' · ' + escapeHtml(caratuladoTexto(e.causa)) : ''}</div>
        </div>
        <span class="stamp evento-estado-${eventoEstadoClass(e.estado)}">${escapeHtml(e.estado)}</span>
      </div>`).join('');
  }

  // ---------- Hoy: reglas simples ----------
  const items = [];
  eventos.forEach(e => {
    if (!isEventoActivo(e)) return;
    if (e.fecha === hoy) items.push({ text: `${e.tipo} hoy: ${e.titulo}`, causaId: e.causaId, tono: 'hoy' });
    else if (e.fecha === manana) items.push({ text: `${e.tipo} mañana: ${e.titulo}`, causaId: e.causaId, tono: 'manana' });
    else if (e.fecha < hoy) items.push({ text: `Evento vencido sin marcar como realizado: ${e.titulo}`, causaId: e.causaId, tono: 'vencido' });
    else if (e.tipo === 'Plazo procesal') {
      const d = daysUntil(e.fecha);
      if (d !== null && d >= 0 && d <= 2) items.push({ text: `Plazo procesal ${d === 0 ? 'hoy' : d === 1 ? 'mañana' : `dentro de ${d} días`}: ${e.titulo}`, causaId: e.causaId, tono: 'plazo' });
    } else if (e.tipo === 'Gestión importante') {
      const d = daysUntil(e.fecha);
      if (d !== null && d >= 0 && d <= 2) items.push({ text: `Gestión importante pendiente: ${e.titulo}`, causaId: e.causaId, tono: 'plazo' });
    }
  });
  // orden: vencidos primero, luego hoy, luego mañana, luego plazos
  const ordenTono = { vencido: 0, hoy: 1, manana: 2, plazo: 3 };
  items.sort((a, b) => (ordenTono[a.tono] ?? 9) - (ordenTono[b.tono] ?? 9));

  const hoyBody = document.getElementById('dash-hoy-body');
  if (items.length === 0) {
    hoyBody.innerHTML = `<div class="dash-empty">Sin pendientes para hoy. Al día 🎉</div>`;
  } else {
    hoyBody.innerHTML = items.slice(0, 8).map(it => `
      <div class="dash-hoy-item dash-hoy-${it.tono}" data-causa-id="${it.causaId}">${escapeHtml(it.text)}</div>`).join('');
  }

  document.querySelectorAll('#dash-row [data-causa-id]').forEach(el => {
    el.addEventListener('click', () => goToCausaAgenda(el.dataset.causaId));
  });
}

// ============================================================================
// AGENDA GLOBAL
// ============================================================================
function agendaFilteredEvents() {
  let events = allEventosFlat();
  if (agendaFilters.causaId) events = events.filter(e => e.causaId === agendaFilters.causaId);
  if (agendaFilters.tipo) events = events.filter(e => e.tipo === agendaFilters.tipo);
  if (agendaFilters.estado) events = events.filter(e => e.estado === agendaFilters.estado);
  if (agendaFilters.prioridad) events = events.filter(e => e.prioridad === agendaFilters.prioridad);
  if (agendaFilters.desde) events = events.filter(e => e.fecha && e.fecha >= agendaFilters.desde);
  if (searchTerm) {
    const st = searchTerm.toLowerCase();
    events = events.filter(e => {
      const hay = [e.titulo, e.causa.rol, e.causa.folio, e.causa.patrocinado, e.causa.demandanteNombre, e.causa.demandadoNombre].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(st);
    });
  }
  return events.sort((a, b) => `${a.fecha || ''}${a.horaInicio || ''}`.localeCompare(`${b.fecha || ''}${b.horaInicio || ''}`));
}

function agendaFilterBarHtml() {
  const causaOptions = CAUSAS.slice().sort((a, b) => (a.titulo || '').localeCompare(b.titulo || ''))
    .map(c => `<option value="${c.id}" ${agendaFilters.causaId === c.id ? 'selected' : ''}>${escapeHtml(c.titulo)}</option>`).join('');
  const tipoOptions = AGENDA_TIPOS.map(t => `<option value="${t}" ${agendaFilters.tipo === t ? 'selected' : ''}>${t}</option>`).join('');
  const estadoOptions = AGENDA_ESTADOS.map(s => `<option value="${s}" ${agendaFilters.estado === s ? 'selected' : ''}>${s}</option>`).join('');
  const prioridadOptions = ['Urgente', 'Semi urgente', 'No prioritario'].map(p => `<option value="${p}" ${agendaFilters.prioridad === p ? 'selected' : ''}>${p}</option>`).join('');

  return `
  <div class="agenda-filterbar">
    <select id="ag-f-causa"><option value="">Todas las causas</option>${causaOptions}</select>
    <select id="ag-f-tipo"><option value="">Todos los tipos</option>${tipoOptions}</select>
    <select id="ag-f-estado"><option value="">Todos los estados</option>${estadoOptions}</select>
    <select id="ag-f-prioridad"><option value="">Toda prioridad</option>${prioridadOptions}</select>
    <input type="date" id="ag-f-desde" value="${escapeHtml(agendaFilters.desde)}" title="Desde">
    <button class="btn small ghost" id="ag-f-clear">Limpiar filtros</button>
  </div>
  <div class="agenda-viewtabs">
    ${['lista', 'mes', 'semana', 'dia'].map(v => `<button class="btn small ${agendaViewMode === v ? 'primary' : ''}" data-view="${v}">${v.charAt(0).toUpperCase() + v.slice(1)}</button>`).join('')}
  </div>`;
}

function agendaEventRowHtml(e) {
  return `<div class="case-card evento-row" data-causa-id="${e.causaId}">
    <div class="case-main">
      <div class="titulo">${AGENDA_TIPO_ICONO[e.tipo] || '•'} ${escapeHtml(e.titulo)}</div>
      <div class="meta">
        <span class="rol">${escapeHtml(causaShortLabel(e.causa))}</span>
        <span>${escapeHtml(e.tipo)}</span>
        ${caratuladoTexto(e.causa) ? `<span>${escapeHtml(caratuladoTexto(e.causa))}</span>` : ''}
        ${e.horaInicio ? `<span>${escapeHtml(e.horaInicio)}</span>` : ''}
      </div>
    </div>
    <div class="case-side" style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
      <span class="stamp evento-estado-${eventoEstadoClass(e.estado)}">${escapeHtml(e.estado)}</span>
      ${e.prioridad ? `<span class="stamp ${priorClass(e.prioridad)}">${escapeHtml(e.prioridad)}</span>` : ''}
      ${googleSyncBadgeHtml(e)}
    </div>
  </div>`;
}

function agendaListViewHtml(events) {
  if (events.length === 0) return `<div class="empty-msg">No hay eventos que coincidan con los filtros actuales.</div>`;
  const grupos = {};
  events.forEach(e => { const k = e.fecha || 'Sin fecha'; (grupos[k] = grupos[k] || []).push(e); });
  return Object.keys(grupos).sort().map(fecha => `
    <div class="section-title" style="font-size:14px; margin-top:16px;">${escapeHtml(fmtFechaSolo(fecha) || fecha)}</div>
    <div class="case-grid">${grupos[fecha].map(agendaEventRowHtml).join('')}</div>`).join('');
}

function startOfWeek(date) {
  const d = new Date(date); const day = (d.getDay() + 6) % 7; // lunes=0
  d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0);
  return d;
}
function toISO(d) { return d.toISOString().slice(0, 10); }

function agendaMonthViewHtml(events) {
  const cursor = agendaCursor;
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startGrid = startOfWeek(first);
  const monthLabel = cursor.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  const byDate = {};
  events.forEach(e => { if (e.fecha) (byDate[e.fecha] = byDate[e.fecha] || []).push(e); });

  let cells = '';
  const hoy = todayISO();
  for (let i = 0; i < 42; i++) {
    const d = new Date(startGrid); d.setDate(startGrid.getDate() + i);
    const iso = toISO(d);
    const inMonth = d.getMonth() === month;
    const dayEvents = byDate[iso] || [];
    cells += `<div class="cal-cell ${inMonth ? '' : 'cal-cell-out'} ${iso === hoy ? 'cal-cell-today' : ''}" data-day="${iso}">
      <div class="cal-daynum">${d.getDate()}</div>
      ${dayEvents.slice(0, 3).map(e => `<div class="cal-chip evento-estado-${eventoEstadoClass(e.estado)}">${escapeHtml(e.titulo)}</div>`).join('')}
      ${dayEvents.length > 3 ? `<div class="cal-more">+${dayEvents.length - 3} más</div>` : ''}
    </div>`;
  }

  return `
  <div class="cal-nav">
    <button class="btn small" id="cal-prev">‹</button>
    <div class="cal-label">${monthLabel}</div>
    <button class="btn small" id="cal-next">›</button>
    <button class="btn small ghost" id="cal-today">Hoy</button>
  </div>
  <div class="cal-grid cal-grid-head">${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(d => `<div>${d}</div>`).join('')}</div>
  <div class="cal-grid">${cells}</div>
  <div id="cal-day-detail"></div>`;
}

function agendaWeekViewHtml(events) {
  const start = startOfWeek(agendaCursor);
  const byDate = {};
  events.forEach(e => { if (e.fecha) (byDate[e.fecha] = byDate[e.fecha] || []).push(e); });
  const hoy = todayISO();
  let cols = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const iso = toISO(d);
    const dayEvents = (byDate[iso] || []).sort((a, b) => (a.horaInicio || '').localeCompare(b.horaInicio || ''));
    cols += `<div class="week-col ${iso === hoy ? 'week-col-today' : ''}">
      <div class="week-col-head">${d.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
      ${dayEvents.length ? dayEvents.map(e => `<div class="cal-chip evento-estado-${eventoEstadoClass(e.estado)}" data-causa-id="${e.causaId}">${e.horaInicio ? escapeHtml(e.horaInicio) + ' · ' : ''}${escapeHtml(e.titulo)}</div>`).join('') : `<div class="week-empty">—</div>`}
    </div>`;
  }
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return `
  <div class="cal-nav">
    <button class="btn small" id="cal-prev">‹</button>
    <div class="cal-label">${start.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
    <button class="btn small" id="cal-next">›</button>
    <button class="btn small ghost" id="cal-today">Hoy</button>
  </div>
  <div class="week-grid">${cols}</div>`;
}

function agendaDayViewHtml(events) {
  const iso = toISO(agendaCursor);
  const dayEvents = events.filter(e => e.fecha === iso).sort((a, b) => (a.horaInicio || '').localeCompare(b.horaInicio || ''));
  return `
  <div class="cal-nav">
    <button class="btn small" id="cal-prev">‹</button>
    <div class="cal-label">${agendaCursor.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
    <button class="btn small" id="cal-next">›</button>
    <button class="btn small ghost" id="cal-today">Hoy</button>
  </div>
  ${dayEvents.length ? `<div class="case-grid">${dayEvents.map(agendaEventRowHtml).join('')}</div>` : `<div class="empty-msg">Sin eventos este día.</div>`}`;
}

function renderAgendaGlobal() {
  const events = agendaFilteredEvents();
  const container = document.getElementById('list-container');

  let bodyHtml = '';
  if (agendaViewMode === 'lista') bodyHtml = agendaListViewHtml(events);
  else if (agendaViewMode === 'mes') bodyHtml = agendaMonthViewHtml(events);
  else if (agendaViewMode === 'semana') bodyHtml = agendaWeekViewHtml(events);
  else if (agendaViewMode === 'dia') bodyHtml = agendaDayViewHtml(events);

  container.innerHTML = `
    <div class="section-title">Agenda <span class="n">${events.length}</span></div>
    ${agendaFilterBarHtml()}
    <div class="agenda-view-body">${bodyHtml}</div>
  `;

  container.querySelector('#ag-f-causa').addEventListener('change', e => { agendaFilters.causaId = e.target.value; renderAgendaGlobal(); });
  container.querySelector('#ag-f-tipo').addEventListener('change', e => { agendaFilters.tipo = e.target.value; renderAgendaGlobal(); });
  container.querySelector('#ag-f-estado').addEventListener('change', e => { agendaFilters.estado = e.target.value; renderAgendaGlobal(); });
  container.querySelector('#ag-f-prioridad').addEventListener('change', e => { agendaFilters.prioridad = e.target.value; renderAgendaGlobal(); });
  container.querySelector('#ag-f-desde').addEventListener('change', e => { agendaFilters.desde = e.target.value; renderAgendaGlobal(); });
  container.querySelector('#ag-f-clear').addEventListener('click', () => { agendaFilters = { causaId: '', tipo: '', estado: '', prioridad: '', desde: '' }; renderAgendaGlobal(); });

  container.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => { agendaViewMode = btn.dataset.view; renderAgendaGlobal(); });
  });

  const prevBtn = container.querySelector('#cal-prev');
  const nextBtn = container.querySelector('#cal-next');
  const todayBtn = container.querySelector('#cal-today');
  function step(delta) {
    if (agendaViewMode === 'mes') agendaCursor.setMonth(agendaCursor.getMonth() + delta);
    else if (agendaViewMode === 'semana') agendaCursor.setDate(agendaCursor.getDate() + delta * 7);
    else agendaCursor.setDate(agendaCursor.getDate() + delta);
    renderAgendaGlobal();
  }
  if (prevBtn) prevBtn.addEventListener('click', () => step(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => step(1));
  if (todayBtn) todayBtn.addEventListener('click', () => { agendaCursor = new Date(); renderAgendaGlobal(); });

  container.querySelectorAll('.cal-cell[data-day]').forEach(cell => {
    cell.addEventListener('click', () => {
      agendaCursor = new Date(cell.dataset.day + 'T00:00:00');
      agendaViewMode = 'dia';
      renderAgendaGlobal();
    });
  });

  container.querySelectorAll('[data-causa-id]').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      goToCausaAgenda(el.dataset.causaId);
    });
  });
}


function detailHtml(c) {
  return `
  <div class="detail-head">
    <div>
      <h2>${escapeHtml(c.titulo)}</h2>
      <div class="rolmono">${headerSubline(c)}</div>
    </div>
    <button class="close-x" id="detail-close">&times;</button>
  </div>
  ${quickActionsHtml(c)}
  <div class="detail-tabs">
    <div class="dtab" data-tab="editar">Antecedentes</div>
    <div class="dtab active" data-tab="resumen">Resumen</div>
    <div class="dtab" data-tab="gestiones">Gestiones</div>
    <div class="dtab" data-tab="agenda">Agenda</div>
    <div class="dtab" data-tab="notificacion">Notificación</div>
    <div class="dtab" data-tab="contacto">Contacto</div>
    <div class="dtab" data-tab="exportar">Exportar ficha</div>
  </div>

  <div class="dtab-content" data-tab="resumen">
    ${c.objetivoApelacion ? `<div class="subhead" style="margin-top:0;">Objetivo de la apelación</div><p class="para">${escapeHtml(c.objetivoApelacion)}</p>` : ''}
    <div class="subhead" style="margin-top:0;">Clave para recordar</div>
    <input type="text" class="ct-input" id="rf-clave" value="${escapeHtml(c.clave || '')}">
    <div class="subhead">Estado actual</div>
    <textarea id="rf-estado" style="width:100%; min-height:80px; background:var(--bg-card); border:1px solid var(--line); color:var(--ink); padding:10px 12px; border-radius:5px; font-size:13.5px; font-family:var(--font-body); line-height:1.6;">${escapeHtml(c.estado || '')}</textarea>
    <div class="subhead">Resumen de la causa</div>
    <textarea id="rf-resumen" style="width:100%; min-height:140px; background:var(--bg-card); border:1px solid var(--line); color:var(--ink); padding:10px 12px; border-radius:5px; font-size:13.5px; font-family:var(--font-body); line-height:1.6;">${escapeHtml(c.resumen || '')}</textarea>

    <div class="subhead">Carpeta de Google Drive</div>
    <div class="drive-box">
      <div class="drive-url ${c.driveFolderUrl ? '' : 'empty'}" id="drive-url-display">${c.driveFolderUrl ? escapeHtml(c.driveFolderUrl) : 'Esta causa aún no tiene una carpeta de Google Drive vinculada.'}</div>
      ${c.driveFolderUrl ? `<button class="btn small" id="btn-open-drive-edit" type="button">Abrir carpeta en Google Drive</button>` : ''}
      <div class="drive-edit-row">
        <input type="text" id="rf-drive-url" placeholder="Pega aquí el enlace de la carpeta de Drive…" value="${escapeHtml(c.driveFolderUrl || '')}">
      </div>
      <div style="font-size:11.5px; color:var(--ink-faint); margin-top:10px;">Este enlace se guarda al presionar "Guardar resumen", junto con el resto de los datos de esta pestaña.</div>
    </div>

    <div class="subhead">Comentarios</div>
    <textarea id="rf-comentarios" style="width:100%; min-height:80px; background:var(--bg-card); border:1px solid var(--line); color:var(--ink); padding:10px 12px; border-radius:5px; font-size:13.5px; font-family:var(--font-body); line-height:1.6;">${escapeHtml(c.comentarios || '')}</textarea>
    <div class="subhead">Observaciones de traspaso</div>
    <textarea id="rf-traspaso" placeholder="Información útil para quien reciba la causa después (no genera gestiones ni eventos)…" style="width:100%; min-height:70px; background:var(--bg-card); border:1px solid var(--line); color:var(--ink); padding:10px 12px; border-radius:5px; font-size:13.5px; font-family:var(--font-body); line-height:1.6;">${escapeHtml(c.observacionesTraspaso || '')}</textarea>
    <div style="margin-top:10px;">
      <button class="btn small primary" id="save-resumen">Guardar resumen</button>
    </div>

    <div class="subhead" style="margin-top:22px;">Próximos hitos</div>
    <div id="hitos-container">${hitosHtml(c)}</div>
    <div class="add-row">
      <input type="text" id="new-hito" placeholder="Agregar hito del flujo esperado…">
      <button class="btn small" id="add-hito">Agregar</button>
    </div>
  </div>

  <div class="dtab-content" data-tab="gestiones">
    <div class="agenda-toolbar">
      <button class="btn small primary" id="add-gestion">+ Nueva gestión</button>
    </div>
    <div id="gestion-form-wrap" class="agenda-form-wrap" hidden></div>
    <div id="gestion-list-wrap">${pendientesHtml(c)}</div>

    <div class="subhead" style="margin-top:26px; display:flex; align-items:center; justify-content:space-between;">
      <span>Instrucciones del tutor <span style="color:var(--ink-faint); font-weight:400; text-transform:none; font-family:var(--font-body);">(antecedente histórico)</span></span>
    </div>
    <div class="agenda-toolbar">
      <button class="btn small" id="add-instr">+ Nueva instrucción</button>
    </div>
    <div id="instr-form-wrap" class="agenda-form-wrap" hidden></div>
    <div id="instr-list-wrap">${instruccionesListHtml(c)}</div>

    <div class="subhead" style="margin-top:26px;">Cronología jurídica</div>
    <div id="tl-cronologia">${cronologiaHtml(c)}</div>
    <div class="add-row">
      <input type="text" id="new-cron" placeholder="Registrar actuación (incluye la fecha en el texto si corresponde)…">
      <button class="btn small" id="add-cron">Registrar</button>
    </div>
  </div>

  <div class="dtab-content" data-tab="notificacion">
    <div class="field-row">
      <div class="field">
        <div class="k">Estado de notificación</div>
        <select class="ct-input" id="nt-estado">
          <option value="">Sin definir</option>
          <option value="Notificado">Notificado</option>
          <option value="Pendiente">Pendiente</option>
        </select>
      </div>
      <div class="field"><div class="k">Nombre</div><input type="text" class="ct-input" id="nt-nombre" value="${escapeHtml(c.notifNombre || '')}" placeholder="Persona a notificar"></div>
    </div>
    <div class="subhead">Domicilios y búsquedas</div>
    <div class="notif-table-wrap">
      <table class="notif-table">
        <thead><tr>
          <th class="col-domicilio">Domicilio</th><th>Estado</th><th>Fecha</th><th>Folio</th><th>Informado por</th><th class="col-del"></th>
        </tr></thead>
        <tbody id="notif-tbody">${notifRowsHtml(c)}</tbody>
      </table>
    </div>
    <div style="margin-top:10px;">
      <button class="btn small" id="add-domicilio">+ Agregar domicilio</button>
    </div>
    <div style="margin-top:14px;">
      <button class="btn small primary" id="save-notificacion">Guardar notificación</button>
    </div>
  </div>

  <div class="dtab-content" data-tab="contacto">
    <div class="contact-grid">
      <div class="field"><div class="k">Patrocinado</div><input type="text" class="ct-input" id="ct-patrocinado" value="${escapeHtml(c.patrocinado || '')}"></div>
      <div class="field"><div class="k">RUT</div><input type="text" class="ct-input" id="ct-rut" value="${escapeHtml(c.rut || '')}"></div>
      <div class="field"><div class="k">Correo</div><input type="text" class="ct-input" id="ct-correo" value="${escapeHtml(c.correo || '')}"></div>
      <div class="field"><div class="k">Correo alternativo</div><input type="text" class="ct-input" id="ct-correoAlt" value="${escapeHtml(c.correoAlt || '')}"></div>
      <div class="field"><div class="k">Clave portal PJUD</div><input type="text" class="ct-input" id="ct-claveWeb" value="${escapeHtml(c.claveWeb || '')}"></div>
      <div class="field"><div class="k">Clave única</div><input type="text" class="ct-input" id="ct-claveUnica" value="${escapeHtml(c.claveUnica || '')}"></div>
      <div class="field"><div class="k">Teléfono</div><input type="text" class="ct-input" id="ct-telefono" value="${escapeHtml(c.telefono || '')}"></div>
      <div class="field"><div class="k">Nota</div><input type="text" class="ct-input" id="ct-nota" value="${escapeHtml(c.nota || '')}"></div>
      <div class="field"><div class="k">Tutor</div><input type="text" class="ct-input" id="ct-tutor" value="${escapeHtml(c.tutor || '')}"></div>
      <div class="field"><div class="k">Fecha ingreso causa</div><input type="text" class="ct-input" id="ct-fechaIngreso" value="${escapeHtml(c.fechaIngreso || '')}" placeholder="AAAA-MM-DD"></div>
    </div>
    <div style="margin-top:14px;">
      <button class="btn small primary" id="save-contacto">Guardar contacto</button>
    </div>
  </div>

  <div class="dtab-content" data-tab="agenda">
    <div class="agenda-toolbar">
      <button class="btn small primary" id="add-evento">+ Nuevo evento</button>
    </div>
    <div id="agenda-form-wrap" class="agenda-form-wrap" hidden></div>
    <div id="agenda-list-wrap">${agendaListHtml(c)}</div>
  </div>

  <div class="dtab-content active" data-tab="editar">
    <div class="modal-form">
      <div class="form-grid4">
        <div>
          <label>Código SAJ</label>
          <input type="text" inputmode="numeric" id="an-saj" class="saj-input" value="${escapeHtml(c.folio || '')}" placeholder="Solo números">
        </div>
        <div>
          <label>Etapa</label>
          <input type="text" id="an-etapa" value="${escapeHtml(c.etapa || '')}">
        </div>
        <div>
          <label>Materia</label>
          <input type="text" id="an-materia" value="${escapeHtml(c.materia || '')}">
        </div>
        <div>
          <label>BAJ</label>
          <select id="an-baj">
            <option value="">Sin definir</option>
            ${BAJ_OPCIONES.map(([v, l]) => `<option value="${v}" ${c.bajEstado === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid2">
        <div>
          <label>Recurso</label>
          <input type="text" id="an-recurso" value="${escapeHtml(c.recurso || '')}" placeholder="Ej: Apelación">
        </div>
        <div>
          <label>ROL ingreso Corte</label>
          <input type="text" id="an-rolingreso" value="${escapeHtml(c.rolIngreso || '')}" placeholder="Ej: 9315-2025">
        </div>
      </div>

      <div class="form-grid2">
        <div>
          <label>Título / referencia de la causa</label>
          <input type="text" id="ed-titulo" value="${escapeHtml(c.titulo)}" placeholder="Ej: Pérez / J.O. Menor Cuantía / Indemnización">
        </div>
        <div>
          <label>ROL</label>
          <input type="text" id="ed-rol" value="${escapeHtml(c.rol || '')}" placeholder="Ej: C-10560-2026">
        </div>
      </div>
      <div class="form-grid2">
        <div>
          <label>Carpeta</label>
          <select id="ed-categoria">
            <option value="tramitacion">En tramitación</option>
            <option value="nueva">Nueva (redacción)</option>
            <option value="terminada">Terminada</option>
          </select>
        </div>
        <div>
          <label>Tipo de juicio</label>
          <select id="ed-subcategoria">
            <option value="">Sin definir</option>
            <option value="Juicio Ejecutivo">Juicio Ejecutivo</option>
            <option value="Juicio Ordinario">Juicio Ordinario</option>
            <option value="Juicio Sumario">Juicio Sumario</option>
            <option value="Voluntario">Voluntario</option>
            <option value="Extrajudicial">Extrajudicial</option>
          </select>
        </div>
      </div>

      <div>
        <label>Prioridad de la causa</label>
        <select id="ed-prioridad">
          <option value="">Sin definir</option>
          <option value="Urgente">Urgente</option>
          <option value="Semi urgente">Semi urgente</option>
          <option value="No prioritario">No prioritaria</option>
        </select>
      </div>
      <div style="font-size:11px; color:var(--ink-faint); margin-top:-4px;">Se define manualmente. Clasifica visualmente tu cartera de causas; no depende de ninguna instrucción ni fecha límite.</div>

      <div class="subhead" style="margin-top:10px;">Tribunal</div>
      <div class="form-grid2">
        <div>
          <label>Tipo de tribunal</label>
          <select id="ed-tipotribunal">
            <option value="">Sin definir</option>
            <option value="Juzgado Civil">Juzgado Civil</option>
            <option value="Juzgado de Familia">Juzgado de Familia</option>
            <option value="Juzgado de Letras del Trabajo">Juzgado de Letras del Trabajo</option>
            <option value="Juzgado de Cobranza Laboral y Previsional">Juzgado de Cobranza Laboral y Previsional</option>
            <option value="Tribunal Tributario y Aduanero">Tribunal Tributario y Aduanero</option>
            <option value="Juzgado de Policía Local">Juzgado de Policía Local</option>
            <option value="Corte de Apelaciones">Corte de Apelaciones</option>
            <option value="Corte Suprema">Corte Suprema</option>
            <option value="Otro">Otro</option>
          </select>
        </div>
        <div>
          <label>Número (si corresponde)</label>
          <input type="text" id="ed-numerotribunal" value="${escapeHtml(c.numeroTribunal || '')}" placeholder="Ej: 2, 19, 28">
        </div>
      </div>
      <div>
        <label>Ciudad o jurisdicción</label>
        <input type="text" id="ed-ciudadtribunal" value="${escapeHtml(c.ciudadTribunal || '')}" placeholder="Ej: Santiago, San Miguel, Puente Alto">
      </div>
      <div style="font-size:11px; color:var(--ink-faint); margin-top:-4px;" id="ed-tribunal-preview">Se mostrará como: <strong>${escapeHtml(tribunalTexto(c) || 'Sin definir')}</strong></div>
      ${(!c.tipoTribunal && c.tribunal) ? `<div style="font-size:11px; color:var(--ink-faint);">Tribunal registrado anteriormente (texto libre, aún sin normalizar): ${escapeHtml(c.tribunal)}</div>` : ''}

      <div class="subhead" style="margin-top:10px;">Caratulado procesal</div>
      ${!tieneRolProcesalDefinido(c) && (c.patrocinado || c.contraparteNombre) ? `<div style="font-size:11.5px; color:var(--semi); background:var(--semi-bg); border-radius:5px; padding:8px 10px; margin-bottom:4px;">Pendiente definir posición procesal de las partes.</div>` : ''}
      <div class="form-grid2">
        <div>
          <label>Demandante</label>
          <input type="text" id="ed-demandante" value="${escapeHtml(c.demandanteNombre || '')}" placeholder="Nombre completo">
        </div>
        <div>
          <label>Demandado</label>
          <input type="text" id="ed-demandado" value="${escapeHtml(c.demandadoNombre || '')}" placeholder="Nombre completo">
        </div>
      </div>
      <div>
        <label>Parte que represento</label>
        <select id="ed-parterepresentada">
          <option value="">Sin definir</option>
          <option value="Demandante">Demandante</option>
          <option value="Demandado">Demandado</option>
        </select>
      </div>
      <div style="font-size:11px; color:var(--ink-faint); margin-top:-4px;" id="ed-caratulado-preview">Caratulado: <strong>${escapeHtml(caratuladoTexto(c) || 'Sin definir')}</strong></div>
      ${c.contraparteNombre && !c.demandanteNombre && !c.demandadoNombre ? `<div style="font-size:11px; color:var(--ink-faint);">Contraparte registrada anteriormente (respaldo, sin posición procesal): ${escapeHtml(c.contraparteNombre)}</div>` : ''}

      <div class="subhead" style="margin-top:10px; display:flex; align-items:center; justify-content:space-between;">
        <span>Última revisión PJUD</span>
        <button class="btn small" id="btn-actualizar-revision" type="button">Actualizar revisión</button>
      </div>
      <div style="font-size:12.5px; color:var(--ink-dim);" id="ultima-revision-display">${c.ultimaRevisionAt ? escapeHtml(fmtFechaHora(c.ultimaRevisionAt)) : 'Aún no registrada.'}</div>

      <button class="btn primary" id="save-edit">Guardar cambios</button>
      <button class="btn danger" id="delete-causa">Eliminar esta causa del panel</button>
    </div>
  </div>

  <div class="dtab-content" data-tab="exportar">
    <div class="export-toolbar">
      <button class="btn small primary" id="btn-print-ficha">Imprimir</button>
      <button class="btn small" id="btn-pdf-ficha">Descargar PDF</button>
    </div>
    <div id="ficha-print-area">${fichaHtml(c)}</div>
  </div>
  `;
}

function openDetail(id, tab) {
  const c = findCausa(id);
  if (!c) return;
  document.getElementById('detail-panel').innerHTML = detailHtml(c);
  document.getElementById('overlay').classList.add('show');
  wireDetailEvents(c);
  const activeTab = tab || 'editar';
  const tabEl = document.querySelector(`.dtab[data-tab="${activeTab}"]`);
  if (tabEl) tabEl.click();
}

function closeOverlay() {
  document.getElementById('overlay').classList.remove('show');
}

function wireDetailEvents(c) {
  const panel = document.getElementById('detail-panel');
  panel.querySelector('#detail-close').addEventListener('click', closeOverlay);

  panel.querySelectorAll('.dtab').forEach(tab => {
    tab.addEventListener('click', () => {
      panel.querySelectorAll('.dtab').forEach(t => t.classList.remove('active'));
      panel.querySelectorAll('.dtab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      panel.querySelector(`.dtab-content[data-tab="${tab.dataset.tab}"]`).classList.add('active');
      lastDetailTab = tab.dataset.tab;
    });
  });

  const catSel = panel.querySelector('#ed-categoria'); if (catSel) catSel.value = c.categoria;
  const subcatSel = panel.querySelector('#ed-subcategoria'); if (subcatSel) subcatSel.value = c.subcategoria || '';
  const prioridadSel = panel.querySelector('#ed-prioridad'); if (prioridadSel) prioridadSel.value = c.prioridad || '';
  const tipoTribunalSel = panel.querySelector('#ed-tipotribunal'); if (tipoTribunalSel) tipoTribunalSel.value = c.tipoTribunal || '';

  function refreshTribunalPreview() {
    const preview = panel.querySelector('#ed-tribunal-preview');
    if (!preview) return;
    const tipo = panel.querySelector('#ed-tipotribunal').value;
    const numero = panel.querySelector('#ed-numerotribunal').value.trim();
    const ciudad = panel.querySelector('#ed-ciudadtribunal').value.trim();
    const texto = tribunalTexto({ tipoTribunal: tipo || null, numeroTribunal: numero || null, ciudadTribunal: ciudad || null, tribunal: c.tribunal });
    preview.innerHTML = `Se mostrará como: <strong>${escapeHtml(texto || 'Sin definir')}</strong>`;
  }
  ['#ed-tipotribunal', '#ed-numerotribunal', '#ed-ciudadtribunal'].forEach(sel => {
    const el = panel.querySelector(sel);
    if (el) el.addEventListener('input', refreshTribunalPreview);
  });

  const parteRepSel = panel.querySelector('#ed-parterepresentada'); if (parteRepSel) parteRepSel.value = c.parteRepresentada || '';
  function refreshCaratuladoPreview() {
    const preview = panel.querySelector('#ed-caratulado-preview');
    if (!preview) return;
    const dte = panel.querySelector('#ed-demandante').value.trim();
    const ddo = panel.querySelector('#ed-demandado').value.trim();
    const texto = caratuladoTexto({ demandanteNombre: dte || null, demandadoNombre: ddo || null, patrocinado: c.patrocinado, contraparteNombre: c.contraparteNombre });
    preview.innerHTML = `Caratulado: <strong>${escapeHtml(texto || 'Sin definir')}</strong>`;
  }
  ['#ed-demandante', '#ed-demandado'].forEach(sel => {
    const el = panel.querySelector(sel);
    if (el) el.addEventListener('input', refreshCaratuladoPreview);
  });

  const notifEstadoSel = panel.querySelector('#nt-estado'); if (notifEstadoSel) notifEstadoSel.value = c.notifEstado || '';

  // ---------- Accesos rápidos ----------
  panel.querySelector('[data-action="qa-drive"]').addEventListener('click', () => {
    if (c.driveFolderUrl) window.open(c.driveFolderUrl, '_blank', 'noopener,noreferrer');
    else toast('Esta causa aún no tiene una carpeta de Drive vinculada');
  });
  panel.querySelector('[data-action="qa-saj"]').addEventListener('click', () => {
    window.open(SAJ_APP_URL, '_blank', 'noopener,noreferrer');
  });
  panel.querySelector('[data-action="qa-pjud"]').addEventListener('click', () => {
    window.open(PJUD_APP_URL, '_blank', 'noopener,noreferrer');
  });
  panel.querySelector('[data-action="qa-gmail"]').addEventListener('click', () => {
    window.open(GMAIL_URL, '_blank', 'noopener,noreferrer');
  });

  // ---------- Código SAJ: solo números ----------
  panel.querySelectorAll('.saj-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const digitsOnly = inp.value.replace(/\D/g, '');
      if (inp.value !== digitsOnly) inp.value = digitsOnly;
    });
  });

  // ---------- Próximos hitos ----------
  panel.querySelectorAll('[data-action="toggle-hito"]').forEach(chk => {
    chk.addEventListener('change', async () => {
      const id = chk.dataset.id;
      const h = (c.hitos || []).find(x => x.id === id);
      if (!h) return;
      h.completado = chk.checked;
      try { await api.toggleHito(id, chk.checked); } catch (e) { toast('No se pudo guardar'); }
      chk.closest('.hito-item').classList.toggle('completado', chk.checked);
    });
  });
  panel.querySelectorAll('[data-action="del-hito"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        await api.deleteHito(id);
        c.hitos = (c.hitos || []).filter(h => h.id !== id);
        panel.querySelector('#hitos-container').innerHTML = hitosHtml(c);
        wireHitosEvents(c, panel);
      } catch (e) { toast('No se pudo eliminar'); }
    });
  });
  const addHitoBtn = panel.querySelector('#add-hito');
  if (addHitoBtn) addHitoBtn.addEventListener('click', async () => {
    const inp = panel.querySelector('#new-hito');
    const val = inp.value.trim();
    if (!val) return;
    try {
      const orden = (c.hitos || []).length;
      const nuevo = await api.addHito(CURRENT_USER.id, c.id, val, orden);
      c.hitos = c.hitos || [];
      c.hitos.push({ id: nuevo.id, descripcion: nuevo.descripcion, orden: nuevo.orden, completado: nuevo.completado });
      inp.value = '';
      panel.querySelector('#hitos-container').innerHTML = hitosHtml(c);
      wireHitosEvents(c, panel);
      toast('Hito agregado');
    } catch (e) { toast('No se pudo agregar el hito'); }
  });

  // ---------- Resumen ----------
  const saveResumen = panel.querySelector('#save-resumen');
  if (saveResumen) saveResumen.addEventListener('click', async () => {
    const patch = {
      clave: panel.querySelector('#rf-clave').value.trim() || null,
      estado: panel.querySelector('#rf-estado').value.trim() || null,
      resumen: panel.querySelector('#rf-resumen').value.trim() || null,
      driveFolderUrl: panel.querySelector('#rf-drive-url').value.trim() || null,
      comentarios: panel.querySelector('#rf-comentarios').value.trim() || null,
      observacionesTraspaso: panel.querySelector('#rf-traspaso').value.trim() || null
    };
    try {
      await api.updateCausa(c.id, patch);
      Object.assign(c, patch);
      toast('Resumen guardado');
      render();
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });

  // ---------- Gestiones (unidad de trabajo) ----------
  wireGestionesTab(c, panel);
  // ---------- Instrucciones del tutor (historial) ----------
  wireInstruccionesTab(c, panel);
  wireCronologiaEvents(c, panel);

  // ---------- Notificación ----------
  function collectNotificacion() {
    const rows = panel.querySelectorAll('#notif-tbody tr');
    const newDomicilios = [];
    rows.forEach(tr => {
      const domicilio = tr.querySelector('.nd-domicilio').value.trim();
      const estado = tr.querySelector('.nd-estado').value;
      const fecha = tr.querySelector('.nd-fecha').value;
      const folio = tr.querySelector('.nd-folio').value.trim();
      const informadoPor = tr.querySelector('.nd-informado').value.trim();
      if (domicilio || estado || fecha || folio || informadoPor) {
        newDomicilios.push({ domicilio: domicilio || null, estado: estado || null, fecha: fecha || null, folio: folio || null, informadoPor: informadoPor || null });
      }
    });
    return newDomicilios;
  }

  const saveNotif = panel.querySelector('#save-notificacion');
  if (saveNotif) saveNotif.addEventListener('click', async () => {
    const domicilios = collectNotificacion();
    const patch = { notifEstado: panel.querySelector('#nt-estado').value || null, notifNombre: panel.querySelector('#nt-nombre').value.trim() || null };
    try {
      await api.updateCausa(c.id, patch);
      await api.replaceDomicilios(CURRENT_USER.id, c.id, domicilios);
      Object.assign(c, patch);
      c.domicilios = domicilios;
      toast('Notificación guardada');
      render();
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });

  const addDomicilio = panel.querySelector('#add-domicilio');
  if (addDomicilio) addDomicilio.addEventListener('click', async () => {
    const domicilios = collectNotificacion();
    domicilios.push({ domicilio: null, estado: null, fecha: null, folio: null, informadoPor: null });
    try {
      await api.replaceDomicilios(CURRENT_USER.id, c.id, domicilios);
      c.domicilios = domicilios;
      openDetail(c.id, 'notificacion');
    } catch (e) { toast('No se pudo agregar: ' + e.message); }
  });

  panel.querySelectorAll('[data-action="del-domicilio"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domicilios = collectNotificacion();
      const idx = parseInt(btn.dataset.idx, 10);
      domicilios.splice(idx, 1);
      try {
        await api.replaceDomicilios(CURRENT_USER.id, c.id, domicilios);
        c.domicilios = domicilios;
        openDetail(c.id, 'notificacion');
      } catch (e) { toast('No se pudo eliminar: ' + e.message); }
    });
  });

  // ---------- Contacto ----------
  const saveContacto = panel.querySelector('#save-contacto');
  if (saveContacto) saveContacto.addEventListener('click', async () => {
    const patch = {
      patrocinado: panel.querySelector('#ct-patrocinado').value.trim() || null,
      rut: panel.querySelector('#ct-rut').value.trim() || null,
      correo: panel.querySelector('#ct-correo').value.trim() || null,
      correoAlt: panel.querySelector('#ct-correoAlt').value.trim() || null,
      claveWeb: panel.querySelector('#ct-claveWeb').value.trim() || null,
      claveUnica: panel.querySelector('#ct-claveUnica').value.trim() || null,
      telefono: panel.querySelector('#ct-telefono').value.trim() || null,
      nota: panel.querySelector('#ct-nota').value.trim() || null,
      tutor: panel.querySelector('#ct-tutor').value.trim() || null,
      fechaIngreso: panel.querySelector('#ct-fechaIngreso').value.trim() || null
    };
    try { await api.updateCausa(c.id, patch); Object.assign(c, patch); toast('Contacto guardado'); render(); }
    catch (e) { toast('No se pudo guardar: ' + e.message); }
  });

  // ---------- Agenda (eventos de la causa) ----------
  wireAgendaTab(c, panel);

  // ---------- Editar (incluye título, carpeta, tipo de juicio, SAJ, ROL Corte y Drive) ----------
  const btnOpenDriveEdit = panel.querySelector('#btn-open-drive-edit');
  if (btnOpenDriveEdit) btnOpenDriveEdit.addEventListener('click', () => window.open(c.driveFolderUrl, '_blank', 'noopener,noreferrer'));

  const btnActualizarRevision = panel.querySelector('#btn-actualizar-revision');
  if (btnActualizarRevision) btnActualizarRevision.addEventListener('click', async () => {
    try {
      const now = new Date().toISOString();
      await api.updateCausa(c.id, { ultimaRevisionAt: now });
      c.ultimaRevisionAt = now;
      const disp = panel.querySelector('#ultima-revision-display');
      if (disp) disp.textContent = fmtFechaHora(now);
      toast('Revisión actualizada');
      render();
    } catch (e) { toast('No se pudo actualizar: ' + e.message); }
  });

  const saveEdit = panel.querySelector('#save-edit');
  if (saveEdit) saveEdit.addEventListener('click', async () => {
    const demandanteNombre = panel.querySelector('#ed-demandante').value.trim() || null;
    const demandadoNombre = panel.querySelector('#ed-demandado').value.trim() || null;
    const parteRepresentada = panel.querySelector('#ed-parterepresentada').value || null;
    const patch = {
      folio: panel.querySelector('#an-saj').value.trim() || null,
      etapa: panel.querySelector('#an-etapa').value.trim() || null,
      materia: panel.querySelector('#an-materia').value.trim() || null,
      bajEstado: panel.querySelector('#an-baj').value || null,
      recurso: panel.querySelector('#an-recurso').value.trim() || null,
      rolIngreso: panel.querySelector('#an-rolingreso').value.trim() || null,
      titulo: panel.querySelector('#ed-titulo').value.trim() || c.titulo,
      rol: panel.querySelector('#ed-rol').value.trim() || null,
      categoria: panel.querySelector('#ed-categoria').value,
      subcategoria: panel.querySelector('#ed-subcategoria').value || null,
      prioridad: panel.querySelector('#ed-prioridad').value || null,
      tipoTribunal: panel.querySelector('#ed-tipotribunal').value || null,
      numeroTribunal: panel.querySelector('#ed-numerotribunal').value.trim() || null,
      ciudadTribunal: panel.querySelector('#ed-ciudadtribunal').value.trim() || null,
      demandanteNombre, demandadoNombre, parteRepresentada
    };
    // Sincroniza "patrocinado" automáticamente según la parte representada,
    // sin duplicar el dato manualmente (se sigue mostrando en Contacto).
    if (parteRepresentada === 'Demandante' && demandanteNombre) patch.patrocinado = demandanteNombre;
    else if (parteRepresentada === 'Demandado' && demandadoNombre) patch.patrocinado = demandadoNombre;
    try {
      await api.updateCausa(c.id, patch);
      Object.assign(c, patch);
      toast('Cambios guardados');
      render();
      closeOverlay();
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });

  // ---------- Exportar ficha ----------
  const btnPrint = panel.querySelector('#btn-print-ficha');
  if (btnPrint) btnPrint.addEventListener('click', () => window.print());

  const btnPdf = panel.querySelector('#btn-pdf-ficha');
  if (btnPdf) btnPdf.addEventListener('click', async () => {
    btnPdf.disabled = true;
    const originalText = btnPdf.textContent;
    btnPdf.textContent = 'Generando…';
    try {
      const data = buildFichaData(c);
      const pdf = renderFichaPdf(data);
      const nombreArchivo = `ficha-${(c.rol || c.titulo || 'causa').replace(/[^\w-]+/g, '_')}.pdf`;
      pdf.save(nombreArchivo);
    } catch (e) {
      toast('No se pudo generar el PDF: ' + e.message);
    } finally {
      btnPdf.disabled = false;
      btnPdf.textContent = originalText;
    }
  });

  const delBtn = panel.querySelector('#delete-causa');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('¿Eliminar esta causa del panel? Esta acción no se puede deshacer.')) return;
    try {
      await api.deleteCausa(c.id);
      CAUSAS = CAUSAS.filter(x => x.id !== c.id);
      toast('Causa eliminada');
      render();
      closeOverlay();
    } catch (e) { toast('No se pudo eliminar: ' + e.message); }
  });
}

function wireHitosEvents(c, panel) {
  panel.querySelectorAll('[data-action="toggle-hito"]').forEach(chk => {
    chk.addEventListener('change', async () => {
      const id = chk.dataset.id;
      const h = (c.hitos || []).find(x => x.id === id);
      if (!h) return;
      h.completado = chk.checked;
      try { await api.toggleHito(id, chk.checked); } catch (e) { toast('No se pudo guardar'); }
      chk.closest('.hito-item').classList.toggle('completado', chk.checked);
    });
  });
  panel.querySelectorAll('[data-action="del-hito"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        await api.deleteHito(id);
        c.hitos = (c.hitos || []).filter(h => h.id !== id);
        panel.querySelector('#hitos-container').innerHTML = hitosHtml(c);
        wireHitosEvents(c, panel);
      } catch (e) { toast('No se pudo eliminar'); }
    });
  });
}

function wireGestionesTab(c, panel) {
  const formWrap = panel.querySelector('#gestion-form-wrap');
  const listWrap = panel.querySelector('#gestion-list-wrap');
  if (!formWrap || !listWrap) return;

  function closeForm() { formWrap.hidden = true; formWrap.innerHTML = ''; }

  function openForm(gestion) {
    formWrap.innerHTML = gestionFormHtml(gestion);
    formWrap.hidden = false;
    formWrap.querySelector('#cancel-gestion').addEventListener('click', closeForm);
    formWrap.querySelector('#save-gestion').addEventListener('click', async () => {
      const patch = {
        descripcion: formWrap.querySelector('#gf-descripcion').value.trim(),
        categoria: formWrap.querySelector('#gf-categoria').value.trim() || null,
        prioridad: formWrap.querySelector('#gf-prioridad').value || null,
        estado: formWrap.querySelector('#gf-estado').value,
        fechaRevision: formWrap.querySelector('#gf-fecharevision').value || null,
        fechaLimite: formWrap.querySelector('#gf-fechalimite').value || null,
        driveLink: formWrap.querySelector('#gf-drivelink').value.trim() || null,
        observaciones: formWrap.querySelector('#gf-observaciones').value.trim() || null
      };
      if (!patch.descripcion) { toast('La gestión necesita una descripción'); return; }
      try {
        if (gestion) {
          const actualizado = await api.updateGestionPendiente(gestion.id, patch);
          const idx = c.gestionesPendientes.findIndex(x => x.id === gestion.id);
          if (idx >= 0) c.gestionesPendientes[idx] = { id: actualizado.id, descripcion: actualizado.descripcion, driveLink: actualizado.drive_link, categoria: actualizado.categoria, prioridad: actualizado.prioridad, estado: actualizado.estado, fechaRevision: actualizado.fecha_revision, fechaLimite: actualizado.fecha_limite, observaciones: actualizado.observaciones, createdAt: actualizado.created_at };
          toast('Gestión actualizada');
        } else {
          const nuevo = await api.createGestion(CURRENT_USER.id, c.id, patch);
          c.gestionesPendientes = c.gestionesPendientes || [];
          c.gestionesPendientes.push({ id: nuevo.id, descripcion: nuevo.descripcion, driveLink: nuevo.drive_link, categoria: nuevo.categoria, prioridad: nuevo.prioridad, estado: nuevo.estado, fechaRevision: nuevo.fecha_revision, fechaLimite: nuevo.fecha_limite, observaciones: nuevo.observaciones, createdAt: nuevo.created_at });
          toast('Gestión creada');
        }
        closeForm();
        listWrap.innerHTML = pendientesHtml(c);
        wireGestionListButtons(c, panel, openForm, listWrap);
        render();
      } catch (err) { toast('No se pudo guardar la gestión: ' + err.message); }
    });
  }

  panel.querySelector('#add-gestion').addEventListener('click', () => openForm(null));
  wireGestionListButtons(c, panel, openForm, listWrap);
}

function wireGestionListButtons(c, panel, openForm, listWrap) {
  listWrap.querySelectorAll('[data-action="edit-gestion"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = (c.gestionesPendientes || []).find(x => x.id === btn.dataset.id);
      if (g) openForm(g);
    });
  });
  listWrap.querySelectorAll('[data-action="delete-gestion"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta gestión?')) return;
      try {
        await api.deleteGestionPendiente(btn.dataset.id);
        c.gestionesPendientes = (c.gestionesPendientes || []).filter(x => x.id !== btn.dataset.id);
        listWrap.innerHTML = pendientesHtml(c);
        wireGestionListButtons(c, panel, openForm, listWrap);
        toast('Gestión eliminada');
        render();
      } catch (err) { toast('No se pudo eliminar: ' + err.message); }
    });
  });
  listWrap.querySelectorAll('[data-action="agenda-gestion"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = (c.gestionesPendientes || []).find(x => x.id === btn.dataset.id);
      if (!g) return;
      const tabEl = panel.querySelector('.dtab[data-tab="agenda"]');
      if (tabEl) tabEl.click();
      const addBtn = panel.querySelector('#add-evento');
      if (addBtn) addBtn.click();
      setTimeout(() => {
        const tituloInput = panel.querySelector('#ev-titulo');
        if (tituloInput) tituloInput.value = g.descripcion;
      }, 0);
      toast('Completa la fecha del evento en la Agenda');
    });
  });
}

function wireInstruccionesTab(c, panel) {
  const formWrap = panel.querySelector('#instr-form-wrap');
  const listWrap = panel.querySelector('#instr-list-wrap');
  if (!formWrap || !listWrap) return;

  function closeForm() { formWrap.hidden = true; formWrap.innerHTML = ''; }

  function openForm(instr) {
    formWrap.innerHTML = instruccionFormHtml(instr);
    formWrap.hidden = false;
    formWrap.querySelector('#cancel-instr').addEventListener('click', closeForm);
    formWrap.querySelector('#save-instr').addEventListener('click', async () => {
      const patch = {
        tutor: formWrap.querySelector('#if-tutor').value.trim() || null,
        fecha: formWrap.querySelector('#if-fecha').value || todayISO(),
        instruccion: formWrap.querySelector('#if-instruccion').value.trim(),
        fechaLimite: formWrap.querySelector('#if-fechalimite').value || null,
        estado: formWrap.querySelector('#if-estado').value
      };
      if (!patch.instruccion) { toast('La instrucción no puede quedar vacía'); return; }
      try {
        if (instr) {
          const actualizado = await api.updateInstruccion(instr.id, patch);
          const idx = c.instrucciones.findIndex(x => x.id === instr.id);
          if (idx >= 0) c.instrucciones[idx] = actualizado;
          toast('Instrucción actualizada');
        } else {
          const nueva = await api.createInstruccion(CURRENT_USER.id, c.id, patch);
          c.instrucciones = c.instrucciones || [];
          c.instrucciones.unshift(nueva);
          toast('Instrucción registrada');
        }
        closeForm();
        listWrap.innerHTML = instruccionesListHtml(c);
        wireInstruccionListButtons(c, panel, openForm, listWrap);
      } catch (err) { toast('No se pudo guardar: ' + err.message); }
    });
  }

  panel.querySelector('#add-instr').addEventListener('click', () => openForm(null));
  wireInstruccionListButtons(c, panel, openForm, listWrap);
}

function wireInstruccionListButtons(c, panel, openForm, listWrap) {
  listWrap.querySelectorAll('[data-action="edit-instr"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const it = (c.instrucciones || []).find(x => x.id === btn.dataset.id);
      if (it) openForm(it);
    });
  });
  listWrap.querySelectorAll('[data-action="cumplir-instr"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const actualizado = await api.updateInstruccion(btn.dataset.id, { estado: 'Cumplida' });
        const idx = c.instrucciones.findIndex(x => x.id === btn.dataset.id);
        if (idx >= 0) c.instrucciones[idx] = actualizado;
        listWrap.innerHTML = instruccionesListHtml(c);
        wireInstruccionListButtons(c, panel, openForm, listWrap);
        toast('Instrucción marcada como cumplida');
      } catch (err) { toast('No se pudo actualizar: ' + err.message); }
    });
  });
  listWrap.querySelectorAll('[data-action="delete-instr"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta instrucción del historial?')) return;
      try {
        await api.deleteInstruccion(btn.dataset.id);
        c.instrucciones = (c.instrucciones || []).filter(x => x.id !== btn.dataset.id);
        listWrap.innerHTML = instruccionesListHtml(c);
        wireInstruccionListButtons(c, panel, openForm, listWrap);
        toast('Instrucción eliminada');
      } catch (err) { toast('No se pudo eliminar: ' + err.message); }
    });
  });
}

function wireCronologiaEvents(c, panel) {
  panel.querySelectorAll('[data-action="edit-cron"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = panel.querySelector(`.cron-item[data-cron-id="${btn.dataset.id}"]`);
      item.querySelector('[data-view]').style.display = 'none';
      item.querySelector('[data-edit]').style.display = 'block';
      item.querySelector('[data-action="edit-cron"]').style.display = 'none';
      item.querySelector('[data-action="save-cron"]').style.display = 'inline-block';
    });
  });
  panel.querySelectorAll('[data-action="save-cron"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const item = panel.querySelector(`.cron-item[data-cron-id="${id}"]`);
      const descripcion = item.querySelector('.cron-edit-input').value.trim();
      if (!descripcion) return;
      try {
        await api.updateCronologia(id, { descripcion });
        const g = c.cronologia.find(x => x.id === id);
        if (g) g.descripcion = descripcion;
        toast('Actuación actualizada');
        openDetail(c.id, 'gestiones');
        render();
      } catch (e) { toast('No se pudo guardar: ' + e.message); }
    });
  });
  panel.querySelectorAll('[data-action="delete-cron"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta actuación de la cronología?')) return;
      const id = btn.dataset.id;
      try {
        await api.deleteCronologia(id);
        c.cronologia = c.cronologia.filter(x => x.id !== id);
        toast('Actuación eliminada');
        openDetail(c.id, 'gestiones');
        render();
      } catch (e) { toast('No se pudo eliminar: ' + e.message); }
    });
  });
  const addCron = panel.querySelector('#add-cron');
  if (addCron) addCron.addEventListener('click', async () => {
    const inp = panel.querySelector('#new-cron');
    const val = inp.value.trim();
    if (!val) return;
    try {
      const nuevo = await api.addCronologia(CURRENT_USER.id, c.id, val, null, CURRENT_USER.nombre || CURRENT_USER.email);
      c.cronologia = c.cronologia || [];
      c.cronologia.unshift({ id: nuevo.id, descripcion: nuevo.descripcion, driveLink: nuevo.drive_link, usuarioNombre: nuevo.usuario_nombre, fecha: nuevo.fecha });
      toast('Actuación registrada');
      openDetail(c.id, 'gestiones');
      render();
    } catch (e) { toast('No se pudo registrar: ' + e.message); }
  });
}

// ============================================================================
// REGISTROS: ENCARGO RECEPTOR
// ============================================================================
const ENCARGO_FIELD_ROWS = [
  [['folio', 'Folio'], ['depto', 'DR o Depto.']],
  [['centroEncarga', 'Centro que encarga diligencia'], ['abogadoEncarga', 'Abogado que encarga diligencia']],
  [['fechaResolucion', 'Fecha de resolución', 'date'], ['fechaEncargo', 'Fecha de encargo', 'date']],
  [['estadoGestion', 'Estado de gestión', 'select', ['Pendiente de encargo', 'Encargado']], ['urgencia', 'Urgencia (SI/NO)']],
  [['materia', 'Materia'], ['tipoDiligencia', 'Tipo de diligencia']],
  [['patrocinadoNombre', 'Patrocinado'], ['contraparteNombre', 'Contraparte']],
  [['patrocinadoSexo', 'Sexo patrocinado'], ['contraparteSexo', 'Sexo contraparte']],
  [['tribunal', 'Tribunal'], ['rol', 'RIT / ROL']],
  [['jurisdiccion', 'Jurisdicción'], ['comuna', 'Comuna']],
  [['direccion', 'Dirección de la diligencia'], ['observaciones', 'Observaciones relevantes', 'textarea']],
  [['receptorTurnoNombre', 'Receptor judicial de turno'], ['telefonoReceptor', 'Teléfono']],
  [['domicilioReceptor', 'Domicilio del receptor'], ['correoReceptor', 'Correo del receptor']]
];
const ENCARGO_FIELDS = ENCARGO_FIELD_ROWS.flat();

function recordCardHtml(r) {
  const urg = (r.urgencia || '').toUpperCase() === 'SI';
  const estadoGestion = r.estadoGestion || 'Pendiente de encargo';
  const encargado = estadoGestion === 'Encargado';
  const estadoLabel = encargado ? 'ENCARGADO' : (urg ? 'URGENTE | PENDIENTE' : 'PENDIENTE');
  return `<div class="case-card case-card-3col" data-rid="${r.id}">
    <div style="display:flex; flex-direction:column; gap:4px;">
      <div class="stamp evento-estado-${encargado ? 'calm-estado' : (urg ? 'urgente' : 'noprior')}" style="transform:none;">${estadoLabel}</div>
    </div>
    <div class="case-main">
      <div class="titulo">${escapeHtml(r.patrocinadoNombre || 'Sin nombre registrado')}</div>
      <div class="meta">
        ${r.rol ? `<span class="rol">${escapeHtml(r.rol)}</span>` : ''}
        ${r.tribunal ? `<span>${escapeHtml(r.tribunal)}</span>` : ''}
        ${r.tipoDiligencia ? `<span>${escapeHtml(r.tipoDiligencia)}</span>` : ''}
      </div>
      ${r.direccion ? `<div class="gestion">${escapeHtml([r.direccion, r.comuna].filter(Boolean).join(', '))}</div>` : ''}
    </div>
    <div class="case-side">${escapeHtml(r.fechaEncargo || '')}</div>
  </div>`;
}

function renderRecordsList() {
  const filtered = searchTerm ? ENCARGOS.filter(r => JSON.stringify(r).toLowerCase().includes(searchTerm.toLowerCase())) : ENCARGOS;
  let html = `<div class="section-title">Encargo receptor <span class="n">${filtered.length}</span></div>`;
  html += `<div style="margin-bottom:14px;"><button class="btn small primary" id="btn-add-record">+ Agregar registro</button></div>`;
  html += filtered.length ? `<div class="case-grid">${filtered.map(recordCardHtml).join('')}</div>` : `<div class="empty-msg">Sin registros${searchTerm ? ' que coincidan con la búsqueda' : ''}.</div>`;
  const container = document.getElementById('list-container');
  container.innerHTML = html;
  container.querySelectorAll('.case-card[data-rid]').forEach(el => el.addEventListener('click', () => openRecordDetail(el.dataset.rid)));
  const addBtn = document.getElementById('btn-add-record');
  if (addBtn) addBtn.addEventListener('click', () => openRecordDetail(null));
}

function emptyRecord() {
  const rec = {};
  ENCARGO_FIELDS.forEach(([key]) => { rec[key] = null; });
  return rec;
}

// Busca turnos vigentes para una fecha de resolución + jurisdicción (+
// materia). No asigna nada automáticamente: solo devuelve candidatos para
// que la usuaria confirme.
function buscarTurnosAplicables(fecha, jurisdiccion, materia) {
  if (!fecha) return [];
  return TURNOS.filter(t => {
    if (fecha < t.fechaInicio || fecha > t.fechaFin) return false;
    if (jurisdiccion && t.jurisdiccion && !t.jurisdiccion.toLowerCase().includes(jurisdiccion.toLowerCase()) && !jurisdiccion.toLowerCase().includes(t.jurisdiccion.toLowerCase())) return false;
    if (materia && t.materia && t.materia.toLowerCase() !== materia.toLowerCase()) return false;
    return true;
  });
}

function encargoFieldHtml([key, label, kind, options], rec) {
  const val = rec[key] == null ? '' : rec[key];
  const id = `rec-${key}`;
  if (kind === 'select') {
    const opts = options.map(o => `<option value="${o}" ${val === o ? 'selected' : ''}>${o}</option>`).join('');
    return `<div><label>${label}</label><select id="${id}">${opts}</select></div>`;
  }
  if (kind === 'textarea') return `<div><label>${label}</label><textarea id="${id}">${escapeHtml(val)}</textarea></div>`;
  if (kind === 'date') return `<div><label>${label}</label><input type="date" id="${id}" value="${escapeHtml(val)}"></div>`;
  return `<div><label>${label}</label><input type="text" id="${id}" value="${escapeHtml(val)}"></div>`;
}

function recordFormHtml(rec, isNew) {
  const fieldsHtml = ENCARGO_FIELD_ROWS.map(([left, right]) => `
    <div class="form-grid2">
      ${encargoFieldHtml(left, rec)}
      ${encargoFieldHtml(right, rec)}
    </div>`).join('');
  return `
  <div class="detail-head">
    <h2 style="font-size:18px;">${isNew ? 'Agregar registro' : 'Editar registro'} · Encargo receptor</h2>
    <button class="close-x" id="detail-close">&times;</button>
  </div>
  <div style="padding:20px 26px 26px;">
    <div class="modal-form">
      ${fieldsHtml}
      <button class="btn primary" id="save-record">Guardar registro</button>
      <button class="btn ghost" id="buscar-receptor-turno" type="button">Buscar receptor sugerido según fecha y jurisdicción</button>
      <div id="receptor-sugerido-wrap"></div>
      ${!isNew ? `<button class="btn danger" id="delete-record">Eliminar este registro</button>` : ''}
    </div>
  </div>`;
}

function wireRecordEvents(rec, isNew) {
  const panel = document.getElementById('detail-panel');
  panel.querySelector('#detail-close').addEventListener('click', closeOverlay);

  const buscarBtn = panel.querySelector('#buscar-receptor-turno');
  const sugeridoWrap = panel.querySelector('#receptor-sugerido-wrap');
  if (buscarBtn) buscarBtn.addEventListener('click', () => {
    const fecha = panel.querySelector('#rec-fechaResolucion').value;
    const jurisdiccion = panel.querySelector('#rec-jurisdiccion').value.trim();
    const materia = panel.querySelector('#rec-materia').value.trim() || 'Civil';
    if (!fecha) { toast('Ingresa primero la fecha de resolución'); return; }

    const candidatos = buscarTurnosAplicables(fecha, jurisdiccion, materia);

    if (candidatos.length === 0) {
      sugeridoWrap.innerHTML = `
        <div class="receptor-sugerido-box">
          <div class="ficha-empty" style="color:var(--ink-faint);">No existe información de turnos cargada para esta fecha y jurisdicción.</div>
          <div class="agenda-toolbar" style="margin-top:8px;">
            <button class="btn small" id="rs-ir-admin" type="button">Ir a Administración de receptores</button>
            <button class="btn small" id="rs-manual" type="button">Seleccionar receptor manualmente</button>
          </div>
        </div>`;
      sugeridoWrap.querySelector('#rs-ir-admin').addEventListener('click', () => { closeOverlay(); currentCat = 'receptores'; render(); });
      sugeridoWrap.querySelector('#rs-manual').addEventListener('click', () => mostrarSelectorManualReceptor(panel, sugeridoWrap, rec));
      return;
    }

    if (candidatos.length > 1) {
      sugeridoWrap.innerHTML = `
        <div class="receptor-sugerido-box">
          <div class="ficha-empty" style="color:var(--semi);">Existen ${candidatos.length} turnos aplicables a esta fecha. Revisa y elige manualmente antes de confirmar:</div>
          ${candidatos.map(t => `
            <div class="turno-candidato" data-turno-id="${t.id}">
              <strong>${escapeHtml(t.receptor ? t.receptor.nombreCompleto : 'Receptor sin datos')}</strong>
              <div class="ficha-empty" style="color:var(--ink-faint);">${escapeHtml(fmtFechaSolo(t.fechaInicio))} — ${escapeHtml(fmtFechaSolo(t.fechaFin))} · ${escapeHtml(t.jurisdiccion || '')}</div>
              <button class="btn small" data-action="elegir-turno" data-id="${t.id}" type="button">Elegir este receptor</button>
            </div>`).join('')}
        </div>`;
      sugeridoWrap.querySelectorAll('[data-action="elegir-turno"]').forEach(btn => {
        btn.addEventListener('click', () => aplicarReceptorSugerido(panel, sugeridoWrap, candidatos.find(t => t.id === btn.dataset.id), rec));
      });
      return;
    }

    aplicarReceptorSugerido(panel, sugeridoWrap, candidatos[0], rec);
  });

  panel.querySelector('#save-record').addEventListener('click', async () => {
    const patch = {};
    ENCARGO_FIELDS.forEach(([key]) => { patch[key] = panel.querySelector(`#rec-${key}`).value.trim() || null; });
    // Trazabilidad de la asignación del receptor (se completa al usar
    // "Buscar receptor sugerido" / "Confirmar receptor", no son inputs del formulario).
    ['receptorSugeridoId', 'receptorConfirmadoId', 'turnoId', 'fuenteTurno', 'fechaConfirmacionReceptor'].forEach(k => {
      if (rec[k] !== undefined) patch[k] = rec[k];
    });
    try {
      if (isNew) {
        const nuevo = await api.createEncargo(CURRENT_USER.id, patch);
        ENCARGOS.unshift(nuevo);
      } else {
        await api.updateEncargo(rec.id, patch);
        Object.assign(rec, patch);
      }
      toast('Registro guardado');
      closeOverlay();
      render();
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });
  const delBtn = panel.querySelector('#delete-record');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('¿Eliminar este registro? Esta acción no se puede deshacer.')) return;
    try {
      await api.deleteEncargo(rec.id);
      ENCARGOS = ENCARGOS.filter(x => x.id !== rec.id);
      toast('Registro eliminado');
      closeOverlay();
      render();
    } catch (e) { toast('No se pudo eliminar: ' + e.message); }
  });
}

function aplicarReceptorSugerido(panel, sugeridoWrap, turno, rec) {
  const r = turno.receptor;
  sugeridoWrap.innerHTML = `
    <div class="receptor-sugerido-box">
      <div class="ficha-empty" style="color:var(--calm);">Receptor sugerido según fecha y jurisdicción:</div>
      <strong>${escapeHtml(r ? r.nombreCompleto : 'Sin datos')}</strong>
      <div class="ficha-empty" style="color:var(--ink-faint);">
        ${r && r.telefono ? escapeHtml(r.telefono) + ' · ' : ''}${r && r.correo ? escapeHtml(r.correo) : ''}
      </div>
      <div class="ficha-empty" style="color:var(--ink-faint);">Turno: ${escapeHtml(fmtFechaSolo(turno.fechaInicio))} — ${escapeHtml(fmtFechaSolo(turno.fechaFin))}${turno.fuenteOficial ? ' · Fuente: ' + escapeHtml(turno.fuenteOficial) : ''}</div>
      <div class="agenda-toolbar" style="margin-top:8px;">
        <button class="btn small primary" id="rs-confirmar" type="button">Confirmar receptor</button>
        <button class="btn small" id="rs-manual2" type="button">Elegir otro / corregir</button>
      </div>
    </div>`;
  sugeridoWrap.querySelector('#rs-confirmar').addEventListener('click', () => {
    panel.querySelector('#rec-receptorTurnoNombre').value = r ? r.nombreCompleto : '';
    panel.querySelector('#rec-telefonoReceptor').value = r ? (r.telefono || '') : '';
    panel.querySelector('#rec-domicilioReceptor').value = r ? (r.domicilio || '') : '';
    panel.querySelector('#rec-correoReceptor').value = r ? (r.correo || '') : '';
    rec.receptorSugeridoId = r ? r.id : null;
    rec.receptorConfirmadoId = r ? r.id : null;
    rec.turnoId = turno.id;
    rec.fuenteTurno = turno.fuenteOficial || null;
    rec.fechaConfirmacionReceptor = new Date().toISOString();
    toast('Receptor confirmado. No olvides presionar "Guardar registro".');
  });
  sugeridoWrap.querySelector('#rs-manual2').addEventListener('click', () => mostrarSelectorManualReceptor(panel, sugeridoWrap, rec));
}

function mostrarSelectorManualReceptor(panel, sugeridoWrap, rec) {
  const activos = RECEPTORES.filter(r => r.activo);
  const opciones = activos.map(r => `<option value="${r.id}">${escapeHtml(r.nombreCompleto)}</option>`).join('');
  sugeridoWrap.innerHTML = `
    <div class="receptor-sugerido-box">
      <label>Seleccionar receptor del catálogo</label>
      <select id="rs-select-manual">
        <option value="">— Dejar sin asignar —</option>
        ${opciones}
      </select>
      <div class="agenda-toolbar" style="margin-top:8px;">
        <button class="btn small primary" id="rs-confirmar-manual" type="button">Usar este receptor</button>
      </div>
    </div>`;
  sugeridoWrap.querySelector('#rs-confirmar-manual').addEventListener('click', () => {
    const id = sugeridoWrap.querySelector('#rs-select-manual').value;
    const r = activos.find(x => x.id === id);
    panel.querySelector('#rec-receptorTurnoNombre').value = r ? r.nombreCompleto : '';
    panel.querySelector('#rec-telefonoReceptor').value = r ? (r.telefono || '') : '';
    panel.querySelector('#rec-domicilioReceptor').value = r ? (r.domicilio || '') : '';
    panel.querySelector('#rec-correoReceptor').value = r ? (r.correo || '') : '';
    rec.receptorSugeridoId = null;
    rec.receptorConfirmadoId = r ? r.id : null;
    rec.turnoId = null;
    rec.fuenteTurno = r ? 'Selección manual' : null;
    rec.fechaConfirmacionReceptor = r ? new Date().toISOString() : null;
    toast(r ? 'Receptor asignado manualmente. No olvides presionar "Guardar registro".' : 'Encargo dejado sin receptor asignado.');
  });
}

function openRecordDetail(id) {
  let rec = id ? ENCARGOS.find(x => x.id === id) : null;
  const isNew = !rec;
  if (!rec) rec = emptyRecord();
  document.getElementById('detail-panel').innerHTML = recordFormHtml(rec, isNew);
  document.getElementById('overlay').classList.add('show');
  wireRecordEvents(rec, isNew);
}

// ============================================================================
// NUEVA CAUSA
// ============================================================================
function openNewModal() { document.getElementById('overlay-new').classList.add('show'); }
function closeNewModal() {
  document.getElementById('overlay-new').classList.remove('show');
  ['nf-titulo', 'nf-rol', 'nf-tribunal', 'nf-patrocinado', 'nf-rut', 'nf-clave', 'nf-gestion'].forEach(id => { document.getElementById(id).value = ''; });
}
async function saveNewCausa() {
  const titulo = document.getElementById('nf-titulo').value.trim();
  if (!titulo) { toast('Ingresa un título para la causa'); return; }
  const patch = {
    titulo,
    categoria: document.getElementById('nf-categoria').value,
    subcategoria: document.getElementById('nf-subcategoria').value || null,
    rol: document.getElementById('nf-rol').value.trim() || null,
    tribunal: document.getElementById('nf-tribunal').value.trim() || null,
    patrocinado: document.getElementById('nf-patrocinado').value.trim() || null,
    rut: document.getElementById('nf-rut').value.trim() || null,
    clave: document.getElementById('nf-clave').value.trim() || null,
    fechaIngreso: new Date().toISOString().slice(0, 10)
  };
  try {
    const nueva = await api.createCausa(CURRENT_USER.id, patch);
    const gestion = document.getElementById('nf-gestion').value.trim();
    if (gestion) {
      const g = await api.addGestionPendiente(CURRENT_USER.id, nueva.id, gestion, null);
      nueva.gestionesPendientes.push({ id: g.id, descripcion: g.descripcion, driveLink: g.drive_link, createdAt: g.created_at });
    }
    CAUSAS.unshift(nueva);
    toast('Causa agregada');
    closeNewModal();
    render();
  } catch (e) { toast('No se pudo crear la causa: ' + e.message); }
}

// ============================================================================
// MENÚ MÓVIL
// ============================================================================
function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('show');
}
function wireMobileMenu() {
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-backdrop').classList.add('show');
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileSidebar);
}

// ============================================================================
// WIRING GENERAL
// ============================================================================
function wireTopLevelUI() {
  document.querySelectorAll('.chip[data-prior]').forEach(chip => {
    chip.addEventListener('click', () => {
      statFilter = null;
      const p = chip.dataset.prior;
      if (activePriors.has(p)) { activePriors.delete(p); chip.classList.remove('active'); }
      else { activePriors.add(p); chip.classList.add('active'); }
      render();
    });
  });

  document.getElementById('search').addEventListener('input', (e) => { searchTerm = e.target.value; render(); });

  document.querySelectorAll('.stat-card[data-filter]').forEach(card => {
    card.addEventListener('click', () => {
      const f = card.dataset.filter;
      if (f === 'agenda') {
        statFilter = null; currentSubcat = null;
        currentCat = 'agenda-global';
        closeMobileSidebar();
        render();
        return;
      }
      statFilter = (statFilter === f) ? null : f;
      currentCat = 'todas'; currentSubcat = null;
      render();
    });
  });

  document.getElementById('overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeOverlay(); });
  document.getElementById('overlay-new').addEventListener('click', (e) => { if (e.target.id === 'overlay-new') closeNewModal(); });

  document.getElementById('btn-new').addEventListener('click', openNewModal);
  document.getElementById('close-new').addEventListener('click', closeNewModal);
  document.getElementById('save-new').addEventListener('click', saveNewCausa);

  const tabEncargo = document.getElementById('tab-encargo');
  if (tabEncargo) tabEncargo.addEventListener('click', () => { statFilter = null; currentCat = 'encargo'; currentSubcat = null; closeMobileSidebar(); render(); });

  const tabAgendaGlobal = document.getElementById('tab-agenda-global');
  if (tabAgendaGlobal) tabAgendaGlobal.addEventListener('click', () => { statFilter = null; currentCat = 'agenda-global'; currentSubcat = null; closeMobileSidebar(); render(); });

  const tabCentroTrabajo = document.getElementById('tab-centro-trabajo');
  if (tabCentroTrabajo) tabCentroTrabajo.addEventListener('click', () => { statFilter = null; currentCat = 'centro-trabajo'; currentSubcat = null; closeMobileSidebar(); render(); });

  const tabRevisionPjud = document.getElementById('tab-revision-pjud');
  if (tabRevisionPjud) tabRevisionPjud.addEventListener('click', () => { statFilter = null; currentCat = 'revision-pjud'; currentSubcat = null; closeMobileSidebar(); render(); });

  const tabProgramacionSalas = document.getElementById('tab-programacion-salas');
  if (tabProgramacionSalas) tabProgramacionSalas.addEventListener('click', () => { statFilter = null; currentCat = 'programacion-salas'; currentSubcat = null; closeMobileSidebar(); render(); });

  const tabReceptores = document.getElementById('tab-receptores');
  if (tabReceptores) tabReceptores.addEventListener('click', () => { statFilter = null; currentCat = 'receptores'; currentSubcat = null; closeMobileSidebar(); render(); });

  const tabInformeFinal = document.getElementById('tab-informe-final');
  if (tabInformeFinal) tabInformeFinal.addEventListener('click', () => { statFilter = null; currentCat = 'informe-final'; currentSubcat = null; closeMobileSidebar(); render(); });

  const tabIntegraciones = document.getElementById('tab-integraciones');
  if (tabIntegraciones) tabIntegraciones.addEventListener('click', () => { statFilter = null; currentCat = 'integraciones'; currentSubcat = null; closeMobileSidebar(); render(); });

  wireMobileMenu();
}

// ============================================================================
// BOOTSTRAP
// ============================================================================
export async function initApp() {
  wireAuthUI();
  wireTopLevelUI();
  switchAuthForm('login');

  const { onAuthStateChange } = await import('./auth.js');

  // onAuthStateChange es la única fuente de verdad sobre el estado de sesión:
  // se dispara de inmediato con la sesión actual (o null) al suscribirse, y
  // luego en cada login/logout/refresh. Así evitamos que dos rutas distintas
  // (una llamada manual a getSession() y este listener) decidan por su cuenta
  // qué pantalla mostrar y terminen pisándose.
  onAuthStateChange((session) => {
    if (session) {
      onSessionReady(session);
    } else {
      CAUSAS = [];
      ENCARGOS = [];
      MODULE_ACCESOS = [];
      CURRENT_ORG_MODULE = null;
      borrarSeleccionModuloGuardada();
      document.getElementById('familia-screen').hidden = true;
      document.getElementById('module-select-screen').hidden = true;
      showAuthScreen();
    }
  });
}
