import { supabase } from './supabaseClient.js';
import * as api from './lib/api.js';
import { SAJ_APP_URL, PJUD_APP_URL, GMAIL_URL } from './config.js';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
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

// Catálogo fijo de tipos de juicio — las subcarpetas de En tramitación /
// Nuevas (redacción) / Terminadas se pintan siempre con estos 8, en este
// orden, tengan o no causas cargadas (ver renderFolders).
const ORDEN_TIPOS_JUICIO = [
  'Juicio Ejecutivo', 'Juicio Ordinario', 'Juicio Sumario',
  'Juicio monitorio', 'Recurso de protección', 'Recurso de amparo',
  'Voluntario', 'Extrajudicial',
  'Gestión preparatoria', 'Interdicción', 'Interdictos posesorios'
];

function subcatClass(c) {
  const s = (c.subcategoria || c.materia || '').toLowerCase();
  if (s.includes('ejecutivo')) return 'sc-ejecutivo';
  if (s.includes('ordinario')) return 'sc-ordinario';
  if (s.includes('sumario')) return 'sc-sumario';
  if (s.includes('monitorio')) return 'sc-monitorio';
  if (s.includes('protección') || s.includes('proteccion')) return 'sc-recurso-proteccion';
  if (s.includes('amparo')) return 'sc-recurso-amparo';
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

    // Catálogo fijo: se pintan siempre las 8 opciones oficiales, en este
    // orden, con su contador real (0 si no hay ninguna causa de ese tipo)
    // — ya no depende de qué exista en los datos. Cualquier subcategoria
    // histórica que no esté en el catálogo (texto libre de antes, o un tipo
    // que dejó de ofrecerse) se agrega después, para no perder acceso a ella.
    const subsHistoricas = [];
    inCat.forEach(c => {
      const k = c.subcategoria || '';
      if (k && !ORDEN_TIPOS_JUICIO.includes(k) && !subsHistoricas.includes(k)) subsHistoricas.push(k);
    });
    // En la barra lateral solo se muestran las subcarpetas con al menos 1
    // causa — el catálogo oficial (ORDEN_TIPOS_JUICIO) sigue completo y sin
    // reducirse; esto solo filtra qué se pinta aquí, no las opciones
    // disponibles en los formularios de creación/edición.
    const subs = [...ORDEN_TIPOS_JUICIO, ...subsHistoricas]
      .filter(sub => inCat.some(c => c.subcategoria === sub));

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
  if (statFilter === 'urgente' && (c.categoria === 'terminada' || prioridadEfectiva(c) !== 'Urgente')) return false;
  if (statFilter === 'semi' && (c.categoria === 'terminada' || prioridadEfectiva(c) !== 'Semi urgente')) return false;
  if (statFilter === 'noprior' && (c.categoria === 'terminada' || prioridadEfectiva(c) !== 'No prioritario')) return false;
  if (currentCat !== 'todas' && c.categoria !== currentCat) return false;
  if (currentCat !== 'todas' && currentSubcat && (c.subcategoria || '') !== currentSubcat) return false;
  if (searchTerm) {
    const hay = [c.titulo, c.patrocinado, c.demandanteNombre, c.demandadoNombre, c.rut, c.rol, c.materia, c.submateria, c.clave].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(searchTerm.toLowerCase())) return false;
  }
  return true;
}

// Prioridad efectiva de una causa: se calcula al vuelo a partir de sus
// gestiones y eventos activos (nunca de un valor guardado directamente en
// la causa). Jerarquía excluyente Urgente > Semi urgente > No prioritario
// — una causa nunca pertenece a más de una a la vez. Reutiliza
// isEventoActivo() tal cual existe (Suspendido cuenta como no activo,
// igual que Realizado/Cancelado), sin ninguna definición paralela.
function prioridadEfectiva(c) {
  const gestionesActivas = (c.gestionesPendientes || []).filter(g => g.estado === 'Pendiente' || g.estado === 'En espera');
  const eventosActivos = (c.agendaEventos || []).filter(isEventoActivo);
  const prioridades = new Set([...gestionesActivas, ...eventosActivos].map(x => x.prioridad).filter(Boolean));
  if (prioridades.has('Urgente')) return 'Urgente';
  if (prioridades.has('Semi urgente')) return 'Semi urgente';
  if (prioridades.has('No prioritario')) return 'No prioritario';
  return null;
}

