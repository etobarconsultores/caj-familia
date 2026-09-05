import { crearClienteAdmin } from '../supabaseServer.js';
import { hashearPin, formatoPinValido } from '../pin.js';

export async function pinCreate(req, res, usuario) {
  try {
    const { pin, pinConfirm } = req.body || {};
    if (!formatoPinValido(pin)) {
      return res.status(400).json({ error: 'El PIN debe tener exactamente 4 dígitos.' });
    }
    if (pin !== pinConfirm) {
      return res.status(400).json({ error: 'El PIN y su confirmación no coinciden.' });
    }

    const admin = crearClienteAdmin();

    const { data: existente, error: errLectura } = await admin
      .from('security_settings')
      .select('user_id')
      .eq('user_id', usuario.id)
      .maybeSingle();
    if (errLectura) throw errLectura;
    if (existente) {
      return res.status(409).json({ error: 'Ya existe un PIN configurado. Usa la opción "Cambiar PIN".' });
    }

    const pinHash = await hashearPin(pin);
    const { error: errInsert } = await admin
      .from('security_settings')
      .insert({ user_id: usuario.id, pin_hash: pinHash });
    if (errInsert) throw errInsert;

    res.status(200).json({ ok: true });
  } catch (e) {
    // Nunca se loguea el PIN ni el hash -- solo el mensaje técnico interno.
    console.error('pin.create error:', e.message);
    res.status(500).json({ error: 'No se pudo crear el PIN.' });
  }
}
