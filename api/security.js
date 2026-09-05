import { requerirMetodo, obtenerUsuarioDesdeRequest } from './_lib/supabaseServer.js';
import { credentialsSave } from './_lib/security-ops/credentialsSave.js';
import { credentialsReveal } from './_lib/security-ops/credentialsReveal.js';
import { credentialsStatus } from './_lib/security-ops/credentialsStatus.js';
import { pinCreate } from './_lib/security-ops/pinCreate.js';
import { pinChange } from './_lib/security-ops/pinChange.js';
import { pinReset } from './_lib/security-ops/pinReset.js';
import { pinStatus } from './_lib/security-ops/pinStatus.js';

// Dispatcher único para las 7 operaciones de Seguridad (credenciales
// cifradas + PIN), consolidadas en esta sola Vercel Function para
// mantener el total de funciones dentro del límite del plan Hobby.
//
// Cada operación mantiene, sin cambios, su lógica específica dentro de su
// propio módulo en api/_lib/security-ops/ (validaciones, verificación de
// causa vía JWT/RLS antes de service_role, throttling atómico,
// AES-256-GCM/AAD, bcrypt, mensajes y códigos HTTP). Lo único que se
// centralizó acá es lo que las 7 operaciones hacían de forma idéntica al
// principio: exigir POST y validar el JWT -- antes se repetía 7 veces,
// ahora ocurre una sola vez, con el mismo resultado exacto para cada caso.
//
// Cambio aprobado respecto al esquema anterior: pin.status pasaba a usar
// GET en su endpoint propio; acá, como las 7 operaciones comparten un
// único método, pasa a resolverse también vía POST.
const OPERACIONES = Object.freeze({
  'credentials.save': credentialsSave,
  'credentials.reveal': credentialsReveal,
  'credentials.status': credentialsStatus,
  'pin.create': pinCreate,
  'pin.change': pinChange,
  'pin.reset': pinReset,
  'pin.status': pinStatus
});

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'POST')) return;

  const { operation } = req.body || {};

  // Whitelist estricta: se exige que la clave sea propia del objeto (no
  // heredada), para no dejar ningún resquicio a algo como "__proto__" o
  // "constructor" si `operation` viniera manipulado.
  if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(OPERACIONES, operation)) {
    return res.status(400).json({ error: 'Operación no reconocida.' });
  }

  let usuario;
  try {
    usuario = await obtenerUsuarioDesdeRequest(req);
  } catch (e) {
    console.error('api/security: fallo al validar el JWT:', e.message);
    return res.status(500).json({ error: 'No se pudo validar la sesión.' });
  }
  if (!usuario) return res.status(401).json({ error: 'No autenticado' });

  const modulo = OPERACIONES[operation];
  await modulo(req, res, usuario);
}