function renderStats() {
  const activos = CAUSAS.filter(c => c.categoria !== 'terminada');
  document.getElementById('stat-total').textContent = activos.length;
  document.getElementById('stat-urgentes').textContent = activos.filter(c => prioridadEfectiva(c) === 'Urgente').length;
  document.getElementById('stat-semi').textContent = activos.filter(c => prioridadEfectiva(c) === 'Semi urgente').length;
  document.getElementById('stat-noprior').textContent = activos.filter(c => prioridadEfectiva(c) === 'No prioritario').length;
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
const NOTIF_PARTE_OPCIONES = ['Demandado/a', 'Solicitado', 'Requerido', 'Tercero'];

function notifDomicilioRowHtml(d, pIdx, dIdx) {
  return `<tr data-p-idx="${pIdx}" data-d-idx="${dIdx}">
    <td><input type="text" class="np-domicilio" value="${escapeHtml(d.domicilio || '')}"></td>
    <td><select class="np-dom-estado">
      <option value="" ${!d.estado ? 'selected' : ''}>—</option>
      <option value="Negativa" ${d.estado === 'Negativa' ? 'selected' : ''}>Negativa</option>
      <option value="Señalar" ${d.estado === 'Señalar' ? 'selected' : ''}>Señalar</option>
      <option value="Señalado" ${d.estado === 'Señalado' ? 'selected' : ''}>Señalado</option>
    </select></td>
    <td><input type="date" class="np-dom-fecha" value="${escapeHtml(d.fecha || '')}"></td>
    <td><input type="text" class="np-dom-folio" value="${escapeHtml(d.folio || '')}"></td>
    <td><input type="text" class="np-dom-informado" value="${escapeHtml(d.informadoPor || '')}"></td>
    <td class="col-del"><button class="notif-row-del" data-action="np-quitar-domicilio" data-p-idx="${pIdx}" data-d-idx="${dIdx}">&times;</button></td>
  </tr>`;
}

function notifPersonaBlockHtml(persona, idx) {
  return `<div class="agenda-form" data-persona-idx="${idx}" style="margin-bottom:14px;">
    <div class="form-grid2">
      <div><label>Parte</label><select class="np-parte" data-idx="${idx}"><option value="">Sin definir</option>${NOTIF_PARTE_OPCIONES.map(o => `<option value="${o}" ${persona.parte === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
      <div><label>Nombre</label><input type="text" class="np-nombre" data-idx="${idx}" value="${escapeHtml(persona.nombre || '')}"></div>
    </div>
    <div><label>Estado de notificación</label>
      <select class="np-estado" data-idx="${idx}">
        <option value="">Sin definir</option>
        <option value="Notificado" ${persona.estadoNotificacion === 'Notificado' ? 'selected' : ''}>Notificado</option>
        <option value="Pendiente" ${persona.estadoNotificacion === 'Pendiente' ? 'selected' : ''}>Pendiente</option>
      </select>
    </div>
    <div class="subhead">Domicilios y búsquedas</div>
    <div class="notif-table-wrap">
      <table class="notif-table">
        <thead><tr><th class="col-domicilio">Domicilio</th><th>Estado</th><th>Fecha</th><th>Folio</th><th>Informado por</th><th class="col-del"></th></tr></thead>
        <tbody class="np-domicilios-tbody" data-idx="${idx}">${(persona.domicilios || []).map((d, di) => notifDomicilioRowHtml(d, idx, di)).join('')}</tbody>
      </table>
    </div>
    <button class="btn small" data-action="np-agregar-domicilio" data-idx="${idx}" type="button">+ Agregar domicilio</button>
  </div>`;
}

// Notificación múltiple. Fallback histórico: si la causa no tiene personas
// en el modelo nuevo, se muestra debajo (solo lectura) el registro antiguo
// de una sola persona (c.notifNombre/c.notifEstado/c.domicilios), sin
// migrarlo ni tocarlo — domicilios_notificacion queda intacta.
function notificacionTabHtml(c) {
  const personas = c.notificacionPersonas || [];
  const hayHistorico = !personas.length && ((c.domicilios || []).length || c.notifNombre || c.notifEstado);
  return `
    <div class="subhead" style="margin-top:0; display:flex; align-items:center; justify-content:space-between;">
      <span>Personas a notificar</span>
      <div style="display:flex; align-items:center; gap:8px;">
        <label style="margin:0; font-size:12px;">Cantidad de personas a notificar</label>
        <input type="number" id="notif-cantidad" min="0" value="${personas.length}" style="width:64px;">
      </div>
    </div>
    <div id="notif-personas-wrap">${personas.length ? personas.map((p, i) => notifPersonaBlockHtml(p, i)).join('') : '<div class="ficha-empty" style="color:var(--ink-faint);">Sin personas registradas todavía.</div>'}</div>
    <div style="margin-top:10px;"><button class="btn small primary" id="notif-guardar">Guardar notificación</button></div>
    ${hayHistorico ? `
    <div class="subhead" style="margin-top:26px; border-top:1px dashed var(--line); padding-top:16px;">Registro histórico (anterior al modelo de varias personas)</div>
    <div class="ficha-empty" style="color:var(--ink-faint); margin-bottom:8px;">Se conserva tal cual, sin migrar. Al agregar personas arriba, la información nueva se guarda en el modelo actual.</div>
    <div class="field-row">
      <div class="field"><div class="k">Estado de notificación (histórico)</div><input type="text" class="ct-input" value="${escapeHtml(c.notifEstado || '')}" disabled></div>
      <div class="field"><div class="k">Nombre (histórico)</div><input type="text" class="ct-input" value="${escapeHtml(c.notifNombre || '')}" disabled></div>
    </div>
    <div class="notif-table-wrap">
      <table class="notif-table">
        <thead><tr><th class="col-domicilio">Domicilio</th><th>Estado</th><th>Fecha</th><th>Folio</th><th>Informado por</th></tr></thead>
        <tbody>${(c.domicilios || []).map(d => `<tr><td>${escapeHtml(d.domicilio || '')}</td><td>${escapeHtml(d.estado || '')}</td><td>${escapeHtml(fmtFechaSolo(d.fecha) || '')}</td><td>${escapeHtml(d.folio || '')}</td><td>${escapeHtml(d.informadoPor || '')}</td></tr>`).join('')}</tbody>
      </table>
    </div>` : ''}
  `;
}

function wireNotificacionTab(c, panel) {
  let estadoPersonas = (c.notificacionPersonas || []).map(p => ({
    id: p.id, parte: p.parte, nombre: p.nombre, estadoNotificacion: p.estadoNotificacion,
    domicilios: (p.domicilios || []).map(d => ({ id: d.id, domicilio: d.domicilio, estado: d.estado, fecha: d.fecha, folio: d.folio, informadoPor: d.informadoPor }))
  }));

  function refrescar() {
    panel.querySelector('#notif-personas-wrap').innerHTML = estadoPersonas.length
      ? estadoPersonas.map((p, i) => notifPersonaBlockHtml(p, i)).join('')
      : '<div class="ficha-empty" style="color:var(--ink-faint);">Sin personas registradas todavía.</div>';
    panel.querySelector('#notif-cantidad').value = estadoPersonas.length;
  }

  const cantInput = panel.querySelector('#notif-cantidad');
  if (cantInput) cantInput.addEventListener('input', () => {
    const nueva = Math.max(0, parseInt(cantInput.value, 10) || 0);
    while (estadoPersonas.length < nueva) estadoPersonas.push({ id: null, parte: '', nombre: '', estadoNotificacion: '', domicilios: [] });
    while (estadoPersonas.length > nueva) estadoPersonas.pop();
    refrescar();
  });

  const wrap = panel.querySelector('#notif-personas-wrap');
  if (wrap) {
    wrap.addEventListener('input', (e) => {
      if (e.target.classList.contains('np-parte')) { estadoPersonas[parseInt(e.target.dataset.idx, 10)].parte = e.target.value; return; }
      if (e.target.classList.contains('np-nombre')) { estadoPersonas[parseInt(e.target.dataset.idx, 10)].nombre = e.target.value.trim(); return; }
      if (e.target.classList.contains('np-estado')) { estadoPersonas[parseInt(e.target.dataset.idx, 10)].estadoNotificacion = e.target.value; return; }
      const tr = e.target.closest('tr[data-p-idx]');
      if (!tr) return;
      const pi = parseInt(tr.dataset.pIdx, 10);
      const di = parseInt(tr.dataset.dIdx, 10);
      const dom = estadoPersonas[pi].domicilios[di];
      if (e.target.classList.contains('np-domicilio')) dom.domicilio = e.target.value.trim();
      if (e.target.classList.contains('np-dom-estado')) dom.estado = e.target.value || null;
      if (e.target.classList.contains('np-dom-fecha')) dom.fecha = e.target.value || null;
      if (e.target.classList.contains('np-dom-folio')) dom.folio = e.target.value.trim();
      if (e.target.classList.contains('np-dom-informado')) dom.informadoPor = e.target.value.trim();
    });
    wrap.addEventListener('click', (e) => {
      const addBtn = e.target.closest('[data-action="np-agregar-domicilio"]');
      if (addBtn) {
        estadoPersonas[parseInt(addBtn.dataset.idx, 10)].domicilios.push({ id: null, domicilio: '', estado: '', fecha: '', folio: '', informadoPor: '' });
        refrescar();
        return;
      }
      const delBtn = e.target.closest('[data-action="np-quitar-domicilio"]');
      if (delBtn) {
        estadoPersonas[parseInt(delBtn.dataset.pIdx, 10)].domicilios.splice(parseInt(delBtn.dataset.dIdx, 10), 1);
        refrescar();
      }
    });
  }

  const guardarBtn = panel.querySelector('#notif-guardar');
  if (guardarBtn) guardarBtn.addEventListener('click', async () => {
    try {
      const originalesPersonas = c.notificacionPersonas || [];
      const idsPersonasFinales = new Set();
      const nuevaListaPersonas = [];
      for (let idx = 0; idx < estadoPersonas.length; idx++) {
        const p = estadoPersonas[idx];
        if (!p.nombre || !p.parte) continue;
        let personaId = p.id;
        if (personaId) {
          await api.updateNotificacionPersona(personaId, { parte: p.parte, nombre: p.nombre, estadoNotificacion: p.estadoNotificacion || null, orden: idx });
        } else {
          const creada = await api.createNotificacionPersona(CURRENT_USER.id, c.id, { parte: p.parte, nombre: p.nombre, estadoNotificacion: p.estadoNotificacion || null, orden: idx });
          personaId = creada.id;
        }
        idsPersonasFinales.add(personaId);

        const originalPersona = originalesPersonas.find(op => op.id === personaId);
        const originalesDomicilios = (originalPersona && originalPersona.domicilios) || [];
        const idsDomiciliosFinales = new Set();
        const nuevaListaDomicilios = [];
        for (let dIdx = 0; dIdx < p.domicilios.length; dIdx++) {
          const d = p.domicilios[dIdx];
          if (!d.domicilio && !d.estado && !d.fecha && !d.folio && !d.informadoPor) continue;
          let domId = d.id;
          const dPatch = { domicilio: d.domicilio || null, estado: d.estado || null, fecha: d.fecha || null, folio: d.folio || null, informadoPor: d.informadoPor || null, orden: dIdx };
          if (domId) await api.updateNotificacionDomicilio(domId, dPatch);
          else { const creado = await api.createNotificacionDomicilio(personaId, dPatch); domId = creado.id; }
          idsDomiciliosFinales.add(domId);
          nuevaListaDomicilios.push({ id: domId, ...dPatch });
        }
        for (const od of originalesDomicilios) if (!idsDomiciliosFinales.has(od.id)) await api.deleteNotificacionDomicilio(od.id);

        nuevaListaPersonas.push({ id: personaId, parte: p.parte, nombre: p.nombre, estadoNotificacion: p.estadoNotificacion || null, orden: idx, domicilios: nuevaListaDomicilios });
      }
      for (const op of originalesPersonas) if (!idsPersonasFinales.has(op.id)) await api.deleteNotificacionPersona(op.id);

      c.notificacionPersonas = nuevaListaPersonas;
      toast('Notificación guardada');
      openDetail(c.id, 'notificacion');
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });
}

const OFICIO_PARTE_OPCIONES = ['Demandado/a', 'Solicitado', 'Requerido', 'Tercero'];
const OFICIO_TRAMITACION_OPCIONES = ['Correo enviado a usuario/a', 'Tramitada por mano', 'Tramitada por correo', 'Pendiente de tramitar'];
const OFICIO_RESPUESTA_OPCIONES = ['Contestada', 'Pendiente'];

function oficioInstitucionRowHtml(inst, pIdx, iIdx) {
  return `<tr data-p-idx="${pIdx}" data-i-idx="${iIdx}">
    <td><input type="text" class="oi-institucion" value="${escapeHtml(inst.institucion || '')}"></td>
    <td><select class="oi-tramitacion"><option value="">Sin definir</option>${OFICIO_TRAMITACION_OPCIONES.map(o => `<option value="${o}" ${inst.tramitacion === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
    <td><select class="oi-respuesta"><option value="">Sin definir</option>${OFICIO_RESPUESTA_OPCIONES.map(o => `<option value="${o}" ${inst.respuesta === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td>
    <td><input type="date" class="oi-fecha" value="${escapeHtml(inst.fecha || '')}"></td>
    <td><input type="text" class="oi-folio" value="${escapeHtml(inst.folio || '')}"></td>
    <td class="col-del"><button class="notif-row-del" data-action="oi-quitar-institucion" data-p-idx="${pIdx}" data-i-idx="${iIdx}">&times;</button></td>
  </tr>`;
}

function oficioPersonaBlockHtml(persona, idx) {
  return `<div class="agenda-form" data-persona-idx="${idx}" style="margin-bottom:14px;">
    <div class="form-grid2">
      <div><label>Parte</label><select class="op-parte" data-idx="${idx}"><option value="">Sin definir</option>${OFICIO_PARTE_OPCIONES.map(o => `<option value="${o}" ${persona.parte === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
      <div><label>Nombre</label><input type="text" class="op-nombre" data-idx="${idx}" value="${escapeHtml(persona.nombre || '')}"></div>
    </div>
    <div class="subhead">Instituciones oficiadas</div>
    <div class="notif-table-wrap">
      <table class="notif-table">
        <thead><tr><th class="col-domicilio">Institución oficiada</th><th>Tramitación</th><th>Respuesta</th><th>Fecha</th><th>Folio</th><th class="col-del"></th></tr></thead>
        <tbody class="op-instituciones-tbody" data-idx="${idx}">${(persona.instituciones || []).map((inst, ii) => oficioInstitucionRowHtml(inst, idx, ii)).join('')}</tbody>
      </table>
    </div>
    <button class="btn small" data-action="op-agregar-institucion" data-idx="${idx}" type="button">+ Agregar institución</button>
  </div>`;
}

// Oficios: sección nueva e independiente de Notificación. Mismo modelo
// (cantidad de personas -> bloques -> lista anidada), sin fallback histórico
// porque no existe ningún dato anterior de Oficios en la aplicación.
function oficiosTabHtml(c) {
  const personas = c.oficiosPersonas || [];
  return `
    <div class="subhead" style="margin-top:0; display:flex; align-items:center; justify-content:space-between;">
      <span>Personas</span>
      <div style="display:flex; align-items:center; gap:8px;">
        <label style="margin:0; font-size:12px;">Cantidad de personas</label>
        <input type="number" id="oficio-cantidad" min="0" value="${personas.length}" style="width:64px;">
      </div>
    </div>
    <div id="oficio-personas-wrap">${personas.length ? personas.map((p, i) => oficioPersonaBlockHtml(p, i)).join('') : '<div class="ficha-empty" style="color:var(--ink-faint);">Sin personas registradas todavía.</div>'}</div>
    <div style="margin-top:10px;"><button class="btn small primary" id="oficio-guardar">Guardar oficios</button></div>
  `;
}

function wireOficiosTab(c, panel) {
  let estadoPersonas = (c.oficiosPersonas || []).map(p => ({
    id: p.id, parte: p.parte, nombre: p.nombre,
    instituciones: (p.instituciones || []).map(i => ({ id: i.id, institucion: i.institucion, tramitacion: i.tramitacion, respuesta: i.respuesta, fecha: i.fecha, folio: i.folio }))
  }));

  function refrescar() {
    panel.querySelector('#oficio-personas-wrap').innerHTML = estadoPersonas.length
      ? estadoPersonas.map((p, i) => oficioPersonaBlockHtml(p, i)).join('')
      : '<div class="ficha-empty" style="color:var(--ink-faint);">Sin personas registradas todavía.</div>';
    panel.querySelector('#oficio-cantidad').value = estadoPersonas.length;
  }

  const cantInput = panel.querySelector('#oficio-cantidad');
  if (cantInput) cantInput.addEventListener('input', () => {
    const nueva = Math.max(0, parseInt(cantInput.value, 10) || 0);
    while (estadoPersonas.length < nueva) estadoPersonas.push({ id: null, parte: '', nombre: '', instituciones: [] });
    while (estadoPersonas.length > nueva) estadoPersonas.pop();
    refrescar();
  });

  const wrap = panel.querySelector('#oficio-personas-wrap');
  if (wrap) {
    wrap.addEventListener('input', (e) => {
      if (e.target.classList.contains('op-parte')) { estadoPersonas[parseInt(e.target.dataset.idx, 10)].parte = e.target.value; return; }
      if (e.target.classList.contains('op-nombre')) { estadoPersonas[parseInt(e.target.dataset.idx, 10)].nombre = e.target.value.trim(); return; }
      const tr = e.target.closest('tr[data-p-idx]');
      if (!tr) return;
      const pi = parseInt(tr.dataset.pIdx, 10);
      const ii = parseInt(tr.dataset.iIdx, 10);
      const inst = estadoPersonas[pi].instituciones[ii];
      if (e.target.classList.contains('oi-institucion')) inst.institucion = e.target.value.trim();
      if (e.target.classList.contains('oi-tramitacion')) inst.tramitacion = e.target.value || null;
      if (e.target.classList.contains('oi-respuesta')) inst.respuesta = e.target.value || null;
      if (e.target.classList.contains('oi-fecha')) inst.fecha = e.target.value || null;
      if (e.target.classList.contains('oi-folio')) inst.folio = e.target.value.trim();
    });
    wrap.addEventListener('click', (e) => {
      const addBtn = e.target.closest('[data-action="op-agregar-institucion"]');
      if (addBtn) {
        estadoPersonas[parseInt(addBtn.dataset.idx, 10)].instituciones.push({ id: null, institucion: '', tramitacion: '', respuesta: '', fecha: '', folio: '' });
        refrescar();
        return;
      }
      const delBtn = e.target.closest('[data-action="oi-quitar-institucion"]');
      if (delBtn) {
        estadoPersonas[parseInt(delBtn.dataset.pIdx, 10)].instituciones.splice(parseInt(delBtn.dataset.iIdx, 10), 1);
        refrescar();
      }
    });
  }

  const guardarBtn = panel.querySelector('#oficio-guardar');
  if (guardarBtn) guardarBtn.addEventListener('click', async () => {
    try {
      const originalesPersonas = c.oficiosPersonas || [];
      const idsPersonasFinales = new Set();
      const nuevaListaPersonas = [];
      for (let idx = 0; idx < estadoPersonas.length; idx++) {
        const p = estadoPersonas[idx];
        if (!p.nombre || !p.parte) continue;
        let personaId = p.id;
        if (personaId) {
          await api.updateOficioPersona(personaId, { parte: p.parte, nombre: p.nombre, orden: idx });
        } else {
          const creada = await api.createOficioPersona(CURRENT_USER.id, c.id, { parte: p.parte, nombre: p.nombre, orden: idx });
          personaId = creada.id;
        }
        idsPersonasFinales.add(personaId);

        const originalPersona = originalesPersonas.find(op => op.id === personaId);
        const originalesInstituciones = (originalPersona && originalPersona.instituciones) || [];
        const idsInstitucionesFinales = new Set();
        const nuevaListaInstituciones = [];
        for (let iIdx = 0; iIdx < p.instituciones.length; iIdx++) {
          const inst = p.instituciones[iIdx];
          if (!inst.institucion && !inst.tramitacion && !inst.respuesta && !inst.fecha && !inst.folio) continue;
          let instId = inst.id;
          const iPatch = { institucion: inst.institucion || null, tramitacion: inst.tramitacion || null, respuesta: inst.respuesta || null, fecha: inst.fecha || null, folio: inst.folio || null, orden: iIdx };
          if (instId) await api.updateOficioInstitucion(instId, iPatch);
          else { const creado = await api.createOficioInstitucion(personaId, iPatch); instId = creado.id; }
          idsInstitucionesFinales.add(instId);
          nuevaListaInstituciones.push({ id: instId, ...iPatch });
        }
        for (const oi of originalesInstituciones) if (!idsInstitucionesFinales.has(oi.id)) await api.deleteOficioInstitucion(oi.id);

        nuevaListaPersonas.push({ id: personaId, parte: p.parte, nombre: p.nombre, orden: idx, instituciones: nuevaListaInstituciones });
      }
      for (const op of originalesPersonas) if (!idsPersonasFinales.has(op.id)) await api.deleteOficioPersona(op.id);

      c.oficiosPersonas = nuevaListaPersonas;
      toast('Oficios guardados');
      openDetail(c.id, 'oficios');
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });
}

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
// Concepto independiente de Categoría (que sigue siendo texto libre para
// clasificaciones como Notificación/Oficio/PJUD): Tipo distingue si la
// gestión es una tarea propia (redactar, presentar, revisar) o una gestión
// que depende de un tercero (contactar, solicitar, hacer seguimiento).
const GESTION_TIPOS = ['Tarea', 'Gestión'];
const CATEGORIA_POR_TIPO_GESTION = {
  'Tarea': [
    'Revisión de causa', 'Consulta a tutor', 'Contactar a usuario', 'Contactar a testigos',
    'Preparar escrito', 'Enviar a tutor para revisión', 'Otra tarea'
  ],
  'Gestión': [
    'Presentar escrito', 'Encargar notificación', 'Citar a usuario', 'Ir a tribunales',
    'Tramitar oficio', 'Ir a CBR', 'Ir a otra institución', 'Otra Gestión'
  ]
};
// Categoría dependiente de Tipo — mismo criterio de tolerancia histórica ya
// usado en Antecedentes: un valor guardado que no calce con el catálogo del
// tipo actual se agrega como opción adicional, sin perderse.
function categoriaGestionOptionsHtml(tipo, valorActual) {
  const opciones = CATEGORIA_POR_TIPO_GESTION[tipo] || [];
  const esValorDePrueba = (valorActual || '').trim().toLowerCase() === 'prueba';
  let opts = `<option value="">Sin definir</option>`;
  opts += opciones.map(o => `<option value="${escapeHtml(o)}" ${valorActual === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  if (valorActual && !esValorDePrueba && !opciones.includes(valorActual)) {
    opts += `<option value="${escapeHtml(valorActual)}" selected>${escapeHtml(valorActual)} (valor anterior)</option>`;
  }
  return opts;
}

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
  const tipoOptions = ['', ...GESTION_TIPOS].map(t => `<option value="${t}" ${(e.tipo || '') === t ? 'selected' : ''}>${t || 'Selecciona…'}</option>`).join('');
  const prioridadOptions = ['', ...GESTION_PRIORIDADES].map(p => `<option value="${p}" ${(e.prioridad || '') === p ? 'selected' : ''}>${p || 'Sin definir'}</option>`).join('');
  const estadoOptions = GESTION_ESTADOS.map(s => `<option value="${s}" ${e.estado === s ? 'selected' : ''}>${s}</option>`).join('');
  return `
  <div class="agenda-form">
    <div class="subhead" style="margin-top:0;">${g ? 'Editar gestión' : 'Nueva Gestión/Tarea'}</div>
    <div><label>Descripción</label><textarea id="gf-descripcion">${escapeHtml(e.descripcion || '')}</textarea></div>
    <div class="form-grid2">
      <div><label>Tipo</label><select id="gf-tipo">${tipoOptions}</select></div>
      <div><label>Categoría</label><select id="gf-categoria">${categoriaGestionOptionsHtml(e.tipo || '', e.categoria || '')}</select></div>
    </div>
    <div class="form-grid2">
      <div><label>Prioridad</label><select id="gf-prioridad">${prioridadOptions}</select></div>
      <div><label>Estado</label><select id="gf-estado">${estadoOptions}</select></div>
    </div>
    <div class="form-grid2">
      <div><label>Fecha programada</label><input type="date" id="gf-fecharevision" value="${escapeHtml(e.fechaRevision || '')}"></div>
      <div><label>Fecha límite (opcional)</label><input type="date" id="gf-fechalimite" value="${escapeHtml(e.fechaLimite || '')}"></div>
    </div>
    <div style="display:flex; gap:8px; margin-top:6px;">
      <button class="btn primary" id="save-gestion" type="button">Guardar gestión</button>
      <button class="btn ghost" id="cancel-gestion" type="button">Cancelar</button>
    </div>
  </div>`;
}

// Cronología jurídica: la fecha elegida en un <input type="date"> se envía
// siempre con hora fija al mediodía UTC ("...T12:00:00Z") para que ningún
// huso horario real pueda desplazarla al día anterior o siguiente. Al
// mostrarla, se toman directamente los primeros 10 caracteres del valor
// guardado (YYYY-MM-DD) — nunca se reconstruye vía `new Date(...)` en la
// zona horaria local del navegador, que es la causa típica de ese
// desplazamiento.
function fechaCalendarioAExplicita(valorInputFecha) {
  if (!valorInputFecha) return null;
  return `${valorInputFecha}T12:00:00Z`;
}
function fechaExplicitaADisplaySolo(valorGuardado) {
  if (!valorGuardado) return '';
  return String(valorGuardado).slice(0, 10);
}

function cronologiaHtml(c) {
  const items = c.cronologia || [];
  if (items.length === 0) return '<div style="color:var(--ink-faint); font-size:13px;">Aún no hay actuaciones registradas.</div>';
  return `<div class="cron-timeline">${items.map(g => `
    <div class="cron-item" data-cron-id="${g.id}">
      <div class="cron-date">${g.fecha ? escapeHtml(fechaExplicitaADisplaySolo(g.fecha)) : '—'}</div>
      <div class="cron-body" style="flex:1;">
        <div class="desc" data-view>${escapeHtml(g.descripcion)}</div>
        <div class="txt" data-edit style="display:none;">
          <textarea class="cron-edit-input" style="width:100%; min-height:50px;">${escapeHtml(g.descripcion)}</textarea>
        </div>
        ${g.driveLink ? `<div class="meta"><a href="${escapeHtml(g.driveLink)}" target="_blank" rel="noopener">Ver documento ↗</a></div>` : ''}
      </div>
      <div style="display:flex; gap:6px; align-self:center;">
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
      <div><label>Tutor</label><select id="if-tutor"><option value="">Sin definir</option>${TUTOR_OPCIONES.map(t => `<option value="${escapeHtml(t)}" ${e.tutor === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select></div>
      <div><label>Fecha de instrucción</label><input type="date" id="if-fecha" value="${escapeHtml(e.fecha || todayISO())}"></div>
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
    ['RIT / ROL', rolCompletoTexto(c)],
    ['Caratulado', caratuladoTexto(c)],
    ['Tribunal', tribunalTexto(c)],
    ['Código SAJ', c.folio],
    ['ROL ingreso Corte', c.rolIngreso],
    ['Carpeta', CATEGORIA_LABEL[c.categoria] || c.categoria],
    ['Procedimiento', c.subcategoria],
    ['Tipo de juicio', (c.tipoJuicio && c.tipoJuicio !== 'No Aplica') ? c.tipoJuicio : null],
    ['Etapa Procesal', c.etapa],
    ['Materia', c.materia],
    ['Patrocinado', patrocinadoEfectivo(c)],
    ['Tutor', c.tutor],
    ['Fecha ingreso causa', fmtFechaSolo(c.fechaIngreso)],
    ['Recurso', c.recurso]
  ]);
  if (generales.length) sections.push({ title: 'Datos generales', kind: 'kv', rows: generales });

  const resumen = kv([
    ['Clave para recordar', c.clave],
    ['Estado actual', c.estado],
    ['Resumen de la causa', c.resumen]
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
    ['RUT', c.rut],
    ['Correo', c.correo],
    ['Correo alternativo', c.correoAlt],
    ['Teléfono', c.telefono],
    ['Nota', c.nota]
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
    rows: proximosEventos.map(e => [e.tipo, fmtFechaSolo(e.fecha), e.horaInicio || '', eventoTituloEfectivo(e), e.estado])
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
  'Audiencia', 'Cita con usuario', 'Reunión con tutor', 'Reunión con usuario', 'Llamada', 'Plazo procesal',
  'Presentación de escrito', 'Revisión de causa', 'Gestión importante', 'Recordatorio', 'Otro'
];
// Opciones del formulario de Nuevo/Editar evento — reducidas a 4. AGENDA_TIPOS
// (arriba) se mantiene completa y se sigue usando en el filtro de la agenda
// para no perder acceso a eventos históricos con un tipo que ya no se ofrece.
const AGENDA_TIPOS_FORM = ['Audiencia', 'Reunión con usuario', 'Reunión con tutor', 'Otro'];
const MODALIDAD_OPCIONES = ['Presencial', 'Remota'];
const TIPO_AUDIENCIA_OPCIONES = [
  'Audiencia de conciliación', 'Audiencia de parientes', 'Audiencia de testigos',
  'Audiencia de designación de perito', 'Audiencia de Contestación y Conciliación',
  'Audiencia del discapacitado', 'Audiencia de reconocimiento deuda/firma'
];
const AGENDA_ESTADOS = ['Pendiente', 'Confirmado', 'Realizado', 'Suspendido', 'Reprogramado', 'Cancelado'];
// Opciones del formulario — sin 'Confirmado' (deja de ofrecerse como opción
// nueva; los eventos ya guardados con ese estado siguen siendo válidos).
const AGENDA_ESTADOS_FORM = ['Pendiente', 'Realizado', 'Suspendido', 'Reprogramado', 'Cancelado'];
// Título eliminado del formulario de Nuevo evento — los eventos nuevos no
// tienen titulo. Para no mostrar vacío en ningún listado existente, se cae
// al Tipo de evento (y, si es Audiencia, se agrega el tipo de audiencia).
function eventoTituloEfectivo(e) {
  if (e.titulo) return e.titulo;
  if (e.tipo === 'Audiencia' && e.tipoAudiencia) return `${e.tipo} — ${e.tipoAudiencia}`;
  return e.tipo || 'Evento';
}
const AGENDA_ESTADOS_ACTIVOS = ['Pendiente', 'Confirmado', 'Reprogramado'];
const AGENDA_TIPO_ICONO = {
  'Audiencia': '⚖', 'Cita con usuario': '🙋', 'Reunión con tutor': '👤', 'Reunión con usuario': '🧑‍🤝‍🧑', 'Llamada': '☎',
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
      <div class="evento-titulo">${escapeHtml(eventoTituloEfectivo(e))}</div>
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
  let tipoOptions = AGENDA_TIPOS_FORM.map(t => `<option value="${t}" ${e.tipo === t ? 'selected' : ''}>${t}</option>`).join('');
  if (e.tipo && !AGENDA_TIPOS_FORM.includes(e.tipo)) tipoOptions += `<option value="${escapeHtml(e.tipo)}" selected>${escapeHtml(e.tipo)} (valor anterior)</option>`;
  let estadoOptions = AGENDA_ESTADOS_FORM.map(s => `<option value="${s}" ${e.estado === s ? 'selected' : ''}>${s}</option>`).join('');
  if (e.estado && !AGENDA_ESTADOS_FORM.includes(e.estado)) estadoOptions += `<option value="${escapeHtml(e.estado)}" selected>${escapeHtml(e.estado)} (valor anterior)</option>`;
  const prioridadOptions = ['', 'No prioritario', 'Semi urgente', 'Urgente'].map(p => `<option value="${p}" ${(e.prioridad || '') === p ? 'selected' : ''}>${p || 'Sin definir'}</option>`).join('');
  let modalidadOptions = ['', ...MODALIDAD_OPCIONES].map(m => `<option value="${m}" ${(e.modalidad || '') === m ? 'selected' : ''}>${m || 'Sin definir'}</option>`).join('');
  if (e.modalidad && !MODALIDAD_OPCIONES.includes(e.modalidad)) modalidadOptions += `<option value="${escapeHtml(e.modalidad)}" selected>${escapeHtml(e.modalidad)} (valor anterior)</option>`;
  const esAudiencia = e.tipo === 'Audiencia';
  const tipoAudienciaOptions = ['', ...TIPO_AUDIENCIA_OPCIONES].map(t => `<option value="${t}" ${(e.tipoAudiencia || '') === t ? 'selected' : ''}>${t || 'Sin definir'}</option>`).join('');
  return `
  <div class="agenda-form">
    <div class="subhead" style="margin-top:0;">${evento ? 'Editar evento' : 'Nuevo evento'}</div>
    <div class="form-grid2">
      <div><label>Tipo de evento</label><select id="ev-tipo">${tipoOptions}</select></div>
      <div><label>Estado</label><select id="ev-estado">${estadoOptions}</select></div>
    </div>
    <div id="ev-tipoaudiencia-wrap" ${esAudiencia ? '' : 'hidden'}>
      <label>Tipo de audiencia</label>
      <select id="ev-tipoaudiencia">${tipoAudienciaOptions}</select>
    </div>
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
      <div><label>Modalidad</label><select id="ev-modalidad">${modalidadOptions}</select></div>
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
    formWrap.querySelector('#ev-tipo').addEventListener('change', () => {
      const esAudiencia = formWrap.querySelector('#ev-tipo').value === 'Audiencia';
      formWrap.querySelector('#ev-tipoaudiencia-wrap').hidden = !esAudiencia;
    });
    formWrap.querySelector('#save-evento').addEventListener('click', async () => {
      const tipoSel = formWrap.querySelector('#ev-tipo').value;
      const patch = {
        tipo: tipoSel,
        tipoAudiencia: tipoSel === 'Audiencia' ? (formWrap.querySelector('#ev-tipoaudiencia').value || null) : null,
        descripcion: formWrap.querySelector('#ev-descripcion').value.trim() || null,
        fecha: formWrap.querySelector('#ev-fecha').value || null,
        horaInicio: formWrap.querySelector('#ev-horaInicio').value.trim() || null,
        horaTermino: formWrap.querySelector('#ev-horaTermino').value.trim() || null,
        modalidad: formWrap.querySelector('#ev-modalidad').value || null,
        ubicacion: formWrap.querySelector('#ev-ubicacion').value.trim() || null,
        enlace: formWrap.querySelector('#ev-enlace').value.trim() || null,
        estado: formWrap.querySelector('#ev-estado').value,
        prioridad: formWrap.querySelector('#ev-prioridad').value || null,
        observaciones: formWrap.querySelector('#ev-observaciones').value.trim() || null
      };
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

// 30 Juzgados Civiles de Santiago — único listado válido para el nuevo
// desplegable "Tribunal" cuando Tipo de tribunal = Juzgado Civil. El valor
// interno es solo el número (compatible con numeroTribunal ya existente).
function opcionesTribunalCivilHtml(numeroSeleccionado) {
  let html = '<option value="">Sin definir</option>';
  for (let i = 1; i <= 30; i++) {
    html += `<option value="${i}" ${String(numeroSeleccionado) === String(i) ? 'selected' : ''}>${i}° Juzgado Civil de Santiago</option>`;
  }
  return html;
}

// Precarga del select civil desde una causa existente: solo si el número
// guardado está en 1-30 Y la ciudad guardada es (razonablemente) "Santiago"
// — si no calza exactamente, el select parte en "Sin definir" sin alterar
// el dato ya guardado (tribunalTexto lo sigue mostrando igual).
function numeroTribunalCivilPrecargado(c) {
  const n = parseInt(c.numeroTribunal, 10);
  const ciudadEsSantiago = (c.ciudadTribunal || '').trim().toLowerCase() === 'santiago';
  return (ciudadEsSantiago && n >= 1 && n <= 30) ? String(n) : '';
}

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
// intervinientesEfectivos(c) es la fuente real (ver más abajo) — usa la
// tabla nueva cuando tiene datos, o arma el mismo par de siempre a partir
// de las columnas antiguas cuando la causa aún no tiene intervinientes.
function tieneRolProcesalDefinido(c) {
  return intervinientesEfectivos(c).some(i => i.tipoParte === 'Demandante' || i.tipoParte === 'Demandado/a');
}

function caratuladoTexto(c) {
  const lista = intervinientesEfectivos(c);
  if (tieneRolProcesalDefinido(c)) {
    const primerDemandante = lista.find(i => i.tipoParte === 'Demandante');
    const primerDemandado = lista.find(i => i.tipoParte === 'Demandado/a');
    const dte = nombreCorto(primerDemandante ? primerDemandante.nombre : null);
    const ddo = nombreCorto(primerDemandado ? primerDemandado.nombre : null);
    if (dte && ddo) return `${dte} / ${ddo}`;
    if (dte) return dte;
    if (ddo) return ddo;
  }
  // Causa antigua sin posición procesal definida: se muestra el respaldo
  // (patrocinado/contraparte) sin garantía de orden procesal.
  return partesAbreviadas(c);
}

function normalizarProcedimiento(s) { return normalizarTexto(s || ''); }
function procedimientoCanonico(valorGuardado) {
  const norm = normalizarProcedimiento(valorGuardado);
  if (!norm) return null;
  return ORDEN_TIPOS_JUICIO.find(p => normalizarProcedimiento(p) === norm) || null;
}

const TIPO_JUICIO_POR_PROCEDIMIENTO = {
  'Juicio Ordinario': ['Mayor Cuantía', 'Menor Cuantía', 'Mínima Cuantía', 'Otro'],
  'Juicio Ejecutivo': ['Obligación de Dar', 'Obligación de Hacer', 'Obligación de no Hacer', 'Otro']
};
function opcionesTipoJuicioParaProcedimiento(procedimientoCanon) {
  return TIPO_JUICIO_POR_PROCEDIMIENTO[procedimientoCanon] || null;
}

const MATERIA_POR_PROCEDIMIENTO = {
  'Juicio Ordinario': [
    'Acción Cambiaria Ordinaria, Letra', 'Acción Cambiaria Ordinaria, Pagaré',
    'Acción de Rescisión por Lesión Enorme', 'Acción de Simulación', 'Acción Hipotecaria',
    'Acción Ordinaria de Cobro de Cheque', 'Acción Ordinaria de Desposeimiento',
    'Acción Pauliana, Revocatorias', 'Cobro de Mutuo de Dinero', 'Cobro de Pesos',
    'Cumplimiento de Contrato', 'Derecho y Cobro de Pensiones, Jubilar',
    'Indemnización de Perjuicios', 'Indemnización de Perjuicios Transporte Aéreo',
    'Indemnización de Perjuicios Transporte Terrestre', 'Nulidad de Acto Administrativo',
    'Nulidad de Contrato', 'Nulidad de Expropiación', 'Nulidad de Testamento',
    'Otros Ordinarios', 'Peteción de Herencia',
    'Prescripción Exrinción de Acciones, Adquisición de Derechos y Otros',
    'Procedimiento Cuantía Inferior Art. 749 C.P.C. Hacienda',
    'Procedimiento Cuantía Superior Art. 749 C.P.C. Hacienda', 'Reforma de Testamento',
    'Reivindicación', 'Reliquidación de Pensiones', 'Resolución de Contrato', 'Violencia de Genero'
  ],
  'Juicio Sumario': [
    'Acción de Cerramiento', 'Acciones Contempladas en la Ley que Regula la Competencia',
    'Acciones Revocatorias Concursales', 'Amparo de Aguas',
    'Arrendamiento Bienes Inmuebles, Menor a 4 U.T.M', 'Arrendamiento de Bienes Muebles, CPC',
    'Arrendamiento Devolución de Garantía', 'Cobro de Honorarios', 'Cobro de Rentas, Monitorio',
    'Cobro Pequeño Derecho de Autor', 'Cobro Rentas Bienes Raíces Urbanos, Arrendamiento',
    'Cobro Servicios Según D.L. 964 y Ley 18.101, Arrendamiento', 'Comodato', 'Comodato Precario',
    'Depósito Necesario', 'Derecho Real, Conservación Medioambiental',
    'Derechos Aprovechamiento, C. Aguas', 'Desahucio Contrato Bienes Raíces Urbanos, Arrendamiento',
    'Impugnación del Acuerdo de Renegociación', 'Indemnización de Perjuicios, Arrendamiento',
    'Indemnización Ley de Propiedad Intelectual', 'Indemnización Perjuicios Art. 169 Ley Tránsito',
    'Indemnización Perjuicios Art. 9 Ley 18.287', 'Infracciones a la Ley de Pesca y Acuicultura',
    'Jactancia', 'Otros Sumarios', 'Pesos, Cobro Según Art. 680 N° 7 CPC',
    'Precario, inc. 2° Art. 2.195 C.C', 'Predios Rústicos, Arrendamiento',
    'Procedimiento Arrendamiento, Reconveción de Pago', 'Procedimiento Art. 680 N° 8 C.P.C., Cuentas',
    'Procedimiento de Demarcación', 'Reclamación Art. 341 Ley 20.720',
    'Reclamación de Acto Administrativo', 'Reclamación de Multa Administrativa',
    'Restitución por Expiración Tiempo Estipulado Arrendamiento',
    'Restitución por Extinción Derecho Arrendador', 'Sanitario Código Reclamación de Multas Art. 171',
    'Sentencia Penal Condenatoria', 'Servidumbre Legales', 'Servidumbre Naturales',
    'Terminación Inmediata por no Pago Rentas o Reconvención, Arrandamiento',
    'Transgresión a la Ética Profesional'
  ],
  'Juicio monitorio': ['Cobro de rentas', 'Comodato precario', 'Precario'],
  'Gestión preparatoria': [
    'Citación confesión de deuda', 'Citación Reconocimiento de Firma',
    'Citación y Confesión de Deuda, Reconocimiento de Firma', 'Gestión de Avaluación',
    'Gestión de Confrontación', 'Notificación de Desposeimiento', 'Notificación de Factura',
    'Notificación de Protesto, Letra', 'Notificación de Protesto, Pagaré',
    'Notificación protesto de cheque', 'Notificación Título Ejecutivo Herederos'
  ],
  'Juicio Ejecutivo': [
    'Acción de Desposeimiento', 'Acción Según Ley de Bancos Hipotecario', 'Cobro de Cheque',
    'Cobro de Facturas', 'Cobro de Gastos Comunes', 'Cobro de Letra de Cambio', 'Cobro de Mutuo',
    'Cobro de Pagaré', 'Cobro Ejecutivo de Sentencia Judicial', 'Cumplimiento Obligación de Dar',
    'Cumplimiento Obligación de Hacer', 'Cumplimiento Obligación de No Hacer',
    'Ejecutivo según Ley CORVI', 'Otros Ejecutivos'
  ],
  'Voluntario': [
    'Aprobación de escrituras de partición', 'Autorización Cambio de Nombre',
    'Autorización inscripción fuera de plazo legal Defunción', 'Autorización para arrendar Bienes Raíces',
    'Autorización para Cesión de Derechos', 'Autorización para contraer segundas nupcias',
    'Autorización para Donar o insinuación', 'Autorización para enajenar Bienes Raíces',
    'Autorización para gravar Bienes Raíces', 'Declaración de Herencia yacente', 'Extravío de Título',
    'Inscripciones en Registro Vehiculos Motorizados', 'Inventario solemne', 'Muerte Presunta',
    'Nombramiento de Curador', 'Otros Voluntarios', 'Pago por consignación (art. 1600 CC)',
    'Posesión efectiva', 'Reclamo negativa del Conservador de Bienes Raíces',
    'Reclamo negativa Registro Civil', 'Rectificación Partidas de nacimiento',
    'Registro Civil autorización nombramiento curador especial'
  ],
  'Interdicción': ['Discipación', 'Interdicción por Demencia c/certificado COMPIN', 'Rehabilitación del disipador'],
  'Interdictos posesorios': [
    'Amparo, querella', 'Obra nueva, denuncia', 'Obra ruinosa, denuncia',
    'Oposición a Reconstitución de Inscripción Ley 16665', 'Otros interdictos posesorios',
    'Reestablecimiento, querella', 'Restitución, querella'
  ],
  'Recurso de protección': [
    'Salud', 'Administrativo', 'Autotutela (Corte de suministros básicos)',
    'Educación (Sanción Universidad)', 'Educación (Ley 21.128 aula segura)',
    'Extranjería (Negativa a solicitud de refugio)', 'Extranjería (Omisión visa temporal)',
    'Extranjería (Omisión permanencia definitiva)', 'Grupos intermedios (Suspensión y expulsión de bomberos)',
    'Honra (Funa por RR.SS (redes sociales)', 'Honra (Publicación deuda con pagaré no protestado en Liq. Concursal)',
    'Honra (Publicación deuda con pagaré no protestado)', 'Jurisdiccional (Reclamo de ilegalidad)',
    'Jurisdiccional (Publicación de datos personales SAF)', 'Jurisdiccional (Resolución judicial)',
    'Laboral (No renovación de contrata)', 'Laboral (Municipalidad descuenta licencias médicas rechazadas)',
    'Laboral (Funcionarios en cargos de exclusiva confianza)', 'Laboral (Término anticipado de contrata)',
    'Propiedad', 'Otras protecciones'
  ],
  'Recurso de amparo': ['Amparo Art. 21 Constitución Política', 'Amparo económico']
};

const ETAPA_JUICIO_ORDINARIO = ['En redacción', 'Presentación de la demanda', 'Notificación y Emplazamiento', 'Contestación', 'Réplica y Dúplica', 'Llamado a conciliación', 'Término probatorio', 'Observaciones a la prueba', 'Citación a oír sentencia', 'Sentencia', 'Cumplimiento Incidental', 'Recursos'];
const ETAPA_JUICIO_SUMARIO = ['En redacción', 'Presentación de la demanda', 'Notificación y Emplazamiento', 'Contestación y conciliación', 'Término probatorio', 'Citación a oír sentencia', 'Sentencia', 'Recursos'];
const ETAPA_JUICIO_MONITORIO = ['En redacción', 'Presentación de la demanda', 'Notificación y Emplazamiento', 'Contestación y conciliación', 'Término probatorio', 'Citación a oír sentencia', 'Sentencia', 'Recursos', 'Lanzamiento'];
const ETAPA_GESTION_PREPARATORIA = ['En redacción', 'Presentación de la solicitud', 'Notificación', 'Audiencia o comparecencia', 'Resolución del Tribunal'];
const ETAPA_JUICIO_EJECUTIVO = ['En redacción', 'Presentación de la demanda', 'Notificación y Emplazamiento', 'Excepciones', 'Término probatorio', 'Citación a oír sentencia', 'Sentencia', 'Embargo', 'Bases de remate', 'Remate', 'Recursos'];
const ETAPA_VOLUNTARIO_INTERDICCION = ['En redacción', 'Presentación de la solicitud', 'Audiencia', 'Informes / Oficios', 'Testigos', 'Citación a oír sentencia', 'Sentencia', 'Publicación', 'Inscripción'];
const ETAPA_INTERDICTOS_POSESORIOS = ['En redacción', 'Presentación de la querella', 'Notificación', 'Audiencia', 'Contestación', 'Término probatorio', 'Citación a oír sentencia', 'Sentencia', 'Recursos', 'Cumplimiento Incidental'];
const ETAPA_RECURSO_PROTECCION_AMPARO = ['En redacción', 'Presentación recurso', 'Examen de admisibilidad', 'Recurso', 'Alegatos', 'Sentencia', 'Recurso'];

const ETAPA_POR_PROCEDIMIENTO = {
  'Juicio Ordinario': ETAPA_JUICIO_ORDINARIO,
  'Juicio Sumario': ETAPA_JUICIO_SUMARIO,
  'Juicio monitorio': ETAPA_JUICIO_MONITORIO,
  'Gestión preparatoria': ETAPA_GESTION_PREPARATORIA,
  'Juicio Ejecutivo': ETAPA_JUICIO_EJECUTIVO,
  'Voluntario': ETAPA_VOLUNTARIO_INTERDICCION,
  'Interdicción': ETAPA_VOLUNTARIO_INTERDICCION,
  'Interdictos posesorios': ETAPA_INTERDICTOS_POSESORIOS,
  'Recurso de protección': ETAPA_RECURSO_PROTECCION_AMPARO,
  'Recurso de amparo': ETAPA_RECURSO_PROTECCION_AMPARO
};
function opcionesMateriaParaProcedimiento(procedimientoCanon) { return MATERIA_POR_PROCEDIMIENTO[procedimientoCanon] || null; }
function opcionesEtapaParaProcedimiento(procedimientoCanon) { return ETAPA_POR_PROCEDIMIENTO[procedimientoCanon] || null; }

const RIT_PREFIJOS_VALIDOS = ['C', 'V', 'E', 'A', 'F', 'I'];
function ritYRolEfectivos(c) {
  if (c.rit) return { rit: c.rit, rol: c.rol || '' };
  const rol = c.rol || '';
  const m = rol.match(/^([CVEAFI])-(.+)$/);
  if (m && RIT_PREFIJOS_VALIDOS.includes(m[1])) return { rit: m[1], rol: m[2] };
  return { rit: null, rol };
}
function rolCompletoTexto(c) {
  const { rit, rol } = ritYRolEfectivos(c);
  if (!rit || !rol) return null;
  return `${rit}-${rol}`;
}

function tituloAutomatico(c) {
  const componentes = [];
  const rolTexto = rolCompletoTexto(c);
  if (rolTexto) componentes.push(`ROL ${rolTexto}`);
  if (c.tipoJuicio && c.tipoJuicio !== 'No Aplica') componentes.push(c.tipoJuicio);
  if (c.materia) componentes.push(c.materia);
  const lista = intervinientesEfectivos(c);
  const primerDemandante = lista.find(i => i.tipoParte === 'Demandante');
  const primerDemandado = lista.find(i => i.tipoParte === 'Demandado/a');
  const apDte = nombreCorto(primerDemandante ? primerDemandante.nombre : null);
  const apDdo = nombreCorto(primerDemandado ? primerDemandado.nombre : null);
  if (apDte) componentes.push(apDte);
  if (apDdo) componentes.push(apDdo);
  return componentes.filter(Boolean).join(' / ');
}

function emptyCausa() {
  return {
    id: null, folio: null, categoria: 'nueva', subcategoria: null, tipoJuicio: null,
    materia: null, etapa: null, bajEstado: null, recurso: null, rolIngreso: null, competencia: null,
    rit: null, rol: null, tipoTribunal: null, numeroTribunal: null, ciudadTribunal: null, tribunal: null,
    fechaIngreso: new Date().toISOString().slice(0, 10), tutor: null,
    intervinientes: [], demandanteNombre: null, demandadoNombre: null, parteRepresentada: null,
    patrocinado: null, patrocinadoTipo: null, contraparteNombre: null, titulo: null
  };
}

// ============================================================================
// ANTECEDENTES — formulario único compartido por "Nueva causa" y la
// pestaña Antecedentes de una causa existente. antecedentesFormHtml(c)
// genera el HTML (idéntico en ambos contextos); wireAntecedentesForm
// conecta los eventos y decide createCausa/updateCausa según corresponda.
// ============================================================================
const TUTOR_OPCIONES = ['Hugo Toledo', 'Cesar Romero'];
const RECURSO_OPCIONES = ['Apelación', 'Apelación en subsidio casación', 'Casación en la forma', 'Casación en el fondo'];

function tutorOptionsHtml(seleccionado) {
  return `<option value="">Sin definir</option>` +
    TUTOR_OPCIONES.map(t => `<option value="${escapeHtml(t)}" ${seleccionado === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
}

function procedimientoOptionsHtml(seleccionado) {
  return `<option value="">Sin definir</option>` +
    ORDEN_TIPOS_JUICIO.map(p => `<option value="${escapeHtml(p)}" ${seleccionado === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
}

// Campo dependiente de Procedimiento: si `opciones` es null, se muestra un
// input de texto libre (caso Extrajudicial, o cualquier procedimiento sin
// catálogo). Si es un arreglo, se muestra un select con esas opciones — y,
// si el valor ya guardado no está entre ellas (dato histórico anterior al
// catálogo), se agrega como una opción adicional al final, ya
// seleccionada, para no perder ni ocultar el dato.
// Tipo de juicio es distinto de Materia/Etapa: cuando el procedimiento no
// tiene catálogo propio, NO se vuelve texto libre — queda fijo en "No
// Aplica", sin posibilidad de digitar nada.
function campoTipoJuicioHtml(opciones, valorActual) {
  if (!opciones) {
    return `<input type="text" id="af-tipojuicio" value="No Aplica" disabled style="opacity:.6; cursor:not-allowed;">`;
  }
  const incluyeValorActual = valorActual && opciones.includes(valorActual);
  let opts = `<option value="">Sin definir</option>`;
  opts += opciones.map(o => `<option value="${escapeHtml(o)}" ${valorActual === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  if (valorActual && !incluyeValorActual) {
    opts += `<option value="${escapeHtml(valorActual)}" selected>${escapeHtml(valorActual)} (valor anterior, sin normalizar)</option>`;
  }
  return `<select id="af-tipojuicio">${opts}</select>`;
}

function campoDependienteHtml(id, opciones, valorActual) {
  if (!opciones) {
    return `<input type="text" id="${id}" value="${escapeHtml(valorActual || '')}">`;
  }
  const incluyeValorActual = valorActual && opciones.includes(valorActual);
  let opts = `<option value="">Sin definir</option>`;
  opts += opciones.map(o => `<option value="${escapeHtml(o)}" ${valorActual === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('');
  if (valorActual && !incluyeValorActual) {
    opts += `<option value="${escapeHtml(valorActual)}" selected>${escapeHtml(valorActual)} (valor anterior, sin normalizar)</option>`;
  }
  return `<select id="${id}">${opts}</select>`;
}

function intervinienteRowHtml(item, idx) {
  return `<div class="af-interviniente-row" data-idx="${idx}">
    <label>Tipo de parte</label>
    <select class="af-interv-tipo" data-idx="${idx}">
      <option value="">Sin definir</option>
      ${TIPOS_PARTE.map(t => `<option value="${t}" ${item.tipoParte === t ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <label style="margin-top:6px;">Nombre</label>
    <input type="text" class="af-interv-nombre" data-idx="${idx}" value="${escapeHtml(item.nombre || '')}" placeholder="Nombre completo">
    <button class="btn small danger" type="button" data-action="af-quitar-interviniente" data-idx="${idx}" style="margin-top:6px; width:100%;">Quitar</button>
  </div>`;
}
function intervinientesRowsHtml(lista) {
  if (!lista.length) return `<div class="ficha-empty" style="color:var(--ink-faint);">Sin intervinientes registrados.</div>`;
  return `<div style="display:grid; grid-template-columns:repeat(${lista.length}, minmax(150px, 1fr)); gap:10px; overflow-x:auto;">
    ${lista.map((item, idx) => intervinienteRowHtml(item, idx)).join('')}
  </div>`;
}

// Patrocinado ya no se digita: su nombre se deriva del interviniente con
// el tipo de parte seleccionado (el primero por orden, si hubiera más de
// uno del mismo tipo).
function nombrePatrocinadoDesdeIntervinientes(tipoParte, lista) {
  if (!tipoParte) return null;
  const match = lista.find(i => i.tipoParte === tipoParte);
  return match ? match.nombre : null;
}
// parte_representada (columna antigua) solo admite 'Demandante'/'Demandado'
// por su CHECK ya existente — nunca se le escribe ninguno de los otros 5
// tipos nuevos, para no violar esa restricción. Traducción en ambos
// sentidos solo para los 2 casos compatibles.
function parteRepresentadaLegacyDesdeTipo(tipoParte) {
  if (tipoParte === 'Demandante') return 'Demandante';
  if (tipoParte === 'Demandado/a') return 'Demandado';
  return null;
}
function tipoPatrocinadoDesdeLegacy(parteRepresentada) {
  if (parteRepresentada === 'Demandante') return 'Demandante';
  if (parteRepresentada === 'Demandado') return 'Demandado/a';
  return '';
}
// Fuente principal: patrocinado_tipo (admite los 7 tipos). Si una causa
// histórica no lo tiene, cae a parte_representada solo para los 2 tipos
// que esa columna antigua siempre pudo representar.
function tipoPatrocinadoEfectivo(c) {
  if (c.patrocinadoTipo) return c.patrocinadoTipo;
  return tipoPatrocinadoDesdeLegacy(c.parteRepresentada);
}

function antecedentesFormHtml(c) {
  const procedimientoCanon = procedimientoCanonico(c.subcategoria) || (c.subcategoria || null);
  const opcionesTipoJuicio = opcionesTipoJuicioParaProcedimiento(procedimientoCanon);
  const opcionesMateria = opcionesMateriaParaProcedimiento(procedimientoCanon);
  const opcionesEtapa = opcionesEtapaParaProcedimiento(procedimientoCanon);
  const { rit, rol } = ritYRolEfectivos(c);
  const lista = intervinientesEfectivos(c);

  return `
  <div class="modal-form" id="af-form">
    <div class="form-grid4">
      <div><label>Código SAJ</label><input type="text" inputmode="numeric" id="af-saj" class="saj-input" value="${escapeHtml(c.folio || '')}" placeholder="Solo números"></div>
      <div>
        <label>Carpeta</label>
        <select id="af-categoria">
          <option value="tramitacion" ${c.categoria === 'tramitacion' ? 'selected' : ''}>En tramitación</option>
          <option value="nueva" ${c.categoria === 'nueva' ? 'selected' : ''}>Nueva (redacción)</option>
          <option value="terminada" ${c.categoria === 'terminada' ? 'selected' : ''}>Terminada</option>
        </select>
      </div>
      <div><label>Fecha ingreso causa</label><input type="date" id="af-fechaingreso" value="${escapeHtml(c.fechaIngreso || '')}"></div>
      <div><label>Tutor</label><select id="af-tutor">${tutorOptionsHtml(c.tutor)}</select></div>
    </div>

    <div class="form-grid4">
      <div><label>Procedimiento</label><select id="af-procedimiento">${procedimientoOptionsHtml(procedimientoCanon)}</select></div>
      <div id="af-tipojuicio-wrap"><label>Tipo de juicio</label>${campoTipoJuicioHtml(opcionesTipoJuicio, c.tipoJuicio)}</div>
      <div id="af-materia-wrap"><label>Materia</label>${campoDependienteHtml('af-materia', opcionesMateria, c.materia)}</div>
      <div><label>BAJ</label><select id="af-baj"><option value="">Sin definir</option>${BAJ_OPCIONES.map(([v, l]) => `<option value="${v}" ${c.bajEstado === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>

    <div class="subhead" style="margin-top:10px;">Tribunal</div>
    <div class="form-grid4">
      <div><label>RIT</label><select id="af-rit"><option value="">Sin definir</option>${RIT_PREFIJOS_VALIDOS.map(p => `<option value="${p}" ${rit === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div><label>ROL</label><input type="text" id="af-rol" value="${escapeHtml(rol || '')}" placeholder="Ej: 15250-2026"></div>
      <div><label>Tribunal</label><select id="af-tribunal-civil">${opcionesTribunalCivilHtml(numeroTribunalCivilPrecargado(c))}</select></div>
      <div id="af-etapa-wrap"><label>Etapa Procesal</label>${campoDependienteHtml('af-etapa', opcionesEtapa, c.etapa)}</div>
    </div>
    <div style="font-size:11px; color:var(--ink-faint); margin-top:-4px;" id="af-tribunal-preview">Se mostrará como: <strong>${escapeHtml(tribunalTexto(c) || 'Sin definir')}</strong></div>

    <div class="subhead" style="margin-top:10px; display:flex; align-items:center; justify-content:space-between;">
      <span>Intervinientes</span>
      <div style="display:flex; align-items:center; gap:8px;">
        <label style="margin:0; font-size:12px;">Cantidad</label>
        <input type="number" id="af-cant-intervinientes" min="0" value="${lista.length}" style="width:64px;">
      </div>
    </div>
    <div id="af-intervinientes-wrap">${intervinientesRowsHtml(lista)}</div>

    <div class="subhead" style="margin-top:10px;">Patrocinado</div>
    <div class="form-grid2">
      <div><label>Tipo de parte</label><select id="af-patrocinado-tipo"><option value="">Sin definir</option>${TIPOS_PARTE.map(t => `<option value="${t}" ${tipoPatrocinadoEfectivo(c) === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div><label>Nombre (derivado de Intervinientes)</label><div id="af-patrocinado-nombre-preview" style="padding:8px 0; color:var(--ink-dim);">${escapeHtml(nombrePatrocinadoDesdeIntervinientes(tipoPatrocinadoEfectivo(c), lista) || 'Sin definir')}</div></div>
    </div>
    <div style="font-size:11px; color:var(--ink-faint); margin-top:-4px;" id="af-caratulado-preview">Caratulado: <strong>${escapeHtml(caratuladoTexto(c) || 'Sin definir')}</strong></div>
    <div style="font-size:11px; color:var(--ink-faint);" id="af-titulo-preview">Título generado: <strong>${escapeHtml(tituloAutomatico(c) || 'Sin definir')}</strong></div>

    <div class="subhead" style="margin-top:10px;">Recurso</div>
    <div class="form-grid4">
      <div><label>Recurso</label><select id="af-recurso"><option value="">Sin definir</option>${RECURSO_OPCIONES.map(r => `<option value="${r}" ${c.recurso === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <div><label>ROL ingreso Corte</label><input type="text" id="af-rolingreso" value="${escapeHtml(c.rolIngreso || '')}" placeholder="Ej: 9315-2025"></div>
      <div><label>Competencia</label><select id="af-competencia"><option value="">Sin definir</option><option value="Corte de Apelaciones" ${c.competencia === 'Corte de Apelaciones' ? 'selected' : ''}>Corte de Apelaciones</option><option value="Corte Suprema" ${c.competencia === 'Corte Suprema' ? 'selected' : ''}>Corte Suprema</option></select></div>
      <div></div>
    </div>

    <div style="display:flex; gap:8px; margin-top:16px;">
      <button class="btn primary" id="af-save" type="button">Guardar</button>
      ${c.id ? `<button class="btn danger" id="af-delete" type="button" style="margin-left:auto;">Eliminar esta causa del panel</button>` : ''}
    </div>
  </div>`;
}

// Arma un objeto tipo-causa a partir del estado actual del formulario (sin
// guardar nada) — usado para recalcular las vistas previas de Tribunal/
// Caratulado/Título en vivo, y como base del patch final al guardar.
function snapshotDesdeFormulario(panel, c, estadoIntervinientes) {
  const procedimiento = panel.querySelector('#af-procedimiento').value || null;
  const ritSel = panel.querySelector('#af-rit').value || null;
  const rolInput = panel.querySelector('#af-rol').value.trim() || null;
  const numeroCivil = panel.querySelector('#af-tribunal-civil').value || null;
  const tipoPatrocinadoSel = panel.querySelector('#af-patrocinado-tipo').value || null;
  const patrocinadoNombre = nombrePatrocinadoDesdeIntervinientes(tipoPatrocinadoSel, estadoIntervinientes);
  const parteRepresentada = parteRepresentadaLegacyDesdeTipo(tipoPatrocinadoSel);
  const tipoJuicioEl = panel.querySelector('#af-tipojuicio');
  const materiaEl = panel.querySelector('#af-materia');
  const etapaEl = panel.querySelector('#af-etapa');
  return {
    ...c,
    folio: panel.querySelector('#af-saj').value.trim() || null,
    categoria: panel.querySelector('#af-categoria').value,
    fechaIngreso: panel.querySelector('#af-fechaingreso').value || null,
    tutor: panel.querySelector('#af-tutor').value || null,
    subcategoria: procedimiento,
    tipoJuicio: tipoJuicioEl ? (tipoJuicioEl.value || null) : null,
    materia: materiaEl ? (materiaEl.value.trim ? materiaEl.value.trim() || null : materiaEl.value || null) : null,
    bajEstado: panel.querySelector('#af-baj').value || null,
    rit: ritSel, rol: rolInput,
    tipoTribunal: numeroCivil ? 'Juzgado Civil' : null,
    numeroTribunal: numeroCivil || null,
    ciudadTribunal: numeroCivil ? 'Santiago' : null,
    etapa: etapaEl ? (etapaEl.value.trim ? etapaEl.value.trim() || null : etapaEl.value || null) : null,
    intervinientes: estadoIntervinientes.filter(i => i.nombre && i.tipoParte),
    patrocinado: patrocinadoNombre,
    patrocinadoTipo: tipoPatrocinadoSel || null,
    parteRepresentada,
    recurso: panel.querySelector('#af-recurso').value || null,
    rolIngreso: panel.querySelector('#af-rolingreso').value.trim() || null,
    competencia: panel.querySelector('#af-competencia').value || null
  };
}

function wireAntecedentesForm(panel, c, { esNuevaCausa }) {
  const form = panel.querySelector('#af-form');
  if (!form) return;

  // Estado en memoria de intervinientes — parte de intervinientesEfectivos(c)
  // (tabla nueva, o el respaldo demandante/demandado si aún no existe).
  let estadoIntervinientes = intervinientesEfectivos(c).map(i => ({ id: i.id, tipoParte: i.tipoParte, nombre: i.nombre }));

  function refreshPreviews() {
    const snap = snapshotDesdeFormulario(form, c, estadoIntervinientes);
    const tribunalPreview = form.querySelector('#af-tribunal-preview');
    if (tribunalPreview) tribunalPreview.innerHTML = `Se mostrará como: <strong>${escapeHtml(tribunalTexto(snap) || 'Sin definir')}</strong>`;
    const caratuladoPreview = form.querySelector('#af-caratulado-preview');
    if (caratuladoPreview) caratuladoPreview.innerHTML = `Caratulado: <strong>${escapeHtml(caratuladoTexto(snap) || 'Sin definir')}</strong>`;
    const tituloPreview = form.querySelector('#af-titulo-preview');
    if (tituloPreview) tituloPreview.innerHTML = `Título generado: <strong>${escapeHtml(tituloAutomatico(snap) || 'Sin definir')}</strong>`;
    const patrocinadoPreview = form.querySelector('#af-patrocinado-nombre-preview');
    if (patrocinadoPreview) patrocinadoPreview.textContent = snap.patrocinado || 'Sin definir';
  }

  function renderIntervinientes() {
    form.querySelector('#af-intervinientes-wrap').innerHTML = intervinientesRowsHtml(estadoIntervinientes);
    form.querySelector('#af-cant-intervinientes').value = estadoIntervinientes.length;
    refreshPreviews();
  }

  // Procedimiento -> recalcula Tipo de juicio / Materia / Etapa Procesal
  // dependientes (se reinician al cambiar de procedimiento, ya que un
  // valor de otro procedimiento no tiene sentido en el nuevo catálogo).
  form.querySelector('#af-procedimiento').addEventListener('change', () => {
    const canon = form.querySelector('#af-procedimiento').value || null;
    form.querySelector('#af-tipojuicio-wrap').innerHTML = `<label>Tipo de juicio</label>${campoTipoJuicioHtml(opcionesTipoJuicioParaProcedimiento(canon), null)}`;
    form.querySelector('#af-materia-wrap').innerHTML = `<label>Materia</label>${campoDependienteHtml('af-materia', opcionesMateriaParaProcedimiento(canon), null)}`;
    form.querySelector('#af-etapa-wrap').innerHTML = `<label>Etapa Procesal</label>${campoDependienteHtml('af-etapa', opcionesEtapaParaProcedimiento(canon), null)}`;
    wireCamposDependientesInput();
    refreshPreviews();
  });

  function wireCamposDependientesInput() {
    ['#af-tipojuicio', '#af-materia', '#af-etapa'].forEach(sel => {
      const el = form.querySelector(sel);
      if (el) el.addEventListener('input', refreshPreviews);
    });
  }
  wireCamposDependientesInput();

  // Tribunal / RIT / ROL — todo en vivo hacia la vista previa.
  ['#af-rit', '#af-rol', '#af-tribunal-civil'].forEach(sel => {
    const el = form.querySelector(sel);
    if (el) el.addEventListener('input', refreshPreviews);
  });

  // Cantidad de intervinientes: agrega/quita filas al final, conservando
  // los datos ya ingresados en las filas que se mantienen.
  form.querySelector('#af-cant-intervinientes').addEventListener('input', (e) => {
    const nueva = Math.max(0, parseInt(e.target.value, 10) || 0);
    while (estadoIntervinientes.length < nueva) estadoIntervinientes.push({ id: null, tipoParte: '', nombre: '' });
    while (estadoIntervinientes.length > nueva) estadoIntervinientes.pop();
    renderIntervinientes();
  });

  // Delegación de eventos sobre el contenedor de intervinientes — las
  // filas se reconstruyen dinámicamente, así que se conecta una sola vez
  // sobre el contenedor persistente.
  const intervWrap = form.querySelector('#af-intervinientes-wrap');
  intervWrap.addEventListener('input', (e) => {
    const idx = parseInt(e.target.dataset.idx, 10);
    if (Number.isNaN(idx)) return;
    if (e.target.classList.contains('af-interv-tipo')) estadoIntervinientes[idx].tipoParte = e.target.value;
    if (e.target.classList.contains('af-interv-nombre')) estadoIntervinientes[idx].nombre = e.target.value.trim();
    refreshPreviews();
  });
  intervWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="af-quitar-interviniente"]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    estadoIntervinientes.splice(idx, 1);
    renderIntervinientes();
  });

  // Patrocinado (el nombre se deriva, no se digita — se refresca junto con
  // el resto de las vistas previas al cambiar el tipo o los intervinientes)
  const patrocinadoTipoSel = form.querySelector('#af-patrocinado-tipo');
  if (patrocinadoTipoSel) patrocinadoTipoSel.addEventListener('input', refreshPreviews);

  form.querySelector('#af-save').addEventListener('click', async () => {
    const snap = snapshotDesdeFormulario(form, c, estadoIntervinientes);
    const patch = {
      folio: snap.folio, categoria: snap.categoria, fechaIngreso: snap.fechaIngreso, tutor: snap.tutor,
      subcategoria: snap.subcategoria, tipoJuicio: snap.tipoJuicio, materia: snap.materia, bajEstado: snap.bajEstado,
      rit: snap.rit, rol: snap.rol, tipoTribunal: snap.tipoTribunal, numeroTribunal: snap.numeroTribunal, ciudadTribunal: snap.ciudadTribunal,
      etapa: snap.etapa, patrocinado: snap.patrocinado, patrocinadoTipo: snap.patrocinadoTipo, parteRepresentada: snap.parteRepresentada,
      recurso: snap.recurso, rolIngreso: snap.rolIngreso, competencia: snap.competencia,
      titulo: tituloAutomatico(snap) || null
    };
    const intervinientesValidos = estadoIntervinientes.filter(i => i.nombre && i.tipoParte);
    try {
      if (esNuevaCausa) {
        const nueva = await api.createCausa(CURRENT_USER.id, patch);
        nueva.intervinientes = [];
        for (let idx = 0; idx < intervinientesValidos.length; idx++) {
          const it = intervinientesValidos[idx];
          const creado = await api.createInterviniente(CURRENT_USER.id, nueva.id, { tipoParte: it.tipoParte, nombre: it.nombre, orden: idx });
          nueva.intervinientes.push(creado);
        }
        CAUSAS.unshift(nueva);
        toast('Causa agregada');
        closeNewModal();
        render();
      } else {
        await api.updateCausa(c.id, patch);
        Object.assign(c, patch);
        const originales = intervinientesEfectivos(c).filter(i => i.id);
        const nuevaLista = [];
        for (let idx = 0; idx < intervinientesValidos.length; idx++) {
          const it = intervinientesValidos[idx];
          if (it.id) {
            await api.updateInterviniente(it.id, { tipoParte: it.tipoParte, nombre: it.nombre, orden: idx });
            nuevaLista.push({ id: it.id, tipoParte: it.tipoParte, nombre: it.nombre, orden: idx });
          } else {
            const creado = await api.createInterviniente(CURRENT_USER.id, c.id, { tipoParte: it.tipoParte, nombre: it.nombre, orden: idx });
            nuevaLista.push({ id: creado.id, tipoParte: it.tipoParte, nombre: it.nombre, orden: idx });
          }
        }
        const idsFinales = new Set(nuevaLista.map(i => i.id));
        for (const original of originales) {
          if (!idsFinales.has(original.id)) await api.deleteInterviniente(original.id);
        }
        c.intervinientes = nuevaLista;
        toast('Cambios guardados');
        render();
        closeOverlay();
      }
    } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });

  const delBtn = form.querySelector('#af-delete');
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

const TIPOS_PARTE = ['Demandante', 'Demandado/a', 'Solicitante', 'Solicitado', 'Requirente', 'Requerido', 'Tercero'];

function intervinientesEfectivos(c) {
  const reales = (c.intervinientes || []).slice().sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  if (reales.length) return reales;
  const respaldo = [];
  if (c.demandanteNombre) respaldo.push({ id: null, tipoParte: 'Demandante', nombre: c.demandanteNombre, orden: 0 });
  if (c.demandadoNombre) respaldo.push({ id: null, tipoParte: 'Demandado/a', nombre: c.demandadoNombre, orden: 1 });
  return respaldo;
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

// Vista activa dentro de Centro de Trabajo: 'Tarea' o 'Gestión' (nunca una
// tercera pestaña — "Sin tipo asignado" es un bloque aparte, no una vista).
let centroTrabajoVista = 'Tarea';
// Filtro de categoría dentro de la vista activa (capa nueva, no reemplaza la
// clasificación temporal): null = sin filtro, string = categoría elegida.
let centroTrabajoCategoriaFiltro = null;

// Cuenta CAUSAS ÚNICAS (no gestiones) con al menos una gestión activa
// (Pendiente/En espera) de esa categoría — si una misma causa tiene 2
// gestiones activas iguales, cuenta 1 sola vez.
function causasUnicasPorCategoria(vista, categoria) {
  const activas = allGestionesActivasFlat().filter(g => g.tipo === vista && g.categoria === categoria);
  const ids = new Set(activas.map(g => g.causa.id));
  const causas = [];
  ids.forEach(id => { const c = activas.find(g => g.causa.id === id).causa; causas.push(c); });
  return causas;
}

function categoriaCardsHtml(vista) {
  const categorias = CATEGORIA_POR_TIPO_GESTION[vista] || [];
  return `<div class="work-grid" style="margin-bottom:18px;">
    ${categorias.map(cat => {
      const causas = causasUnicasPorCategoria(vista, cat);
      const activa = centroTrabajoCategoriaFiltro === cat;
      return `<div class="work-card" data-ct-categoria="${escapeHtml(cat)}" style="cursor:pointer; ${activa ? 'border-color:var(--brass);' : ''}">
        <div class="work-desc">${escapeHtml(cat)}</div>
        <div class="work-meta">${causas.length} causa${causas.length === 1 ? '' : 's'}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function centroTrabajoBuckets(tipo) {
  const hoy = todayISO();
  const en7dias = new Date(); en7dias.setDate(en7dias.getDate() + 7);
  const en7iso = toISO(en7dias);

  // tipo undefined -> todas las activas (sin usar, se deja por compatibilidad);
  // tipo === null -> exclusivamente las que NO tienen tipo asignado (bloque
  // temporal de regularización); tipo === 'Tarea'/'Gestión' -> solo esas.
  let activas = allGestionesActivasFlat();
  if (tipo === null) activas = activas.filter(g => !g.tipo);
  else if (tipo) activas = activas.filter(g => g.tipo === tipo);

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
  const b = centroTrabajoBuckets(centroTrabajoVista);
  const sinTipo = allGestionesActivasFlat().filter(g => !g.tipo);
  const causasFiltradas = centroTrabajoCategoriaFiltro ? causasUnicasPorCategoria(centroTrabajoVista, centroTrabajoCategoriaFiltro) : [];
  const container = document.getElementById('list-container');
  container.innerHTML = `
    <div class="section-title">Centro de Trabajo</div>
    <div style="color:var(--ink-dim); font-size:12.5px; margin:-6px 0 14px;">¿Qué debo hacer hoy? — reúne automáticamente las gestiones pendientes de todas tus causas.</div>
    <div style="display:flex; gap:8px; margin-bottom:16px;">
      <button class="btn small ${centroTrabajoVista === 'Tarea' ? 'primary' : 'ghost'}" data-ct-vista="Tarea" type="button">Tareas pendientes</button>
      <button class="btn small ${centroTrabajoVista === 'Gestión' ? 'primary' : 'ghost'}" data-ct-vista="Gestión" type="button">Gestiones pendientes</button>
    </div>
    <div class="subhead" style="margin-top:0;">Por categoría</div>
    ${categoriaCardsHtml(centroTrabajoVista)}
    ${centroTrabajoCategoriaFiltro ? `
    <div class="work-bucket" style="margin-bottom:18px;">
      <div class="work-bucket-h">${escapeHtml(centroTrabajoCategoriaFiltro)} <span class="n">${causasFiltradas.length}</span></div>
      ${causasFiltradas.length ? `<div class="case-grid">${causasFiltradas.map(c => `
        <div class="case-card" data-causa-id="${c.id}">
          <div class="case-main">
            <div class="titulo">${escapeHtml(tituloAutomatico(c) || c.titulo || 'Sin título')}</div>
            <div class="meta"><span class="rol">${escapeHtml(c.rol || '')}</span><span>${escapeHtml(tribunalTexto(c) || '')}</span></div>
          </div>
        </div>`).join('')}</div>` : `<div class="dash-empty">Sin causas en esta categoría.</div>`}
    </div>` : ''}
    <div class="subhead" style="margin-top:0;">Por fecha</div>
    ${workBucketHtml('Hoy', b.hoy, 'No tienes nada para revisar hoy.')}
    ${workBucketHtml('Próximos 7 días', b.proximos7, 'Nada programado para los próximos 7 días.')}
    ${workBucketHtml('En espera', b.enEspera, 'No hay nada en espera.')}
    ${workBucketHtml('Vencidas', b.vencidas, 'No tienes nada vencido. Al día 🎉')}
    ${workBucketHtml('Sin fecha', b.sinFecha, 'No hay nada sin fecha de revisión.')}
    ${sinTipo.length ? `
    <div class="work-bucket" style="margin-top:24px; border-top:1px dashed var(--line); padding-top:16px;">
      <div class="work-bucket-h">Sin tipo asignado <span class="n">${sinTipo.length}</span></div>
      <div style="color:var(--ink-faint); font-size:12px; margin:-4px 0 10px;">Registros históricos creados antes de distinguir Tarea/Gestión. Edítalos para clasificarlos — este bloque desaparece solo cuando ya no quede ninguno.</div>
      <div class="work-grid">${sinTipo.map(workCardHtml).join('')}</div>
    </div>` : ''}
  `;
  container.querySelectorAll('[data-ct-vista]').forEach(btn => {
    btn.addEventListener('click', () => { centroTrabajoVista = btn.dataset.ctVista; centroTrabajoCategoriaFiltro = null; renderCentroTrabajo(); });
  });
  container.querySelectorAll('[data-ct-categoria]').forEach(card => {
    card.addEventListener('click', () => {
      const cat = card.dataset.ctCategoria;
      centroTrabajoCategoriaFiltro = (centroTrabajoCategoriaFiltro === cat) ? null : cat;
      renderCentroTrabajo();
    });
  });
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
let importEsExcelListado = false; // true solo cuando el listado de receptores vino de un Excel (.xlsx/.xls), para elegir la vista previa reducida sin afectar PDF/CSV

function normalizarTexto(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function encontrarOCrearReceptorLocal(nombre) {
  const norm = normalizarTexto(nombre);
  return RECEPTORES.find(r => normalizarTexto(r.nombreCompleto) === norm) || null;
}

// ---------- Sub-vista: catálogo de receptores ----------

// Filtra RECEPTORES por el buscador global (searchTerm) — nombre completo,
// correo principal/alternativo, teléfono 1/2/3, corte, tribunal y
// dirección. Case-insensitive y tolerante a tildes (normalizarTexto, ya
// usado en el resto del archivo para este mismo propósito). Se usa tanto
// en renderReceptoresTab() como en el "Seleccionar todos" de
// wireReceptoresTab(), para que ambos vean siempre la misma lista visible.
function receptoresFiltradosPorBusqueda() {
  if (!searchTerm) return RECEPTORES;
  const st = normalizarTexto(searchTerm);
  return RECEPTORES.filter(r => {
    const campos = [r.nombreCompleto, r.correo, r.correoAlternativo, r.telefono, r.telefono2, r.telefono3, r.corte, r.tribunal, r.domicilio];
    return campos.some(c => normalizarTexto(c).includes(st));
  });
}

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

  const receptoresFiltrados = receptoresFiltradosPorBusqueda();

  // Poda cualquier selección que haya quedado OCULTA por el filtro de
  // búsqueda actual. Se ejecuta en cada render (cada tecla del buscador),
  // así receptoresSeleccionados nunca conserva IDs invisibles — ni el
  // contador, ni "Seleccionar todos", ni "Eliminar seleccionados" pueden
  // llegar a operar sobre algo que no está a la vista.
  const idsVisibles = new Set(receptoresFiltrados.map(r => r.id));
  receptoresSeleccionados.forEach(id => { if (!idsVisibles.has(id)) receptoresSeleccionados.delete(id); });

  const activos = receptoresFiltrados.filter(r => r.activo);
  const inactivos = receptoresFiltrados.filter(r => !r.activo);
  let html = `<div class="agenda-toolbar"><button class="btn small primary" id="add-receptor">+ Nuevo receptor</button></div>
  <div id="receptor-form-wrap" class="agenda-form-wrap" hidden></div>`;
  if (RECEPTORES.length === 0) {
    html += `<div class="empty-msg">Aún no hay receptores en el catálogo. Agrega uno manualmente o usa "Importar PDF / CSV".</div>`;
  } else if (receptoresFiltrados.length === 0) {
    html += `<div class="empty-msg">No hay receptores que coincidan con la búsqueda.</div>`;
  } else {
    // receptoresSeleccionados ya está podado a solo IDs visibles (arriba),
    // así que su .size y el checkbox "checked" de bulkSelectBarHtml
    // reflejan exclusivamente lo filtrado — nunca los 721 del catálogo.
    html += bulkSelectBarHtml(receptoresSeleccionados, receptoresFiltrados.length, 'receptores');
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
    if (selectAll.checked) receptoresFiltradosPorBusqueda().forEach(r => receptoresSeleccionados.add(r.id));
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

  let html = `<div class="agenda-toolbar"><button class="btn small primary" id="add-turno">+ Nuevo turno</button> <button class="btn small" id="importar-turno-excel">Importar turno mensual (Excel)</button></div>
  <div id="turno-form-wrap" class="agenda-form-wrap" hidden></div>`;
  if (TURNOS.length === 0) {
    html += `<div class="empty-msg">Aún no hay turnos cargados. Agrega uno manualmente o importa el archivo Excel de turnos.</div>`;
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
  const importarExcelBtn = container.querySelector('#importar-turno-excel');
  if (importarExcelBtn) importarExcelBtn.addEventListener('click', xtAbrirImportador);
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
      un archivo Excel (.xlsx/.xls) del listado oficial de receptores, o un archivo CSV/TXT. La aplicación
      intenta detectar automáticamente el tipo de documento — siempre puedes corregirlo manualmente. Nada
      se guarda sin tu confirmación en la vista previa.
    </p>
    <p style="font-size:11.5px; color:var(--ink-faint);">
      Excel de la base maestra de receptores: se reconocen las columnas
      <code>Nombre</code>, <code>Corte</code>, <code>Tribunal</code>, <code>Correo Principal</code>,
      <code>Correo Alternativo</code>, <code>Teléfono 1</code>, <code>Teléfono 2</code>, <code>Teléfono 3</code>
      y <code>Dirección</code>. Cada campo se guarda por separado, en su propia columna. Un Excel siempre se trata como
      listado de receptores — nunca crea turnos.
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
      <input type="file" id="import-file" accept=".pdf,.csv,.txt,.xlsx,.xls" hidden>
      <div>Arrastra aquí el PDF, Excel o CSV, o <button class="btn small" id="import-browse" type="button">elegir archivo</button></div>
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
  return `<div class="pjud-row import-preview-row ${incompleta ? 'import-row-incompleta' : ''}" data-preview-idx="${idx}" style="grid-template-columns:auto 1.1fr 1.1fr .8fr .8fr 1fr 1.2fr auto;">
    <div><span class="stamp evento-estado-${incompleta ? 'noprior' : 'calm-estado'}" ${incompleta ? 'style="border-color:var(--urgent); color:var(--urgent);"' : ''}>${estado}</span></div>
    <div><input type="text" class="il-nombre" value="${escapeHtml(row.nombre || '')}" placeholder="Nombre completo"></div>
    <div><input type="text" class="il-domicilio" value="${escapeHtml(row.domicilio || '')}" placeholder="Domicilio"></div>
    <div><input type="text" class="il-telefono" value="${escapeHtml(row.telefono || '')}" placeholder="Teléfono"></div>
    <div><input type="text" class="il-celular" value="${escapeHtml(row.celular || '')}" placeholder="Celular"></div>
    <div><input type="text" class="il-correo" value="${escapeHtml(row.correo || '')}" placeholder="Correo"></div>
    <div><input type="text" class="il-observaciones" value="${escapeHtml(row.observaciones || '')}" placeholder="Correo alternativo / teléfono fijo, etc."></div>
    <div><button class="btn small" data-action="quitar-fila-preview" data-idx="${idx}" style="border-color:var(--urgent); color:var(--urgent);">Quitar</button></div>
  </div>`;
}

// Vista previa del listado de receptores cuando viene de la base Excel
// definitiva: cada columna del Excel (Nombre, Corte, Tribunal, Correo
// Principal, Correo Alternativo, Teléfono 1/2/3, Dirección) tiene su propio
// campo editable — ninguno se mezcla dentro de "observaciones".
function celdaEstadoCatalogoHtml(row, idx) {
  if (!row.nombre) {
    return `<span class="stamp evento-estado-noprior" style="border-color:var(--urgent); color:var(--urgent);">Incompleta</span>`;
  }
  if (row.estadoCatalogo === 'existente') {
    return `<span class="stamp evento-estado-calm-estado">EXISTENTE</span>
      <div class="tm-receptor-datos" style="margin-top:2px;">${escapeHtml(row.receptorExistenteNombre || '')}</div>`;
  }
  if (row.estadoCatalogo === 'nuevo') {
    return `<span class="stamp evento-estado-calm-estado">NUEVO</span>`;
  }
  // 'revisar' — selector manual: elegir un receptor existente (pasa a
  // EXISTENTE, se omitirá) o confirmar que es nuevo (pasa a NUEVO, se creará).
  return `<span class="stamp evento-estado-noprior" style="border-color:var(--urgent); color:var(--urgent);">REVISAR</span>
    <div class="tm-buscador" style="margin-top:4px;">
      <input type="text" class="ilx-buscador-input" data-idx="${idx}" placeholder="Buscar receptor existente…" autocomplete="off">
      <div class="tm-buscador-resultados" data-idx="${idx}"></div>
      <button class="btn small ghost" data-ilx-es-nuevo="${idx}" type="button">Es nuevo</button>
    </div>`;
}

function previewFilaListadoExcelHtml(row, idx) {
  const incompleta = row.incompleta || !row.nombre;
  return `<div class="pjud-row import-preview-row ${incompleta ? 'import-row-incompleta' : ''}" data-preview-idx="${idx}" style="grid-template-columns:auto 1.3fr .9fr 1.1fr 1.3fr 1.3fr .9fr .9fr .9fr 1.1fr auto;">
    <div>${celdaEstadoCatalogoHtml(row, idx)}</div>
    <div><input type="text" class="il-nombre" value="${escapeHtml(row.nombre || '')}" placeholder="Nombre completo"></div>
    <div><input type="text" class="il-corte" value="${escapeHtml(row.corte || '')}" placeholder="Corte"></div>
    <div><input type="text" class="il-tribunal" value="${escapeHtml(row.tribunal || '')}" placeholder="Tribunal"></div>
    <div><input type="text" class="il-correo" value="${escapeHtml(row.correo || '')}" placeholder="Correo principal"></div>
    <div><input type="text" class="il-correo-alt" value="${escapeHtml(row.correoAlternativo || '')}" placeholder="Correo alternativo"></div>
    <div><input type="text" class="il-telefono" value="${escapeHtml(row.telefono || '')}" placeholder="Teléfono 1"></div>
    <div><input type="text" class="il-telefono2" value="${escapeHtml(row.telefono2 || '')}" placeholder="Teléfono 2"></div>
    <div><input type="text" class="il-telefono3" value="${escapeHtml(row.telefono3 || '')}" placeholder="Teléfono 3"></div>
    <div><input type="text" class="il-domicilio" value="${escapeHtml(row.domicilio || '')}" placeholder="Dirección"></div>
    <div><button class="btn small" data-action="quitar-fila-preview" data-idx="${idx}" style="border-color:var(--urgent); color:var(--urgent);">Quitar</button></div>
  </div>`;
}

const AMBITO_TURNO_OPCIONES = ['Corte Suprema', 'Corte Apelaciones / 34° Crimen', 'Juzgado Civil', 'Cobranza Laboral y Previsional'];

const ESTADO_MATCH_LABEL = {
  exacta: 'Coincidencia exacta',
  correo: 'Coincidencia por correo',
  revision: 'Revisión requerida',
  no_encontrado: 'No encontrado en base'
};

function previewFilaTurnoMensualHtml(row, idx) {
  const estadoMatch = row.estadoMatch || 'no_encontrado';
  const esSegura = estadoMatch === 'exacta' || estadoMatch === 'correo';
  const incompleta = row.incompleta || !row.receptorPdf || !esSegura;
  const estadoLabel = !row.receptorPdf ? 'Incompleta' : (ESTADO_MATCH_LABEL[estadoMatch] || 'Revisión requerida');
  return `<div class="pjud-row import-preview-row ${incompleta ? 'import-row-incompleta' : ''}" data-preview-idx="${idx}" data-estado-match="${estadoMatch}" style="grid-template-columns:auto 1.3fr 1.3fr 1.2fr 1.1fr 1.3fr .9fr auto;">
    <div><span class="stamp evento-estado-${esSegura ? 'calm-estado' : 'noprior'}" ${esSegura ? '' : 'style="border-color:var(--urgent); color:var(--urgent);"'}>${estadoLabel}</span></div>
    <div><input type="text" class="it-receptor" value="${escapeHtml(row.receptorPdf || '')}" placeholder="Receptor tal como aparece en el PDF"></div>
    <div class="it-receptor-encontrado" style="font-size:12.5px; ${esSegura ? 'color:var(--ink);' : 'color:var(--urgent);'}">${escapeHtml(row.receptorEncontradoNombre || 'No encontrado en base')}</div>
    <div><input type="text" class="it-correo" value="${escapeHtml(row.correoPdf || '')}" placeholder="Correo del PDF"></div>
    <div><select class="it-ambito">
      ${AMBITO_TURNO_OPCIONES.map(o => `<option value="${escapeHtml(o)}" ${row.ambitoTurno === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
    </select></div>
    <div><input type="text" class="it-tribunal" value="${escapeHtml(row.tribunalTurno || '')}" placeholder="Tribunal"></div>
    <div style="display:flex; gap:4px;">
      <input type="text" class="it-mes" value="${escapeHtml(row.mes || '')}" placeholder="Mes" style="width:64px;">
      <input type="text" class="it-anio" value="${escapeHtml(row.anio || '')}" placeholder="Año" style="width:52px;">
    </div>
    <div><button class="btn small" data-action="quitar-fila-preview" data-idx="${idx}" style="border-color:var(--urgent); color:var(--urgent);">Quitar</button></div>
  </div>`;
}

const IMPORT_FORMATOS_META = {
  'csv-turno': { headers: ['Estado', 'Nombre', 'Inicio', 'Fin', 'Jurisdicción', ''], render: previewFilaTurnoFechaHtml, cols: 'auto 1.4fr 1fr 1fr 1fr auto' },
  'pdf-listado': { headers: ['Estado', 'Nombre', 'Domicilio', 'Teléfono', 'Celular', 'Correo', 'Observaciones', ''], render: previewFilaListadoHtml, cols: 'auto 1.1fr 1.1fr .8fr .8fr 1fr 1.2fr auto' },
  'pdf-turno-mensual': { headers: ['Estado', 'Receptor PDF', 'Receptor encontrado en base', 'Correo PDF', 'Ámbito', 'Tribunal', 'Mes', ''], render: previewFilaTurnoMensualHtml, cols: 'auto 1.3fr 1.3fr 1.2fr 1.1fr 1.3fr .9fr auto' }
};

// Meta exclusiva para el listado de receptores importado desde Excel (ver
// importEsExcelListado / previewFilaListadoExcelHtml). No reemplaza ni
// modifica la entrada 'pdf-listado' de arriba, usada tal cual para PDF.
const IMPORT_LISTADO_EXCEL_META = {
  headers: ['Estado', 'Nombre', 'Corte', 'Tribunal', 'Correo principal', 'Correo alternativo', 'Teléfono 1', 'Teléfono 2', 'Teléfono 3', 'Dirección', ''],
  render: previewFilaListadoExcelHtml,
  cols: 'auto 1.3fr .9fr 1.1fr 1.3fr 1.3fr .9fr .9fr .9fr 1.1fr auto'
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
  const meta = (importFormato === 'pdf-listado' && importEsExcelListado)
    ? IMPORT_LISTADO_EXCEL_META
    : IMPORT_FORMATOS_META[importFormato];
  const selectorHtml = selectorTipoDocumentoHtml();

  if (importPreviewRows.length === 0) {
    wrap.innerHTML = `${selectorHtml}<div class="empty-msg">No se detectaron filas. Agrega una manualmente para continuar.</div>
      <div class="agenda-toolbar" style="margin-top:10px;"><button class="btn small" id="import-add-row" type="button">+ Agregar fila manual</button></div>`;
  } else {
    const completas = importPreviewRows.filter(r => !r.incompleta).length;
    const resumenHtml = importEsExcelListado
      ? (() => {
          const existentes = importPreviewRows.filter(r => r.nombre && r.estadoCatalogo === 'existente').length;
          const nuevos = importPreviewRows.filter(r => r.nombre && r.estadoCatalogo === 'nuevo').length;
          const revision = importPreviewRows.filter(r => r.nombre && r.estadoCatalogo === 'revisar').length;
          return `Total: ${importPreviewRows.length} · Existentes: ${existentes} · Nuevos: ${nuevos} · Para revisión: ${revision}${completas < importPreviewRows.length ? ` · ${importPreviewRows.length - completas} incompleta(s)` : ''}.`;
        })()
      : `${importPreviewRows.length} fila(s) en total · ${completas} completa(s) · ${importPreviewRows.length - completas} requieren revisión (marcadas en rojo).`;
    // El scroll horizontal se aplica únicamente a la vista previa de Excel
    // (9 columnas de datos + Estado + Acción); el resto de los importadores
    // (CSV, PDF listado, turno mensual) no se toca.
    const scrollAperturaHtml = importEsExcelListado ? '<div class="import-table-scroll">' : '';
    const scrollCierreHtml = importEsExcelListado ? '</div>' : '';
    wrap.innerHTML = `
      ${selectorHtml}
      <div class="subhead">Vista previa — revisa y corrige antes de confirmar</div>
      <div style="font-size:11.5px; color:var(--ink-faint); margin-bottom:8px;">
        ${resumenHtml}
      </div>
      ${scrollAperturaHtml}
      <div class="pjud-table">
        <div class="pjud-row pjud-head" style="grid-template-columns:${meta.cols};">${meta.headers.map(h => `<div>${h}</div>`).join('')}</div>
        ${importPreviewRows.map(meta.render).join('')}
      </div>
      ${scrollCierreHtml}
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
      'pdf-listado': { nombre: '', domicilio: '', telefono: '', celular: '', correo: '', correoAlternativo: '', telefono2: '', telefono3: '', corte: '', tribunal: '', observaciones: '', incompleta: true },
      'pdf-turno-mensual': { receptorPdf: '', correoPdf: '', ambitoTurno: 'Juzgado Civil', tribunalTurno: '', mes: '', anio: '', receptorId: null, receptorEncontradoNombre: '', estadoMatch: 'no_encontrado', incompleta: true }
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
        if (importEsExcelListado) {
          // La celda de estado del catálogo maestro (EXISTENTE/NUEVO/REVISAR,
          // con su propio buscador para las filas en revisión) no debe
          // sobrescribirse aquí con el badge genérico OK/Revisar — eso
          // destruiría el buscador mismo al escribir en él. Solo se
          // mantiene el resaltado de fila incompleta.
          row.classList.toggle('import-row-incompleta', !ok);
          return;
        }
      } else {
        // Turno mensual: la corrección del nombre/correo debe re-evaluar la
        // coincidencia real contra receptores_judiciales en vivo — nunca se
        // marca "OK" solo porque el campo de texto no está vacío, ya que la
        // regla obligatoria es no confirmar sin coincidencia segura.
        const receptorTexto = row.querySelector('.it-receptor').value.trim();
        const correoTexto = row.querySelector('.it-correo').value.trim();
        const { receptor, estado } = encontrarReceptorEnBase(receptorTexto, correoTexto);
        row.dataset.estadoMatch = estado;
        const encontradoCell = row.querySelector('.it-receptor-encontrado');
        if (encontradoCell) {
          encontradoCell.textContent = receptor ? receptor.nombreCompleto : 'No encontrado en base';
          encontradoCell.style.color = receptor ? 'var(--ink)' : 'var(--urgent)';
        }
        ok = !!receptorTexto && (estado === 'exacta' || estado === 'correo');
        const badgeCell = row.children[0];
        badgeCell.innerHTML = !receptorTexto
          ? '<span class="stamp evento-estado-noprior" style="border-color:var(--urgent); color:var(--urgent);">Incompleta</span>'
          : `<span class="stamp evento-estado-${ok ? 'calm-estado' : 'noprior'}" ${ok ? '' : 'style="border-color:var(--urgent); color:var(--urgent);"'}>${escapeHtml(ESTADO_MATCH_LABEL[estado] || 'Revisión requerida')}</span>`;
        row.classList.toggle('import-row-incompleta', !ok);
        return;
      }
      row.classList.toggle('import-row-incompleta', !ok);
      const badgeCell = row.children[0];
      badgeCell.innerHTML = ok
        ? '<span class="stamp evento-estado-calm-estado">OK</span>'
        : '<span class="stamp evento-estado-noprior" style="border-color:var(--urgent); color:var(--urgent);">Revisar</span>';
    };
    row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', actualizarEstadoFila));
  });

  // Actualización masiva del catálogo maestro: resolución manual de las
  // filas en REVISAR — elegir un receptor existente (pasa a EXISTENTE, se
  // omitirá al confirmar) o confirmar que es nuevo (pasa a NUEVO, se creará).
  // No afecta a PDF/CSV: esos formatos nunca generan estos elementos.
  wrap.querySelectorAll('.ilx-buscador-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = parseInt(inp.dataset.idx, 10);
      const cont = wrap.querySelector(`.tm-buscador-resultados[data-idx="${idx}"]`);
      if (!cont) return;
      if (!inp.value.trim()) { cont.innerHTML = ''; return; }
      const resultados = xtBuscarReceptoresPorPalabras(inp.value); // búsqueda por palabras ya aprobada, reutilizada sin cambios
      cont.innerHTML = resultados.length === 0
        ? '<div class="tm-buscador-vacio">Sin coincidencias en la base maestra.</div>'
        : resultados.map(r => {
          const datos = [r.correo, r.telefono, r.domicilio].filter(Boolean);
          return `<div class="tm-buscador-item" data-ilx-elegir="${idx}" data-receptor-id="${r.id}">
            <strong>${escapeHtml(r.nombreCompleto)}</strong>
            ${datos.length ? `<span>${datos.map(escapeHtml).join(' · ')}</span>` : ''}
          </div>`;
        }).join('');
    });
  });
  // [data-ilx-elegir] se crea dinámicamente dentro del evento 'input' de
  // arriba (recién cuando la usuaria escribe), así que conectar el clic
  // directamente sobre esos elementos en este momento nunca los alcanza —
  // mismo problema ya corregido en el importador de Turnos. Se delega sobre
  // el contenedor persistente wrap; como wireImportPreview se llama de
  // nuevo en cada render, se registra una sola vez con una bandera para no
  // acumular listeners duplicados.
  if (!wrap.dataset.ilxDelegado) {
    wrap.dataset.ilxDelegado = '1';
    wrap.addEventListener('click', (e) => {
      const item = e.target.closest('[data-ilx-elegir]');
      if (!item) return;
      const idx = parseInt(item.dataset.ilxElegir, 10);
      const receptor = RECEPTORES.find(r => r.id === item.dataset.receptorId);
      if (!receptor) return;
      importPreviewRows[idx].estadoCatalogo = 'existente';
      importPreviewRows[idx].receptorExistenteId = receptor.id;
      importPreviewRows[idx].receptorExistenteNombre = receptor.nombreCompleto;
      renderImportPreview(container, archivoNombre);
    });
  }
  wrap.querySelectorAll('[data-ilx-es-nuevo]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.ilxEsNuevo, 10);
      importPreviewRows[idx].estadoCatalogo = 'nuevo';
      importPreviewRows[idx].receptorExistenteId = null;
      importPreviewRows[idx].receptorExistenteNombre = '';
      renderImportPreview(container, archivoNombre);
    });
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
        // Regla obligatoria (global, aplica a toda importación de turnos,
        // antigua o nueva): un turno SOLO puede vincularse a un receptor que
        // ya exista en receptores_judiciales. Esta función NUNCA debe crear
        // uno — a diferencia del importador del catálogo maestro
        // (confirmarImportacionListado, más abajo en este archivo), que sí
        // puede hacerlo y no se modifica aquí.
        const receptor = encontrarOCrearReceptorLocal(row.nombre);
        if (!receptor) {
          resumen.errores.push({ nombre: row.nombre, jurisdiccion: row.jurisdiccion, mensaje: 'Receptor no encontrado en la base maestra — fila omitida, requiere revisión.' });
          continue;
        }
        resumen.receptoresExistentes++;

        // Evitar duplicados: mismo receptor_id + fecha_inicio + fecha_fin
        // + jurisdicción ya guardado (incluye turnos de una importación
        // anterior, no solo los del archivo actual).
        const yaExiste = TURNOS.some(t =>
          t.receptorId === receptor.id &&
          t.fechaInicio === row.fechaInicio &&
          t.fechaFin === row.fechaFin &&
          normalizarTexto(t.jurisdiccion || '') === normalizarTexto(row.jurisdiccion || '')
        );
        if (yaExiste) { resumen.duplicadosOmitidos++; continue; }

        // Crear el turno vinculado al receptor ya existente.
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
    // val(): lectura segura — .il-corte/.il-tribunal/.il-correo-alt/
    // .il-telefono2/.il-telefono3 solo existen en la vista previa de Excel
    // (previewFilaListadoExcelHtml); en la vista de PDF (previewFilaListadoHtml)
    // esos elementos no existen y simplemente quedan como '', sin error y
    // sin cambiar el comportamiento del importador de PDF.
    const val = (selector) => row.querySelector(selector)?.value?.trim() || '';
    importPreviewRows[idx] = {
      nombre: val('.il-nombre'),
      domicilio: val('.il-domicilio'),
      telefono: val('.il-telefono'),
      celular: val('.il-celular'),
      correo: val('.il-correo'),
      correoAlternativo: val('.il-correo-alt'),
      telefono2: val('.il-telefono2'),
      telefono3: val('.il-telefono3'),
      corte: val('.il-corte'),
      tribunal: val('.il-tribunal'),
      observaciones: val('.il-observaciones'),
      // fuenteOficial no tiene input propio en la vista previa: se conserva
      // el valor ya asignado al parsear (fijo para el Excel oficial del
      // Poder Judicial; ausente para PDF/CSV, que siguen usando el nombre
      // del archivo, sin cambios respecto del comportamiento anterior).
      fuenteOficial: importPreviewRows[idx]?.fuenteOficial,
      // Clasificación del catálogo maestro (EXISTENTE/NUEVO/REVISAR): se
      // calculó al parsear o se resolvió manualmente — nunca se recalcula
      // aquí, solo se preserva (si no, se perdería al reconstruir el objeto).
      estadoCatalogo: importPreviewRows[idx]?.estadoCatalogo,
      receptorExistenteId: importPreviewRows[idx]?.receptorExistenteId,
      receptorExistenteNombre: importPreviewRows[idx]?.receptorExistenteNombre
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

  if (importacionEnProgreso) return; // impide doble clic / reentrancia
  importacionEnProgreso = true;

  const confirmBtn = wrap.querySelector('#import-confirm');
  const addRowBtn = wrap.querySelector('#import-add-row');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Guardando…'; }
  if (addRowBtn) addRowBtn.disabled = true;

  const total = validas.length;
  let procesadas = 0;

  if (importEsExcelListado) {
    // ---- Actualización masiva del catálogo maestro: NUNCA llama a
    // api.updateReceptor. EXISTENTE se omite, REVISAR sin resolver se
    // omite (nunca se crea mientras siga ambiguo), solo NUEVO se crea. ----
    const actualizarProgresoExcel = () => {
      if (warningsEl) warningsEl.innerHTML = `<div class="familia-hint">Guardando receptores… ${procesadas} de ${total}</div>`;
    };
    actualizarProgresoExcel();

    let nuevosGuardados = 0, existentesOmitidos = 0, sinResolver = 0, errorAlGuardarExcel = 0;
    for (const row of validas) {
      if (row.estadoCatalogo === 'existente') { existentesOmitidos++; procesadas++; actualizarProgresoExcel(); continue; }
      if (row.estadoCatalogo === 'revisar') { sinResolver++; procesadas++; actualizarProgresoExcel(); continue; }
      // 'nuevo'
      const telefono = [row.telefono, row.celular].filter(Boolean).join(' / ') || null;
      const fuenteOficial = row.fuenteOficial || archivoNombre;
      try {
        const nuevo = await api.createReceptor(CURRENT_USER.id, {
          nombreCompleto: row.nombre, telefono, correo: row.correo || null, domicilio: row.domicilio || null,
          observaciones: row.observaciones || null,
          correoAlternativo: row.correoAlternativo || null,
          telefono2: row.telefono2 || null,
          telefono3: row.telefono3 || null,
          corte: row.corte || null,
          tribunal: row.tribunal || null,
          materia: 'Civil', activo: true, fuenteOficial, fechaActualizacion: todayISO()
        });
        RECEPTORES.unshift(nuevo);
        nuevosGuardados++;
      } catch (e) {
        console.error(e);
        errorAlGuardarExcel++;
      }
      procesadas++;
      actualizarProgresoExcel();
    }

    importacionEnProgreso = false;

    if (warningsEl) {
      warningsEl.innerHTML = `<div class="familia-hint" style="line-height:1.8;">
        <strong>Proceso finalizado</strong><br>
        Total procesado: ${procesadas} de ${total}<br>
        Nuevos guardados: ${nuevosGuardados}<br>
        Existentes omitidos: ${existentesOmitidos}<br>
        Sin resolver: ${sinResolver}<br>
        Errores: ${errorAlGuardarExcel}
      </div>`;
    }
    const toolbarElExcel = container.querySelector('.agenda-toolbar');
    if (toolbarElExcel) {
      toolbarElExcel.innerHTML = `<button class="btn primary" id="import-listo" type="button">Listo</button>`;
      document.getElementById('import-listo').addEventListener('click', () => {
        importPreviewRows = [];
        renderReceptoresAdmin();
      });
    }
    return;
  }

  // ---- Comportamiento SIN CAMBIOS para PDF oficial y CSV/TXT genérico:
  // busca y actualiza si existe, crea si no existe. ----
  const actualizarProgreso = () => {
    if (warningsEl) warningsEl.innerHTML = `<div class="familia-hint">Guardando receptores… ${procesadas} de ${total}</div>`;
  };
  actualizarProgreso();

  let creados = 0, actualizados = 0, errorAlGuardar = 0;
  for (const row of validas) {
    const telefono = [row.telefono, row.celular].filter(Boolean).join(' / ') || null;
    const fuenteOficial = row.fuenteOficial || archivoNombre;
    try {
      const existente = encontrarOCrearReceptorLocal(row.nombre);
      if (existente) {
        const actualizado = await api.updateReceptor(existente.id, {
          telefono: telefono || existente.telefono,
          correo: row.correo || existente.correo,
          domicilio: row.domicilio || existente.domicilio,
          observaciones: row.observaciones || existente.observaciones,
          correoAlternativo: row.correoAlternativo || existente.correoAlternativo,
          telefono2: row.telefono2 || existente.telefono2,
          telefono3: row.telefono3 || existente.telefono3,
          corte: row.corte || existente.corte,
          tribunal: row.tribunal || existente.tribunal,
          fuenteOficial, fechaActualizacion: todayISO()
        });
        Object.assign(existente, actualizado);
        actualizados++;
      } else {
        const nuevo = await api.createReceptor(CURRENT_USER.id, {
          nombreCompleto: row.nombre, telefono, correo: row.correo || null, domicilio: row.domicilio || null,
          observaciones: row.observaciones || null,
          correoAlternativo: row.correoAlternativo || null,
          telefono2: row.telefono2 || null,
          telefono3: row.telefono3 || null,
          corte: row.corte || null,
          tribunal: row.tribunal || null,
          materia: 'Civil', activo: true, fuenteOficial, fechaActualizacion: todayISO()
        });
        RECEPTORES.unshift(nuevo);
        creados++;
      }
    } catch (e) {
      console.error(e);
      errorAlGuardar++;
    }
    procesadas++;
    actualizarProgreso();
  }

  importacionEnProgreso = false; // recién aquí se puede volver a cambiar de pestaña o iniciar otra importación

  if (warningsEl) {
    warningsEl.innerHTML = `<div class="familia-hint" style="line-height:1.8;">
      <strong>Proceso finalizado</strong><br>
      Total procesado: ${procesadas} de ${total}<br>
      Guardados (nuevos): ${creados}<br>
      Actualizados (ya existentes): ${actualizados}<br>
      Errores: ${errorAlGuardar}
    </div>`;
  }
  const toolbarEl = container.querySelector('.agenda-toolbar');
  if (toolbarEl) {
    toolbarEl.innerHTML = `<button class="btn primary" id="import-listo" type="button">Listo</button>`;
    document.getElementById('import-listo').addEventListener('click', () => {
      importPreviewRows = [];
      renderReceptoresAdmin();
    });
  }
}

// Tipo B: turno mensual (juzgados civiles de Santiago) → crea/vincula el
// receptor y crea un turno por tribunal, con el mes completo como período.
// Antes de crear un turno: ¿ya existe uno con el mismo receptor, mismo
// rango de fechas y mismo tribunal_turno? Se revisa contra TURNOS (ya
// cargado en memoria) y también contra lo recién creado en esta misma
// tanda de confirmación, para no duplicar si el PDF repite una fila.
function turnoYaExiste(receptorId, fechaInicio, fechaFin, tribunalTurno, extra) {
  const coincide = (t) => t.receptorId === receptorId && t.fechaInicio === fechaInicio &&
    t.fechaFin === fechaFin && (t.tribunalTurno || '') === (tribunalTurno || '');
  return TURNOS.some(coincide) || (extra || []).some(coincide);
}

// ============================================================================
// IMPORTADOR SEMIAUTOMÁTICO DE TURNO MENSUAL (PDF escaneado como referencia
// visual) — bloque nuevo y autocontenido. NO reutiliza ni modifica
// parsearTurnoMensualCivilPdf/confirmarImportacionTurnoMensual/
// previewFilaTurnoMensualHtml de arriba (esas siguen intactas, dormidas
// para PDF escaneados, tal como ya estaban). Este flujo NUNCA lee texto del
// PDF ni intenta reconocer nombres — el PDF solo se renderiza como imagen
// de referencia (page.render(), no getTextContent()); toda asignación de
// receptor viene de una selección explícita contra RECEPTORES ya cargado en
// memoria. Nunca crea receptores nuevos.
// ============================================================================

let tmState = null;
let tmFilaSeq = 0;

function tmNuevaFila(ambitoTurno, tribunalTurno, removible) {
  tmFilaSeq++;
  return { id: `tmf${tmFilaSeq}`, ambitoTurno, tribunalTurno, receptorId: null, receptorNoEncontrado: false, correoPdf: '', removible: !!removible };
}

function tmFilasIniciales() {
  const filas = [];
  filas.push(tmNuevaFila('Corte Suprema', 'Corte Suprema', false));
  filas.push(tmNuevaFila('Corte Apelaciones / 34° Crimen', 'Corte de Apelaciones de Santiago y 34° Juzgado del Crimen de Santiago', true));
  for (let i = 1; i <= 30; i++) {
    filas.push(tmNuevaFila('Juzgado Civil', `${i}° Juzgado Civil de Santiago`, false));
  }
  filas.push(tmNuevaFila('Cobranza Laboral y Previsional', 'Juzgado de Cobranza Laboral y Previsional de Santiago', true));
  return filas;
}

// Detecta mes/año desde el NOMBRE DEL ARCHIVO (nunca desde el contenido del
// PDF) — precarga, siempre corregible a mano. P.ej. "TURNO_RECEPTORES_
// JULIO_2026.pdf" → { mes:'julio', anio:'2026' }.
function tmDetectarMesAnioDesdeNombreArchivo(nombreArchivo) {
  const texto = normalizarTexto(nombreArchivo).replace(/[_\-.]/g, ' ');
  for (let i = 0; i < MESES_ES.length; i++) {
    if (new RegExp(`\\b${MESES_ES[i]}\\b`).test(texto)) {
      const anioMatch = texto.match(/\b(20\d{2})\b/);
      if (anioMatch) return { mes: MESES_ES[i], anio: anioMatch[1] };
    }
  }
  return { mes: '', anio: '' };
}

function tmRangoMes(mesNombre, anioStr) {
  const idxMes = MESES_ES.indexOf((mesNombre || '').toLowerCase());
  const anio = parseInt(anioStr, 10);
  if (idxMes < 0 || !anio) return null;
  const fechaInicio = `${anio}-${String(idxMes + 1).padStart(2, '0')}-01`;
  const ultimoDia = new Date(anio, idxMes + 1, 0).getDate();
  const fechaFin = `${anio}-${String(idxMes + 1).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
  return { fechaInicio, fechaFin };
}

function abrirImportadorTurnoMensualPdf() {
  tmState = { archivo: null, archivoNombre: '', pdfDoc: null, paginaActual: 1, totalPaginas: 0, mes: '', anio: '', filas: tmFilasIniciales() };
  document.getElementById('tm-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="tm-overlay" id="tm-overlay">
      <div class="tm-panel">
        <div class="tm-panel-head">
          <h3>Importar turno mensual (PDF de referencia)</h3>
          <button class="familia-close-x" id="tm-cerrar" type="button">&times;</button>
        </div>
        <div class="tm-panel-body" id="tm-panel-body"></div>
      </div>
    </div>
  `);
  document.getElementById('tm-overlay').classList.add('show');
  document.getElementById('tm-overlay').addEventListener('click', (e) => { if (e.target.id === 'tm-overlay') tmCerrar(); });
  document.getElementById('tm-cerrar').addEventListener('click', tmCerrar);
  tmRenderPaso1();
}

function tmCerrar() {
  document.getElementById('tm-overlay')?.classList.remove('show');
  document.getElementById('tm-overlay')?.remove();
  tmState = null;
}

// ---- Paso 1: elegir archivo + confirmar mes/año ----
function tmRenderPaso1() {
  const body = document.getElementById('tm-panel-body');
  body.innerHTML = `
    <div class="tm-paso1">
      <p class="familia-hint">Selecciona el PDF mensual de turnos. Se usa únicamente como referencia visual — no se extrae texto del archivo.</p>
      <input type="file" id="tm-file" accept=".pdf">
      <div class="form-grid2" style="margin-top:14px;">
        <div><label>Mes</label>
          <select id="tm-mes">
            <option value="">— Selecciona —</option>
            ${MESES_ES.map(m => `<option value="${m}">${m.charAt(0).toUpperCase() + m.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div><label>Año</label><input type="text" id="tm-anio" placeholder="Ej: 2026" maxlength="4"></div>
      </div>
      <div id="tm-archivo-nombre" class="familia-hint" style="margin-top:6px;"></div>
      <div style="margin-top:16px;"><button class="btn primary" id="tm-continuar" type="button" disabled>Continuar</button></div>
    </div>
  `;
  const fileInput = body.querySelector('#tm-file');
  const mesSelect = body.querySelector('#tm-mes');
  const anioInput = body.querySelector('#tm-anio');
  const continuarBtn = body.querySelector('#tm-continuar');
  const nombreEl = body.querySelector('#tm-archivo-nombre');

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    tmState.archivo = file;
    tmState.archivoNombre = file.name;
    nombreEl.textContent = `Archivo: ${file.name}`;
    const { mes, anio } = tmDetectarMesAnioDesdeNombreArchivo(file.name);
    if (mes) mesSelect.value = mes;
    if (anio) anioInput.value = anio;
    continuarBtn.disabled = false;
  });

  continuarBtn.addEventListener('click', async () => {
    if (!tmState.archivo) { toast('Selecciona un PDF.'); return; }
    if (!mesSelect.value || !/^20\d{2}$/.test(anioInput.value.trim())) { toast('Indica un mes y un año válidos (ej: 2026).'); return; }
    tmState.mes = mesSelect.value;
    tmState.anio = anioInput.value.trim();
    continuarBtn.disabled = true;
    continuarBtn.textContent = 'Cargando PDF…';
    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
      const buffer = await tmState.archivo.arrayBuffer();
      tmState.pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
      tmState.totalPaginas = tmState.pdfDoc.numPages;
      tmState.paginaActual = 1;
      tmRenderPaso2();
    } catch (e) {
      console.error(e);
      toast('No se pudo abrir el PDF: ' + e.message);
      continuarBtn.disabled = false;
      continuarBtn.textContent = 'Continuar';
    }
  });
}

// ---- Paso 2: visor de PDF + formulario de asignación ----
function tmRenderPaso2() {
  const body = document.getElementById('tm-panel-body');
  body.innerHTML = `
    <div class="tm-paso2">
      <div class="tm-pdf-pane">
        <div class="tm-pdf-toolbar">
          <button class="btn small ghost" id="tm-pagina-prev" type="button">← Anterior</button>
          <span id="tm-pagina-label"></span>
          <button class="btn small ghost" id="tm-pagina-next" type="button">Siguiente →</button>
        </div>
        <div class="tm-pdf-canvas-wrap"><canvas id="tm-pdf-canvas"></canvas></div>
      </div>
      <div class="tm-form-pane">
        <div class="tm-form-header">
          <div><strong>${tmState.mes.charAt(0).toUpperCase() + tmState.mes.slice(1)} ${tmState.anio}</strong> · ${escapeHtml(tmState.archivoNombre)}</div>
          <button class="btn small ghost" id="tm-cambiar-mes" type="button">Cambiar mes/archivo</button>
        </div>
        <div class="tm-filas-wrap" id="tm-filas-wrap"></div>
        <div class="tm-form-footer">
          <button class="btn primary" id="tm-ver-resumen" type="button">Ver resumen y guardar</button>
        </div>
      </div>
    </div>
  `;

  body.querySelector('#tm-cambiar-mes').addEventListener('click', tmRenderPaso1);
  body.querySelector('#tm-pagina-prev').addEventListener('click', () => tmCambiarPagina(-1));
  body.querySelector('#tm-pagina-next').addEventListener('click', () => tmCambiarPagina(1));
  body.querySelector('#tm-ver-resumen').addEventListener('click', tmRenderResumen);

  tmActualizarPaginaLabel();
  tmRenderizarPaginaActual();
  tmRenderFilas();
}

function tmActualizarPaginaLabel() {
  const label = document.getElementById('tm-pagina-label');
  if (label) label.textContent = `Página ${tmState.paginaActual} de ${tmState.totalPaginas}`;
}

async function tmCambiarPagina(delta) {
  const nueva = tmState.paginaActual + delta;
  if (nueva < 1 || nueva > tmState.totalPaginas) return;
  tmState.paginaActual = nueva;
  tmActualizarPaginaLabel();
  await tmRenderizarPaginaActual();
}

// Renderiza la página como IMAGEN (page.render) — nunca se llama a
// getTextContent() en este flujo, no hay ninguna extracción de texto.
async function tmRenderizarPaginaActual() {
  const canvas = document.getElementById('tm-pdf-canvas');
  if (!canvas || !tmState?.pdfDoc) return;
  const page = await tmState.pdfDoc.getPage(tmState.paginaActual);
  const wrapWidth = canvas.parentElement.clientWidth || 560;
  const viewportBase = page.getViewport({ scale: 1 });
  const escala = Math.max(0.4, Math.min(wrapWidth / viewportBase.width, 2.5));
  const viewport = page.getViewport({ scale: escala });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}

// ---- Filas del formulario ----
function tmRenderFilas() {
  const wrap = document.getElementById('tm-filas-wrap');
  if (!wrap) return;
  const bloques = [
    { titulo: 'A. Corte Suprema', filas: tmState.filas.filter(f => f.ambitoTurno === 'Corte Suprema') },
    { titulo: 'B. Corte de Apelaciones de Santiago / 34° Juzgado del Crimen', filas: tmState.filas.filter(f => f.ambitoTurno === 'Corte Apelaciones / 34° Crimen'), agregar: 'Corte Apelaciones / 34° Crimen' },
    { titulo: 'C. Juzgados Civiles de Santiago', filas: tmState.filas.filter(f => f.ambitoTurno === 'Juzgado Civil') },
    { titulo: 'D. Juzgado de Cobranza Laboral y Previsional', filas: tmState.filas.filter(f => f.ambitoTurno === 'Cobranza Laboral y Previsional'), agregar: 'Cobranza Laboral y Previsional' }
  ];
  wrap.innerHTML = bloques.map(b => `
    <div class="tm-bloque">
      <div class="familia-subhead">${b.titulo}</div>
      <div class="tm-filas">${b.filas.map(tmFilaHtml).join('')}</div>
      ${b.agregar ? `<button class="btn small ghost" data-tm-agregar-bloque="${escapeHtml(b.agregar)}" type="button">＋ Agregar receptor</button>` : ''}
    </div>
  `).join('');
  tmWireFilas();
}

function tmFilaHtml(fila) {
  return `<div class="tm-row" data-fila-id="${fila.id}">
    <div class="tm-row-tribunal">${escapeHtml(fila.tribunalTurno)}</div>
    <div class="tm-row-receptor">${tmReceptorCeldaHtml(fila)}</div>
    <div class="tm-row-correo"><input type="text" class="tm-correo-pdf" data-fila-id="${fila.id}" placeholder="Correo del oficio (opcional)" value="${escapeHtml(fila.correoPdf || '')}"></div>
    ${fila.removible ? `<button class="btn small" data-tm-quitar-fila="${fila.id}" type="button" style="border-color:var(--urgent); color:var(--urgent);">Quitar</button>` : '<div></div>'}
  </div>`;
}

function tmReceptorCeldaHtml(fila) {
  if (fila.receptorId) {
    const r = RECEPTORES.find(x => x.id === fila.receptorId);
    if (!r) return tmBuscadorHtml(fila);
    const datos = [r.correo, r.telefono, r.domicilio].filter(Boolean);
    return `<div class="tm-receptor-chip">
      <strong>${escapeHtml(r.nombreCompleto)}</strong>
      ${datos.length ? `<span class="tm-receptor-datos">${datos.map(escapeHtml).join(' · ')}</span>` : ''}
      <button class="btn small ghost" data-tm-cambiar="${fila.id}" type="button">Cambiar</button>
    </div>`;
  }
  if (fila.receptorNoEncontrado) {
    return `<div class="tm-receptor-no-encontrado">
      <span class="familia-badge" style="border-color:var(--urgent); color:var(--urgent);">No encontrado en base</span>
      <button class="btn small ghost" data-tm-cambiar="${fila.id}" type="button">Buscar de nuevo</button>
    </div>`;
  }
  return tmBuscadorHtml(fila);
}

function tmBuscadorHtml(fila) {
  return `<div class="tm-buscador" data-tm-buscador="${fila.id}">
    <input type="text" class="tm-buscador-input" data-fila-id="${fila.id}" placeholder="Buscar receptor por nombre o correo…" autocomplete="off">
    <div class="tm-buscador-resultados" data-fila-id="${fila.id}"></div>
    <button class="btn small ghost" data-tm-marcar-no-encontrado="${fila.id}" type="button">No está en la base</button>
  </div>`;
}

function tmBuscarReceptores(query) {
  const q = normalizarTexto(query);
  if (!q) return [];
  return RECEPTORES.filter(r => normalizarTexto(r.nombreCompleto).includes(q) || normalizarTexto(r.correo).includes(q)).slice(0, 8);
}

function tmRenderResultadosBusqueda(filaId, query) {
  const cont = document.querySelector(`.tm-buscador-resultados[data-fila-id="${filaId}"]`);
  if (!cont) return;
  const resultados = tmBuscarReceptores(query);
  if (!query.trim()) { cont.innerHTML = ''; return; }
  cont.innerHTML = resultados.length === 0
    ? '<div class="tm-buscador-vacio">Sin coincidencias en la base maestra.</div>'
    : resultados.map(r => {
      const datos = [r.correo, r.telefono, r.domicilio].filter(Boolean);
      return `<div class="tm-buscador-item" data-tm-elegir="${filaId}" data-receptor-id="${r.id}">
        <strong>${escapeHtml(r.nombreCompleto)}</strong>
        ${datos.length ? `<span>${datos.map(escapeHtml).join(' · ')}</span>` : ''}
      </div>`;
    }).join('');
}

function tmFindFila(filaId) { return tmState.filas.find(f => f.id === filaId); }

function tmRerenderCeldaReceptor(filaId) {
  const row = document.querySelector(`.tm-row[data-fila-id="${filaId}"]`);
  if (!row) return;
  row.querySelector('.tm-row-receptor').innerHTML = tmReceptorCeldaHtml(tmFindFila(filaId));
  tmWireFilaIndividual(filaId);
}

function tmWireFilas() {
  document.querySelectorAll('[data-tm-agregar-bloque]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ambito = btn.dataset.tmAgregarBloque;
      const tribunal = ambito === 'Corte Apelaciones / 34° Crimen'
        ? 'Corte de Apelaciones de Santiago y 34° Juzgado del Crimen de Santiago'
        : 'Juzgado de Cobranza Laboral y Previsional de Santiago';
      tmState.filas.push(tmNuevaFila(ambito, tribunal, true));
      tmRenderFilas();
    });
  });
  document.querySelectorAll('[data-tm-quitar-fila]').forEach(btn => {
    btn.addEventListener('click', () => {
      tmState.filas = tmState.filas.filter(f => f.id !== btn.dataset.tmQuitarFila);
      tmRenderFilas();
    });
  });
  document.querySelectorAll('.tm-correo-pdf').forEach(inp => {
    inp.addEventListener('input', () => {
      const f = tmFindFila(inp.dataset.filaId);
      if (f) f.correoPdf = inp.value;
    });
  });
  tmState.filas.forEach(f => tmWireFilaIndividual(f.id));
}

function tmWireFilaIndividual(filaId) {
  const cambiarBtn = document.querySelector(`[data-tm-cambiar="${filaId}"]`);
  if (cambiarBtn) cambiarBtn.addEventListener('click', () => {
    const f = tmFindFila(filaId);
    f.receptorId = null; f.receptorNoEncontrado = false;
    tmRerenderCeldaReceptor(filaId);
    document.querySelector(`.tm-buscador-input[data-fila-id="${filaId}"]`)?.focus();
  });

  const noEncontradoBtn = document.querySelector(`[data-tm-marcar-no-encontrado="${filaId}"]`);
  if (noEncontradoBtn) noEncontradoBtn.addEventListener('click', () => {
    const f = tmFindFila(filaId);
    f.receptorNoEncontrado = true; f.receptorId = null;
    tmRerenderCeldaReceptor(filaId);
  });

  const buscadorInput = document.querySelector(`.tm-buscador-input[data-fila-id="${filaId}"]`);
  if (buscadorInput) buscadorInput.addEventListener('input', () => tmRenderResultadosBusqueda(filaId, buscadorInput.value));

  document.querySelectorAll(`.tm-buscador-resultados[data-fila-id="${filaId}"] .tm-buscador-item`).forEach(item => {
    item.addEventListener('click', () => {
      const f = tmFindFila(filaId);
      f.receptorId = item.dataset.receptorId; f.receptorNoEncontrado = false;
      tmRerenderCeldaReceptor(filaId);
    });
  });
}

// ---- Resumen final + confirmación ----
function tmRenderResumen() {
  const body = document.getElementById('tm-panel-body');
  const filasConReceptor = tmState.filas.filter(f => f.receptorId);
  const filasSinReceptor = tmState.filas.filter(f => !f.receptorId);

  const filaResumenHtml = (f, guardara) => {
    const r = f.receptorId ? RECEPTORES.find(x => x.id === f.receptorId) : null;
    return `<div class="pjud-row" style="grid-template-columns:1.1fr 1.4fr 1.3fr 1.2fr .9fr;">
      <div>${escapeHtml(f.ambitoTurno)}</div>
      <div>${escapeHtml(f.tribunalTurno)}</div>
      <div>${r ? escapeHtml(r.nombreCompleto) : '—'}</div>
      <div>${r?.correo ? escapeHtml(r.correo) : '—'}</div>
      <div>${guardara ? '<span class="familia-badge" style="border-color:var(--calm); color:var(--calm);">Se guardará</span>' : '<span class="familia-badge" style="border-color:var(--urgent); color:var(--urgent);">No encontrado en base</span>'}</div>
    </div>`;
  };

  body.innerHTML = `
    <div class="tm-resumen">
      <p class="familia-hint">
        <strong>${tmState.mes.charAt(0).toUpperCase() + tmState.mes.slice(1)} ${tmState.anio}</strong> ·
        ${filasConReceptor.length} asignación(es) lista(s) para guardar ·
        ${filasSinReceptor.length} sin receptor asignado (no se guardarán).
      </p>
      <div class="pjud-table">
        <div class="pjud-row pjud-head" style="grid-template-columns:1.1fr 1.4fr 1.3fr 1.2fr .9fr;"><div>Ámbito</div><div>Tribunal</div><div>Receptor</div><div>Correo base</div><div>Estado</div></div>
        ${filasConReceptor.map(f => filaResumenHtml(f, true)).join('')}
        ${filasSinReceptor.map(f => filaResumenHtml(f, false)).join('')}
      </div>
      <div style="display:flex; gap:8px; margin-top:16px;">
        <button class="btn ghost" id="tm-volver-formulario" type="button">← Volver a editar</button>
        <button class="btn primary" id="tm-confirmar" type="button" ${filasConReceptor.length === 0 ? 'disabled' : ''}>Confirmar e importar (${filasConReceptor.length})</button>
      </div>
    </div>
  `;

  body.querySelector('#tm-volver-formulario').addEventListener('click', tmRenderPaso2);
  body.querySelector('#tm-confirmar').addEventListener('click', tmConfirmarGuardado);
}

async function tmConfirmarGuardado() {
  const rango = tmRangoMes(tmState.mes, tmState.anio);
  if (!rango) { toast('Mes/año inválido.'); return; }
  const fuenteOficial = `Corte de Apelaciones de Santiago — turno ${tmState.mes} ${tmState.anio}`;
  const creadosEnEstaTanda = [];
  let creados = 0, duplicados = 0, errores = 0;

  for (const f of tmState.filas.filter(x => x.receptorId)) {
    if (turnoYaExiste(f.receptorId, rango.fechaInicio, rango.fechaFin, f.tribunalTurno, creadosEnEstaTanda)) {
      duplicados++;
      continue;
    }
    try {
      const turno = await api.createTurno(CURRENT_USER.id, {
        receptorId: f.receptorId, fechaInicio: rango.fechaInicio, fechaFin: rango.fechaFin,
        jurisdiccion: f.tribunalTurno || f.ambitoTurno || null,
        materia: 'Civil', region: 'Metropolitana',
        ambitoTurno: f.ambitoTurno, tribunalTurno: f.tribunalTurno, correoPdf: f.correoPdf?.trim() || null,
        fuenteOficial, archivoNombre: tmState.archivoNombre
      });
      TURNOS.unshift(turno);
      creadosEnEstaTanda.push(turno);
      creados++;
    } catch (e) {
      console.error(e);
      errores++;
    }
  }

  toast(`Turno mensual importado: ${creados} guardado(s)${duplicados ? `, ${duplicados} duplicado(s) omitido(s)` : ''}${errores ? `, ${errores} con error` : ''}.`);
  tmCerrar();
  renderReceptoresAdmin();
}

async function confirmarImportacionTurnoMensual(container, wrap, archivoNombre) {
  wrap.querySelectorAll('[data-preview-idx]').forEach(row => {
    const idx = parseInt(row.dataset.previewIdx, 10);
    const receptorPdf = row.querySelector('.it-receptor').value.trim();
    const correoPdf = row.querySelector('.it-correo').value.trim();
    // Se re-resuelve la coincidencia contra la base maestra usando los
    // valores tal como quedaron después de la corrección manual en la
    // vista previa — no se reutiliza el resultado calculado al momento de
    // leer el PDF, por si la usuaria corrigió un nombre mal extraído.
    const { receptor, estado } = encontrarReceptorEnBase(receptorPdf, correoPdf);
    importPreviewRows[idx] = {
      receptorPdf, correoPdf,
      ambitoTurno: row.querySelector('.it-ambito').value,
      tribunalTurno: row.querySelector('.it-tribunal').value.trim(),
      mes: row.querySelector('.it-mes').value.trim(),
      anio: row.querySelector('.it-anio').value.trim(),
      receptorId: receptor ? receptor.id : null,
      receptorEncontradoNombre: receptor ? receptor.nombreCompleto : '',
      estadoMatch: estado
    };
    importPreviewRows[idx].incompleta = !receptorPdf || (estado !== 'exacta' && estado !== 'correo');
  });

  const errores = [];
  const sinCoincidencia = [];
  const validas = [];
  importPreviewRows.forEach((row, i) => {
    if (!row.receptorPdf) { errores.push(`Fila ${i + 1}: falta el nombre del receptor.`); return; }
    if (!row.mes || !row.anio) { errores.push(`Fila ${i + 1} (${row.receptorPdf}): falta mes o año del turno.`); return; }
    // Regla obligatoria: las filas sin coincidencia segura (nombre exacto o
    // correo exacto) NUNCA se confirman automáticamente — no hay opción de
    // forzarlas desde aquí. Si la usuaria quiere igual vincularlas, primero
    // debe corregir el nombre en la vista previa hasta que coincida con la
    // base, o agregar el receptor en la pestaña Receptores y reintentar.
    if (row.estadoMatch !== 'exacta' && row.estadoMatch !== 'correo') {
      sinCoincidencia.push(`Fila ${i + 1} (${row.receptorPdf}): ${ESTADO_MATCH_LABEL[row.estadoMatch] || 'sin coincidencia segura'} — no se importará.`);
      return;
    }
    validas.push(row);
  });

  const warningsEl = container.querySelector('#import-warnings');
  const avisos = [...errores, ...sinCoincidencia];
  if (avisos.length) {
    warningsEl.innerHTML = `<div class="ficha-empty" style="color:var(--urgent);">${avisos.map(e => escapeHtml(e)).join('<br>')}</div>`;
    if (validas.length === 0) return;
    if (!confirm(`${avisos.length} fila(s) no se importarán (sin coincidencia segura o datos incompletos). ¿Continuar con las ${validas.length} fila(s) restantes?`)) return;
  }

  const mesIndice = (mesNombre) => MESES_ES.indexOf((mesNombre || '').toLowerCase());
  const creadosEnEstaTanda = [];

  let creados = 0, omitidosPorMes = 0, duplicados = 0;
  for (const row of validas) {
    const idxMes = mesIndice(row.mes);
    if (idxMes < 0) { toast(`Mes no reconocido para "${row.receptorPdf}": "${row.mes}"`); omitidosPorMes++; continue; }
    const anio = parseInt(row.anio, 10);
    const fechaInicio = `${anio}-${String(idxMes + 1).padStart(2, '0')}-01`;
    const ultimoDia = new Date(anio, idxMes + 1, 0).getDate();
    const fechaFin = `${anio}-${String(idxMes + 1).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;

    // row.receptorId ya fue resuelto arriba contra la base maestra — NUNCA
    // se crea un receptor nuevo desde este flujo.
    if (turnoYaExiste(row.receptorId, fechaInicio, fechaFin, row.tribunalTurno, creadosEnEstaTanda)) {
      duplicados++;
      continue;
    }

    try {
      const turno = await api.createTurno(CURRENT_USER.id, {
        receptorId: row.receptorId, fechaInicio, fechaFin,
        jurisdiccion: row.tribunalTurno || row.ambitoTurno || null,
        materia: 'Civil', region: 'Metropolitana',
        ambitoTurno: row.ambitoTurno, tribunalTurno: row.tribunalTurno, correoPdf: row.correoPdf || null,
        fuenteOficial: archivoNombre, archivoNombre,
        observaciones: `Turno mensual — ${row.mes} ${row.anio}`
      });
      TURNOS.unshift(turno);
      creadosEnEstaTanda.push(turno);
      creados++;
    } catch (e) {
      toast(`No se pudo guardar el turno de "${row.receptorPdf}": ${e.message}`);
    }
  }

  toast(`Importación confirmada: ${creados} turno(s) guardado(s)${duplicados ? `, ${duplicados} duplicado(s) omitido(s)` : ''}${omitidosPorMes ? `, ${omitidosPorMes} fila(s) omitida(s) por mes inválido` : ''}.`);
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

// ---------- Turno mensual: encabezados de bloque del oficio de la Corte de
// Apelaciones de Santiago (julio/agosto/septiembre 2026). El oficio no trae
// un formato tabular único: alterna 4 bloques distintos, cada uno con su
// propio criterio de ámbito/tribunal. Estos patrones se basan en la
// redacción de encabezado que describiste; no fueron verificados todavía
// contra el texto real extraído de un PDF oficial (ver limitaciones en la
// entrega) — si el oficio real usa una redacción distinta, esta detección
// de encabezado es el punto exacto a ajustar.
const BLOQUE_CORTE_SUPREMA_REGEX = /Receptor(?:es)?\s+Judicial(?:es)?\s+Excma\.?\s+Corte\s+Suprema/i;
const BLOQUE_CORTE_APELACIONES_REGEX = /Receptor(?:es)?\s+Judicial(?:es)?\s+Ilma\.?\s+Corte\s+de\s+Apelaciones\s+de\s+Santiago\s+y\s+34°?\s*Juzgado\s+del\s+Crimen/i;
const BLOQUE_JUZGADOS_CIVILES_REGEX = /Receptor(?:es)?\s+Judicial(?:es)?\s+Juzgados\s+Civiles\s+de\s+Santiago/i;
const BLOQUE_COBRANZA_REGEX = /Juzgado\s+de\s+Cobranza\s+Laboral\s+y\s+Previsional/i;

const AMBITO_TURNO_POR_BLOQUE = {
  corte_suprema: 'Corte Suprema',
  corte_apelaciones: 'Corte Apelaciones / 34° Crimen',
  cobranza: 'Cobranza Laboral y Previsional'
};
const TRIBUNAL_TURNO_POR_BLOQUE = {
  corte_suprema: 'Corte Suprema',
  corte_apelaciones: 'Corte de Apelaciones de Santiago y 34° Juzgado del Crimen de Santiago',
  cobranza: 'Juzgado de Cobranza Laboral y Previsional de Santiago'
};

// Detecta si una línea es un encabezado de alguno de los 4 bloques. Devuelve
// la clave del bloque ('corte_suprema' | 'corte_apelaciones' | 'juzgados_civiles'
// | 'cobranza') o null si la línea no es un encabezado.
function detectarEncabezadoBloqueTurno(texto) {
  if (BLOQUE_CORTE_SUPREMA_REGEX.test(texto)) return 'corte_suprema';
  if (BLOQUE_CORTE_APELACIONES_REGEX.test(texto)) return 'corte_apelaciones';
  if (BLOQUE_JUZGADOS_CIVILES_REGEX.test(texto)) return 'juzgados_civiles';
  if (BLOQUE_COBRANZA_REGEX.test(texto)) return 'cobranza';
  return null;
}

// Líneas de ruido que nunca son un receptor dentro de un bloque colectivo
// (Corte Suprema / Corte Apelaciones-34° Crimen / Cobranza): pie de página,
// numeración, o la línea de mes/año del propio oficio.
function esLineaRuidoBloqueTurno(texto) {
  if (!texto || texto.length < 3) return true;
  if (/^p[aá]gina\s+\d+/i.test(texto)) return true;
  if (MESES_ES.some(m => new RegExp(`\\b${m}\\b`, 'i').test(texto)) && /\d{4}/.test(texto)) return true;
  return false;
}

// ---------- Coincidencia contra receptores_judiciales — NUNCA crea receptores ----------
// Regla obligatoria: un PDF de turno solo puede vincular receptores que ya
// existen en la base maestra. Primero por nombre normalizado exacto; como
// respaldo, por correo exacto. Nunca por coincidencia parcial/débil — si hay
// ambigüedad (más de un receptor coincide) se trata como "revisión
// requerida", igual que si no hay ninguna coincidencia.
function encontrarReceptorEnBase(nombre, correo) {
  const nombreNorm = normalizarTexto(nombre);
  if (nombreNorm) {
    const porNombre = RECEPTORES.filter(r => normalizarTexto(r.nombreCompleto) === nombreNorm);
    if (porNombre.length === 1) return { receptor: porNombre[0], estado: 'exacta' };
    if (porNombre.length > 1) return { receptor: null, estado: 'revision' }; // nombre duplicado en la base: ambiguo, no se adivina
  }
  const correoNorm = normalizarTexto(correo);
  if (correoNorm) {
    const porCorreo = RECEPTORES.filter(r => normalizarTexto(r.correo) === correoNorm);
    if (porCorreo.length === 1) return { receptor: porCorreo[0], estado: 'correo' };
    if (porCorreo.length > 1) return { receptor: null, estado: 'revision' };
  }
  return { receptor: null, estado: 'no_encontrado' };
}

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
// Frases de título/encabezado del documento oficial que NUNCA deben tratarse
// como nombre de persona, sin importar cómo el extractor de texto del PDF
// las presente (MAYÚSCULAS SOSTENIDAS o Título — algunos PDF exponen el
// encabezado ya en formato "Palabra Palabra", que sí pasaría el resto de
// este chequeo si no se excluye explícitamente aquí).
const ENCABEZADO_DOCUMENTO_REGEX = /listado\s+de\s+receptores|n[oó]mina\s+de\s+receptores|receptores?\s+judiciales|poder\s+judicial|corte\s+de\s+apelaciones/i;

function pareceNombrePersona(texto) {
  if (EMAIL_REGEX.test(texto) || TELEFONO_REGEX.test(texto)) return false;
  if (/\d/.test(texto)) return false;
  if (ENCABEZADO_DOCUMENTO_REGEX.test(texto)) return false;
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
// Convierte una línea colectiva (Corte Suprema / Corte Apelaciones-34° Crimen
// / Cobranza) en {receptor, correo} — el correo se extrae y se quita del
// resto del texto para no contaminar el nombre, igual criterio que ya usaba
// el bloque de Juzgados Civiles.
function extraerReceptorYCorreoDeLinea(texto) {
  const emailMatch = texto.match(new RegExp(EMAIL_REGEX));
  const correo = emailMatch ? emailMatch[0] : '';
  let resto = texto;
  if (correo) resto = resto.replace(correo, '');
  return { receptor: limpiarTexto(resto), correo };
}

function parsearTurnoMensualCivilPdf(lineas) {
  const { mes, anio } = extraerMesAnioDocumento(lineas);
  const filas = [];
  let bloqueActual = null; // null | 'corte_suprema' | 'corte_apelaciones' | 'juzgados_civiles' | 'cobranza'

  function agregarFila({ receptor, correo, ambitoTurno, tribunalTurno }) {
    if (!receptor) return;
    const { receptor: encontrado, estado } = encontrarReceptorEnBase(receptor, correo);
    filas.push({
      receptorPdf: receptor,
      correoPdf: correo,
      ambitoTurno,
      tribunalTurno,
      mes, anio,
      receptorId: encontrado ? encontrado.id : null,
      receptorEncontradoNombre: encontrado ? encontrado.nombreCompleto : '',
      estadoMatch: estado, // 'exacta' | 'correo' | 'revision' | 'no_encontrado'
      // "incompleta" (usado por el resto de la UI para el conteo genérico
      // completas/requieren revisión) refleja tanto datos faltantes como
      // ausencia de coincidencia segura con la base maestra.
      incompleta: !receptor || estado === 'revision' || estado === 'no_encontrado'
    });
  }

  lineas.forEach(l => {
    const texto = limpiarTexto(l.texto);
    if (!texto) return;

    const encabezado = detectarEncabezadoBloqueTurno(texto);
    if (encabezado) { bloqueActual = encabezado; return; }

    if (bloqueActual === 'juzgados_civiles') {
      // Mismo criterio ya usado antes de este cambio: una fila por tribunal
      // "N° Juzgado Civil de Santiago" + receptor individual.
      if (EXCLUIR_TRIBUNAL_REGEX.test(texto)) return;
      const m = texto.match(TRIBUNAL_CIVIL_SANTIAGO_REGEX);
      if (!m) return;
      const tribunalTurno = `${m[1]}° Juzgado Civil de Santiago`;
      let resto = texto.replace(m[0], '');
      const { receptor, correo } = extraerReceptorYCorreoDeLinea(resto);
      agregarFila({ receptor, correo, ambitoTurno: 'Juzgado Civil', tribunalTurno });
      return;
    }

    if (bloqueActual === 'corte_suprema' || bloqueActual === 'corte_apelaciones' || bloqueActual === 'cobranza') {
      if (esLineaRuidoBloqueTurno(texto)) return;
      const { receptor, correo } = extraerReceptorYCorreoDeLinea(texto);
      agregarFila({
        receptor, correo,
        ambitoTurno: AMBITO_TURNO_POR_BLOQUE[bloqueActual],
        tribunalTurno: TRIBUNAL_TURNO_POR_BLOQUE[bloqueActual]
      });
      return;
    }
    // bloqueActual === null: todavía no se encontró ningún encabezado
    // reconocido — la línea se ignora (probablemente portada/membrete).
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

// ---------- Excel del listado oficial de receptores (Poder Judicial - Transparencia) ----------
// Encabezados de la base Excel definitiva; el matching es tolerante a
// mayúsculas/acentos/espacios (igual criterio que normalizarEncabezadoCsv),
// nunca por posición de columna.
function normalizarEncabezadoExcel(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
const XLSX_ALIAS_NOMBRE = ['nombre'];
const XLSX_ALIAS_CORTE = ['corte'];
const XLSX_ALIAS_TRIBUNAL = ['tribunal'];
const XLSX_ALIAS_CORREO_PRINCIPAL = ['correo principal', 'correo'];
const XLSX_ALIAS_CORREO_ALTERNATIVO = ['correo alternativo'];
const XLSX_ALIAS_TELEFONO_1 = ['telefono 1', 'telefono1', 'telefono'];
const XLSX_ALIAS_TELEFONO_2 = ['telefono 2', 'telefono2'];
const XLSX_ALIAS_TELEFONO_3 = ['telefono 3', 'telefono3'];
const XLSX_ALIAS_DIRECCION = ['direccion', 'domicilio'];

// filasObjeto: arreglo de objetos { 'Nombre': ..., 'Corte': ..., ... } tal
// como los entrega XLSX.utils.sheet_to_json() (encabezado real de cada
// columna como clave, sin asumir un orden fijo). Cada columna del Excel
// definitivo va a su propio campo — Corte, Tribunal, Correo Alternativo y
// Teléfono 2/3 tienen columna propia en receptores_judiciales, así que
// nunca se mezclan en observaciones. Domicilio/Dirección tampoco se
// inventa: si el Excel no la trae, queda vacía.
function parsearExcelListadoReceptores(filasObjeto) {
  return filasObjeto.map(obj => {
    const porEncabezado = {};
    Object.keys(obj || {}).forEach(k => { porEncabezado[normalizarEncabezadoExcel(k)] = obj[k]; });

    const buscar = (alias) => {
      for (const a of alias) {
        if (porEncabezado[a] !== undefined && String(porEncabezado[a]).trim()) return String(porEncabezado[a]).trim();
      }
      return '';
    };

    const nombre = buscar(XLSX_ALIAS_NOMBRE);
    const corte = buscar(XLSX_ALIAS_CORTE);
    const tribunal = buscar(XLSX_ALIAS_TRIBUNAL);
    const correo = buscar(XLSX_ALIAS_CORREO_PRINCIPAL);
    const correoAlternativo = buscar(XLSX_ALIAS_CORREO_ALTERNATIVO);
    const telefono = buscar(XLSX_ALIAS_TELEFONO_1);
    const telefono2 = buscar(XLSX_ALIAS_TELEFONO_2);
    const telefono3 = buscar(XLSX_ALIAS_TELEFONO_3);
    const domicilio = buscar(XLSX_ALIAS_DIRECCION);

    // Clasificación para la actualización masiva del catálogo maestro —
    // se calcula una sola vez aquí, contra el estado real de RECEPTORES al
    // momento de cargar el archivo.
    const { receptor, estado } = nombre
      ? receptorCatalogoMejorCoincidencia(nombre, correo)
      : { receptor: null, estado: 'revisar' };

    return {
      nombre, corte, tribunal, correo, correoAlternativo, telefono, telefono2, telefono3, domicilio,
      fuenteOficial: 'Base maestra de receptores judiciales',
      incompleta: !nombre,
      estadoCatalogo: estado,
      receptorExistenteId: receptor ? receptor.id : null,
      receptorExistenteNombre: receptor ? receptor.nombreCompleto : ''
    };
  }).filter(r => r.nombre || r.correo || r.telefono || r.corte || r.tribunal || r.domicilio);
}

// ============================================================================
// IMPORTADOR EXCEL DE TURNO MENSUAL — bloque nuevo y autocontenido. Prefijo
// `xt` (Excel Turnos) para no colisionar con el importador PDF anterior
// (prefijo `tm`), cuya lógica interna se conserva íntegra y sin tocar — solo
// se le retiró el acceso visible (botón) en renderTurnosTab()/wireTurnosTab().
//
// Reutiliza sin modificar: normalizarTexto, escapeHtml, MESES_ES,
// TRIBUNAL_CIVIL_SANTIAGO_REGEX, normalizarEncabezadoExcel, turnoYaExiste,
// tmBuscarReceptores, api.createTurno.
//
// Reglas de seguridad (mismas para carga histórica y mensual, un solo
// parser): el cruce con receptores_judiciales es por CONTENCIÓN de palabras
// completas (todas las palabras del nombre del Excel deben estar presentes
// en el candidato de la base) — nunca por similitud aproximada de letras.
// Ambigüedad (más de un candidato) o ausencia total quedan siempre para
// revisión manual. Nunca se crea un receptor nuevo.
// ============================================================================

let xtState = null;
// Compartida entre el importador Excel de turnos y el de receptores: evita
// cerrar, cambiar de pestaña o iniciar el otro importador mientras cualquiera
// de los dos está guardando.
let importacionEnProgreso = false;

function xtTokens(s) {
  return normalizarTexto(s).split(' ').filter(Boolean);
}

// Matching específico de la actualización masiva del catálogo maestro
// (Excel de receptores) — reutiliza xtTokens (utilidad genérica, ya
// existente) pero es una función propia, independiente de
// xtMejorCoincidenciaReceptor (Turnos) y de encontrarOCrearReceptorLocal
// (PDF/CSV, igualdad exacta, sin tocar). Mismo criterio ya aprobado:
// contención de TODAS las palabras del nombre importado dentro del
// candidato de la base, sin importar el orden, sin fuzzy matching. El
// correo es respaldo auxiliar, nunca fuente única salvo ausencia total de
// coincidencia por nombre. Cualquier ambigüedad o contradicción -> 'revisar',
// nunca se decide al azar.
function receptorCatalogoMejorCoincidencia(nombre, correo) {
  const tokensNombre = xtTokens(nombre);
  const candidatosPorNombre = tokensNombre.length
    ? RECEPTORES.filter(r => {
        const tokensBase = new Set(xtTokens(r.nombreCompleto));
        return tokensNombre.every(t => tokensBase.has(t));
      })
    : [];

  const correoNorm = normalizarTexto(correo);
  const candidatosPorCorreo = correoNorm
    ? RECEPTORES.filter(r => normalizarTexto(r.correo) === correoNorm)
    : [];

  if (candidatosPorNombre.length === 1) {
    const receptor = candidatosPorNombre[0];
    if (candidatosPorCorreo.length === 1 && candidatosPorCorreo[0].id !== receptor.id) {
      return { receptor: null, estado: 'revisar' }; // contradicción real, nunca se ignora
    }
    return { receptor, estado: 'existente' };
  }
  if (candidatosPorNombre.length > 1) return { receptor: null, estado: 'revisar' };
  if (candidatosPorCorreo.length === 1) return { receptor: candidatosPorCorreo[0], estado: 'existente' };
  if (candidatosPorCorreo.length > 1) return { receptor: null, estado: 'revisar' };
  return { receptor: null, estado: 'nuevo' };
}

// Búsqueda manual de excepciones — SOLO para el buscador de este
// importador (no se toca tmBuscarReceptores, compartida con el
// importador PDF antiguo). Coincide cuando TODAS las palabras escritas
// por la usuaria están presentes como palabras completas en el nombre
// del receptor, sin importar el orden ("Renato Soto" encuentra "Soto
// Yunge Renato Enrique", igual que "Soto Renato"). El correo se sigue
// buscando por substring, sin dividir en palabras (no tiene sentido
// tokenizar un correo). Nunca hay tolerancia a errores de letra: cada
// palabra debe coincidir exactamente, normalizada.
function xtBuscarReceptoresPorPalabras(query) {
  const tokensConsulta = xtTokens(query);
  const correoConsulta = normalizarTexto(query);
  if (!tokensConsulta.length) return [];
  return RECEPTORES.filter(r => {
    const tokensNombre = new Set(xtTokens(r.nombreCompleto));
    const coincidePorNombre = tokensConsulta.every(t => tokensNombre.has(t));
    const coincidePorCorreo = correoConsulta && normalizarTexto(r.correo).includes(correoConsulta);
    return coincidePorNombre || coincidePorCorreo;
  }).slice(0, 8);
}

// Cruce por contención de palabras — el nombre del Excel puede venir en
// cualquier orden ("Nombre Apellido Apellido") mientras que la base maestra
// suele guardar "Apellido Apellido Nombre(s)", a veces con un segundo
// nombre que el Excel no trae. Por eso se exige que TODAS las palabras del
// Excel estén contenidas en el candidato, nunca una igualdad de cadena
// completa ni una comparación por letras.
function xtMejorCoincidenciaReceptor(nombreExcel, correoExcel) {
  const tokensExcel = xtTokens(nombreExcel);
  const candidatosPorNombre = tokensExcel.length
    ? RECEPTORES.filter(r => {
        const tokensBase = new Set(xtTokens(r.nombreCompleto));
        return tokensExcel.every(t => tokensBase.has(t));
      })
    : [];

  const correoNorm = normalizarTexto(correoExcel);
  const candidatosPorCorreo = correoNorm
    ? RECEPTORES.filter(r => normalizarTexto(r.correo) === correoNorm)
    : [];

  if (candidatosPorNombre.length === 1) {
    const receptor = candidatosPorNombre[0];
    // El correo es respaldo auxiliar: si está informado y apunta de forma
    // única a un receptor DISTINTO del que ganó por nombre, es una
    // contradicción real — baja a revisión, nunca se ignora.
    if (candidatosPorCorreo.length === 1 && candidatosPorCorreo[0].id !== receptor.id) {
      return { receptor: null, estado: 'revision', viaCorreo: false };
    }
    return { receptor, estado: 'segura', viaCorreo: false };
  }
  if (candidatosPorNombre.length > 1) {
    return { receptor: null, estado: 'revision', viaCorreo: false };
  }
  // Sin candidato por nombre: el correo puede servir de respaldo, pero solo
  // si identifica a un único receptor — nunca se elige al azar.
  if (candidatosPorCorreo.length === 1) {
    return { receptor: candidatosPorCorreo[0], estado: 'segura', viaCorreo: true };
  }
  if (candidatosPorCorreo.length > 1) {
    return { receptor: null, estado: 'revision', viaCorreo: false };
  }
  return { receptor: null, estado: 'no_encontrado', viaCorreo: false };
}

// Deriva el ámbito del turno a partir del propio texto del tribunal — no se
// asume que todas las filas sean Juzgado Civil, aunque en la práctica (el
// histórico real enero-septiembre 2026) el 100% de las filas lo son.
function xtAmbitoDesdeTribunal(tribunal) {
  if (TRIBUNAL_CIVIL_SANTIAGO_REGEX.test(tribunal)) return 'Juzgado Civil';
  if (/Corte\s+Suprema/i.test(tribunal)) return 'Corte Suprema';
  if (/Corte\s+de\s+Apelaciones/i.test(tribunal)) return 'Corte Apelaciones / 34° Crimen';
  if (/Cobranza\s+Laboral/i.test(tribunal)) return 'Cobranza Laboral y Previsional';
  return tribunal; // ámbito desconocido: se usa el propio texto, sin inventar una categoría
}

// Valida una fila cruda del Excel (año, mes, mes_num, tribunal,
// receptor_nombre, correo_turno, fecha_inicio, fecha_fin) — nunca guarda
// silenciosamente una fila con error; cada inconsistencia se acumula en
// `errores` y la fila queda marcada como tal en la vista previa.
function xtValidarFila(obj) {
  const errores = [];
  const anio = parseInt(obj['año'], 10);
  const mesNombre = String(obj['mes'] || '').trim();
  const mesNum = parseInt(obj['mes_num'], 10);
  const tribunal = String(obj['tribunal'] || '').trim();
  const receptorNombre = String(obj['receptor_nombre'] || '').trim();
  const correoTurno = String(obj['correo_turno'] || '').trim();

  if (!anio || anio < 2000 || anio > 2100) errores.push('año inválido');
  if (!mesNum || mesNum < 1 || mesNum > 12) errores.push('mes_num fuera de rango (1-12)');
  if (!tribunal) errores.push('falta tribunal');
  if (!receptorNombre) errores.push('falta receptor_nombre');

  // fecha_inicio/fecha_fin: el parser lee el archivo con cellDates:true, así
  // que aquí ya deberían llegar como objetos Date reales, no como número de
  // serie de Excel ni como texto.
  let fechaInicio = null, fechaFin = null;
  const fi = obj['fecha_inicio'], ff = obj['fecha_fin'];
  if (fi instanceof Date && !isNaN(fi)) fechaInicio = fi.toISOString().slice(0, 10);
  else errores.push('fecha_inicio no es una fecha válida');
  if (ff instanceof Date && !isNaN(ff)) fechaFin = ff.toISOString().slice(0, 10);
  else errores.push('fecha_fin no es una fecha válida');

  if (mesNum >= 1 && mesNum <= 12 && fechaInicio) {
    const mesDeFecha = parseInt(fechaInicio.slice(5, 7), 10);
    if (mesDeFecha !== mesNum) errores.push(`fecha_inicio (mes ${mesDeFecha}) no coincide con mes_num (${mesNum})`);
  }
  if (mesNum >= 1 && mesNum <= 12 && mesNombre) {
    if (normalizarTexto(mesNombre) !== MESES_ES[mesNum - 1]) {
      errores.push(`mes ("${mesNombre}") no coincide con mes_num (${mesNum})`);
    }
  }
  if (fechaInicio && fechaFin && fechaFin < fechaInicio) errores.push('fecha_fin es anterior a fecha_inicio');

  return { anio, mesNombre, mesNum, tribunal, receptorNombre, correoTurno, fechaInicio, fechaFin, errores };
}

// Encabezados independientes de mayúsculas/minúsculas y tildes razonables —
// mismo criterio que normalizarEncabezadoExcel(), ya usado en el resto del
// archivo para el importador de Excel del catálogo maestro.
const XT_ALIAS_COLUMNAS = {
  anio: ['año', 'ano'],
  mes: ['mes'],
  mesNum: ['mes_num', 'mesnum'],
  tribunal: ['tribunal'],
  receptorNombre: ['receptor_nombre', 'receptornombre'],
  correoTurno: ['correo_turno', 'correoturno'],
  fechaInicio: ['fecha_inicio', 'fechainicio'],
  fechaFin: ['fecha_fin', 'fechafin']
};

// Parser único para carga histórica (varios meses) y carga mensual normal
// (un mes, ~30 filas) — es exactamente el mismo código para ambos casos, tal
// como se pidió. `filasObjeto` viene de XLSX.utils.sheet_to_json() sobre la
// hoja "Turnos", leída con cellDates:true para que fecha_inicio/fecha_fin
// lleguen como objetos Date reales en vez de números de serie de Excel.
function xtParsearExcel(filasObjeto) {
  return filasObjeto.map(obj => {
    const porEncabezado = {};
    Object.keys(obj || {}).forEach(k => { porEncabezado[normalizarEncabezadoExcel(k)] = obj[k]; });
    const leer = (alias) => {
      for (const a of alias) if (porEncabezado[a] !== undefined) return porEncabezado[a];
      return '';
    };
    const objNormalizado = {
      'año': leer(XT_ALIAS_COLUMNAS.anio),
      'mes': leer(XT_ALIAS_COLUMNAS.mes),
      'mes_num': leer(XT_ALIAS_COLUMNAS.mesNum),
      'tribunal': leer(XT_ALIAS_COLUMNAS.tribunal),
      'receptor_nombre': leer(XT_ALIAS_COLUMNAS.receptorNombre),
      'correo_turno': leer(XT_ALIAS_COLUMNAS.correoTurno),
      'fecha_inicio': leer(XT_ALIAS_COLUMNAS.fechaInicio),
      'fecha_fin': leer(XT_ALIAS_COLUMNAS.fechaFin)
    };
    const validada = xtValidarFila(objNormalizado);

    if (validada.errores.length) {
      return { ...validada, estado: 'error', receptorId: null, receptorEncontradoNombre: '', viaCorreo: false };
    }

    const { receptor, estado, viaCorreo } = xtMejorCoincidenciaReceptor(validada.receptorNombre, validada.correoTurno);
    return {
      ...validada,
      estado, // 'segura' | 'revision' | 'no_encontrado' (nunca 'error' aquí, ya se filtró arriba)
      receptorId: receptor ? receptor.id : null,
      receptorEncontradoNombre: receptor ? receptor.nombreCompleto : '',
      viaCorreo
    };
  });
}

function xtCerrar() {
  if (importacionEnProgreso) return;
  document.getElementById('xt-overlay')?.classList.remove('show');
  document.getElementById('xt-overlay')?.remove();
  xtState = null;
}

function xtAbrirImportador() {
  if (importacionEnProgreso) { toast('Espera a que termine la importación en curso.'); return; }
  xtState = { archivo: null, archivoNombre: '', filas: [] };
  document.getElementById('xt-overlay')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="tm-overlay" id="xt-overlay">
      <div class="tm-panel">
        <div class="tm-panel-head">
          <h3>Importar turno mensual (Excel)</h3>
          <button class="familia-close-x" id="xt-cerrar" type="button">&times;</button>
        </div>
        <div class="tm-panel-body" id="xt-panel-body"></div>
      </div>
    </div>
  `);
  document.getElementById('xt-overlay').classList.add('show');
  document.getElementById('xt-overlay').addEventListener('click', (e) => { if (e.target.id === 'xt-overlay') xtCerrar(); });
  document.getElementById('xt-cerrar').addEventListener('click', xtCerrar);
  xtRenderPaso1();
}

function xtRenderPaso1() {
  const body = document.getElementById('xt-panel-body');
  body.innerHTML = `
    <div class="tm-paso1">
      <p class="familia-hint">
        Selecciona el archivo Excel de turnos (hoja "Turnos", columnas
        año/mes/mes_num/tribunal/receptor_nombre/correo_turno/fecha_inicio/fecha_fin).
        Sirve tanto para la carga histórica de varios meses como para la carga
        mensual normal — es el mismo formato en ambos casos.
      </p>
      <input type="file" id="xt-file" accept=".xlsx,.xls">
      <div id="xt-archivo-nombre" class="familia-hint" style="margin-top:6px;"></div>
      <div style="margin-top:16px;"><button class="btn primary" id="xt-continuar" type="button" disabled>Continuar</button></div>
    </div>
  `;

  const fileInput = body.querySelector('#xt-file');
  const continuarBtn = body.querySelector('#xt-continuar');
  const nombreEl = body.querySelector('#xt-archivo-nombre');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    xtState.archivo = file;
    xtState.archivoNombre = file.name;
    nombreEl.textContent = `Archivo: ${file.name}`;
    continuarBtn.disabled = false;
  });

  continuarBtn.addEventListener('click', async () => {
    continuarBtn.disabled = true;
    continuarBtn.textContent = 'Leyendo archivo…';
    try {
      const XLSX = await import('xlsx');
      const buffer = await xtState.archivo.arrayBuffer();
      // cellDates:true es indispensable aquí: sin esta opción, fecha_inicio/
      // fecha_fin llegan como número de serie de Excel (ej. 46023), no como
      // fechas utilizables. Este parser es el único que la necesita — no se
      // toca el importador de Excel de receptores, que no tiene columnas de
      // fecha.
      const libro = XLSX.read(buffer, { type: 'array', cellDates: true });
      // El formato exige una hoja llamada exactamente "Turnos" — no se
      // asume la primera hoja del archivo, para no leer por error una
      // hoja distinta si el archivo tiene más de una.
      const nombreHoja = libro.SheetNames.find(n => n === 'Turnos');
      if (!nombreHoja) {
        toast('El archivo no contiene una hoja llamada "Turnos". Revisa el formato e intenta nuevamente.');
        continuarBtn.disabled = false;
        continuarBtn.textContent = 'Continuar';
        return;
      }
      const hoja = libro.Sheets[nombreHoja];
      const filasObjeto = XLSX.utils.sheet_to_json(hoja, { defval: '' });
      xtState.filas = xtParsearExcel(filasObjeto);
      xtRenderPreview();
    } catch (e) {
      console.error(e);
      toast('No se pudo leer el archivo: ' + e.message);
      continuarBtn.disabled = false;
      continuarBtn.textContent = 'Continuar';
    }
  });
}

function xtEstadoLabel(fila) {
  if (fila.estado === 'error') return 'Error en fila';
  if (fila.estado === 'segura') return 'Coincidencia encontrada';
  if (fila.estado === 'revision') return 'Revisión necesaria';
  if (fila.estado === 'no_encontrado') return 'No encontrado';
  if (fila.estado === 'duplicado') return 'Duplicado';
  return fila.estado;
}

function xtEsSeguro(fila) { return fila.estado === 'segura'; }

function xtFilaHtml(fila, idx) {
  const seguro = xtEsSeguro(fila);
  const claseEstado = seguro ? 'calm-estado' : 'noprior';
  const colorInline = seguro ? '' : 'style="border-color:var(--urgent); color:var(--urgent);"';
  const mesAnio = fila.mesNombre ? `${fila.mesNombre} ${fila.anio || ''}`.trim() : '';

  let celdaCoincidencia;
  if (fila.estado === 'error') {
    celdaCoincidencia = `<span style="color:var(--urgent); font-size:12px;">${escapeHtml(fila.errores.join('; '))}</span>`;
  } else if (fila.receptorId) {
    celdaCoincidencia = `<div class="tm-receptor-chip">
      <strong>${escapeHtml(fila.receptorEncontradoNombre)}</strong>
      ${fila.viaCorreo ? '<span class="tm-receptor-datos">coincidencia por correo</span>' : ''}
      <button class="btn small ghost" data-xt-cambiar="${idx}" type="button">Cambiar</button>
    </div>`;
  } else {
    celdaCoincidencia = `<div class="tm-buscador" data-xt-buscador="${idx}">
      <input type="text" class="tm-buscador-input" data-idx="${idx}" placeholder="Buscar receptor por nombre o correo…" autocomplete="off">
      <div class="tm-buscador-resultados" data-idx="${idx}"></div>
    </div>`;
  }

  return `<div class="pjud-row" data-xt-fila="${idx}" style="grid-template-columns:.9fr 1.3fr 1.3fr 1.6fr 1fr;">
    <div>${escapeHtml(mesAnio)}<br><span style="font-size:11px; color:var(--ink-faint);">${escapeHtml(fila.tribunal || '')}</span></div>
    <div>${escapeHtml(fila.receptorNombre || '')}${fila.correoTurno ? `<br><span style="font-size:11px; color:var(--ink-faint);">${escapeHtml(fila.correoTurno)}</span>` : ''}</div>
    <div>${celdaCoincidencia}</div>
    <div><span class="stamp evento-estado-${claseEstado}" ${colorInline}>${xtEstadoLabel(fila)}</span></div>
    <div>${fila.estado === 'duplicado' ? '<span style="font-size:11px; color:var(--ink-faint);">Ya existe, se omitirá</span>' : ''}</div>
  </div>`;
}

function xtRenderResultadosBusqueda(idx, query) {
  const cont = document.querySelector(`.tm-buscador-resultados[data-idx="${idx}"]`);
  if (!cont) return;
  if (!query.trim()) { cont.innerHTML = ''; return; }
  const resultados = xtBuscarReceptoresPorPalabras(query);
  cont.innerHTML = resultados.length === 0
    ? '<div class="tm-buscador-vacio">Sin coincidencias en la base maestra.</div>'
    : resultados.map(r => {
      const datos = [r.correo, r.telefono, r.domicilio].filter(Boolean);
      return `<div class="tm-buscador-item" data-xt-elegir="${idx}" data-receptor-id="${r.id}">
        <strong>${escapeHtml(r.nombreCompleto)}</strong>
        ${datos.length ? `<span>${datos.map(escapeHtml).join(' · ')}</span>` : ''}
      </div>`;
    }).join('');
}

// Event delegation sobre el contenedor persistente #xt-filas-wrap — se
// registra UNA sola vez (desde xtRenderPreview), no en cada render de
// filas. Corrige el problema real: los resultados de búsqueda
// (.tm-buscador-item[data-xt-elegir]) se crean dinámicamente recién
// cuando la usuaria escribe, así que un listener conectado directamente
// sobre ellos en el momento del render de la fila nunca los alcanza —
// delegando sobre el contenedor padre, que sí existe siempre, el clic se
// captura sin importar cuándo se creó el elemento.
function xtWireFilas() {
  const wrap = document.getElementById('xt-filas-wrap');
  if (!wrap || wrap.dataset.xtDelegado) return; // evita registrar el listener más de una vez
  wrap.dataset.xtDelegado = '1';

  wrap.addEventListener('click', (e) => {
    const btnCambiar = e.target.closest('[data-xt-cambiar]');
    if (btnCambiar) {
      const idx = parseInt(btnCambiar.dataset.xtCambiar, 10);
      xtState.filas[idx].receptorId = null;
      xtState.filas[idx].receptorEncontradoNombre = '';
      xtState.filas[idx].estado = 'no_encontrado';
      xtState.filas[idx].viaCorreo = false;
      xtRenderFilas();
      return;
    }
    const itemElegir = e.target.closest('[data-xt-elegir]');
    if (itemElegir) {
      const idx = parseInt(itemElegir.dataset.xtElegir, 10);
      const receptor = RECEPTORES.find(r => r.id === itemElegir.dataset.receptorId);
      if (!receptor) return;
      xtState.filas[idx].receptorId = receptor.id;
      xtState.filas[idx].receptorEncontradoNombre = receptor.nombreCompleto;
      xtState.filas[idx].estado = 'segura';
      xtState.filas[idx].viaCorreo = false;
      xtRenderFilas();
      return;
    }
  });

  wrap.addEventListener('input', (e) => {
    const inp = e.target.closest('.tm-buscador-input[data-idx]');
    if (inp) xtRenderResultadosBusqueda(parseInt(inp.dataset.idx, 10), inp.value);
  });
}

function xtRenderFilas() {
  const wrap = document.getElementById('xt-filas-wrap');
  if (!wrap) return;
  // Duplicado: se marca ya en la vista previa (contra TURNOS ya cargado),
  // para que la usuaria lo vea antes de confirmar — sin cambiar el estado
  // de matching de la fila (queda registrado aparte).
  xtState.filas.forEach(f => {
    if (f.estado === 'segura' && f.receptorId && turnoYaExiste(f.receptorId, f.fechaInicio, f.fechaFin, f.tribunal)) {
      f.duplicadoPrevio = true;
    } else {
      f.duplicadoPrevio = false;
    }
  });

  wrap.innerHTML = `
    <div class="pjud-row pjud-head" style="grid-template-columns:.9fr 1.3fr 1.3fr 1.6fr 1fr;">
      <div>Mes / Tribunal</div><div>Receptor (Excel)</div><div>Coincidencia en base</div><div>Estado</div><div></div>
    </div>
    ${xtState.filas.map((f, idx) => xtFilaHtml(f.duplicadoPrevio ? { ...f, estado: 'duplicado' } : f, idx)).join('')}
  `;
  xtActualizarContadores();
}

// Recalcula y repinta el resumen de la cabecera (coincidencias, revisión,
// no encontradas, duplicadas, con error) a partir del estado REAL y actual
// de xtState.filas — se llama después de cada cambio manual (Cambiar /
// elegir un candidato), para que los conteos nunca queden desactualizados.
// Los duplicados se cuentan aparte (no se suman a "con coincidencia"),
// igual criterio visual que ya usa cada fila individual.
function xtActualizarContadores() {
  const cabecera = document.getElementById('xt-resumen-cabecera');
  if (!cabecera) return;
  const total = xtState.filas.length;
  let seguras = 0, revision = 0, noEncontrado = 0, errores = 0, duplicados = 0;
  xtState.filas.forEach(f => {
    if (f.estado === 'error') { errores++; return; }
    if (f.duplicadoPrevio) { duplicados++; return; }
    if (f.estado === 'segura') seguras++;
    else if (f.estado === 'revision') revision++;
    else if (f.estado === 'no_encontrado') noEncontrado++;
  });
  cabecera.innerHTML = `<strong>${escapeHtml(xtState.archivoNombre)}</strong> · ${total} fila(s) ·
    ${seguras} con coincidencia · ${revision} para revisión ·
    ${noEncontrado} no encontrada(s) · ${duplicados} duplicada(s) ·
    ${errores} con error en la fila.`;
}

function xtRenderPreview() {
  const body = document.getElementById('xt-panel-body');

  body.innerHTML = `
    <div class="xt-resumen-cabecera familia-hint" id="xt-resumen-cabecera"></div>
    <div class="import-table-scroll">
      <div class="pjud-table" id="xt-filas-wrap"></div>
    </div>
    <div id="xt-estado-guardado"></div>
    <div style="display:flex; gap:8px; margin-top:16px;" id="xt-acciones">
      <button class="btn ghost" id="xt-volver" type="button">← Elegir otro archivo</button>
      <button class="btn primary" id="xt-confirmar" type="button">Confirmar importación</button>
    </div>
  `;
  body.querySelector('#xt-volver').addEventListener('click', xtRenderPaso1);
  body.querySelector('#xt-confirmar').addEventListener('click', xtConfirmarGuardado);
  xtWireFilas(); // delegación de eventos, se registra una sola vez aquí
  xtRenderFilas(); // pinta las filas y actualiza los contadores
}

async function xtConfirmarGuardado() {
  if (importacionEnProgreso) return; // impide doble clic / reentrancia
  importacionEnProgreso = true;

  const btnConfirmar = document.getElementById('xt-confirmar');
  const btnVolver = document.getElementById('xt-volver');
  const estadoEl = document.getElementById('xt-estado-guardado');
  if (btnConfirmar) { btnConfirmar.disabled = true; btnConfirmar.textContent = 'Guardando…'; }
  if (btnVolver) btnVolver.disabled = true;

  const total = xtState.filas.length;
  let procesadas = 0;
  const actualizarProgreso = () => {
    if (estadoEl) estadoEl.innerHTML = `<div class="familia-hint">Guardando turnos… ${procesadas} de ${total}</div>`;
  };
  actualizarProgreso();

  const creadosEnEstaTanda = [];
  let creados = 0, duplicados = 0, sinResolver = 0, conError = 0, errores = 0;

  for (const f of xtState.filas) {
    procesadas++;
    if (f.estado === 'error') { conError++; actualizarProgreso(); continue; }
    if (!f.receptorId) { sinResolver++; actualizarProgreso(); continue; }
    if (turnoYaExiste(f.receptorId, f.fechaInicio, f.fechaFin, f.tribunal, creadosEnEstaTanda)) {
      duplicados++;
      actualizarProgreso();
      continue;
    }
    const ambitoTurno = xtAmbitoDesdeTribunal(f.tribunal);
    try {
      const turno = await api.createTurno(CURRENT_USER.id, {
        receptorId: f.receptorId, fechaInicio: f.fechaInicio, fechaFin: f.fechaFin,
        jurisdiccion: f.tribunal, materia: 'Civil', region: 'Metropolitana',
        ambitoTurno, tribunalTurno: f.tribunal, correoPdf: f.correoTurno || null,
        fuenteOficial: `Excel de turnos — ${f.mesNombre} ${f.anio}`,
        archivoNombre: xtState.archivoNombre
      });
      TURNOS.unshift(turno);
      creadosEnEstaTanda.push(turno);
      creados++;
    } catch (e) {
      console.error(e);
      errores++;
    }
    actualizarProgreso();
  }

  importacionEnProgreso = false; // recién aquí se puede volver a cerrar/iniciar otra importación

  if (estadoEl) {
    estadoEl.innerHTML = `<div class="familia-hint" style="line-height:1.8;">
      <strong>Proceso finalizado</strong><br>
      Total procesado: ${procesadas} de ${total}<br>
      Guardados: ${creados}<br>
      Duplicados omitidos: ${duplicados}<br>
      Sin resolver: ${sinResolver}<br>
      Errores: ${conError + errores}
    </div>`;
  }
  const accionesEl = document.getElementById('xt-acciones');
  if (accionesEl) {
    accionesEl.innerHTML = `<button class="btn primary" id="xt-cerrar-final" type="button">Cerrar</button>`;
    document.getElementById('xt-cerrar-final').addEventListener('click', () => {
      xtCerrar();
      renderReceptoresAdmin();
    });
  }
}

function reparsearPdfComoFormato(formato) {
  importFormato = formato;
  if (formato === 'pdf-listado') importPreviewRows = parsearListadoReceptoresPdf(importLineasPdf);
  else if (formato === 'pdf-turno-mensual') importPreviewRows = parsearTurnoMensualCivilPdf(importLineasPdf);
}

async function procesarArchivoImportado(file, container) {
  if (importacionEnProgreso) { toast('Espera a que termine la importación en curso.'); return; }
  const statusEl = container.querySelector('#import-status');
  statusEl.textContent = 'Leyendo archivo…';
  importPreviewRows = [];
  importLineasPdf = [];
  importEsExcelListado = false;

  try {
    if (file.type === 'text/csv' || /\.csv$|\.txt$/i.test(file.name)) {
      importFormato = 'csv-turno';
      importPreviewRows = parsearCsv(await file.text());
      const completas = importPreviewRows.filter(r => !r.incompleta).length;
      statusEl.innerHTML = importPreviewRows.length
        ? `Archivo leído. Filas detectadas: <strong>${importPreviewRows.length}</strong> · completas: <strong>${completas}</strong> · requieren revisión: <strong>${importPreviewRows.length - completas}</strong>.`
        : 'No se detectaron filas en el archivo. Puedes agregarlas manualmente.';
    } else if (/\.xlsx$|\.xls$/i.test(file.name)) {
      // Excel del listado oficial de receptores: siempre se trata como
      // catálogo de receptores (pdf-listado) — nunca crea turnos, y no
      // ofrece el selector de "tipo de documento" (ese selector solo
      // aparece cuando hay líneas de PDF que reprocesar).
      importEsExcelListado = true;
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const libro = XLSX.read(buffer, { type: 'array' });
      const hoja = libro.Sheets[libro.SheetNames[0]];

      // El archivo oficial trae una fila de título ("Poder Judicial -
      // Transparencia") antes de los encabezados reales, así que no se
      // puede asumir que la fila 1 es el encabezado. Se leen las filas
      // como arreglos crudos y se busca, dentro de las primeras filas, la
      // que contiene una columna "Nombre" — esa es la fila de encabezado
      // real. Si un Excel distinto ya trae los encabezados en la fila 1,
      // se encuentra igual, en la primera iteración.
      const filasCrudas = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: '' });
      const LIMITE_BUSQUEDA_ENCABEZADO = 10;
      let indiceEncabezado = -1;
      for (let i = 0; i < Math.min(filasCrudas.length, LIMITE_BUSQUEDA_ENCABEZADO); i++) {
        const fila = filasCrudas[i] || [];
        if (fila.some(celda => normalizarEncabezadoExcel(celda) === 'nombre')) {
          indiceEncabezado = i;
          break;
        }
      }

      importFormato = 'pdf-listado';

      if (indiceEncabezado === -1) {
        importPreviewRows = [];
        statusEl.innerHTML = `
          No se encontró una columna "Nombre" entre las primeras filas de este Excel. Verifica que el
          archivo tenga una fila de encabezados con esa columna. Puedes agregar registros manualmente,
          o intentar con el PDF/CSV oficial.
        `;
      } else {
        const encabezadosFila = filasCrudas[indiceEncabezado].map(h => String(h || '').trim());
        const filasObjeto = filasCrudas.slice(indiceEncabezado + 1)
          .filter(fila => (fila || []).some(celda => String(celda || '').trim()))
          .map(fila => {
            const obj = {};
            encabezadosFila.forEach((h, idx) => { if (h) obj[h] = fila[idx] !== undefined ? fila[idx] : ''; });
            return obj;
          });

        importPreviewRows = parsearExcelListadoReceptores(filasObjeto);

        const completas = importPreviewRows.filter(r => !r.incompleta).length;
        if (importPreviewRows.length === 0) {
          statusEl.innerHTML = `
            No se reconoció ninguna fila con nombre en este Excel. Verifica que la fila de encabezados
            tenga las columnas <code>Nombre</code>, <code>Correo Principal</code>, <code>Teléfono Celular</code>, etc.
            Puedes agregar registros manualmente, o intentar con el PDF/CSV oficial.
          `;
        } else {
          statusEl.innerHTML = `
            Excel leído (listado de receptores). Filas detectadas: <strong>${importPreviewRows.length}</strong> ·
            completas: <strong>${completas}</strong> · requieren revisión: <strong>${importPreviewRows.length - completas}</strong>.
          `;
        }
      }
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
      // Advertencia explícita de baja confianza: hay filas, pero NINGUNA se
      // pudo extraer completa — no basta con la marca "Revisar" de cada
      // fila, se exige revisión manual explícita antes de confirmar.
      const confianzaBaja = importFormato === 'pdf-listado' && importPreviewRows.length > 0 && completas === 0;
      statusEl.innerHTML = `
        Tipo de documento detectado: <strong>${etiquetaTipo}</strong> (puedes corregirlo abajo).<br>
        Páginas analizadas: <strong>${pdf.numPages}</strong> ·
        filas detectadas: <strong>${importPreviewRows.length}</strong> ·
        completas: <strong>${completas}</strong> ·
        requieren revisión: <strong>${requierenRevision}</strong>.
        ${importPreviewRows.length === 0 ? '<br>No se pudo detectar información automáticamente en este archivo. Puedes agregar las filas manualmente, o intentar con un CSV.' : ''}
        ${confianzaBaja ? '<br><strong style="color:var(--urgent);">No se detectó ninguna fila con confianza suficiente — revisa manualmente cada registro antes de confirmar la importación.</strong>' : ''}
      `;
    } else {
      statusEl.textContent = 'Formato no reconocido. Usa PDF, Excel (.xlsx/.xls), CSV o TXT.';
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
    btn.addEventListener('click', () => {
      if (importacionEnProgreso) { toast('Espera a que termine el guardado en curso.'); return; }
      receptoresAdminTab = btn.dataset.radmTab; importPreviewRows = []; importLineasPdf = []; renderReceptoresAdmin();
    });
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

// Informe Final — resumen de audiencias asistidas: se alimenta de Agenda,
// solo tipo='Audiencia' y estado='Realizado', ordenadas cronológicamente.
function resumenAudienciasAsistidas(causas) {
  const filas = [];
  causas.forEach(c => {
    (c.agendaEventos || []).forEach(e => {
      if (e.tipo === 'Audiencia' && e.estado === 'Realizado') {
        filas.push({
          tipoAudiencia: e.tipoAudiencia || '',
          fecha: e.fecha || '',
          rit: rolCompletoTexto(c) || '',
          materia: 'Civil',
          tribunal: tribunalTexto(c) || ''
        });
      }
    });
  });
  filas.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  return filas;
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

  <div class="subhead" style="margin-top:22px;">Resumen de audiencias asistidas</div>
  <div class="ficha-empty" style="color:var(--ink-faint); margin-top:-4px;">Incluye todas las audiencias realizadas en todas las causas, independiente del filtro configurado arriba para el Informe Final.</div>
  ${(() => {
    const audiencias = resumenAudienciasAsistidas(CAUSAS);
    if (!audiencias.length) return `<div class="ficha-empty" style="color:var(--ink-faint);">No hay audiencias realizadas registradas.</div>`;
    return `
    <table class="ficha-table" style="width:100%;">
      <thead><tr><th>TIPO AUDIENCIA</th><th>FECHA</th><th>RIT</th><th>MATERIA</th><th>TRIBUNAL</th></tr></thead>
      <tbody>
        ${audiencias.map(a => `<tr>
          <td>${escapeHtml(a.tipoAudiencia)}</td>
          <td>${escapeHtml(fmtFechaSolo(a.fecha))}</td>
          <td>${escapeHtml(a.rit)}</td>
          <td>${escapeHtml(a.materia)}</td>
          <td>${escapeHtml(a.tribunal)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="margin-top:10px;">
      <button class="btn small" id="informe-audiencias-excel" type="button">Descargar resumen en Excel</button>
    </div>`;
  })()}

  <div class="agenda-toolbar" style="margin-top:20px;">
    <button class="btn small primary" id="informe-generar-pdf" ${causas.length === 0 ? 'disabled' : ''}>Generar PDF</button>
    <button class="btn small" id="informe-volver">Volver a configurar</button>
  </div>`;
}

function wireInformeFinalPreview(container) {
  container.querySelector('#informe-volver').addEventListener('click', () => {
    informeFinalEtapa = 'configurar';
    renderInformeFinal();
  });
  const excelBtn = container.querySelector('#informe-audiencias-excel');
  if (excelBtn) excelBtn.addEventListener('click', () => {
    const audiencias = resumenAudienciasAsistidas(CAUSAS);
    const filasHoja = [
      ['TIPO AUDIENCIA', 'FECHA', 'RIT', 'MATERIA', 'TRIBUNAL'],
      ...audiencias.map(a => [a.tipoAudiencia, fmtFechaSolo(a.fecha), a.rit, a.materia, a.tribunal])
    ];
    const hoja = XLSX.utils.aoa_to_sheet(filasHoja);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Audiencias');
    XLSX.writeFile(libro, `resumen_audiencias_${todayISO()}.xlsx`);
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
      rows: eventos.map(e => [e.tipo, fmtFechaSolo(e.fecha), eventoTituloEfectivo(e)])
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
          <div class="dash-row-title">${escapeHtml(eventoTituloEfectivo(e))}</div>
          <div class="dash-row-sub">${escapeHtml(fmtFechaSolo(e.fecha))}${e.horaInicio ? ' · ' + escapeHtml(e.horaInicio) : ''} · ${escapeHtml(causaShortLabel(e.causa))}${caratuladoTexto(e.causa) ? ' · ' + escapeHtml(caratuladoTexto(e.causa)) : ''}</div>
        </div>
        <span class="stamp evento-estado-${eventoEstadoClass(e.estado)}">${escapeHtml(e.estado)}</span>
      </div>`).join('');
  }

  // ---------- Hoy: reglas simples ----------
  const items = [];
  eventos.forEach(e => {
    if (!isEventoActivo(e)) return;
    if (e.fecha === hoy) items.push({ text: `${e.tipo} hoy: ${eventoTituloEfectivo(e)}`, causaId: e.causaId, tono: 'hoy' });
    else if (e.fecha === manana) items.push({ text: `${e.tipo} mañana: ${eventoTituloEfectivo(e)}`, causaId: e.causaId, tono: 'manana' });
    else if (e.fecha < hoy) items.push({ text: `Evento vencido sin marcar como realizado: ${eventoTituloEfectivo(e)}`, causaId: e.causaId, tono: 'vencido' });
    else if (e.tipo === 'Plazo procesal') {
      const d = daysUntil(e.fecha);
      if (d !== null && d >= 0 && d <= 2) items.push({ text: `Plazo procesal ${d === 0 ? 'hoy' : d === 1 ? 'mañana' : `dentro de ${d} días`}: ${eventoTituloEfectivo(e)}`, causaId: e.causaId, tono: 'plazo' });
    } else if (e.tipo === 'Gestión importante') {
      const d = daysUntil(e.fecha);
      if (d !== null && d >= 0 && d <= 2) items.push({ text: `Gestión importante pendiente: ${eventoTituloEfectivo(e)}`, causaId: e.causaId, tono: 'plazo' });
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
      <div class="titulo">${AGENDA_TIPO_ICONO[e.tipo] || '•'} ${escapeHtml(eventoTituloEfectivo(e))}</div>
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
      ${dayEvents.slice(0, 3).map(e => `<div class="cal-chip evento-estado-${eventoEstadoClass(e.estado)}">${escapeHtml(eventoTituloEfectivo(e))}</div>`).join('')}
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
      ${dayEvents.length ? dayEvents.map(e => `<div class="cal-chip evento-estado-${eventoEstadoClass(e.estado)}" data-causa-id="${e.causaId}">${e.horaInicio ? escapeHtml(e.horaInicio) + ' · ' : ''}${escapeHtml(eventoTituloEfectivo(e))}</div>`).join('') : `<div class="week-empty">—</div>`}
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
    <div class="dtab" data-tab="oficios">Oficios</div>
    <div class="dtab" data-tab="contacto">Contacto</div>
    <div class="dtab" data-tab="encargo-receptor">Encargo receptor</div>
    <div class="dtab" data-tab="exportar">Exportar ficha</div>
  </div>

  <div class="dtab-content" data-tab="resumen">
    ${c.objetivoApelacion ? `<div class="subhead" style="margin-top:0;">Objetivo de la apelación</div><p class="para">${escapeHtml(c.objetivoApelacion)}</p>` : ''}
    <div class="form-grid2">
      <div>
        <div class="subhead" style="margin-top:0;">Clave para recordar</div>
        <input type="text" class="ct-input" id="rf-clave" value="${escapeHtml(c.clave || '')}">
      </div>
      <div>
        <div class="subhead" style="margin-top:0;">Estado actual</div>
        <textarea id="rf-estado" style="width:100%; min-height:80px; background:var(--bg-card); border:1px solid var(--line); color:var(--ink); padding:10px 12px; border-radius:5px; font-size:13.5px; font-family:var(--font-body); line-height:1.6;">${escapeHtml(c.estado || '')}</textarea>
      </div>
    </div>
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
      <button class="btn small primary" id="add-gestion">+ Nueva Gestión/Tarea</button>
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

    <div class="subhead" style="margin-top:26px; display:flex; align-items:center; justify-content:space-between;">
      <span>Última revisión PJUD</span>
      <button class="btn small" id="btn-actualizar-revision" type="button">Actualizar revisión</button>
    </div>
    <div style="font-size:12.5px; color:var(--ink-dim);" id="ultima-revision-display">${c.ultimaRevisionAt ? escapeHtml(fmtFechaHora(c.ultimaRevisionAt)) : 'Aún no registrada.'}</div>

    <div class="subhead" style="margin-top:26px;">Cronología jurídica</div>
    <div id="tl-cronologia">${cronologiaHtml(c)}</div>
    <div class="drive-box" style="margin-top:12px;">
      <div style="display:grid; grid-template-columns:170px 1fr; gap:12px; align-items:end;">
        <div><label style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-faint); display:block; margin-bottom:4px;">Fecha de actuación</label><input type="date" id="new-cron-fecha" value="${escapeHtml(todayISO())}"></div>
        <div><label style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-faint); display:block; margin-bottom:4px;">Actuación</label><input type="text" id="new-cron" placeholder="Texto de la gestión realizada…" style="width:100%;"></div>
      </div>
      <div style="margin-top:12px; display:flex; justify-content:flex-end;">
        <button class="btn small primary" id="add-cron">Registrar</button>
      </div>
    </div>
  </div>

  <div class="dtab-content" data-tab="notificacion">
    ${notificacionTabHtml(c)}
  </div>

  <div class="dtab-content" data-tab="oficios">
    ${oficiosTabHtml(c)}
  </div>

  <div class="dtab-content" data-tab="contacto">
    <div class="contact-grid">
      <div class="field"><div class="k">RUT</div><input type="text" class="ct-input" id="ct-rut" value="${escapeHtml(c.rut || '')}"></div>
      <div class="field"><div class="k">Correo</div><input type="text" class="ct-input" id="ct-correo" value="${escapeHtml(c.correo || '')}"></div>
      <div class="field"><div class="k">Correo alternativo</div><input type="text" class="ct-input" id="ct-correoAlt" value="${escapeHtml(c.correoAlt || '')}"></div>
      <div class="field"><div class="k">Clave portal PJUD</div><input type="text" class="ct-input" id="ct-claveWeb" value="${escapeHtml(c.claveWeb || '')}"></div>
      <div class="field"><div class="k">Clave única</div><input type="text" class="ct-input" id="ct-claveUnica" value="${escapeHtml(c.claveUnica || '')}"></div>
      <div class="field"><div class="k">Teléfono</div><input type="text" class="ct-input" id="ct-telefono" value="${escapeHtml(c.telefono || '')}"></div>
      <div class="field"><div class="k">Nota</div><input type="text" class="ct-input" id="ct-nota" value="${escapeHtml(c.nota || '')}"></div>
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
    ${antecedentesFormHtml(c)}
  </div>

  <div class="dtab-content" data-tab="encargo-receptor">
    <div class="agenda-toolbar">
      <button class="btn small primary" id="add-encargo-receptor">+ Nuevo encargo</button>
    </div>
    <div id="encargo-receptor-form-wrap" class="agenda-form-wrap" hidden></div>
    <div id="encargo-receptor-list-wrap">${encargosDeCausaListHtml(c)}</div>
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

  function alternarCamposTribunal() {
    const esCivil = panel.querySelector('#ed-tipotribunal').value === 'Juzgado Civil';
    panel.querySelector('#ed-numerotribunal-wrap').hidden = esCivil;
    panel.querySelector('#ed-ciudadtribunal-wrap').hidden = esCivil;
    panel.querySelector('#ed-tribunal-civil-wrap').hidden = !esCivil;
  }
  if (tipoTribunalSel) { tipoTribunalSel.addEventListener('change', alternarCamposTribunal); alternarCamposTribunal(); }

  function refreshTribunalPreview() {
    const preview = panel.querySelector('#ed-tribunal-preview');
    if (!preview) return;
    const tipo = panel.querySelector('#ed-tipotribunal').value;
    let numero, ciudad;
    if (tipo === 'Juzgado Civil') {
      numero = panel.querySelector('#ed-tribunal-civil').value.trim();
      ciudad = numero ? 'Santiago' : '';
    } else {
      numero = panel.querySelector('#ed-numerotribunal').value.trim();
      ciudad = panel.querySelector('#ed-ciudadtribunal').value.trim();
    }
    const texto = tribunalTexto({ tipoTribunal: tipo || null, numeroTribunal: numero || null, ciudadTribunal: ciudad || null, tribunal: c.tribunal });
    preview.innerHTML = `Se mostrará como: <strong>${escapeHtml(texto || 'Sin definir')}</strong>`;
  }
  ['#ed-tipotribunal', '#ed-numerotribunal', '#ed-ciudadtribunal', '#ed-tribunal-civil'].forEach(sel => {
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

  // ---------- Notificación (múltiples personas, con fallback histórico) ----------
  wireNotificacionTab(c, panel);

  // ---------- Oficios (nueva sección, independiente de Notificación) ----------
  wireOficiosTab(c, panel);

  // ---------- Contacto ----------
  const saveContacto = panel.querySelector('#save-contacto');
  if (saveContacto) saveContacto.addEventListener('click', async () => {
    const patch = {
      rut: panel.querySelector('#ct-rut').value.trim() || null,
      correo: panel.querySelector('#ct-correo').value.trim() || null,
      correoAlt: panel.querySelector('#ct-correoAlt').value.trim() || null,
      claveWeb: panel.querySelector('#ct-claveWeb').value.trim() || null,
      claveUnica: panel.querySelector('#ct-claveUnica').value.trim() || null,
      telefono: panel.querySelector('#ct-telefono').value.trim() || null,
      nota: panel.querySelector('#ct-nota').value.trim() || null
    };
    try { await api.updateCausa(c.id, patch); Object.assign(c, patch); toast('Contacto guardado'); render(); }
    catch (e) { toast('No se pudo guardar: ' + e.message); }
  });

  // ---------- Agenda (eventos de la causa) ----------
  wireAgendaTab(c, panel);

  // ---------- Encargo receptor (uno o varios por causa) ----------
  wireEncargoReceptorTab(c, panel);

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

  // ---------- Antecedentes (formulario compartido con Nueva causa) ----------
  wireAntecedentesForm(panel, c, { esNuevaCausa: false });

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
    formWrap.querySelector('#gf-tipo').addEventListener('change', () => {
      const tipoSel = formWrap.querySelector('#gf-tipo').value;
      formWrap.querySelector('#gf-categoria').innerHTML = categoriaGestionOptionsHtml(tipoSel, '');
    });
    formWrap.querySelector('#save-gestion').addEventListener('click', async () => {
      const patch = {
        descripcion: formWrap.querySelector('#gf-descripcion').value.trim(),
        categoria: formWrap.querySelector('#gf-categoria').value || null,
        tipo: formWrap.querySelector('#gf-tipo').value || null,
        prioridad: formWrap.querySelector('#gf-prioridad').value || null,
        estado: formWrap.querySelector('#gf-estado').value,
        fechaRevision: formWrap.querySelector('#gf-fecharevision').value || null,
        fechaLimite: formWrap.querySelector('#gf-fechalimite').value || null
      };
      if (!patch.descripcion) { toast('La gestión necesita una descripción'); return; }
      if (!patch.tipo) { toast('Selecciona si es una Tarea o una Gestión'); return; }
      try {
        if (gestion) {
          const actualizado = await api.updateGestionPendiente(gestion.id, patch);
          const idx = c.gestionesPendientes.findIndex(x => x.id === gestion.id);
          if (idx >= 0) c.gestionesPendientes[idx] = { id: actualizado.id, descripcion: actualizado.descripcion, driveLink: actualizado.drive_link, categoria: actualizado.categoria, tipo: actualizado.tipo, prioridad: actualizado.prioridad, estado: actualizado.estado, fechaRevision: actualizado.fecha_revision, fechaLimite: actualizado.fecha_limite, observaciones: actualizado.observaciones, createdAt: actualizado.created_at };
          toast('Gestión actualizada');
        } else {
          const nuevo = await api.createGestion(CURRENT_USER.id, c.id, patch);
          c.gestionesPendientes = c.gestionesPendientes || [];
          c.gestionesPendientes.push({ id: nuevo.id, descripcion: nuevo.descripcion, driveLink: nuevo.drive_link, categoria: nuevo.categoria, tipo: nuevo.tipo, prioridad: nuevo.prioridad, estado: nuevo.estado, fechaRevision: nuevo.fecha_revision, fechaLimite: nuevo.fecha_limite, observaciones: nuevo.observaciones, createdAt: nuevo.created_at });
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
    const fechaInp = panel.querySelector('#new-cron-fecha');
    const val = inp.value.trim();
    if (!val) return;
    if (!fechaInp.value) { toast('Elige la fecha de la actuación'); return; }
    try {
      const fechaExplicita = fechaCalendarioAExplicita(fechaInp.value);
      const nuevo = await api.addCronologia(CURRENT_USER.id, c.id, val, null, CURRENT_USER.nombre || CURRENT_USER.email, fechaExplicita);
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
  [['estadoGestion', 'Estado del encargo', 'select', ['Pendiente de encargo', 'Encargado', 'Realizado']], ['urgencia', 'Urgencia (SI/NO)']],
  [['resultadoDiligencia', 'Resultado de la diligencia', 'select', ['Pendiente', 'Positiva', 'Negativa']], ['fechaRealizacion', 'Fecha de realización', 'date']],
  [['materia', 'Materia'], ['tipoDiligencia', 'Tipo de diligencia']],
  [['descripcionEncargo', 'Descripción de encargo', 'textarea'], ['patrocinadoNombre', 'Patrocinado']],
  [['contraparteNombre', 'Contraparte'], ['patrocinadoSexo', 'Sexo patrocinado']],
  [['contraparteSexo', 'Sexo contraparte'], ['tribunal', 'Tribunal']],
  [['rol', 'RIT / ROL'], ['jurisdiccion', 'Jurisdicción']],
  [['comuna', 'Comuna'], ['direccion', 'Dirección de la diligencia']],
  [['observaciones', 'Observaciones relevantes', 'textarea'], ['receptorTurnoNombre', 'Receptor judicial de turno']],
  [['telefonoReceptor', 'Teléfono'], ['domicilioReceptor', 'Domicilio del receptor']],
  [['correoReceptor', 'Correo del receptor'], null]
];
const ENCARGO_FIELDS = ENCARGO_FIELD_ROWS.flat().filter(Boolean);

function recordCardHtml(r) {
  const urg = (r.urgencia || '').toUpperCase() === 'SI';
  const estadoGestion = r.estadoGestion || 'Pendiente de encargo';
  const realizado = estadoGestion === 'Realizado';
  const encargado = estadoGestion === 'Encargado';
  const estadoLabel = realizado ? 'REALIZADO' : (encargado ? 'ENCARGADO' : (urg ? 'URGENTE | PENDIENTE' : 'PENDIENTE'));
  const estadoClase = realizado ? 'calm-estado' : (encargado ? 'semi' : (urg ? 'urgente' : 'noprior'));
  const causaVinculada = r.causaId ? findCausa(r.causaId) : null;
  return `<div class="case-card case-card-3col" data-rid="${r.id}">
    <div style="display:flex; flex-direction:column; gap:4px;">
      <div class="stamp evento-estado-${estadoClase}" style="transform:none;">${estadoLabel}</div>
    </div>
    <div class="case-main">
      <div class="titulo">${escapeHtml(r.patrocinadoNombre || 'Sin nombre registrado')}</div>
      <div class="meta">
        ${causaVinculada ? `<span class="rol">${escapeHtml(causaVinculada.rol || causaVinculada.titulo)}</span>` : (r.rol ? `<span class="rol">${escapeHtml(r.rol)}</span>` : '')}
        ${r.tribunal ? `<span>${escapeHtml(r.tribunal)}</span>` : ''}
        ${r.tipoDiligencia ? `<span>${escapeHtml(r.tipoDiligencia)}</span>` : ''}
      </div>
      ${r.descripcionEncargo ? `<div class="gestion">${escapeHtml(r.descripcionEncargo)}</div>` : ''}
      ${r.direccion ? `<div class="gestion">${escapeHtml([r.direccion, r.comuna].filter(Boolean).join(', '))}</div>` : ''}
      ${r.receptorTurnoNombre ? `<div class="gestion" style="color:var(--ink-faint);">Receptor: ${escapeHtml(r.receptorTurnoNombre)}</div>` : ''}
      ${realizado ? `<div class="gestion" style="color:var(--ink-faint);">Resultado: ${escapeHtml(r.resultadoDiligencia || '')}${r.fechaRealizacion ? ' · ' + escapeHtml(r.fechaRealizacion) : ''}</div>` : ''}
    </div>
    <div class="case-side">${escapeHtml(r.fechaEncargo || '')}</div>
  </div>`;
}

let encargoFiltroTablero = 'todos';

function renderRecordsList() {
  const porBusqueda = searchTerm ? ENCARGOS.filter(r => JSON.stringify(r).toLowerCase().includes(searchTerm.toLowerCase())) : ENCARGOS;
  const filtros = {
    todos: () => true,
    pendientes: r => (r.estadoGestion || 'Pendiente de encargo') === 'Pendiente de encargo',
    encargados: r => r.estadoGestion === 'Encargado',
    realizados: r => r.estadoGestion === 'Realizado'
  };
  const filtered = porBusqueda.filter(filtros[encargoFiltroTablero] || filtros.todos);

  const botonesFiltro = [
    ['todos', 'Todos'],
    ['pendientes', 'Pendientes de encargar'],
    ['encargados', 'Encargados / pendientes del receptor'],
    ['realizados', 'Realizados']
  ].map(([key, label]) => `<button class="btn small ${encargoFiltroTablero === key ? 'primary' : 'ghost'}" data-encargo-filtro="${key}" type="button">${label}</button>`).join(' ');

  let html = `<div class="section-title">Encargo receptor <span class="n">${filtered.length}</span></div>`;
  html += `<div style="margin-bottom:14px; display:flex; gap:8px; flex-wrap:wrap;">${botonesFiltro}</div>`;
  html += filtered.length ? `<div class="case-grid">${filtered.map(recordCardHtml).join('')}</div>` : `<div class="empty-msg">Sin registros${searchTerm ? ' que coincidan con la búsqueda' : ''}.</div>`;
  const container = document.getElementById('list-container');
  container.innerHTML = html;
  container.querySelectorAll('.case-card[data-rid]').forEach(el => el.addEventListener('click', () => openRecordDetail(el.dataset.rid)));
  container.querySelectorAll('[data-encargo-filtro]').forEach(btn => {
    btn.addEventListener('click', () => { encargoFiltroTablero = btn.dataset.encargoFiltro; renderRecordsList(); });
  });
}

function emptyRecord() {
  const rec = {};
  ENCARGO_FIELDS.forEach(([key]) => { rec[key] = null; });
  rec.causaId = null;
  return rec;
}

// Busca turnos vigentes para una fecha de encargo + tribunal exacto. No
// asigna nada automáticamente: solo devuelve candidatos para que la
// usuaria confirme. Compara contra tribunalTurno (el campo real que carga
// el importador de Turnos) de forma exacta, no por substring — válido
// porque el tribunal de la causa ahora usa el mismo formato exacto
// "N° Juzgado Civil de Santiago". Ya no depende de materia ni jurisdicción.
function buscarTurnosAplicables(fecha, tribunal) {
  if (!fecha) return [];
  return TURNOS.filter(t => {
    if (fecha < t.fechaInicio || fecha > t.fechaFin) return false;
    if (tribunal && t.tribunalTurno && t.tribunalTurno !== tribunal) return false;
    return true;
  });
}

// Coherencia entre Estado del encargo, Resultado de la diligencia y Fecha de
// realización — compartida por el formulario global (prefijo 'rec') y el de
// la ficha de causa (mismo prefijo 'rec', reutilizado íntegro). Mientras el
// estado no sea 'Realizado', resultado y fecha quedan deshabilitados y se
// limpian a 'Pendiente'/vacío. Al pasar a 'Realizado' se habilitan para que
// la usuaria los complete — nunca se adivina el resultado.
function aplicarCoherenciaEstadoGestion(panel, prefix) {
  const estadoSel = panel.querySelector(`#${prefix}-estadoGestion`);
  const resultadoSel = panel.querySelector(`#${prefix}-resultadoDiligencia`);
  const fechaInput = panel.querySelector(`#${prefix}-fechaRealizacion`);
  if (!estadoSel || !resultadoSel || !fechaInput) return;
  // Estilo inline (no hay cambios en style.css en esta ronda) para que un
  // campo deshabilitado se vea claramente "a la espera", no roto: borde
  // discontinuo y algo más tenue, con un tooltip explicando por qué.
  const ESTILO_DESHABILITADO = 'opacity:.55; border-style:dashed; cursor:not-allowed;';
  const TITULO_DESHABILITADO = 'Se habilita al marcar el estado como "Realizado"';
  const sync = () => {
    const realizado = estadoSel.value === 'Realizado';
    resultadoSel.disabled = !realizado;
    fechaInput.disabled = !realizado;
    resultadoSel.style.cssText = realizado ? '' : ESTILO_DESHABILITADO;
    fechaInput.style.cssText = realizado ? '' : ESTILO_DESHABILITADO;
    resultadoSel.title = realizado ? '' : TITULO_DESHABILITADO;
    fechaInput.title = realizado ? '' : TITULO_DESHABILITADO;
    if (realizado) {
      // Mientras el estado es "Realizado", el resultado solo puede ser
      // Positiva o Negativa — nunca "Pendiente" — para que no sea posible
      // ni siquiera seleccionar una combinación inválida en la interfaz.
      const valorActual = resultadoSel.value;
      resultadoSel.innerHTML = `
        <option value="">Selecciona…</option>
        <option value="Positiva"${valorActual === 'Positiva' ? ' selected' : ''}>Positiva</option>
        <option value="Negativa"${valorActual === 'Negativa' ? ' selected' : ''}>Negativa</option>`;
    } else {
      resultadoSel.innerHTML = '<option value="Pendiente" selected>Pendiente</option>';
      fechaInput.value = '';
    }
  };
  estadoSel.addEventListener('change', sync);
  sync();
}

// Antes de guardar: si el estado no es 'Realizado', fuerza resultado
// 'Pendiente' y fecha vacía (defensivo, por si el campo llegó deshabilitado
// con otro valor previo). Si es 'Realizado', exige fecha y resultado
// Positiva/Negativa — nunca se envía una combinación inválida a la base de
// datos, que ya tiene un CHECK que la rechazaría igualmente.
function validarCoherenciaEncargo(patch) {
  if (patch.estadoGestion === 'Realizado') {
    if (!patch.fechaRealizacion) return 'Falta la fecha de realización.';
    if (!['Positiva', 'Negativa'].includes(patch.resultadoDiligencia)) return 'Selecciona si el resultado de la diligencia fue Positiva o Negativa.';
  } else {
    patch.resultadoDiligencia = 'Pendiente';
    patch.fechaRealizacion = null;
  }
  return null;
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
  const fieldsHtml = ENCARGO_FIELD_ROWS_CAUSA.map(([left, right]) => `
    <div class="form-grid2">
      ${encargoFieldHtml(left, rec)}
      ${right ? encargoFieldHtml(right, rec) : '<div></div>'}
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
      <button class="btn ghost" id="buscar-receptor-turno" type="button">Buscar receptor sugerido según fecha de resolución y tribunal</button>
      <div id="receptor-sugerido-wrap"></div>
      ${!isNew ? `<button class="btn danger" id="delete-record">Eliminar este registro</button>` : ''}
    </div>
  </div>`;
}

function wireRecordEvents(rec, isNew) {
  const panel = document.getElementById('detail-panel');
  panel.querySelector('#detail-close').addEventListener('click', closeOverlay);
  aplicarCoherenciaEstadoGestion(panel, 'rec');

  const buscarBtn = panel.querySelector('#buscar-receptor-turno');
  const sugeridoWrap = panel.querySelector('#receptor-sugerido-wrap');
  if (buscarBtn) buscarBtn.addEventListener('click', () => {
    const fecha = panel.querySelector('#rec-fechaResolucion').value;
    const tribunal = panel.querySelector('#rec-tribunal').value.trim();
    if (!fecha) { toast('Ingresa primero la fecha de resolución'); return; }

    const candidatos = buscarTurnosAplicables(fecha, tribunal);

    if (candidatos.length === 0) {
      sugeridoWrap.innerHTML = `
        <div class="receptor-sugerido-box">
          <div class="ficha-empty" style="color:var(--ink-faint);">No existe información de turnos cargada para esta fecha y tribunal.</div>
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
    ENCARGO_FIELDS_CAUSA.forEach(([key]) => { patch[key] = panel.querySelector(`#rec-${key}`).value.trim() || null; });
    // Trazabilidad de la asignación del receptor (se completa al usar
    // "Buscar receptor sugerido" / "Confirmar receptor", no son inputs del formulario) y causaId (tampoco es un input).
    ['receptorSugeridoId', 'receptorConfirmadoId', 'turnoId', 'fuenteTurno', 'fechaConfirmacionReceptor', 'causaId'].forEach(k => {
      if (rec[k] !== undefined) patch[k] = rec[k];
    });
    const errorCoherencia = validarCoherenciaEncargo(patch);
    if (errorCoherencia) { toast(errorCoherencia); return; }
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
      <div class="ficha-empty" style="color:var(--calm);">Receptor sugerido según fecha de resolución y tribunal:</div>
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

// ============================================================================
// Encargo receptor DENTRO de la ficha de causa — bloque nuevo. Lee y escribe
// sobre el MISMO arreglo global ENCARGOS (filtrado por causaId), sin crear
// ningún sistema paralelo: el tablero global (Registros → Encargo receptor)
// y esta pestaña muestran siempre los mismos datos.
// ============================================================================

// Campos reducidos para el formulario dentro de la causa (a diferencia del
// formulario global, que conserva Tipo de diligencia/Urgencia/Dirección para
// no romper el historial): datos generales precargados desde la causa +
// campos operativos del encargo + receptor. Mismo helper encargoFieldHtml,
// mismo prefijo de id "rec-" que el formulario global, para poder reutilizar
// sin cambios aplicarReceptorSugerido/mostrarSelectorManualReceptor.
const ENCARGO_FIELD_ROWS_CAUSA = [
  [['materia', 'Materia'], ['tribunal', 'Tribunal']],
  [['rol', 'RIT / ROL'], ['patrocinadoNombre', 'Patrocinado']],
  [['contraparteNombre', 'Contraparte'], ['folio', 'Folio']],
  [['fechaResolucion', 'Fecha de resolución', 'date'], ['fechaEncargo', 'Fecha de encargo', 'date']],
  [['descripcionEncargo', 'Descripción de encargo', 'textarea'], ['observaciones', 'Observaciones relevantes', 'textarea']],
  [['estadoGestion', 'Estado del encargo', 'select', ['Pendiente de encargo', 'Encargado', 'Realizado']], ['resultadoDiligencia', 'Resultado de la diligencia', 'select', ['Pendiente', 'Positiva', 'Negativa']]],
  [['fechaRealizacion', 'Fecha de realización', 'date'], ['receptorTurnoNombre', 'Receptor judicial de turno']],
  [['telefonoReceptor', 'Teléfono'], ['domicilioReceptor', 'Domicilio del receptor']],
  [['correoReceptor', 'Correo del receptor'], null]
];
const ENCARGO_FIELDS_CAUSA = ENCARGO_FIELD_ROWS_CAUSA.flat().filter(Boolean);

// Encargo nuevo iniciado desde una causa: precarga los datos generales que
// ya existan en la ficha, para no volver a exigirlos manualmente.
function emptyRecordParaCausa(c) {
  const rec = emptyRecord();
  rec.causaId = c.id;
  rec.materia = c.materia || null;
  rec.tribunal = tribunalTexto(c) || null;
  rec.rol = c.rol || null;
  // Patrocinado: se reutiliza patrocinadoEfectivo(c), ya existente, en vez
  // de leer c.patrocinado directamente.
  rec.patrocinadoNombre = patrocinadoEfectivo(c);
  // Contraparte: se deriva procesalmente según qué parte representa la
  // causa (mismo criterio que patrocinadoEfectivo, en sentido inverso).
  // c.contraparteNombre solo se usa como respaldo para causas antiguas que
  // no tengan cargados demandanteNombre/demandadoNombre/parteRepresentada.
  if (c.parteRepresentada === 'Demandante' && c.demandadoNombre) rec.contraparteNombre = c.demandadoNombre;
  else if (c.parteRepresentada === 'Demandado' && c.demandanteNombre) rec.contraparteNombre = c.demandanteNombre;
  else rec.contraparteNombre = c.contraparteNombre || null;
  rec.folio = c.folio || null;
  rec.estadoGestion = 'Pendiente de encargo';
  rec.resultadoDiligencia = 'Pendiente';
  return rec;
}

function encargosDeCausaListHtml(c) {
  const items = ENCARGOS.filter(e => e.causaId === c.id);
  if (items.length === 0) {
    return '<div class="empty-msg" style="margin-top:10px;">Aún no hay encargos receptor registrados para esta causa.</div>';
  }
  const orden = { 'Pendiente de encargo': 0, 'Encargado': 1, 'Realizado': 2 };
  const ordenados = items.slice().sort((a, b) => (orden[a.estadoGestion] ?? 9) - (orden[b.estadoGestion] ?? 9));
  return `<div class="case-grid">${ordenados.map(recordCardHtml).join('')}</div>`;
}

function encargoCausaFormHtml(rec, isNew) {
  const fieldsHtml = ENCARGO_FIELD_ROWS_CAUSA.map(([left, right]) => `
    <div class="form-grid2">
      ${encargoFieldHtml(left, rec)}
      ${right ? encargoFieldHtml(right, rec) : '<div></div>'}
    </div>`).join('');
  return `
  <div class="agenda-form">
    <div class="subhead" style="margin-top:0;">${isNew ? 'Nuevo encargo receptor' : 'Editar encargo receptor'}</div>
    ${fieldsHtml}
    <button class="btn ghost" id="buscar-receptor-turno" type="button">Buscar receptor sugerido según fecha de resolución y tribunal</button>
    <div id="receptor-sugerido-wrap"></div>
    <div style="display:flex; gap:8px; margin-top:6px;">
      <button class="btn primary" id="erf-save" type="button">Guardar encargo</button>
      <button class="btn ghost" id="erf-cancel" type="button">Cancelar</button>
      ${!isNew ? `<button class="btn danger" id="erf-delete" type="button" style="margin-left:auto;">Eliminar</button>` : ''}
    </div>
  </div>`;
}

function wireEncargoReceptorTab(c, panel) {
  const formWrap = panel.querySelector('#encargo-receptor-form-wrap');
  const listWrap = panel.querySelector('#encargo-receptor-list-wrap');

  function closeForm() { formWrap.hidden = true; formWrap.innerHTML = ''; }

  function refreshList() {
    listWrap.innerHTML = encargosDeCausaListHtml(c);
    wireListButtons();
  }

  function wireListButtons() {
    listWrap.querySelectorAll('.case-card[data-rid]').forEach(el => {
      el.addEventListener('click', () => {
        const rec = ENCARGOS.find(x => x.id === el.dataset.rid);
        if (rec) openForm(rec);
      });
    });
  }

  function openForm(recExistente) {
    const isNew = !recExistente;
    const registro = recExistente || emptyRecordParaCausa(c);
    formWrap.innerHTML = encargoCausaFormHtml(registro, isNew);
    formWrap.hidden = false;
    aplicarCoherenciaEstadoGestion(formWrap, 'rec');

    // Buscar receptor sugerido — misma lógica ya existente
    // (buscarTurnosAplicables / aplicarReceptorSugerido /
    // mostrarSelectorManualReceptor), sin reescribir el algoritmo: se
    // reutilizan literalmente, pasando este formulario como "panel".
    const buscarBtn = formWrap.querySelector('#buscar-receptor-turno');
    const sugeridoWrap = formWrap.querySelector('#receptor-sugerido-wrap');
    buscarBtn.addEventListener('click', () => {
      const fecha = formWrap.querySelector('#rec-fechaResolucion').value;
      const tribunal = formWrap.querySelector('#rec-tribunal').value.trim();
      if (!fecha) { toast('Ingresa primero la fecha de resolución'); return; }

      const candidatos = buscarTurnosAplicables(fecha, tribunal);

      if (candidatos.length === 0) {
        sugeridoWrap.innerHTML = `
          <div class="receptor-sugerido-box">
            <div class="ficha-empty" style="color:var(--ink-faint);">No existe información de turnos cargada para esta fecha y tribunal.</div>
            <div class="agenda-toolbar" style="margin-top:8px;">
              <button class="btn small" id="rs-manual" type="button">Seleccionar receptor manualmente</button>
            </div>
          </div>`;
        sugeridoWrap.querySelector('#rs-manual').addEventListener('click', () => mostrarSelectorManualReceptor(formWrap, sugeridoWrap, registro));
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
          btn.addEventListener('click', () => aplicarReceptorSugerido(formWrap, sugeridoWrap, candidatos.find(t => t.id === btn.dataset.id), registro));
        });
        return;
      }

      aplicarReceptorSugerido(formWrap, sugeridoWrap, candidatos[0], registro);
    });

    formWrap.querySelector('#erf-cancel').addEventListener('click', closeForm);
    formWrap.querySelector('#erf-save').addEventListener('click', async () => {
      const patch = {};
      ENCARGO_FIELDS_CAUSA.forEach(([key]) => { patch[key] = formWrap.querySelector(`#rec-${key}`).value.trim() || null; });
      patch.causaId = c.id;
      ['receptorSugeridoId', 'receptorConfirmadoId', 'turnoId', 'fuenteTurno', 'fechaConfirmacionReceptor'].forEach(k => {
        if (registro[k] !== undefined) patch[k] = registro[k];
      });
      const errorCoherencia = validarCoherenciaEncargo(patch);
      if (errorCoherencia) { toast(errorCoherencia); return; }
      try {
        if (isNew) {
          const nuevo = await api.createEncargo(CURRENT_USER.id, patch);
          ENCARGOS.unshift(nuevo);
          toast('Encargo receptor creado');
        } else {
          await api.updateEncargo(registro.id, patch);
          Object.assign(registro, patch);
          toast('Encargo receptor actualizado');
        }
        closeForm();
        refreshList();
      } catch (e) { toast('No se pudo guardar: ' + e.message); }
    });
    const delBtn = formWrap.querySelector('#erf-delete');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este encargo receptor? Esta acción no se puede deshacer.')) return;
      try {
        await api.deleteEncargo(registro.id);
        ENCARGOS = ENCARGOS.filter(x => x.id !== registro.id);
        toast('Encargo eliminado');
        closeForm();
        refreshList();
      } catch (e) { toast('No se pudo eliminar: ' + e.message); }
    });
  }

  panel.querySelector('#add-encargo-receptor').addEventListener('click', () => openForm(null));
  wireListButtons();
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
function openNewModal() {
  const wrap = document.getElementById('nf-antecedentes-wrap');
  const causaVacia = emptyCausa();
  wrap.innerHTML = antecedentesFormHtml(causaVacia);
  wireAntecedentesForm(wrap, causaVacia, { esNuevaCausa: true });
  document.getElementById('overlay-new').classList.add('show');
}
function closeNewModal() {
  document.getElementById('overlay-new').classList.remove('show');
  document.getElementById('nf-antecedentes-wrap').innerHTML = '';
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
