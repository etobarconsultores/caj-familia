import { supabase } from '../supabaseClient.js';

// Organización/módulo del build actual de Civil (Fase 1 — arquitectura
// modular). Se escriben EXPLÍCITAMENTE en cada evento nuevo de Agenda que
// crea este módulo, y se usan también para filtrar la lectura: no se
// depende de ningún valor por defecto de Supabase, para que un evento de
// Civil nunca pueda quedar mal clasificado ni mezclarse con otro módulo.
const CIVIL_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'; // CAJ Lo Prado
const CIVIL_MODULE_ID = 'civil';

// ============================================================================
// Helpers de mapeo entre columnas de Supabase (snake_case) y el modelo de la
// aplicación (camelCase), para no tener que tocar la lógica de la UI.
// ============================================================================

function causaFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    titulo: row.titulo,
    categoria: row.categoria,
    subcategoria: row.subcategoria,
    rol: row.rol,
    rolIngreso: row.rol_ingreso,
    folio: row.folio,
    tribunal: row.tribunal,
    materia: row.materia,
    submateria: row.submateria,
    parte: row.parte,
    representacion: row.representacion,
    recurso: row.recurso,
    rolCA: row.rol_ca,
    tutor: row.tutor,
    patrocinado: row.patrocinado,
    rut: row.rut,
    correo: row.correo,
    correoAlt: row.correo_alt,
    telefono: row.telefono,
    nota: row.nota,
    claveWeb: row.clave_web,
    claveUnica: row.clave_unica,
    prioridad: row.prioridad,
    etapa: row.etapa,
    plazo: row.plazo,
    clave: row.clave,
    estado: row.estado,
    objetivoApelacion: row.objetivo_apelacion,
    resumen: row.resumen,
    comentarios: row.comentarios,
    fechaIngreso: row.fecha_ingreso,
    fechaAudiencia: row.fecha_audiencia,
    hora: row.hora_audiencia,
    modalidad: row.modalidad,
    notifEstado: row.notif_estado,
    notifNombre: row.notif_nombre,
    driveFolderUrl: row.drive_folder_url,
    ultimaRevisionAt: row.ultima_revision_at,
    tipoTribunal: row.tipo_tribunal,
    numeroTribunal: row.numero_tribunal,
    ciudadTribunal: row.ciudad_tribunal,
    contraparteNombre: row.contraparte_nombre,
    demandanteNombre: row.demandante_nombre,
    demandadoNombre: row.demandado_nombre,
    parteRepresentada: row.parte_representada,
    resultadoBeneficio: row.resultado_beneficio,
    observacionesTraspaso: row.observaciones_traspaso,
    bajEstado: row.baj_estado,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    gestionesPendientes: (row.gestiones_pendientes || [])
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(g => ({
        id: g.id, descripcion: g.descripcion, driveLink: g.drive_link,
        categoria: g.categoria, tipo: g.tipo, prioridad: g.prioridad, estado: g.estado || 'Pendiente',
        fechaRevision: g.fecha_revision, fechaLimite: g.fecha_limite, observaciones: g.observaciones,
        createdAt: g.created_at
      })),
    cronologia: (row.cronologia || [])
      .slice()
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
      .map(g => ({ id: g.id, descripcion: g.descripcion, driveLink: g.drive_link, usuarioNombre: g.usuario_nombre, fecha: g.fecha })),
    domicilios: (row.domicilios_notificacion || [])
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(d => ({ id: d.id, domicilio: d.domicilio, estado: d.estado, fecha: d.fecha, folio: d.folio, informadoPor: d.informado_por })),
    hitos: (row.hitos || [])
      .slice()
      .sort((a, b) => a.orden - b.orden)
      .map(h => ({ id: h.id, descripcion: h.descripcion, orden: h.orden, completado: h.completado })),
    instrucciones: (row.instrucciones_tutor || [])
      .slice()
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
      .map(it => ({ id: it.id, tutor: it.tutor, fecha: it.fecha, instruccion: it.instruccion, fechaLimite: it.fecha_limite, estado: it.estado })),
    agendaEventos: (row.agenda_eventos || [])
      .slice()
      .sort((a, b) => {
        const fa = `${a.fecha || ''} ${a.hora_inicio || ''}`;
        const fb = `${b.fecha || ''} ${b.hora_inicio || ''}`;
        return fa.localeCompare(fb);
      })
      .map(e => ({
        id: e.id, causaId: e.causa_id, tipo: e.tipo, titulo: e.titulo, descripcion: e.descripcion,
        fecha: e.fecha, horaInicio: e.hora_inicio, horaTermino: e.hora_termino,
        modalidad: e.modalidad, ubicacion: e.ubicacion, enlace: e.enlace,
        estado: e.estado, prioridad: e.prioridad, observaciones: e.observaciones,
        creadoPor: e.creado_por, createdAt: e.created_at, updatedAt: e.updated_at,
        googleEventId: e.google_event_id, googleCalendarId: e.google_calendar_id,
        googleSyncStatus: e.google_sync_status, googleLastSyncAt: e.google_last_sync_at,
        googleSyncError: e.google_sync_error, recordatorios: e.recordatorios,
        organizationId: e.organization_id, moduleId: e.module_id
      }))
  };
}

