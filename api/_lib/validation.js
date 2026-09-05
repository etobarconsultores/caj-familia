// Validaciones de entrada compartidas por los endpoints de credenciales.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuidValido(valor) {
  return typeof valor === 'string' && UUID_REGEX.test(valor);
}

// Whitelist estricta de campos de credencial permitidos, junto con la
// columna real de case_credentials a la que corresponde cada uno. Se
// exporta como objeto (no como array) para que el lookup sea directo y no
// dependa de comparar strings sueltas en cada endpoint.
export const CAMPOS_CREDENCIAL = Object.freeze({
  claveWeb: 'clave_web_enc',
  claveUnica: 'clave_unica_enc'
});

export function columnaParaCampo(campo) {
  return Object.prototype.hasOwnProperty.call(CAMPOS_CREDENCIAL, campo) ? CAMPOS_CREDENCIAL[campo] : null;
}

// `eliminar` debe ser un booleano explícito. Si viene ausente, se trata
// como false (no eliminar). Si viene presente pero no es exactamente
// `true` o `false`, es un error de solicitud -- nunca se interpreta un
// valor "truthy" arbitrario (string, número, objeto) como equivalente a
// true.
export function eliminarEsValido(eliminar) {
  return eliminar === undefined || eliminar === true || eliminar === false;
}

export function eliminarEsTrue(eliminar) {
  return eliminar === true;
}
