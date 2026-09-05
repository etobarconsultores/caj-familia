import { requerirMetodo, obtenerUsuarioDesdeRequest, crearClienteAdmin } from '../../_lib/supabaseServer.js';
import { hashearPin, compararPin, formatoPinValido, iniciarIntentoPin, reiniciarIntentosPin } from '../../_lib/pin.js';
import { minutosRestantesDesde } from '../../_lib/throttle.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const { currentPin, newPin, newPinConfirm } = req.body || {};

    // Formato inválido en currentPin o newPin: 400 inmediato, NO se
    // reserva ningún intento.
    if (!formatoPinValido(currentPin)) {
      return res.status(400).json({ error: 'El PIN actual debe tener exactamente 4 dígitos.' });
    }
    if (!formatoPinValido(newPin)) {
      return res.status(400).json({ error: 'El PIN nuevo debe tener exactamente 4 dígitos.' });
    }
    if (newPin !== newPinConfirm) {
      return res.status(400).json({ error: 'El PIN nuevo y su confirmación no coinciden.' });
    }

    const admin = crearClienteAdmin();

    // PASO 1: reservar autorización ATÓMICA antes de leer pin_hash y
    // antes de comparar nada -- mismo modelo que credentials/reveal.js.
    let reserva;
    try {
      reserva = await iniciarIntentoPin(admin, usuario.id);
    } catch (errReserva) {
      console.error('pin/change: fallo al reservar intento:', errReserva.message);
      return res.status(500).json({ error: 'No se pudo verificar el PIN actual de forma segura. Intenta nuevamente.' });
    }

    if (!reserva.allowed) {
      const minutos = minutosRestantesDesde(reserva.locked_until);
      return res.status(423).json({ error: `PIN bloqueado temporalmente. Intenta en ${minutos} minuto(s).` });
    }

    // PASO 2: recién ahora leer pin_hash y comparar.
    const { data: settings, error: errLectura } = await admin
      .from('security_settings')
      .select('pin_hash')
      .eq('user_id', usuario.id)
      .maybeSingle();
    if (errLectura) throw errLectura;
    if (!settings) {
      return res.status(404).json({ error: 'No existe un PIN configurado todavía.' });
    }

    const correcto = await compararPin(currentPin, settings.pin_hash);

    if (!correcto) {
      if (reserva.attempt_number >= 5 && reserva.locked_until) {
        const minutos = minutosRestantesDesde(reserva.locked_until);
        return res.status(423).json({ error: `PIN actual incorrecto. Quedó bloqueado temporalmente. Intenta en ${minutos} minuto(s).` });
      }
      return res.status(403).json({ error: 'PIN actual incorrecto.' });
    }

    // PASO 3: PIN correcto -> reinicio atómico del ciclo antes de
    // continuar. Si falla, se falla cerrado: no se cambia el PIN.
    try {
      await reiniciarIntentosPin(admin, usuario.id);
    } catch (errReset) {
      console.error('pin/change: fallo al reiniciar intentos tras PIN correcto:', errReset.message);
      return res.status(500).json({ error: 'No se pudo completar la verificación de forma segura. Intenta nuevamente.' });
    }

    const nuevoHash = await hashearPin(newPin);
    const { error: errUpdate } = await admin
      .from('security_settings')
      .update({ pin_hash: nuevoHash })
      .eq('user_id', usuario.id);
    if (errUpdate) {
      console.error('pin/change: fallo al guardar el nuevo hash:', errUpdate.message);
      return res.status(500).json({ error: 'No se pudo guardar el nuevo PIN.' });
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('security/pin/change error:', e.message);
    res.status(500).json({ error: 'No se pudo cambiar el PIN.' });
  }
}
