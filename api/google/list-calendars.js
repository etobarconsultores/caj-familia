import { obtenerUsuarioDesdeRequest, requerirMetodo } from './_lib/supabaseAdmin.js';
import { obtenerClienteAutenticado, calendarClient } from './_lib/googleClient.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'GET')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { oauth2Client } = await obtenerClienteAutenticado(usuario.id);
    const cal = calendarClient(oauth2Client);
    const { data } = await cal.calendarList.list({ maxResults: 50 });
    const calendarios = (data.items || []).map(c => ({
      id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole
    }));
    res.status(200).json({ calendarios });
  } catch (e) {
    console.error('list-calendars error:', e);
    res.status(500).json({ error: e.message });
  }
}
