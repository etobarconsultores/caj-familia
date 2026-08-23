import { google } from 'googleapis';
import { crearClienteAdmin } from './_lib/supabaseAdmin.js';
import { crearOAuthClient, verificarState } from './_lib/googleClient.js';

// Ruta pública (Google redirige aquí el navegador de la usuaria; no hay
// forma de adjuntar el header Authorization en una redirección de
// navegador). La identidad se valida a través del "state" firmado, no de
// una sesión — ver googleClient.js/verificarState.
export default async function handler(req, res) {
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  if (!appUrl) {
    res.status(500).send('Falta configurar la variable de entorno APP_URL en el backend.');
    return;
  }
  const destino = `${appUrl}/?integraciones=google`;

  const { code, state, error: errorGoogle } = req.query;

  if (errorGoogle) {
    res.redirect(302, `${destino}&google_error=${encodeURIComponent(String(errorGoogle))}`);
    return;
  }

  const userId = verificarState(state);
  if (!userId) {
    res.redirect(302, `${destino}&google_error=${encodeURIComponent('No se pudo validar la solicitud (state inválido).')}`);
    return;
  }
  if (!code) {
    res.redirect(302, `${destino}&google_error=${encodeURIComponent('Falta el código de autorización de Google.')}`);
    return;
  }

  try {
    const oauth2Client = crearOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);

    // Requiere los scopes 'openid' + 'userinfo.email' (ver googleClient.js).
    // Solo se usa para identificar la cuenta conectada; no da acceso a Gmail.
    let email = null;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data } = await oauth2.userinfo.get();
      email = data.email || null;
    } catch (e) {
      console.warn('No se pudo obtener el correo de la cuenta Google conectada:', e.message);
    }

    const admin = crearClienteAdmin();
    const patch = {
      user_id: userId,
      access_token: tokens.access_token || null,
      token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      google_account_email: email
    };
    // Google solo reenvía refresh_token la primera vez (o con prompt=consent,
    // que ya forzamos siempre en auth-url.js). Si no viene uno nuevo, no se
    // sobrescribe el que ya teníamos guardado.
    if (tokens.refresh_token) patch.refresh_token = tokens.refresh_token;

    const { error } = await admin.from('google_calendar_conexiones').upsert(patch, { onConflict: 'user_id' });
    if (error) throw error;

    res.redirect(302, `${destino}&google_connected=1`);
  } catch (e) {
    console.error('callback error:', e);
    res.redirect(302, `${destino}&google_error=${encodeURIComponent(e.message || 'Error desconocido')}`);
  }
}