function causaPatchToDb(patch) {
  const map = {
    titulo: 'titulo', categoria: 'categoria', subcategoria: 'subcategoria',
    rol: 'rol', rolIngreso: 'rol_ingreso', folio: 'folio', tribunal: 'tribunal',
    materia: 'materia', submateria: 'submateria', parte: 'parte', representacion: 'representacion',
    recurso: 'recurso', rolCA: 'rol_ca', tutor: 'tutor',
    patrocinado: 'patrocinado', rut: 'rut', correo: 'correo', correoAlt: 'correo_alt',
    telefono: 'telefono', nota: 'nota', claveWeb: 'clave_web', claveUnica: 'clave_unica',
    prioridad: 'prioridad', etapa: 'etapa', plazo: 'plazo', clave: 'clave', estado: 'estado',
    objetivoApelacion: 'objetivo_apelacion', resumen: 'resumen', comentarios: 'comentarios',
    fechaIngreso: 'fecha_ingreso', fechaAudiencia: 'fecha_audiencia', hora: 'hora_audiencia',
    modalidad: 'modalidad',
    notifEstado: 'notif_estado', notifNombre: 'notif_nombre', driveFolderUrl: 'drive_folder_url',
    ultimaRevisionAt: 'ultima_revision_at',
    tipoTribunal: 'tipo_tribunal', numeroTribunal: 'numero_tribunal', ciudadTribunal: 'ciudad_tribunal',
    contraparteNombre: 'contraparte_nombre',
    demandanteNombre: 'demandante_nombre', demandadoNombre: 'demandado_nombre',
    parteRepresentada: 'parte_representada', resultadoBeneficio: 'resultado_beneficio',
    observacionesTraspaso: 'observaciones_traspaso',
    bajEstado: 'baj_estado'
  };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => {
    if (map[k]) out[map[k]] = v === undefined ? null : v;
  });
  return out;
}

// Tablas relacionadas que se adjuntan a cada causa. Se consultan por
// separado (no en un único select anidado) para que un problema puntual en
// cualquiera de ellas nunca haga desaparecer las causas: en el peor caso,
// esa causa queda sin esa información específica, pero sigue apareciendo.
const CAUSA_CHILD_TABLES = [
  'gestiones_pendientes', 'cronologia', 'domicilios_notificacion',
  'hitos', 'agenda_eventos', 'instrucciones_tutor'
];

