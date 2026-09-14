import { supabase } from '../supabaseClient.js';

// Organización/módulo del build actual de Civil (Fase 1 — arquitectura
// modular). Se escriben EXPLÍCITAMENTE en cada evento nuevo de Agenda que
// crea este módulo, y se usan también para filtrar la lectura: no se
// depende de ningún valor por defecto de Supabase, para que un evento de
// Civil nunca pueda quedar mal clasificado ni mezclarse con otro módulo.
const CIVIL_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'; // CAJ · Área Civil
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
    tipoJuicio: row.tipo_juicio,
    patrocinadoTipo: row.patrocinado_tipo,
    rit: row.rit,
    competencia: row.competencia,
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
    telefonoAlt: row.telefono_alt,
    nota: row.nota,
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
      })),
    intervinientes: (row.intervinientes || [])
      .slice()
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
      .map(i => ({ id: i.id, tipoParte: i.tipo_parte, rut: i.rut, nombre: i.nombre, orden: i.orden })),
    notificacionPersonas: (row.notificacion_personas || [])
      .slice()
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
      .map(p => ({
        id: p.id, parte: p.parte, nombre: p.nombre, estadoNotificacion: p.estado_notificacion, orden: p.orden,
        domicilios: (p._domicilios || [])
          .slice()
          .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
          .map(d => ({
            id: d.id, domicilio: d.domicilio, estado: d.estado, fecha: d.fecha,
            folio: d.folio, informadoPor: d.informado_por, orden: d.orden
          }))
      })),
    oficiosPersonas: (row.oficios_personas || [])
      .slice()
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
      .map(p => ({
        id: p.id, parte: p.parte, nombre: p.nombre, orden: p.orden,
        instituciones: (p._instituciones || [])
          .slice()
          .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
          .map(i => ({
            id: i.id, institucion: i.institucion, tramitacion: i.tramitacion,
            respuesta: i.respuesta, fecha: i.fecha, folio: i.folio, orden: i.orden
          }))
      }))
  };
}

