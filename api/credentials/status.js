import { requerirMetodo, obtenerUsuarioDesdeRequest, extraerJwt, crearClienteConJWT, crearClienteAdmin } from '../_lib/supabaseServer.js';
import { esUuidValido } from '../_lib/validation.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { causaId } = req.body || {};
    if (!esUuidValido(causaId)) return res.status(400).json({ error: 'causaId inválido.' });

    // Propiedad de la causa vía JWT/RLS, igual que en save/reveal.
    const jwt = extraerJwt(req);
    const clienteUsuaria = crearClienteConJWT(jwt);
    const { data: causa, error: errCausa } = await clienteUsuaria
      .from('causas')
      .select('id')
      .eq('id', causaId)
      .maybeSingle();
    if (errCausa) throw errCausa;
    if (!causa) {
      return res.status(403).json({ error: 'La causa no existe o no te pertenece.' });
    }

    const admin = crearClienteAdmin();
    const { data, error } = await admin
      .from('case_credentials')
      .select('clave_web_enc, clave_unica_enc')
      .eq('causa_id', causaId)
      .maybeSingle();
    if (error) throw error;

    // Nunca se devuelve el ciphertext -- solo si cada campo está guardado.
    res.status(200).json({
      claveWebGuardada: !!(data && data.clave_web_enc),
      claveUnicaGuardada: !!(data && data.clave_unica_enc)
    });
  } catch (e) {
    console.error('credentials/status error:', e.message);
    res.status(500).json({ error: 'No se pudo consultar el estado de las credenciales.' });
  }
}