async function fetchChildRows(table, causaIds) {
  try {
    let query = supabase.from(table).select('*');
    if (causaIds) query = query.in('causa_id', causaIds);
    const { data, error } = await query;
    if (error) {
      console.error(`No se pudieron cargar los datos de "${table}":`, error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error(`Error inesperado cargando "${table}":`, e);
    return [];
  }
}

function agruparPorCausa(rows) {
  const map = new Map();
  rows.forEach(r => {
    const key = r.causa_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  });
  return map;
}

async function fetchCausasConRelaciones(filtroIds) {
  let query = supabase.from('causas').select('*').order('created_at', { ascending: false });
  if (filtroIds) query = query.in('id', filtroIds);
  const { data: causasRaw, error } = await query;
  if (error) throw error;
  if (!causasRaw || causasRaw.length === 0) return [];

  const causaIds = causasRaw.map(c => c.id);
  const resultados = await Promise.all(
    CAUSA_CHILD_TABLES.map(table => fetchChildRows(table, causaIds))
  );
  const porTabla = {};
  CAUSA_CHILD_TABLES.forEach((table, i) => { porTabla[table] = agruparPorCausa(resultados[i]); });

  return causasRaw.map(row => causaFromDb({
    ...row,
    gestiones_pendientes: porTabla.gestiones_pendientes.get(row.id) || [],
    cronologia: porTabla.cronologia.get(row.id) || [],
    domicilios_notificacion: porTabla.domicilios_notificacion.get(row.id) || [],
    hitos: porTabla.hitos.get(row.id) || [],
    agenda_eventos: porTabla.agenda_eventos.get(row.id) || [],
    instrucciones_tutor: porTabla.instrucciones_tutor.get(row.id) || []
  }));
}

export async function fetchCausaById(causaId) {
  const causas = await fetchCausasConRelaciones([causaId]);
  if (!causas.length) throw new Error('No se encontró la causa solicitada.');
  return causas[0];
}

export async function fetchCausas() {
  return fetchCausasConRelaciones(null);
}

export async function createCausa(userId, patch) {
  const dbPatch = causaPatchToDb(patch);
  dbPatch.user_id = userId;
  const { data, error } = await supabase
    .from('causas')
    .insert(dbPatch)
    .select('*')
    .single();
  if (error) throw error;
  // Una causa recién creada todavía no tiene gestiones, cronología, etc.
  return causaFromDb({
    ...data,
    gestiones_pendientes: [], cronologia: [], domicilios_notificacion: [],
    hitos: [], agenda_eventos: [], instrucciones_tutor: []
  });
}

export async function updateCausa(causaId, patch) {
  const dbPatch = causaPatchToDb(patch);
  const { error } = await supabase.from('causas').update(dbPatch).eq('id', causaId);
  if (error) throw error;
}

export async function deleteCausa(causaId) {
  const { error } = await supabase.from('causas').delete().eq('id', causaId);
  if (error) throw error;
}

// ---------- Gestiones pendientes ----------
function gestionPatchToDb(patch) {
  const map = {
    descripcion: 'descripcion', driveLink: 'drive_link', categoria: 'categoria', tipo: 'tipo',
    prioridad: 'prioridad', estado: 'estado', fechaRevision: 'fecha_revision',
    fechaLimite: 'fecha_limite', observaciones: 'observaciones'
  };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}

export async function createGestion(userId, causaId, patch) {
  const dbPatch = gestionPatchToDb(patch);
  dbPatch.user_id = userId;
  dbPatch.causa_id = causaId;
  if (!dbPatch.estado) dbPatch.estado = 'Pendiente';
  const { data, error } = await supabase.from('gestiones_pendientes').insert(dbPatch).select().single();
  if (error) throw error;
  return data;
}

// Alias retrocompatible (usado por el modal de "nueva causa" para su primera gestión)
export async function addGestionPendiente(userId, causaId, descripcion, driveLink) {
  return createGestion(userId, causaId, { descripcion, driveLink });
}

export async function updateGestionPendiente(id, patch) {
  const { data, error } = await supabase.from('gestiones_pendientes').update(gestionPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteGestionPendiente(id) {
  const { error } = await supabase.from('gestiones_pendientes').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Cronología ----------
export async function addCronologia(userId, causaId, descripcion, driveLink, usuarioNombre) {
  const { data, error } = await supabase
    .from('cronologia')
    .insert({
      user_id: userId, causa_id: causaId, descripcion,
      drive_link: driveLink || null, usuario_nombre: usuarioNombre || null,
      fecha: new Date().toISOString()
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateCronologia(id, patch) {
  const dbPatch = {};
  if (patch.descripcion !== undefined) dbPatch.descripcion = patch.descripcion;
  if (patch.driveLink !== undefined) dbPatch.drive_link = patch.driveLink;
  const { error } = await supabase.from('cronologia').update(dbPatch).eq('id', id);
  if (error) throw error;
}

export async function deleteCronologia(id) {
  const { error } = await supabase.from('cronologia').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Domicilios de notificación ----------
export async function replaceDomicilios(userId, causaId, domicilios) {
  const { error: delErr } = await supabase.from('domicilios_notificacion').delete().eq('causa_id', causaId);
  if (delErr) throw delErr;
  const rows = (domicilios || [])
    .filter(d => d.domicilio || d.estado || d.fecha || d.folio || d.informadoPor)
    .map(d => ({
      user_id: userId, causa_id: causaId,
      domicilio: d.domicilio || null, estado: d.estado || null,
      fecha: d.fecha || null, folio: d.folio || null, informado_por: d.informadoPor || null
    }));
  if (rows.length > 0) {
    const { error: insErr } = await supabase.from('domicilios_notificacion').insert(rows);
    if (insErr) throw insErr;
  }
}

// ---------- Hitos (próximos hitos) ----------
export async function addHito(userId, causaId, descripcion, orden) {
  const { data, error } = await supabase
    .from('hitos')
    .insert({ user_id: userId, causa_id: causaId, descripcion, orden: orden || 0 })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function toggleHito(id, completado) {
  const { error } = await supabase.from('hitos').update({ completado }).eq('id', id);
  if (error) throw error;
}

export async function deleteHito(id) {
  const { error } = await supabase.from('hitos').delete().eq('id', id);
  if (error) throw error;
}

const HITOS_DEFAULT = ['Esperar proveído', 'Presentar escrito', 'Notificación', 'Audiencia', 'Cumplimiento'];

export async function seedHitosSiVacio(userId, causaId, hitosExistentes) {
  if (hitosExistentes && hitosExistentes.length > 0) return hitosExistentes;
  const rows = HITOS_DEFAULT.map((desc, i) => ({ user_id: userId, causa_id: causaId, descripcion: desc, orden: i }));
  const { data, error } = await supabase.from('hitos').insert(rows).select();
  if (error) throw error;
  return (data || []).map(h => ({ id: h.id, descripcion: h.descripcion, orden: h.orden, completado: h.completado }));
}

// ============================================================================
// Encargo receptor
// ============================================================================
function encargoFromDb(row) {
  return {
    id: row.id,
    causaId: row.causa_id,
    folio: row.folio, depto: row.depto, centroEncarga: row.centro_encarga,
    abogadoEncarga: row.abogado_encarga, fechaEncargo: row.fecha_encargo, materia: row.materia,
    patrocinadoNombre: row.patrocinado_nombre, patrocinadoSexo: row.patrocinado_sexo,
    contraparteNombre: row.contraparte_nombre, contraparteSexo: row.contraparte_sexo,
    tipoDiligencia: row.tipo_diligencia, urgencia: row.urgencia, estadoGestion: row.estado_gestion || 'Pendiente de encargo',
    direccion: row.direccion, comuna: row.comuna, tribunal: row.tribunal, rol: row.rol,
    jurisdiccion: row.jurisdiccion, observaciones: row.observaciones,
    fechaResolucion: row.fecha_resolucion,
    descripcionEncargo: row.descripcion_encargo,
    resultadoDiligencia: row.resultado_diligencia,
    fechaRealizacion: row.fecha_realizacion,
    receptorTurnoNombre: row.receptor_turno_nombre,
    telefonoReceptor: row.telefono_receptor,
    domicilioReceptor: row.domicilio_receptor,
    correoReceptor: row.correo_receptor,
    receptorSugeridoId: row.receptor_sugerido_id,
    receptorConfirmadoId: row.receptor_confirmado_id,
    turnoId: row.turno_id,
    fuenteTurno: row.fuente_turno,
    fechaConfirmacionReceptor: row.fecha_confirmacion_receptor
  };
}

function encargoToDb(patch) {
  const map = {
    causaId: 'causa_id',
    folio: 'folio', depto: 'depto', centroEncarga: 'centro_encarga',
    abogadoEncarga: 'abogado_encarga', fechaEncargo: 'fecha_encargo', materia: 'materia',
    patrocinadoNombre: 'patrocinado_nombre', patrocinadoSexo: 'patrocinado_sexo',
    contraparteNombre: 'contraparte_nombre', contraparteSexo: 'contraparte_sexo',
    tipoDiligencia: 'tipo_diligencia', urgencia: 'urgencia', estadoGestion: 'estado_gestion',
    direccion: 'direccion', comuna: 'comuna', tribunal: 'tribunal', rol: 'rol',
    jurisdiccion: 'jurisdiccion', observaciones: 'observaciones',
    fechaResolucion: 'fecha_resolucion',
    descripcionEncargo: 'descripcion_encargo',
    resultadoDiligencia: 'resultado_diligencia',
    fechaRealizacion: 'fecha_realizacion',
    receptorTurnoNombre: 'receptor_turno_nombre',
    telefonoReceptor: 'telefono_receptor',
    domicilioReceptor: 'domicilio_receptor',
    correoReceptor: 'correo_receptor',
    receptorSugeridoId: 'receptor_sugerido_id',
    receptorConfirmadoId: 'receptor_confirmado_id',
    turnoId: 'turno_id',
    fuenteTurno: 'fuente_turno',
    fechaConfirmacionReceptor: 'fecha_confirmacion_receptor'
  };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}

export async function fetchEncargos() {
  const { data, error } = await supabase.from('encargos_receptor').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(encargoFromDb);
}

export async function createEncargo(userId, patch) {
  const dbPatch = encargoToDb(patch);
  dbPatch.user_id = userId;
  const { data, error } = await supabase.from('encargos_receptor').insert(dbPatch).select().single();
  if (error) throw error;
  return encargoFromDb(data);
}

export async function updateEncargo(id, patch) {
  const { error } = await supabase.from('encargos_receptor').update(encargoToDb(patch)).eq('id', id);
  if (error) throw error;
}

export async function deleteEncargo(id) {
  const { error } = await supabase.from('encargos_receptor').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================================
// Agenda Jurídica (agenda_eventos)
// ============================================================================
function eventoFromDb(e) {
  return {
    id: e.id, causaId: e.causa_id, tipo: e.tipo, titulo: e.titulo, descripcion: e.descripcion,
    fecha: e.fecha, horaInicio: e.hora_inicio, horaTermino: e.hora_termino,
    modalidad: e.modalidad, ubicacion: e.ubicacion, enlace: e.enlace,
    estado: e.estado, prioridad: e.prioridad, observaciones: e.observaciones,
    creadoPor: e.creado_por, createdAt: e.created_at, updatedAt: e.updated_at,
    googleEventId: e.google_event_id, googleCalendarId: e.google_calendar_id,
    googleSyncStatus: e.google_sync_status, googleLastSyncAt: e.google_last_sync_at,
    googleSyncError: e.google_sync_error, recordatorios: e.recordatorios,
    organizationId: e.organization_id, moduleId: e.module_id
  };
}

function eventoPatchToDb(patch) {
  const map = {
    tipo: 'tipo', titulo: 'titulo', descripcion: 'descripcion', fecha: 'fecha',
    horaInicio: 'hora_inicio', horaTermino: 'hora_termino', modalidad: 'modalidad',
    ubicacion: 'ubicacion', enlace: 'enlace', estado: 'estado', prioridad: 'prioridad',
    observaciones: 'observaciones', creadoPor: 'creado_por',
    googleEventId: 'google_event_id', googleCalendarId: 'google_calendar_id',
    googleSyncStatus: 'google_sync_status', googleLastSyncAt: 'google_last_sync_at',
    googleSyncError: 'google_sync_error', recordatorios: 'recordatorios',
    organizationId: 'organization_id', moduleId: 'module_id'
  };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}

export async function createAgendaEvento(userId, causaId, patch) {
  const dbPatch = eventoPatchToDb(patch);
  dbPatch.user_id = userId;
  dbPatch.causa_id = causaId;
  const { data, error } = await supabase.from('agenda_eventos').insert(dbPatch).select().single();
  if (error) throw error;
  return eventoFromDb(data);
}

export async function updateAgendaEvento(id, patch) {
  const { data, error } = await supabase.from('agenda_eventos').update(eventoPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return eventoFromDb(data);
}

export async function deleteAgendaEvento(id) {
  const { error } = await supabase.from('agenda_eventos').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================================
// Instrucciones del tutor (historial — antecedente, no determina prioridad)
// ============================================================================
function instruccionFromDb(it) {
  return { id: it.id, tutor: it.tutor, fecha: it.fecha, instruccion: it.instruccion, fechaLimite: it.fecha_limite, estado: it.estado };
}

function instruccionPatchToDb(patch) {
  const map = { tutor: 'tutor', fecha: 'fecha', instruccion: 'instruccion', fechaLimite: 'fecha_limite', estado: 'estado' };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}

export async function createInstruccion(userId, causaId, patch) {
  const dbPatch = instruccionPatchToDb(patch);
  dbPatch.user_id = userId;
  dbPatch.causa_id = causaId;
  if (!dbPatch.estado) dbPatch.estado = 'Pendiente';
  if (!dbPatch.fecha) dbPatch.fecha = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from('instrucciones_tutor').insert(dbPatch).select().single();
  if (error) throw error;
  return instruccionFromDb(data);
}

export async function updateInstruccion(id, patch) {
  const { data, error } = await supabase.from('instrucciones_tutor').update(instruccionPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return instruccionFromDb(data);
}

export async function deleteInstruccion(id) {
  const { error } = await supabase.from('instrucciones_tutor').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================================
// Administración de receptores: catálogo de receptores y turnos
// ============================================================================
function receptorFromDb(r) {
  return {
    id: r.id, nombreCompleto: r.nombre_completo, telefono: r.telefono, correo: r.correo,
    correoAlternativo: r.correo_alternativo, telefono2: r.telefono_2, telefono3: r.telefono_3,
    corte: r.corte, tribunal: r.tribunal,
    domicilio: r.domicilio, jurisdiccion: r.jurisdiccion, materia: r.materia,
    activo: r.activo, observaciones: r.observaciones, fuenteOficial: r.fuente_oficial,
    fechaActualizacion: r.fecha_actualizacion
  };
}

function receptorPatchToDb(patch) {
  const map = {
    nombreCompleto: 'nombre_completo', telefono: 'telefono', correo: 'correo',
    correoAlternativo: 'correo_alternativo', telefono2: 'telefono_2', telefono3: 'telefono_3',
    corte: 'corte', tribunal: 'tribunal',
    domicilio: 'domicilio', jurisdiccion: 'jurisdiccion', materia: 'materia',
    activo: 'activo', observaciones: 'observaciones', fuenteOficial: 'fuente_oficial',
    fechaActualizacion: 'fecha_actualizacion'
  };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}

export async function fetchReceptores() {
  const { data, error } = await supabase.from('receptores_judiciales').select('*').order('nombre_completo', { ascending: true });
  if (error) throw error;
  return (data || []).map(receptorFromDb);
}

export async function createReceptor(userId, patch) {
  const dbPatch = receptorPatchToDb(patch);
  dbPatch.user_id = userId;
  const { data, error } = await supabase.from('receptores_judiciales').insert(dbPatch).select().single();
  if (error) throw error;
  return receptorFromDb(data);
}

export async function updateReceptor(id, patch) {
  const { data, error } = await supabase.from('receptores_judiciales').update(receptorPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return receptorFromDb(data);
}

export async function deleteReceptor(id) {
  const { error } = await supabase.from('receptores_judiciales').delete().eq('id', id);
  if (error) throw error;
}

function turnoFromDb(t) {
  return {
    id: t.id, receptorId: t.receptor_id, fechaInicio: t.fecha_inicio, fechaFin: t.fecha_fin,
    jurisdiccion: t.jurisdiccion, materia: t.materia, region: t.region,
    fuenteOficial: t.fuente_oficial, archivoNombre: t.archivo_nombre, enlaceOrigen: t.enlace_origen,
    fechaImportacion: t.fecha_importacion, observaciones: t.observaciones,
    ambitoTurno: t.ambito_turno, tribunalTurno: t.tribunal_turno, correoPdf: t.correo_pdf,
    receptor: t.receptores_judiciales ? receptorFromDb(t.receptores_judiciales) : null
  };
}

function turnoPatchToDb(patch) {
  const map = {
    receptorId: 'receptor_id', fechaInicio: 'fecha_inicio', fechaFin: 'fecha_fin',
    jurisdiccion: 'jurisdiccion', materia: 'materia', region: 'region',
    fuenteOficial: 'fuente_oficial', archivoNombre: 'archivo_nombre', enlaceOrigen: 'enlace_origen',
    observaciones: 'observaciones',
    ambitoTurno: 'ambito_turno', tribunalTurno: 'tribunal_turno', correoPdf: 'correo_pdf'
  };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}

export async function fetchTurnos() {
  const { data, error } = await supabase
    .from('turnos_receptores')
    .select('*, receptores_judiciales(*)')
    .order('fecha_inicio', { ascending: false });
  if (error) throw error;
  return (data || []).map(turnoFromDb);
}

export async function createTurno(userId, patch) {
  const dbPatch = turnoPatchToDb(patch);
  dbPatch.user_id = userId;
  const { data, error } = await supabase.from('turnos_receptores').insert(dbPatch).select('*, receptores_judiciales(*)').single();
  if (error) throw error;
  return turnoFromDb(data);
}

export async function updateTurno(id, patch) {
  const { data, error } = await supabase.from('turnos_receptores').update(turnoPatchToDb(patch)).eq('id', id).select('*, receptores_judiciales(*)').single();
  if (error) throw error;
  return turnoFromDb(data);
}

export async function deleteTurno(id) {
  const { error } = await supabase.from('turnos_receptores').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================================
// Programación de salas: historial de revisiones (revisiones_sala)
// ============================================================================
function revisionSalaFromDb(r) {
  return {
    id: r.id, causaId: r.causa_id, fecha: r.fecha, hora: r.hora,
    resultado: r.resultado, observacion: r.observacion,
    fechaAlegato: r.fecha_alegato, sala: r.sala, numeroTabla: r.numero_tabla,
    createdAt: r.created_at
  };
}

function revisionSalaPatchToDb(patch) {
  const map = {
    fecha: 'fecha', hora: 'hora', resultado: 'resultado', observacion: 'observacion',
    fechaAlegato: 'fecha_alegato', sala: 'sala', numeroTabla: 'numero_tabla'
  };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}

export async function fetchRevisionesSala() {
  const { data, error } = await supabase
    .from('revisiones_sala')
    .select('*')
    .order('fecha', { ascending: false });
  if (error) throw error;
  return (data || []).map(revisionSalaFromDb);
}

export async function createRevisionSala(userId, causaId, patch) {
  const dbPatch = revisionSalaPatchToDb(patch);
  dbPatch.user_id = userId;
  dbPatch.causa_id = causaId;
  const { data, error } = await supabase.from('revisiones_sala').insert(dbPatch).select().single();
  if (error) throw error;
  return revisionSalaFromDb(data);
}

export async function updateRevisionSala(id, patch) {
  const { data, error } = await supabase.from('revisiones_sala').update(revisionSalaPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return revisionSalaFromDb(data);
}

export async function deleteRevisionSala(id) {
  const { error } = await supabase.from('revisiones_sala').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================================
// Integración con Google Calendar — llamadas al backend (api/google/*).
// El frontend nunca habla directo con Google ni ve tokens: todo pasa por
// estas funciones, que envían el token de sesión de Supabase en el header
// Authorization para que el backend verifique la identidad.
// ============================================================================
async function googleApiFetch(ruta, opciones = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error('Sesión no disponible. Vuelve a iniciar sesión.');

  const resp = await fetch(`/api/google/${ruta}`, {
    method: opciones.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined
  });

  let data = null;
  try { data = await resp.json(); } catch (_) { /* respuesta sin cuerpo JSON */ }

  if (!resp.ok) {
    throw new Error((data && data.error) || `Error del servidor (${resp.status})`);
  }
  return data;
}

export async function googleGetAuthUrl() {
  return googleApiFetch('auth-url');
}

export async function googleGetStatus() {
  return googleApiFetch('status');
}

export async function googleListCalendars() {
  return googleApiFetch('list-calendars');
}

export async function googleSelectCalendar(patch) {
  return googleApiFetch('select-calendar', { method: 'POST', body: patch });
}

export async function googleDisconnect() {
  return googleApiFetch('disconnect', { method: 'POST' });
}

export async function googleSavePreferences(patch) {
  return googleApiFetch('preferences', { method: 'POST', body: patch });
}

export async function googleSyncEvent(agendaEventoId) {
  return googleApiFetch('sync-event', { method: 'POST', body: { agendaEventoId } });
}

export async function googleDeleteEvent(googleEventId, googleCalendarId) {
  return googleApiFetch('delete-event', { method: 'POST', body: { googleEventId, googleCalendarId } });
}

export async function googlePendingCount() {
  return googleApiFetch('pending-count');
}

export async function googleSyncBatch(patch) {
  return googleApiFetch('sync-pending', { method: 'POST', body: patch });
}

// ============================================================================
// Plataforma modular — accesos a organización/módulo (Fase 1).
// Solo consulta lo que la propia usuaria tiene autorizado (RLS ya lo
// garantiza a nivel de base, pero igual filtramos explícitamente por su
// propio user_id: si esta cuenta fuera además Organization/Platform Admin,
// las políticas le permitirían ver filas de otras personas, y aquí solo
// queremos "a qué organización/módulo puedo entrar yo").
// ============================================================================
export async function fetchMisAccesos(userId) {
  const { data, error } = await supabase
    .from('user_modules')
    .select('organization_id, module_id, role, organizations(nombre, slug), modules(nombre)')
    .eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(r => ({
    organizationId: r.organization_id,
    organizationNombre: r.organizations?.nombre || r.organization_id,
    organizationSlug: r.organizations?.slug || null,
    moduleId: r.module_id,
    moduleNombre: r.modules?.nombre || r.module_id,
    role: r.role
  }));
}
