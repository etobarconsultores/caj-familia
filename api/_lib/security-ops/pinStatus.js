import { crearClienteAdmin } from '../supabaseServer.js';

export async function pinStatus(req, res, usuario) {
  try {
    const admin = crearClienteAdmin();
    const { data, error } = await admin
      .from('security_settings')
      .select('user_id')
      .eq('user_id', usuario.id)
      .maybeSingle();
    if (error) throw error;

    // Nunca se devuelve pin_hash ni ninguna otra columna -- solo si existe
    // o no una fila para esta usuaria.
    res.status(200).json({ pinConfigurado: !!data });
  } catch (e) {
    console.error('pin.status error:', e.message);
    res.status(500).json({ error: 'No se pudo consultar el estado del PIN.' });
  }
}
