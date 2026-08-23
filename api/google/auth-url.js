import { obtenerUsuarioDesdeRequest, requerirMetodo } from './_lib/supabaseAdmin.js';
import { generarUrlAutorizacion } from './_lib/googleClient.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'GET')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const url = generarUrlAutorizacion(usuario.id);
    res.status(200).json({ url });
  } catch (e) {
    console.error('auth-url error:', e);
    res.status(500).json({ error: e.message });
  }
}
