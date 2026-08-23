import crypto from 'crypto';
import { google } from 'googleapis';
import { crearClienteAdmin } from './supabaseAdmin.js';

// Principio de privilegio mínimo. Cuatro scopes, cada uno con un propósito
// concreto y necesario para una función real de la aplicación — nada de
// Gmail, Drive ni Contactos, y nunca el scope "calendar" completo:
//   - calendar.events               → crear, modificar y eliminar eventos.
//   - calendar.calendarlist.readonly→ listar los calendarios disponibles
//                                      para que la usuaria elija uno.
//   - calendar.calendars            → crear el calendario secundario
//                                      "Causas CAJ Lo Prado" (cal.calendars.insert),
//                                      siempre con confirmación explícita.
//   - openid + email                → identificar únicamente qué cuenta de
//                                      Google quedó conectada (mostrar su
//                                      correo en Integraciones). No da
//                                      acceso a Gmail ni a ningún otro dato.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email'
];

function requerirEnv(nombre) {
  const valor = process.env[nombre];
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre} en el backend.`);
  return valor;
}

export function crearOAuthClient() {
  return new google.auth.OAuth2(
    requerirEnv('GOOGLE_CLIENT_ID'),
    requerirEnv('GOOGLE_CLIENT_SECRET'),
    requerirEnv('GOOGLE_REDIRECT_URI')
  );
}

// El "state" del flujo OAuth lleva el user_id firmado (HMAC) para evitar que
// alguien arme una URL de callback con el id de otra usuaria y le robe la
// conexión. No es información sensible, solo evita suplantación del state.
function firmarUserId(userId) {
  const firma = crypto.createHmac('sha256', requerirEnv('GOOGLE_CLIENT_SECRET')).update(userId).digest('hex');
  return `${userId}.${firma}`;
}

export function verificarState(state) {
  const partes = String(state || '').split('.');
  if (partes.length !== 2) return null;
  const [userId, firma] = partes;
  const esperado = crypto.createHmac('sha256', requerirEnv('GOOGLE_CLIENT_SECRET')).update(userId).digest('hex');
  return firma === esperado ? userId : null;
}

export function generarUrlAutorizacion(userId) {
  const oauth2Client = crearOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline', // necesario para obtener refresh_token
    prompt: 'consent',      // fuerza a Google a reentregar refresh_token siempre
    scope: SCOPES,
    state: firmarUserId(userId)
  });
}

// Devuelve un cliente OAuth2 ya autenticado y con el access token vigente
// (lo renueva usando el refresh_token si está vencido o próximo a vencer,
// y persiste el nuevo access_token en Supabase). Lanza un error claro y
// legible si no hay conexión o si el refresh token ya no es válido.
export async function obtenerClienteAutenticado(userId) {
  const admin = crearClienteAdmin();
  const { data: conexion, error } = await admin
    .from('google_calendar_conexiones')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error('No se pudo leer la conexión de Google Calendar.');
  if (!conexion || !conexion.refresh_token) {
    throw new Error('No hay una cuenta de Google Calendar conectada. Conéctala desde Integraciones.');
  }

  const oauth2Client = crearOAuthClient();
  oauth2Client.setCredentials({
    access_token: conexion.access_token || undefined,
    refresh_token: conexion.refresh_token,
    expiry_date: conexion.token_expiry ? new Date(conexion.token_expiry).getTime() : undefined
  });

  let tokenActual;
  try {
    // Internamente usa el refresh_token si el access_token está vencido.
    tokenActual = await oauth2Client.getAccessToken();
  } catch (e) {
    throw new Error('La autorización de Google venció o fue revocada. Vuelve a conectar tu cuenta desde Integraciones.');
  }

  const nuevoAccessToken = tokenActual?.token;
  const credenciales = oauth2Client.credentials || {};
  if (nuevoAccessToken && nuevoAccessToken !== conexion.access_token) {
    await admin.from('google_calendar_conexiones').update({
      access_token: nuevoAccessToken,
      token_expiry: credenciales.expiry_date ? new Date(credenciales.expiry_date).toISOString() : null
    }).eq('user_id', userId);
  }

  return { oauth2Client, conexion, admin };
}

export function calendarClient(oauth2Client) {
  return google.calendar({ version: 'v3', auth: oauth2Client });
}
