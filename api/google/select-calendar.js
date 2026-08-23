import { obtenerUsuarioDesdeRequest, crearClienteAdmin, requerirMetodo } from './_lib/supabaseAdmin.js';
import { obtenerClienteAutenticado, calendarClient } from './_lib/googleClient.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { calendarId, calendarSummary, crearNuevo } = req.body || {};
    const admin = crearClienteAdmin();

    let idFinal = calendarId;
    let nombreFinal = calendarSummary;

    if (crearNuevo) {
      // Solo se crea si la usuaria lo confirma explícitamente desde la
      // interfaz — nunca automáticamente.
      const { oauth2Client } = await obtenerClienteAutenticado(usuario.id);
      const cal = calendarClient(oauth2Client);
      const { data } = await cal.calendars.insert({
        requestBody: { summary: 'Causas CAJ Lo Prado', timeZone: 'America/Santiago' }
      });
      idFinal = data.id;
      nombreFinal = data.summary;
    }

    if (!idFinal) return res.status(400).json({ error: 'Falta indicar el calendario a usar.' });

    const { error } = await admin
      .from('google_calendar_conexiones')
      .update({ calendar_id: idFinal, calendar_summary: nombreFinal || idFinal })
      .eq('user_id', usuario.id);
    if (error) throw error;

    res.status(200).json({ calendarId: idFinal, calendarSummary: nombreFinal || idFinal });
  } catch (e) {
    console.error('select-calendar error:', e);
    res.status(500).json({ error: e.message });
  }
}
