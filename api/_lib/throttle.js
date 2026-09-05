// Con el nuevo modelo de throttling ("reservar antes de comparar", ver
// api/_lib/pin.js), TODA la contabilidad de intentos vive en las
// funciones SQL security_pin_begin_attempt / security_pin_reset_attempts.
// Este archivo ya no calcula ni interpreta ningún contador -- solo ofrece
// un formateador puro para el mensaje de "cuántos minutos faltan", a
// partir de un locked_until que ya vino de la función SQL.

export function minutosRestantesDesde(lockedUntilIso) {
  if (!lockedUntilIso) return 0;
  const hasta = new Date(lockedUntilIso).getTime();
  if (!Number.isFinite(hasta)) return 0;
  return Math.max(1, Math.ceil((hasta - Date.now()) / 60000));
}
