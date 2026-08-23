import { obtenerUsuarioDesdeRequest, requerirMetodo } from './_lib/supabaseAdmin.js';
import { obtenerClienteAutenticado, calendarClient } from './_lib/googleClient.js';
import { construirEventoGoogle } from './_lib/eventoPayload.js';

async function registrarLog(admin, userId, agendaEventoId, accion, resultado, mensaje) {
  try {
    await admin.from('calendar_sync_log').insert({
      user_id: userId, agenda_evento_id: agendaEventoId, accion, resultado, mensaje: mensaje || null
    });
  } catch (e) {
    console.warn('No se pudo registrar el log de sincronización:', e.message);
  }
}

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { agendaEventoId } = req.body || {};
    if (!agendaEventoId) return res.status(400).json({ error: 'Falta agendaEventoId' });

    const { oauth2Client, conexion, admin } = await obtenerClienteAutenticado(usuario.id);
    if (!conexion.calendar_id) {
      return res.status(400).json({ error: 'Todavía no seleccionaste un calendario en Integraciones.' });
    }

    const { data: evento, error: errEvento } = await admin
      .from('agenda_eventos').select('*').eq('id', agendaEventoId).eq('user_id', usuario.id).maybeSingle();
    if (errEvento) throw errEvento;
    if (!evento) return res.status(404).json({ error: 'Evento no encontrado.' });

    const { data: causa } = await admin
      .from('causas').select('*').eq('id', evento.causa_id).eq('user_id', usuario.id).maybeSingle();

    const cal = calendarClient(oauth2Client);
    const body = construirEventoGoogle(evento, causa, conexion);
    const accion = evento.google_event_id ? 'update' : 'create';

    let eventoGoogle;
    try {
      if (evento.google_event_id) {
        const resp = await cal.events.update({
          calendarId: conexion.calendar_id, eventId: evento.google_event_id, requestBody: body
        });
        eventoGoogle = resp.data;
      } else {
        const resp = await cal.events.insert({ calendarId: conexion.calendar_id, requestBody: body });
        eventoGoogle = resp.data;
      }
    } catch (eGoogle) {
      // No se pierde el evento de la Agenda: solo se marca el error.
      const mensaje = eGoogle?.errors?.[0]?.message || eGoogle.message || 'Error desconocido de Google Calendar';
      await admin.from('agenda_eventos').update({
        google_sync_status: 'error', google_sync_error: mensaje, google_last_sync_at: new Date().toISOString()
      }).eq('id', agendaEventoId);
      await registrarLog(admin, usuario.id, agendaEventoId, accion, 'error', mensaje);
      return res.status(502).json({ error: `No se pudo sincronizar con Google Calendar: ${mensaje}. El evento permanece guardado en la Agenda.` });
    }

    const ahora = new Date().toISOString();
    await admin.from('agenda_eventos').update({
      google_event_id: eventoGoogle.id,
      google_calendar_id: conexion.calendar_id,
      google_sync_status: 'synced',
      google_sync_error: null,
      google_last_sync_at: ahora
    }).eq('id', agendaEventoId);
    await admin.from('google_calendar_conexiones').update({ ultima_sincronizacion_at: ahora }).eq('user_id', usuario.id);
    await registrarLog(admin, usuario.id, agendaEventoId, accion, 'success', null);

    res.status(200).json({ ok: true, googleEventId: eventoGoogle.id, syncStatus: 'synced' });
  } catch (e) {
    console.error('sync-event error:', e);
    res.status(500).json({ error: e.message });
  }
}
