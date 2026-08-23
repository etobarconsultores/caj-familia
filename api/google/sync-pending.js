import { obtenerUsuarioDesdeRequest, requerirMetodo } from './_lib/supabaseAdmin.js';
import { obtenerClienteAutenticado, calendarClient } from './_lib/googleClient.js';
import { construirEventoGoogle } from './_lib/eventoPayload.js';

// modo:
//  - "reintentar-pendientes": procesa los eventos del usuario con
//    google_sync_status en ('pending','error').
//  - "sincronizar-existentes": procesa eventos ya existentes que nunca se
//    han sincronizado (google_sync_status es null), según rango
//    ('futuros' | 'todos') o una lista explícita de ids (selección manual).
//    Nunca se ejecuta automáticamente: la usuaria siempre confirma antes.
export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { modo, rango, eventIds } = req.body || {};
    if (!['reintentar-pendientes', 'sincronizar-existentes'].includes(modo)) {
      return res.status(400).json({ error: 'modo inválido' });
    }

    const { oauth2Client, conexion, admin } = await obtenerClienteAutenticado(usuario.id);
    if (!conexion.calendar_id) {
      return res.status(400).json({ error: 'Todavía no seleccionaste un calendario en Integraciones.' });
    }

    let query = admin.from('agenda_eventos').select('*').eq('user_id', usuario.id);
    if (modo === 'reintentar-pendientes') {
      query = query.in('google_sync_status', ['pending', 'error']);
    } else {
      if (Array.isArray(eventIds) && eventIds.length) {
        query = query.in('id', eventIds);
      } else {
        query = query.is('google_sync_status', null);
        if (rango === 'futuros') query = query.gte('fecha', new Date().toISOString().slice(0, 10));
      }
    }

    const { data: eventos, error: errEventos } = await query;
    if (errEventos) throw errEventos;

    const resumen = { procesados: 0, sincronizados: 0, errores: 0, detalle: [] };
    if (!eventos || eventos.length === 0) {
      return res.status(200).json({ ...resumen, mensaje: 'No hay eventos para procesar.' });
    }

    const cal = calendarClient(oauth2Client);
    const causasCache = new Map();

    for (const evento of eventos) {
      resumen.procesados++;
      try {
        let causa = causasCache.get(evento.causa_id);
        if (causa === undefined) {
          const { data } = await admin.from('causas').select('*').eq('id', evento.causa_id).eq('user_id', usuario.id).maybeSingle();
          causa = data || null;
          causasCache.set(evento.causa_id, causa);
        }

        const body = construirEventoGoogle(evento, causa, conexion);
        let eventoGoogle;
        if (evento.google_event_id) {
          const resp = await cal.events.update({ calendarId: conexion.calendar_id, eventId: evento.google_event_id, requestBody: body });
          eventoGoogle = resp.data;
        } else {
          const resp = await cal.events.insert({ calendarId: conexion.calendar_id, requestBody: body });
          eventoGoogle = resp.data;
        }

        await admin.from('agenda_eventos').update({
          google_event_id: eventoGoogle.id, google_calendar_id: conexion.calendar_id,
          google_sync_status: 'synced', google_sync_error: null, google_last_sync_at: new Date().toISOString()
        }).eq('id', evento.id);
        await admin.from('calendar_sync_log').insert({
          user_id: usuario.id, agenda_evento_id: evento.id, accion: 'bulk_sync', resultado: 'success', mensaje: null
        });
        resumen.sincronizados++;
      } catch (eGoogle) {
        const mensaje = eGoogle?.errors?.[0]?.message || eGoogle.message || 'Error desconocido';
        await admin.from('agenda_eventos').update({
          google_sync_status: 'error', google_sync_error: mensaje, google_last_sync_at: new Date().toISOString()
        }).eq('id', evento.id);
        await admin.from('calendar_sync_log').insert({
          user_id: usuario.id, agenda_evento_id: evento.id, accion: 'bulk_sync', resultado: 'error', mensaje
        });
        resumen.errores++;
        resumen.detalle.push({ eventoId: evento.id, titulo: evento.titulo, error: mensaje });
      }
    }

    await admin.from('google_calendar_conexiones').update({ ultima_sincronizacion_at: new Date().toISOString() }).eq('user_id', usuario.id);

    res.status(200).json(resumen);
  } catch (e) {
    console.error('sync-pending error:', e);
    res.status(500).json({ error: e.message });
  }
}