function causaPatchToDb(patch) {
  const map = {
    titulo: 'titulo', categoria: 'categoria', subcategoria: 'subcategoria',
    tipoJuicio: 'tipo_juicio', rit: 'rit', competencia: 'competencia',
    patrocinadoTipo: 'patrocinado_tipo',
    rol: 'rol', rolIngreso: 'rol_ingreso', folio: 'folio', tribunal: 'tribunal',
    materia: 'materia', submateria: 'submateria', parte: 'parte', representacion: 'representacion',
    recurso: 'recurso', rolCA: 'rol_ca', tutor: 'tutor',
    patrocinado: 'patrocinado', rut: 'rut', correo: 'correo', correoAlt: 'correo_alt',
    telefono: 'telefono', telefonoAlt: 'telefono_alt', nota: 'nota',
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
  'hitos', 'agenda_eventos', 'instrucciones_tutor', 'intervinientes',
  'notificacion_personas', 'oficios_personas'
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

async function fetchGrandchildRows(table, personaIds) {
  if (!personaIds.length) return [];
  try {
    const { data, error } = await supabase.from(table).select('*').in('persona_id', personaIds);
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

function agruparPorPersona(rows) {
  const map = new Map();
  rows.forEach(r => {
    const key = r.persona_id;
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

  // notificacion_domicilios y oficios_instituciones dependen únicamente de
  // persona_id (sin causa_id propio) — se cargan en un segundo paso, usando
  // los ids de las personas ya obtenidas, y se anidan dentro de cada una.
  const notifPersonasIds = resultados[CAUSA_CHILD_TABLES.indexOf('notificacion_personas')].map(p => p.id);
  const oficiosPersonasIds = resultados[CAUSA_CHILD_TABLES.indexOf('oficios_personas')].map(p => p.id);
  const [notifDomiciliosRaw, oficiosInstitucionesRaw] = await Promise.all([
    fetchGrandchildRows('notificacion_domicilios', notifPersonasIds),
    fetchGrandchildRows('oficios_instituciones', oficiosPersonasIds)
  ]);
  const domiciliosPorPersona = agruparPorPersona(notifDomiciliosRaw);
  const institucionesPorPersona = agruparPorPersona(oficiosInstitucionesRaw);

  return causasRaw.map(row => causaFromDb({
    ...row,
    gestiones_pendientes: porTabla.gestiones_pendientes.get(row.id) || [],
    cronologia: porTabla.cronologia.get(row.id) || [],
    domicilios_notificacion: porTabla.domicilios_notificacion.get(row.id) || [],
    hitos: porTabla.hitos.get(row.id) || [],
    agenda_eventos: porTabla.agenda_eventos.get(row.id) || [],
    instrucciones_tutor: porTabla.instrucciones_tutor.get(row.id) || [],
    intervinientes: porTabla.intervinientes.get(row.id) || [],
    notificacion_personas: (porTabla.notificacion_personas.get(row.id) || []).map(p => ({
      ...p, _domicilios: domiciliosPorPersona.get(p.id) || []
    })),
    oficios_personas: (porTabla.oficios_personas.get(row.id) || []).map(p => ({
      ...p, _instituciones: institucionesPorPersona.get(p.id) || []
    }))
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

function intervinientePatchToDb(patch) {
  const map = { tipoParte: 'tipo_parte', rut: 'rut', nombre: 'nombre', orden: 'orden' };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}

export async function createInterviniente(userId, causaId, patch) {
  const dbPatch = intervinientePatchToDb(patch);
  dbPatch.user_id = userId;
  dbPatch.causa_id = causaId;
  const { data, error } = await supabase.from('intervinientes').insert(dbPatch).select().single();
  if (error) throw error;
  return data;
}

export async function updateInterviniente(id, patch) {
  const { data, error } = await supabase.from('intervinientes').update(intervinientePatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteInterviniente(id) {
  const { error } = await supabase.from('intervinientes').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Cronología ----------
export async function addCronologia(userId, causaId, descripcion, driveLink, usuarioNombre, fechaActuacion) {
  const { data, error } = await supabase
    .from('cronologia')
    .insert({
      user_id: userId, causa_id: causaId, descripcion,
      drive_link: driveLink || null, usuario_nombre: usuarioNombre || null,
      fecha: fechaActuacion || new Date().toISOString()
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
  if (patch.fecha !== undefined) dbPatch.fecha = patch.fecha;
  const { error } = await supabase.from('cronologia').update(dbPatch).eq('id', id);
  if (error) throw error;
}

export async function deleteCronologia(id) {
  const { error } = await supabase.from('cronologia').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Domicilios de notificación ----------
// ---------- Notificación múltiple: personas + sus domicilios ----------
function notifPersonaPatchToDb(patch) {
  const map = { parte: 'parte', nombre: 'nombre', estadoNotificacion: 'estado_notificacion', orden: 'orden' };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}
export async function createNotificacionPersona(userId, causaId, patch) {
  const dbPatch = notifPersonaPatchToDb(patch);
  dbPatch.user_id = userId;
  dbPatch.causa_id = causaId;
  const { data, error } = await supabase.from('notificacion_personas').insert(dbPatch).select().single();
  if (error) throw error;
  return data;
}
export async function updateNotificacionPersona(id, patch) {
  const { data, error } = await supabase.from('notificacion_personas').update(notifPersonaPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteNotificacionPersona(id) {
  const { error } = await supabase.from('notificacion_personas').delete().eq('id', id);
  if (error) throw error;
}

function notifDomicilioPatchToDb(patch) {
  const map = { domicilio: 'domicilio', estado: 'estado', fecha: 'fecha', folio: 'folio', informadoPor: 'informado_por', orden: 'orden' };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}
export async function createNotificacionDomicilio(personaId, patch) {
  const dbPatch = notifDomicilioPatchToDb(patch);
  dbPatch.persona_id = personaId;
  const { data, error } = await supabase.from('notificacion_domicilios').insert(dbPatch).select().single();
  if (error) throw error;
  return data;
}
export async function updateNotificacionDomicilio(id, patch) {
  const { data, error } = await supabase.from('notificacion_domicilios').update(notifDomicilioPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteNotificacionDomicilio(id) {
  const { error } = await supabase.from('notificacion_domicilios').delete().eq('id', id);
  if (error) throw error;
}

// ---------- Oficios: personas + instituciones oficiadas ----------
function oficioPersonaPatchToDb(patch) {
  const map = { parte: 'parte', nombre: 'nombre', orden: 'orden' };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}
export async function createOficioPersona(userId, causaId, patch) {
  const dbPatch = oficioPersonaPatchToDb(patch);
  dbPatch.user_id = userId;
  dbPatch.causa_id = causaId;
  const { data, error } = await supabase.from('oficios_personas').insert(dbPatch).select().single();
  if (error) throw error;
  return data;
}
export async function updateOficioPersona(id, patch) {
  const { data, error } = await supabase.from('oficios_personas').update(oficioPersonaPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteOficioPersona(id) {
  const { error } = await supabase.from('oficios_personas').delete().eq('id', id);
  if (error) throw error;
}

function oficioInstitucionPatchToDb(patch) {
  const map = { institucion: 'institucion', tramitacion: 'tramitacion', respuesta: 'respuesta', fecha: 'fecha', folio: 'folio', orden: 'orden' };
  const out = {};
  Object.entries(patch).forEach(([k, v]) => { if (map[k]) out[map[k]] = v === undefined ? null : v; });
  return out;
}
export async function createOficioInstitucion(personaId, patch) {
  const dbPatch = oficioInstitucionPatchToDb(patch);
  dbPatch.persona_id = personaId;
  const { data, error } = await supabase.from('oficios_instituciones').insert(dbPatch).select().single();
  if (error) throw error;
  return data;
}
export async function updateOficioInstitucion(id, patch) {
  const { data, error } = await supabase.from('oficios_instituciones').update(oficioInstitucionPatchToDb(patch)).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteOficioInstitucion(id) {
  const { error } = await supabase.from('oficios_instituciones').delete().eq('id', id);
  if (error) throw error;
}

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
    tipoAudiencia: e.tipo_audiencia,
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
    tipoAudiencia: 'tipo_audiencia',
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

// ============================================================================
// Seguridad — llamadas al backend consolidado (api/security.js). Mismo
// patrón que googleApiFetch: el frontend nunca ve la clave maestra de
// cifrado ni el hash del PIN, todo pasa por este único endpoint con el
// token de sesión de Supabase en el header Authorization.
// ============================================================================
async function securityApiFetch(operation, body = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error('Sesión no disponible. Vuelve a iniciar sesión.');

  const resp = await fetch('/api/security', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ operation, ...body })
  });

  let data = null;
  try { data = await resp.json(); } catch (_) { /* respuesta sin cuerpo JSON */ }

  if (!resp.ok) {
    throw new Error((data && data.error) || `Error del servidor (${resp.status})`);
  }
  return data;
}

export async function credentialsSave(causaId, campo, valor, eliminar = false) {
  return securityApiFetch('credentials.save', { causaId, campo, valor, eliminar });
}

export async function credentialsReveal(causaId, campo, pin) {
  return securityApiFetch('credentials.reveal', { causaId, campo, pin });
}

export async function credentialsStatus(causaId) {
  return securityApiFetch('credentials.status', { causaId });
}

export async function pinCreate(pin, pinConfirm) {
  return securityApiFetch('pin.create', { pin, pinConfirm });
}

export async function pinChange(currentPin, newPin, newPinConfirm) {
  return securityApiFetch('pin.change', { currentPin, newPin, newPinConfirm });
}

export async function pinReset(currentPassword, newPin, newPinConfirm) {
  return securityApiFetch('pin.reset', { currentPassword, newPin, newPinConfirm });
}

export async function pinStatus() {
  return securityApiFetch('pin.status');
}

export async function googleSyncBatch(patch) {
  return googleApiFetch('sync-pending', { method: 'POST', body: patch });
}

// ============================================================================
// Constancias legales vigentes.
// La lectura usa el cliente normal y queda limitada por RLS a la propia
// usuaria. La escritura NO se abre mediante INSERT directo: para cuentas
// anteriores al flujo de registro se usa la RPC
// public.accept_current_legal_documents(), que toma el user_id desde
// auth.uid() en Supabase.
// ============================================================================
export async function fetchLegalAcceptances(userId, documentVersion = '1.0') {
  const { data, error } = await supabase
    .from('legal_acceptances')
    .select('document_type, document_version, action, source, accepted_at')
    .eq('user_id', userId)
    .eq('document_version', documentVersion);
  if (error) throw error;
  return data || [];
}

export async function acceptCurrentLegalDocuments() {
  const { data, error } = await supabase.rpc('accept_current_legal_documents');
  if (error) throw error;
  return data || [];
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

// Actualiza nombre y teléfono del propio perfil en una sola operación de
// update sobre public.profiles. Usa el cliente normal -- RLS ya permite a
// cada usuaria actualizar su propia fila (policy "profiles_update_own",
// auth.uid() = id; las policies de RLS operan a nivel de fila, no de
// columna, así que cubren telefono sin necesitar ninguna policy nueva),
// sin necesitar service_role ni ningún endpoint propio.
export async function updateProfileDatos(userId, { nombreCompleto, telefono, recoveryEmail, recoveryPhone } = {}) {
  const cambios = {};
  if (nombreCompleto !== undefined) cambios.nombre_completo = nombreCompleto;
  if (telefono !== undefined) cambios.telefono = telefono;
  if (recoveryEmail !== undefined) cambios.recovery_email = recoveryEmail;
  if (recoveryPhone !== undefined) cambios.recovery_phone = recoveryPhone;

  if (Object.keys(cambios).length === 0) return;

  const { error } = await supabase
    .from('profiles')
    .update(cambios)
    .eq('id', userId);
  if (error) throw error;
}

// ============================================================================
// Datos de práctica (CAJ asignado) -- requieren las tablas de
// sql/migration_v1_7_practica_y_avatar.sql, todavía NO ejecutada. Estas
// funciones son seguras de tener definidas (no se ejecutan solas), pero no
// deben llamarse desde la UI hasta activarlas -- ver PRACTICA_TABLAS_DISPONIBLES
// en src/app.js.
// ============================================================================

// Datos de práctica propios de cada usuaria. `caj_asignado`, dirección y fechas
// viven en practica_usuaria porque pueden variar entre usuarios. La relación
// histórica con `cajs` se conserva para filas antiguas, pero ya no condiciona
// la edición del perfil.
export async function fetchPracticaUsuaria(userId) {
  const { data, error } = await supabase
    .from('practica_usuaria')
    .select('id, caj_asignado, direccion_caj, fecha_inicio, fecha_termino, cajs(nombre)')
    .eq('user_id', userId)
    .order('fecha_inicio', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    cajAsignado: data.caj_asignado || data.cajs?.nombre || null,
    direccionCaj: data.direccion_caj || null,
    fechaInicio: data.fecha_inicio,
    fechaTermino: data.fecha_termino
  };
}

// Crea la primera práctica de una usuaria o actualiza la vigente. El CAJ se
// guarda como texto propio de la asignación para que cada cuenta pueda indicar
// libremente su centro (Lo Prado, Cerro Navia, Lo Espejo, etc.).
export async function savePracticaUsuaria(userId, { practicaId, cajAsignado, direccionCaj, fechaInicio, fechaTermino }) {
  const patch = {
    caj_asignado: cajAsignado,
    direccion_caj: direccionCaj || null,
    fecha_inicio: fechaInicio,
    fecha_termino: fechaTermino
  };

  let query;
  if (practicaId) {
    query = supabase
      .from('practica_usuaria')
      .update(patch)
      .eq('id', practicaId)
      .eq('user_id', userId)
      .select('id, caj_asignado, direccion_caj, fecha_inicio, fecha_termino')
      .single();
  } else {
    query = supabase
      .from('practica_usuaria')
      .insert({ user_id: userId, caj_id: null, ...patch })
      .select('id, caj_asignado, direccion_caj, fecha_inicio, fecha_termino')
      .single();
  }

  const { data, error } = await query;
  if (error) throw error;
  return {
    id: data.id,
    cajAsignado: data.caj_asignado || null,
    direccionCaj: data.direccion_caj || null,
    fechaInicio: data.fecha_inicio,
    fechaTermino: data.fecha_termino
  };
}


// ============================================================================
// Tutores de práctica -- catálogo personal por usuaria.
// Cada cuenta solo puede leer/escribir sus propios tutores mediante RLS.
// ============================================================================

function tutorPracticaFromDb(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    orden: row.orden ?? 0,
    activo: row.activo !== false,
    createdAt: row.created_at
  };
}

export async function fetchTutoresPractica(userId, { incluirInactivos = false } = {}) {
  let query = supabase
    .from('tutores_practica')
    .select('id, nombre, orden, activo, created_at')
    .eq('user_id', userId)
    .order('orden', { ascending: true })
    .order('created_at', { ascending: true });

  if (!incluirInactivos) query = query.eq('activo', true);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(tutorPracticaFromDb);
}

export async function createTutorPractica(userId, { nombre, orden = 0, activo = true }) {
  const { data, error } = await supabase
    .from('tutores_practica')
    .insert({ user_id: userId, nombre, orden, activo })
    .select('id, nombre, orden, activo, created_at')
    .single();
  if (error) throw error;
  return tutorPracticaFromDb(data);
}

export async function updateTutorPractica(id, { nombre, orden, activo } = {}) {
  const patch = {};
  if (nombre !== undefined) patch.nombre = nombre;
  if (orden !== undefined) patch.orden = orden;
  if (activo !== undefined) patch.activo = activo;

  if (Object.keys(patch).length === 0) return null;

  const { data, error } = await supabase
    .from('tutores_practica')
    .update(patch)
    .eq('id', id)
    .select('id, nombre, orden, activo, created_at')
    .single();
  if (error) throw error;
  return tutorPracticaFromDb(data);
}

export async function deleteTutorPractica(id) {
  const { error } = await supabase
    .from('tutores_practica')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ============================================================================
// Foto de perfil -- requiere el bucket de Storage de
// sql/migration_v1_7_practica_y_avatar.sql (documentado, NO creado
// todavía) y la columna profiles.avatar_url (SQL preparado, NO ejecutado).
// No debe llamarse desde la UI hasta activarlas -- ver
// AVATAR_STORAGE_DISPONIBLE en src/app.js.
// ============================================================================

// Sube (o reemplaza) la foto de perfil de la propia usuaria. La ruta se basa
// en el propio user_id, consistente con las policies de Storage propuestas
// (cada usuaria solo puede escribir dentro de su propia carpeta). Devuelve
// la URL pública del archivo recién subido.
// Sube (o reemplaza, con upsert:true) la foto de perfil de la propia
// usuaria. Devuelve la RUTA dentro del bucket -- NUNCA una URL pública, ya
// que el bucket recomendado es privado. La ruta es lo que se persiste en
// profiles.avatar_url; la URL para mostrarla se resuelve aparte y bajo
// demanda con getAvatarSignedUrl(), porque una URL firmada expira y no
// debe guardarse como si fuera permanente.
export async function uploadAvatar(userId, file) {
  const extension = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const ruta = `${userId}/avatar.${extension}`;
  const { error: errorSubida } = await supabase.storage
    .from('avatars')
    .upload(ruta, file, { upsert: true, contentType: file.type });
  if (errorSubida) throw errorSubida;
  return ruta;
}

// Resuelve una URL firmada temporal para mostrar el avatar (bucket
// privado). expiresInSeconds por defecto: 1 hora -- suficiente para una
// sesión de trabajo típica; si la sesión dura más, la imagen puede dejar
// de cargar hasta la próxima vez que se resuelva (ver nota de
// limitaciones entregada junto con esta corrección).
export async function getAvatarSignedUrl(ruta, expiresInSeconds = 3600) {
  const { data, error } = await supabase.storage
    .from('avatars')
    .createSignedUrl(ruta, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

// Guarda la RUTA del avatar (no una URL) en profiles.avatar_url -- el
// nombre de la función coincide con el de la columna que escribe.
export async function updateProfileAvatarUrl(userId, avatarPath) {
  const { error } = await supabase
    .from('profiles')
    .update({ avatar_url: avatarPath })
    .eq('id', userId);
  if (error) throw error;
}

// ============================================================================
// Cierre de cuenta con retención de 30 días.
// La lectura del estado usa el cliente normal -- RLS
// (account_deletion_requests_select_own) ya limita esto a la propia
// usuaria, sin necesitar pasar por el backend. La solicitud y la
// reactivación sí pasan por api/security.js (reutilizando el mismo
// securityApiFetch ya usado para PIN/credenciales) porque requieren
// service_role: fijar scheduled_deletion_at de forma confiable e invalidar
// sesiones no puede resolverlo el cliente por sí solo.
// ============================================================================
export async function fetchAccountDeletionStatus(userId) {
  const { data, error } = await supabase
    .from('account_deletion_requests')
    .select('requested_at, scheduled_deletion_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function requestAccountClosure(currentPassword) {
  return securityApiFetch('account.requestClosure', { currentPassword });
}

export async function reactivateAccount() {
  return securityApiFetch('account.reactivate');
}

