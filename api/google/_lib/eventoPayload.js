// Réplica server-side, simplificada pero equivalente, de la misma lógica de
// caratulado/tribunal que usa el frontend (src/app.js). Vive por separado
// porque el backend corre en un runtime distinto (Vercel Functions) y no
// puede importar directamente el bundle del frontend.

const TRIBUNAL_SIN_NUMERO = ['Corte Suprema'];

function tribunalTexto(c) {
  if (!c) return '';
  if (c.tipo_tribunal) {
    const necesitaNumero = !TRIBUNAL_SIN_NUMERO.includes(c.tipo_tribunal);
    const numero = necesitaNumero && c.numero_tribunal ? `${c.numero_tribunal}° ` : '';
    const ciudad = c.ciudad_tribunal ? ` de ${c.ciudad_tribunal}` : '';
    return `${numero}${c.tipo_tribunal}${ciudad}`.trim();
  }
  return c.tribunal || '';
}

const INSTITUCION_KEYWORDS = [
  'municipalidad', 'banco', 'servicio', 'sociedad', 'spa', 'ltda', 's.a.', 'sa',
  'inmobiliaria', 'empresa', 'compañía', 'compania', 'cooperativa', 'fisco',
  'ministerio', 'universidad', 'corporación', 'corporacion', 'fundación', 'fundacion',
  'isapre', 'afp', 'clínica', 'clinica', 'hospital', 'tesorería', 'tesoreria',
  'caja', 'notaría', 'notaria', 'inversiones', 'constructora', 'comercial'
];

function nombreCorto(nombreCompleto) {
  if (!nombreCompleto) return null;
  const nombre = String(nombreCompleto).trim();
  const low = nombre.toLowerCase();
  if (INSTITUCION_KEYWORDS.some(kw => low.includes(kw))) return nombre;
  const partes = nombre.split(/\s+/).filter(Boolean);
  if (partes.length <= 1) return nombre;
  if (partes.length === 2) return partes[1];
  return partes[partes.length - 2];
}

function caratuladoTexto(c) {
  if (c.demandante_nombre || c.demandado_nombre) {
    const dte = nombreCorto(c.demandante_nombre);
    const ddo = nombreCorto(c.demandado_nombre);
    if (dte && ddo) return `${dte} / ${ddo}`;
    if (dte) return dte;
    if (ddo) return ddo;
  }
  const p1 = nombreCorto(c.patrocinado);
  const p2 = nombreCorto(c.contraparte_nombre);
  if (p1 && p2) return `${p1} / ${p2}`;
  return p1 || p2 || null;
}

// "TIPO — ROL — CARATULADO", omitiendo lo que no exista.
export function construirTitulo(evento, causa) {
  const tipo = String(evento.tipo || 'Evento').toUpperCase();
  const partes = [tipo];
  if (causa?.rol) partes.push(causa.rol);
  const caratulado = causa ? caratuladoTexto(causa) : null;
  if (caratulado) partes.push(caratulado);
  else if (causa?.titulo) partes.push(causa.titulo);
  return partes.join(' — ');
}

export function construirDescripcion(evento, causa) {
  const lineas = [];
  if (causa?.rol) lineas.push(`ROL: ${causa.rol}`);
  if (causa?.rol_ingreso) lineas.push(`ROL ingreso Corte: ${causa.rol_ingreso}`);
  const caratulado = causa ? caratuladoTexto(causa) : null;
  if (caratulado) lineas.push(`Caratulado: ${caratulado}`);
  const tribunal = causa ? tribunalTexto(causa) : '';
  if (tribunal) lineas.push(`Tribunal: ${tribunal}`);
  if (causa?.materia) lineas.push(`Materia: ${causa.materia}`);
  lineas.push(`Tipo de evento: ${evento.tipo}`);
  if (evento.modalidad) lineas.push(`Modalidad: ${evento.modalidad}`);
  if (evento.descripcion) lineas.push('', evento.descripcion);
  if (evento.observaciones) lineas.push('', `Observaciones: ${evento.observaciones}`);
  return lineas.join('\n');
}

export function construirUbicacion(evento, causa) {
  if (evento.ubicacion) return evento.ubicacion;
  if (evento.modalidad && /presencial/i.test(evento.modalidad) && causa) {
    return tribunalTexto(causa) || null;
  }
  return null;
}

const RECORDATORIOS_DEFAULT = [{ minutos: 1440 }, { minutos: 60 }];

// Recordatorios efectivos para un evento: los propios del evento si existen,
// si no los definidos por tipo, si no los generales de la conexión, si no
// un valor razonable por defecto (1 día antes + 1 hora antes).
export function resolverRecordatorios(evento, conexion) {
  if (Array.isArray(evento.recordatorios) && evento.recordatorios.length) return evento.recordatorios;
  if (conexion?.recordatorios_por_tipo && conexion.recordatorios_por_tipo[evento.tipo]) {
    return conexion.recordatorios_por_tipo[evento.tipo];
  }
  if (Array.isArray(conexion?.recordatorios_default) && conexion.recordatorios_default.length) {
    return conexion.recordatorios_default;
  }
  return RECORDATORIOS_DEFAULT;
}

// Construye el cuerpo del evento para la API de Google Calendar. Si el
// evento tiene hora de inicio, crea un evento con horario (America/Santiago);
// si no, un evento de día completo (nunca se inventa una hora arbitraria).
export function construirEventoGoogle(evento, causa, conexion) {
  const zonaHoraria = 'America/Santiago';
  const recordatorios = resolverRecordatorios(evento, conexion);
  const overrides = recordatorios.map(r => ({ method: 'popup', minutes: Math.round(r.minutos) }));

  const body = {
    summary: construirTitulo(evento, causa),
    description: construirDescripcion(evento, causa),
    reminders: { useDefault: false, overrides },
    status: evento.estado === 'Cancelado' ? 'cancelled' : 'confirmed'
  };

  const ubicacion = construirUbicacion(evento, causa);
  if (ubicacion) body.location = ubicacion;

  if (evento.hora_inicio) {
    const fechaHoraInicio = `${evento.fecha}T${normalizarHora(evento.hora_inicio)}:00`;
    const horaFin = evento.hora_termino || sumarUnaHora(evento.hora_inicio);
    const fechaHoraFin = `${evento.fecha}T${normalizarHora(horaFin)}:00`;
    body.start = { dateTime: fechaHoraInicio, timeZone: zonaHoraria };
    body.end = { dateTime: fechaHoraFin, timeZone: zonaHoraria };
  } else {
    // Evento de día completo: "end" en Google es exclusivo (día siguiente).
    body.start = { date: evento.fecha };
    body.end = { date: sumarUnDia(evento.fecha) };
  }

  return body;
}

function normalizarHora(hora) {
  const m = String(hora).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '09:00';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function sumarUnaHora(hora) {
  const m = String(hora).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '10:00';
  let h = (parseInt(m[1], 10) + 1) % 24;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function sumarUnDia(fechaISO) {
  const d = new Date(`${fechaISO}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
