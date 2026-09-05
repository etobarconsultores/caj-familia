import bcrypt from 'bcryptjs';

// Costo de bcrypt para el hash del PIN. Con el nuevo modelo de throttling
// (reservar el intento ANTES de comparar, ver más abajo), como máximo 5
// llamadas a bcrypt.compare pueden ocurrir por ciclo de 15 minutos, sin
// importar cuántas solicitudes concurrentes lleguen -- el costo de bcrypt
// deja de ser la única defensa relevante, pero se mantiene como segunda
// capa por si el hash llegara a filtrarse.
const SALT_ROUNDS = 12;

export async function hashearPin(pin) {
  return bcrypt.hash(pin, SALT_ROUNDS);
}

export async function compararPin(pin, hash) {
  if (!pin || !hash) return false;
  return bcrypt.compare(pin, hash);
}

export function formatoPinValido(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

// ----------------------------------------------------------------------
// Nuevo modelo de throttling: "reservar antes de comparar".
//
// El problema que corrige esta ronda: comparar el PIN primero y recién
// después registrar el intento permite que miles de solicitudes
// concurrentes ejecuten bcrypt.compare en paralelo ANTES de que exista
// cualquier bloqueo -- el throttling llegaba demasiado tarde para
// impedir el ataque, aunque el registro en sí fuera atómico.
//
// La corrección: el backend debe obtener autorización ATÓMICA de la base
// de datos (vía security_pin_begin_attempt) ANTES de ejecutar
// bcrypt.compare. Esa función usa `select ... for update`, así que de
// miles de llamadas concurrentes, como máximo 5 pueden recibir
// allowed=true por cada ciclo de 15 minutos -- las demás son rechazadas
// sin que el backend llegue siquiera a leer pin_hash ni a comparar nada.
// ----------------------------------------------------------------------

// Reserva atómicamente un intento. Devuelve { allowed, attempt_number,
// locked_until }. Si allowed es false, el backend NO debe comparar el PIN
// bajo ninguna circunstancia -- ni siquiera para el propio PIN correcto,
// porque ya no hay cupo en este ciclo.
export async function iniciarIntentoPin(admin, userId) {
  const { data, error } = await admin.rpc('security_pin_begin_attempt', { p_user_id: userId });
  if (error) {
    throw new Error(`No se pudo reservar el intento de PIN de forma segura: ${error.message}`);
  }
  const fila = Array.isArray(data) ? data[0] : data;
  if (!fila) {
    throw new Error('La función de reserva de intentos de PIN no devolvió ningún resultado.');
  }
  return fila;
}

// Reinicia el ciclo de intentos tras un PIN correcto. Debe llamarse SIEMPRE
// que compararPin devuelva true para un intento ya reservado -- si esta
// llamada falla, el backend debe fallar cerrado (no revelar, no cambiar
// el PIN) en vez de asumir que el reinicio ocurrió.
export async function reiniciarIntentosPin(admin, userId) {
  const { error } = await admin.rpc('security_pin_reset_attempts', { p_user_id: userId });
  if (error) {
    throw new Error(`No se pudo reiniciar los intentos de PIN de forma segura: ${error.message}`);
  }
}
