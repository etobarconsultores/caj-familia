import { requerirMetodo, obtenerUsuarioDesdeRequest } from './_lib/supabaseServer.js';
import { credentialsSave } from './_lib/security-ops/credentialsSave.js';
import { credentialsReveal } from './_lib/security-ops/credentialsReveal.js';
import { credentialsStatus } from './_lib/security-ops/credentialsStatus.js';
import { pinCreate } from './_lib/security-ops/pinCreate.js';
import { pinChange } from './_lib/security-ops/pinChange.js';
import { pinReset } from './_lib/security-ops/pinReset.js';
import { pinStatus } from './_lib/security-ops/pinStatus.js';
import { moduleEntry } from './_lib/security-ops/moduleEntry.js';
import { moduleAccessCheck } from './_lib/security-ops/moduleAccessCheck.js';
import { requestClosure } from './_lib/account-ops/requestClosure.js';
import { reactivate } from './_lib/account-ops/reactivate.js';
import { processExpiredDeletions } from './_lib/account-ops/processExpiredDeletions.js';

// Dispatcher único para las operaciones de Seguridad (credenciales
// cifradas + PIN) y, desde esta ronda, también Cuenta (cierre/
// reactivación), consolidadas en esta misma Vercel Function para
// mantener el total de funciones dentro del límite del plan Hobby (ya
// estaba en 12/12 -- agregar un archivo nuevo lo habría superado). Ninguna
// operación existente de Seguridad se modificó para esto -- solo se
// agregaron 2 entradas nuevas al whitelist y una rama de GET aparte para
// el cron, antes de cualquier lógica de POST/operation ya existente.
//
// Cada operación mantiene, sin cambios, su lógica específica dentro de su
// propio módulo (validaciones, verificación de causa vía JWT/RLS antes de
// service_role, throttling atómico, AES-256-GCM/AAD, bcrypt, mensajes y
// códigos HTTP). Lo único que se centralizó acá es lo que las operaciones
// hacían de forma idéntica al principio: exigir POST y validar el JWT --
// antes se repetía 7 veces, ahora ocurre una sola vez, con el mismo
// resultado exacto para cada caso.
//
// Cambio aprobado respecto al esquema anterior: pin.status pasaba a usar
// GET en su endpoint propio; acá, como las operaciones de POST comparten
// un único método, pasa a resolverse también vía POST. La ÚNICA excepción
// real a "todo es POST" es la rama de cron de abajo, porque Vercel Cron
// invoca sus endpoints por GET con el secreto en el header Authorization
// -- no admite un cuerpo JSON personalizado, así que no puede usar el
// mismo esquema de "operation" que todo lo demás.
const OPERACIONES = Object.freeze({
  'credentials.save': credentialsSave,
  'credentials.reveal': credentialsReveal,
  'credentials.status': credentialsStatus,
  'pin.create': pinCreate,
  'pin.change': pinChange,
  'pin.reset': pinReset,
  'pin.status': pinStatus,
  'module.accessCheck': moduleAccessCheck,
  'account.requestClosure': requestClosure,
  'account.reactivate': reactivate
});

export default async function handler(req, res) {
  // Rama del cron de eliminación definitiva: Vercel Cron invoca por GET,
  // con el secreto ya inyectado por Vercel en el header Authorization
  // (nunca en el body). Se resuelve ANTES de exigir POST, para no
  // interferir en absoluto con las operaciones normales de abajo. Si el
  // secreto no coincide (o no está configurado), se rechaza sin ejecutar
  // nada -- nunca se asume autorización por el solo hecho de ser GET.
  if (req.method === 'GET') {
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const secreto = process.env.CRON_SECRET;
    if (secreto && authHeader === `Bearer ${secreto}`) {
      return await processExpiredDeletions(req, res);
    }
    return res.status(401).json({ error: 'No autorizado.' });
  }

  if (!requerirMetodo(req, res, 'POST')) return;

  const { operation } = req.body || {};

  // Entrada desde Práctica Juris Core. No puede exigir JWT Familia porque la
  // usuaria todavía no tiene una sesión en este proyecto Supabase.
  if (operation === 'module.entry') {
    return await moduleEntry(req, res);
  }

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
