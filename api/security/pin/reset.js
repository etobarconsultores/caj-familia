import { createClient } from '@supabase/supabase-js';
import { requerirMetodo, obtenerUsuarioDesdeRequest, crearClienteAdmin } from '../../_lib/supabaseServer.js';
import { hashearPin, formatoPinValido } from '../../_lib/pin.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { currentPassword, newPin, newPinConfirm } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({ error: 'Ingresa tu contraseña actual.' });
    }
    if (!formatoPinValido(newPin)) {
      return res.status(400).json({ error: 'El PIN nuevo debe tener exactamente 4 dígitos.' });
    }
    if (newPin !== newPinConfirm) {
      return res.status(400).json({ error: 'El PIN nuevo y su confirmación no coinciden.' });
    }

    // Decisión final ya aprobada: NO se acepta un restablecimiento solo
    // porque exista una sesión abierta -- se revalida la identidad real
    // verificando la contraseña actual de la cuenta contra Supabase Auth.
    const url = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new Error('Faltan las variables de entorno SUPABASE_URL o SUPABASE_ANON_KEY.');
    const clienteVerificacion = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: errAuth } = await clienteVerificacion.auth.signInWithPassword({
      email: usuario.email,
      password: currentPassword
    });
    if (errAuth) {
      return res.status(403).json({ error: 'Contraseña actual incorrecta.' });
    }

    const admin = crearClienteAdmin();
    const nuevoHash = await hashearPin(newPin);
    const { error: errUpsert } = await admin
      .from('security_settings')
      .upsert(
        { user_id: usuario.id, pin_hash: nuevoHash, failed_attempts: 0, locked_until: null },
        { onConflict: 'user_id' }
      );
    if (errUpsert) throw errUpsert;

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('security/pin/reset error:', e.message);
    res.status(500).json({ error: 'No se pudo restablecer el PIN.' });
  }
}
