import { obtenerUsuarioDesdeRequest, crearClienteAdmin, requerirMetodo } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { syncAutomatica, recordatoriosDefault, recordatoriosPorTipo } = req.body || {};
    const patch = {};
    if (syncAutomatica !== undefined) patch.sync_automatica = !!syncAutomatica;
    if (recordatoriosDefault !== undefined) patch.recordatorios_default = recordatoriosDefault;
    if (recordatoriosPorTipo !== undefined) patch.recordatorios_por_tipo = recordatoriosPorTipo;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No se recibió ninguna preferencia para guardar.' });
    }

    const admin = crearClienteAdmin();
    const { error } = await admin.from('google_calendar_conexiones').update(patch).eq('user_id', usuario.id);
    if (error) throw error;

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('preferences error:', e);
    res.status(500).json({ error: e.message });
  }
}
