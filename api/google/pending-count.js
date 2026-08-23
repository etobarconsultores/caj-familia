import { obtenerUsuarioDesdeRequest, crearClienteAdmin, requerirMetodo } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'GET')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const admin = crearClienteAdmin();
    const { data, error } = await admin
      .from('agenda_eventos')
      .select('id,fecha')
      .eq('user_id', usuario.id)
      .is('google_sync_status', null)
      .order('fecha', { ascending: true });
    if (error) throw error;

    const hoy = new Date().toISOString().slice(0, 10);
    const futuros = (data || []).filter(e => e.fecha >= hoy);

    res.status(200).json({
      total: (data || []).length,
      futuros: futuros.length,
      fechaMin: data && data.length ? data[0].fecha : null,
      fechaMax: data && data.length ? data[data.length - 1].fecha : null
    });
  } catch (e) {
    console.error('pending-count error:', e);
    res.status(500).json({ error: e.message });
  }
}
