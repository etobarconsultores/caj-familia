import { obtenerUsuarioDesdeRequest, crearClienteAdmin, requerirMetodo } from './_lib/supabaseAdmin.js';

// Desconectar: elimina la conexión y los tokens guardados. NO borra
// eventos de Agenda ni de Google Calendar — los eventos ya creados en
// Google Calendar permanecen ahí hasta que la usuaria los borre
// manualmente.
export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const admin = crearClienteAdmin();
    const { error } = await admin.from('google_calendar_conexiones').delete().eq('user_id', usuario.id);
    if (error) throw error;

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('disconnect error:', e);
    res.status(500).json({ error: e.message });
  }
}
