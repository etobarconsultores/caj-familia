import { crearClienteAdmin } from '../supabaseServer.js';

// Se invoca ÚNICAMENTE desde la rama de cron de api/security.js (ver ahí
// la verificación del secreto de Vercel Cron) -- nunca recibe ni necesita
// un usuario autenticado, porque no actúa en nombre de nadie en
// particular: procesa todas las solicitudes ya vencidas.
export async function processExpiredDeletions(req, res) {
  try {
    const admin = crearClienteAdmin();
    const nowIso = new Date().toISOString();

    const { data: vencidas, error: errSelect } = await admin
      .from('account_deletion_requests')
      .select('user_id, scheduled_deletion_at')
      .lte('scheduled_deletion_at', nowIso);
    if (errSelect) throw errSelect;

    const resultados = [];
    for (const fila of (vencidas || [])) {
      try {
        // Mecanismo oficial de Supabase Auth -- nunca un DELETE SQL
        // directo sobre auth.users. Esto dispara el cascade ya existente
        // sobre las tablas dependientes (incluidas security_settings/
        // case_credentials, cumpliendo el requisito de eliminar tokens y
        // credenciales) y también borra, en cascada, la propia fila de
        // account_deletion_requests. legal_acceptances no se toca: no
        // tiene ninguna FK hacia auth.users.
        const { error: errDelete } = await admin.auth.admin.deleteUser(fila.user_id);
        if (errDelete) throw errDelete;
        resultados.push({ userId: fila.user_id, ok: true });
      } catch (e) {
        console.error('processExpiredDeletions: fallo al eliminar una cuenta vencida:', e.message);
        resultados.push({ userId: fila.user_id, ok: false });
      }
    }

    res.status(200).json({
      procesadas: resultados.length,
      exitosas: resultados.filter(r => r.ok).length
    });
  } catch (e) {
    console.error('processExpiredDeletions error:', e.message);
    res.status(500).json({ error: 'No se pudo procesar la eliminación de cuentas vencidas.' });
  }
}
