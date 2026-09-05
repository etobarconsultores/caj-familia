import { requerirMetodo, obtenerUsuarioDesdeRequest, extraerJwt, crearClienteConJWT, crearClienteAdmin } from '../_lib/supabaseServer.js';
import { compararPin, formatoPinValido, iniciarIntentoPin, reiniciarIntentosPin } from '../_lib/pin.js';
import { minutosRestantesDesde } from '../_lib/throttle.js';
import { descifrarCredencial } from '../_lib/crypto.js';
import { esUuidValido, columnaParaCampo } from '../_lib/validation.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;
  try {
    // 1) Validar el JWT y obtener la usuaria autenticada.
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    // 2) Validar causaId, campo y formato de PIN -- antes de crear
    // cualquier cliente de Supabase.
    const { causaId, campo, pin } = req.body || {};

    if (!esUuidValido(causaId)) {
      return res.status(400).json({ error: 'causaId inválido.' });
    }
    const columna = columnaParaCampo(campo);
    if (!columna) {
      return res.status(400).json({ error: 'campo inválido. Debe ser "claveWeb" o "claveUnica".' });
    }
    if (!formatoPinValido(pin)) {
      return res.status(400).json({ error: 'El PIN debe tener exactamente 4 dígitos.' });
    }

    // 3) Crear el cliente Supabase con el JWT de la propia usuaria.
    const jwt = extraerJwt(req);
    const clienteUsuaria = crearClienteConJWT(jwt);

    // 4) Verificar que la causa exista y le pertenezca, dejando que RLS
    // autorice o rechace -- esto ocurre ANTES de tocar service_role o
    // cualquier cosa relacionada con el PIN. No se usa service_role para
    // decidir esto bajo ninguna circunstancia.
    const { data: causa, error: errCausa } = await clienteUsuaria
      .from('causas')
      .select('id')
      .eq('id', causaId)
      .maybeSingle();
    if (errCausa) throw errCausa;
    if (!causa) {
      return res.status(403).json({ error: 'La causa no existe o no te pertenece.' });
    }

    // 5) Solo después de confirmar la propiedad de la causa, crear/usar
    // el cliente service_role -- necesario porque security_settings y
    // case_credentials no tienen policies para authenticated.
    const admin = crearClienteAdmin();

    // 6) Reservar el intento de forma ATÓMICA, ANTES de leer pin_hash y
    // ANTES de comparar nada. De miles de solicitudes concurrentes, como
    // máximo 5 por ciclo de 15 minutos reciben allowed=true -- el resto
    // se rechaza acá mismo, sin gastar ningún bcrypt.compare.
    let reserva;
    try {
      reserva = await iniciarIntentoPin(admin, usuario.id);
    } catch (errReserva) {
      // Fallar cerrado: si no se pudo reservar el intento de forma
      // segura, NO se compara nada y NO se revela nada.
      console.error('credentials/reveal: fallo al reservar intento:', errReserva.message);
      return res.status(500).json({ error: 'No se pudo verificar el PIN de forma segura. Intenta nuevamente.' });
    }

    if (!reserva.allowed) {
      const minutos = minutosRestantesDesde(reserva.locked_until);
      return res.status(423).json({ error: `PIN bloqueado temporalmente. Intenta en ${minutos} minuto(s).` });
    }

    // 7) Recién con el cupo ya reservado, leer security_settings y
    // comparar el PIN con bcrypt. Nunca se devuelve pin_hash al cliente.
    const { data: settings, error: errSettings } = await admin
      .from('security_settings')
      .select('pin_hash')
      .eq('user_id', usuario.id)
      .maybeSingle();
    if (errSettings) throw errSettings;
    if (!settings) {
      // No debería ocurrir (begin_attempt ya confirmó que la fila existe),
      // pero si ocurre, se falla cerrado igual.
      return res.status(404).json({ error: 'No tienes un PIN configurado todavía.' });
    }

    const correcto = await compararPin(pin, settings.pin_hash);

    if (!correcto) {
      // El intento ya fue consumido por begin_attempt -- no hay que
      // volver a registrar nada. Si este era el 5to intento del ciclo,
      // begin_attempt ya dejó locked_until fijado; se informa tal cual.
      if (reserva.attempt_number >= 5 && reserva.locked_until) {
        const minutos = minutosRestantesDesde(reserva.locked_until);
        return res.status(423).json({ error: `PIN incorrecto. Quedó bloqueado temporalmente. Intenta en ${minutos} minuto(s).` });
      }
      return res.status(403).json({ error: 'PIN incorrecto.' });
    }

    // 8) PIN correcto -> reinicio atómico del ciclo. Si esto falla, se
    // falla cerrado: no se revela la credencial.
    try {
      await reiniciarIntentosPin(admin, usuario.id);
    } catch (errReset) {
      console.error('credentials/reveal: fallo al reiniciar intentos tras PIN correcto:', errReset.message);
      return res.status(500).json({ error: 'No se pudo completar la verificación de forma segura. Intenta nuevamente.' });
    }

    // 9) Leer case_credentials -- la propiedad de la causa ya fue
    // confirmada en el paso 4, así que esta lectura con service_role es
    // solo para acceder a una tabla sin policies para authenticated, no
    // para decidir pertenencia.
    const { data: cred, error: errCred } = await admin
      .from('case_credentials')
      .select(columna)
      .eq('causa_id', causaId)
      .maybeSingle();
    if (errCred) throw errCred;
    if (!cred || !cred[columna]) {
      return res.status(404).json({ error: 'No hay una credencial guardada para este campo.' });
    }

    // 10) Descifrar únicamente la credencial solicitada y devolverla.
    const valor = descifrarCredencial(cred[columna], { userId: usuario.id, causaId, campo });
    res.status(200).json({ valor });
  } catch (e) {
    // Nunca se loguea el PIN, el hash, el texto plano ni el ciphertext.
    console.error('credentials/reveal error:', e.message);
    res.status(500).json({ error: 'No se pudo revelar la credencial.' });
  }
}
