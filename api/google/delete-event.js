import { obtenerUsuarioDesdeRequest, requerirMetodo } from './_lib/supabaseAdmin.js';
import { obtenerClienteAutenticado, calendarClient } from './_lib/googleClient.js';

// Se llama ANTES de eliminar el evento de agenda_eventos en el frontend
// (el frontend hace: 1. este endpoint, 2. api.deleteAgendaEvento local).
// Si Google falla, se informa el error explícitamente en vez de fallar en
// silencio, para que la usuaria decida si de todas formas quiere eliminarlo
// localmente (evento huérfano en Google, poco frecuente pero posible).
export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { googleEventId, googleCalendarId } = req.body || {};
    if (!googleEventId) {
      // El evento nunca se sincronizó: no hay nada que borrar en Google.
      return res.status(200).json({ ok: true, borrado: false });
    }

    const { oauth2Client, conexion } = await obtenerClienteAutenticado(usuario.id);
    const calendarId = googleCalendarId || conexion.calendar_id;
    if (!calendarId) return res.status(200).json({ ok: true, borrado: false });

    const cal = calendarClient(oauth2Client);
    try {
      await cal.events.delete({ calendarId, eventId: googleEventId });
    } catch (eGoogle) {
      // 410/404: el evento ya no existe en Google (fue borrado manualmente
      // allá, o el calendario cambió) — no es un error real para la usuaria.
      const status = eGoogle?.code || eGoogle?.response?.status;
      if (status === 404 || status === 410) {
        return res.status(200).json({ ok: true, borrado: true, nota: 'El evento ya no existía en Google Calendar.' });
      }
      const mensaje = eGoogle?.errors?.[0]?.message || eGoogle.message || 'Error desconocido de Google Calendar';
      return res.status(502).json({ error: `No se pudo eliminar el evento en Google Calendar: ${mensaje}` });
    }

    res.status(200).json({ ok: true, borrado: true });
  } catch (e) {
    console.error('delete-event error:', e);
    res.status(500).json({ error: e.message });
  }
}
