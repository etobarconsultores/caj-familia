import crypto from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';
const IV_BYTES = 12;  // tamaño estándar recomendado para GCM
const TAG_BYTES = 16; // tamaño estándar del auth tag de AES-GCM (128 bits)

// Base64 canónico estricto: 4 caracteres del alfabeto por bloque, con el
// padding exacto que corresponde (0, 1 o 2 "="). Esto rechaza strings que
// Node.js tolera al decodificar (caracteres fuera del alfabeto se ignoran
// silenciosamente, el padding puede faltar sin error) pero que no son
// base64 válido en sentido estricto.
const BASE64_CANONICO = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Helper reutilizable: valida formato canónico Y hace la verificación de
// ida y vuelta (re-codificar debe reproducir exactamente el string
// original) -- se usa tanto para la clave maestra como para iv/tag/ct de
// cada credencial cifrada. Nunca incluye el valor recibido en el mensaje
// de error.
function decodificarBase64CanonicoOFallar(valor, nombreCampo) {
  if (typeof valor !== 'string' || !BASE64_CANONICO.test(valor)) {
    throw new Error(`${nombreCampo} no es un base64 canónico válido.`);
  }
  const bytes = Buffer.from(valor, 'base64');
  if (bytes.toString('base64') !== valor) {
    throw new Error(`${nombreCampo} no es una codificación base64 canónica de sus bytes.`);
  }
  return bytes;
}

// CREDENTIALS_ENCRYPTION_KEY debe ser un string en base64 canónico que
// represente exactamente 32 bytes (una clave AES-256 real). Nunca se
// acepta silenciosamente una clave ausente, mal formada, de largo
// incorrecto, o "tolerada" por el decodificador de Node pero no canónica.
function obtenerClaveMaestra() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw || typeof raw !== 'string') {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY no está configurada en el entorno del backend.');
  }
  const clave = decodificarBase64CanonicoOFallar(raw.trim(), 'CREDENTIALS_ENCRYPTION_KEY');
  if (clave.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY debe representar exactamente 32 bytes (AES-256).');
  }
  return clave;
}

// AAD (Additional Authenticated Data): liga criptográficamente el
// ciphertext a su contexto exacto (usuario + causa + campo). No se guarda
// en la base -- se reconstruye de forma determinística a partir de los
// mismos 3 datos tanto al cifrar como al descifrar. Si alguien copia el
// ciphertext de otra causa, de otro usuario, o del otro campo hacia esta
// fila, la verificación de autenticidad de GCM falla y el descifrado se
// rechaza.
function construirAAD(contexto) {
  const { userId, causaId, campo } = contexto || {};
  if (!userId || !causaId || !campo) {
    throw new Error('Contexto incompleto para AAD: se requieren userId, causaId y campo.');
  }
  return Buffer.from(`${userId}:${causaId}:${campo}`, 'utf8');
}

// Cifra un texto plano y devuelve el JSON serializado { v, iv, tag, ct }
// (todos en base64). `contexto` es obligatorio: { userId, causaId, campo }.
export function cifrarCredencial(textoPlano, contexto) {
  if (typeof textoPlano !== 'string') {
    throw new Error('El valor a cifrar debe ser un string explícito.');
  }
  const clave = obtenerClaveMaestra();
  const aad = construirAAD(contexto);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITMO, clave, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64')
  });
}

// Descifra el JSON serializado y devuelve el texto plano original.
// `contexto` debe ser EXACTAMENTE el mismo { userId, causaId, campo } que
// se usó al cifrar.
//
// Endurecido en esta ronda: iv/tag/ct se validan como base64 canónico Y
// con su tamaño exacto esperado (12 bytes el IV, 16 bytes el auth tag)
// ANTES de tocar createDecipheriv/setAuthTag -- un payload mal formado se
// rechaza de inmediato, con un mensaje que nunca incluye los valores
// recibidos ni el ciphertext.
export function descifrarCredencial(jsonSerializado, contexto) {
  const clave = obtenerClaveMaestra();
  const aad = construirAAD(contexto);

  let payload;
  try {
    payload = JSON.parse(jsonSerializado);
  } catch {
    throw new Error('Formato de credencial cifrada inválido.');
  }
  if (payload.v !== 1 || !payload.iv || !payload.tag || !payload.ct) {
    throw new Error('Formato de credencial cifrada inválido (faltan campos).');
  }

  const iv = decodificarBase64CanonicoOFallar(payload.iv, 'iv');
  const tag = decodificarBase64CanonicoOFallar(payload.tag, 'tag');
  const ct = decodificarBase64CanonicoOFallar(payload.ct, 'ct');

  if (iv.length !== IV_BYTES) {
    throw new Error(`iv tiene un tamaño inválido (se esperaban ${IV_BYTES} bytes).`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`tag tiene un tamaño inválido (se esperaban ${TAG_BYTES} bytes).`);
  }
  // ct no tiene un tamaño fijo (depende del largo del texto original),
  // pero un ciphertext vacío no es válido para ninguna credencial real.
  if (ct.length === 0) {
    throw new Error('ct no puede estar vacío.');
  }

  const decipher = crypto.createDecipheriv(ALGORITMO, clave, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const textoPlano = Buffer.concat([decipher.update(ct), decipher.final()]);
  return textoPlano.toString('utf8');
}
