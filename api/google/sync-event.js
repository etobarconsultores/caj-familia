import { obtenerUsuarioDesdeRequest, requerirMetodo } from './_lib/supabaseAdmin.js';
import { obtenerClienteAutenticado, calendarClient } from './_lib/googleClient.js';
import { construirEventoGoogle } from './_lib/eventoPayload.js';

async function registrarLog(admin, userId, agendaEventoId, accion, resultado, mensaje) {
  try {
    const { error } = await admin.from('calendar_sync_log').insert({
      user_id: userId, agenda_evento_id: agendaEventoId, accion, resultado, mensaje: mensaje || null
    });
    if (error) console.warn('No se pudo registrar el log de sincronización:', error.message);
  } catch (e) {
    console.warn('No se pudo registrar el log de sincronización:', e.message);
  }
}

function detalleError(e) {
  if (!e) return 'Error desconocido';
  const partes = [
    e.message,
    e.code ? `código ${e.code}` : null,
    e.details ? `detalle ${e.details}` : null,
    e.hint ? `hint ${e.hint}` : null
  ].filter(Boolean);
  return partes.length ? partes.join(' · ') : String(e);
}

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;

  let etapa = 'inicio';
  try {
    etapa = 'autenticación Supabase';
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { agendaEventoId } = req.body || {};
    if (!agendaEventoId) return res.status(400).json({ error: 'Falta agendaEventoId' });

    etapa = 'conexión Google';
    const { oauth2Client, conexion, admin } = await obtenerClienteAutenticado(usuario.id);
    if (!conexion.calendar_id) {
      return res.status(400).json({ error: 'Todavía no seleccionaste un calendario en Integraciones.' });
    }

    etapa = 'lectura evento Agenda';
    const { data: evento, error: errEvento } = await admin
      .from('agenda_eventos')
      .select('*')
      .eq('id', agendaEventoId)
      .eq('user_id', usuario.id)
      .maybeSingle();
    if (errEvento) throw errEvento;
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado.' });

    etapa = 'lectura causa';
    const { data: causa, error: errCausa } = await admin
      .from('causas')
      .select('*')
      .eq('id', evento.causa_id)
      .eq('user_id', usuario.id)
      .maybeSingle();
    if (errCausa) throw errCausa;

    etapa = 'construcción evento Google';
    const cal = calendarClient(oauth2Client);
    const body = construirEventoGoogle(evento, causa, conexion);
    const accion = evento.google_event_id ? 'update' : 'create';

    etapa = 'envío a Google Calendar';
    let eventoGoogle;
    try {
      if (evento.google_event_id) {
        const resp = await cal.events.update({
          calendarId: conexion.calendar_id,
          eventId: evento.google_event_id,
          requestBody: body
        });
        eventoGoogle = resp.data;
      } else {
        const resp = await cal.events.insert({
          calendarId: conexion.calendar_id,
          requestBody: body
        });
        eventoGoogle = resp.data;
      }
    } catch (eGoogle) {
      const mensaje = eGoogle?.errors?.[0]?.message || eGoogle.message || 'Error desconocido de Google Calendar';
      const ahoraError = new Date().toISOString();
      const { error: errMarca } = await admin.from('agenda_eventos').update({
        google_sync_status: 'error',
        google_sync_error: mensaje,
        google_last_sync_at: ahoraError
      }).eq('id', agendaEventoId);
      if (errMarca) console.warn('No se pudo marcar el error de sincronización:', errMarca.message);
      await registrarLog(admin, usuario.id, agendaEventoId, accion, 'error', mensaje);
      return res.status(502).json({
        error: `No se pudo sincronizar con Google Calendar: ${mensaje}. El evento permanece guardado en la Agenda.`
      });
    }

    etapa = 'guardado resultado sincronización';
    const ahora = new Date().toISOString();
    const { error: errUpdateEvento } = await admin.from('agenda_eventos').update({
      google_event_id: eventoGoogle.id,
      google_calendar_id: conexion.calendar_id,
      google_sync_status: 'synced',
      google_sync_error: null,
      google_last_sync_at: ahora
    }).eq('id', agendaEventoId);
    if (errUpdateEvento) throw errUpdateEvento;

    const { error: errUpdateConexion } = await admin
      .from('google_calendar_conexiones')
      .update({ ultima_sincronizacion_at: ahora })
      .eq('user_id', usuario.id);
    if (errUpdateConexion) throw errUpdateConexion;

    await registrarLog(admin, usuario.id, agendaEventoId, accion, 'success', null);

    res.status(200).json({ ok: true, googleEventId: eventoGoogle.id, syncStatus: 'synced' });
  } catch (e) {
    const detalle = detalleError(e);
    console.error(`sync-event error [${etapa}]: ${detalle}`, e);
    res.status(500).json({ error: `Error en ${etapa}: ${detalle}` });
  }
}
