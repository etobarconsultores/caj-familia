import { crearClienteAdmin } from '../supabaseServer.js';

export async function reactivate(req, res, usuario) {
  try {
    const admin = crearClienteAdmin();
    const { error } = await admin
      .from('account_deletion_requests')
      .delete()
      .eq('user_id', usuario.id);
    if (error) throw error;
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('account.reactivate error:', e.message);
    res.status(500).json({ error: 'No se pudo reactivar la cuenta.' });
  }
}
