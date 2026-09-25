import { supabase } from './supabaseClient.js';

export async function signUp(email, password, nombreCompleto, legalAcceptance = {}) {
  const {
    termsAccepted = false,
    privacyAcknowledged = false,
    securityAcknowledged = false
  } = legalAcceptance;

  if (!termsAccepted || !privacyAcknowledged || !securityAcknowledged) {
    throw new Error('Debes aceptar los Términos y declarar haber leído las políticas de Privacidad y Seguridad para crear tu cuenta.');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        nombre_completo: nombreCompleto || null,
        legal_terms_accepted: true,
        legal_privacy_acknowledged: true,
        legal_security_acknowledged: true,
        legal_acceptance_source: 'registration'
      }
    }
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function sendPasswordReset(email) {
  // Marca explícitamente el retorno como recuperación. Así app.js puede
  // bloquear cualquier INITIAL_SESSION/SIGNED_IN que llegue antes del evento
  // PASSWORD_RECOVERY y mostrar siempre el formulario de nueva contraseña.
  const redirectTo = `${window.location.origin}/?password_recovery=1`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}


// Entrada federada desde Práctica Juris Core.
// El código efímero se entrega al backend de Familia, que lo valida con el
// Core y devuelve únicamente un token hash canjeable por una sesión Supabase.
export async function validateCoreModuleAccess(session) {
  const accessToken = session?.access_token;
  if (!accessToken) {
    const error = new Error('La sesión de Práctica Familia no está disponible.');
    error.code = 'FAMILIA_SESSION_UNAVAILABLE';
    throw error;
  }

  const response = await fetch('/api/security', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ operation: 'module.accessCheck' })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error || 'No pudimos verificar tu acceso a Práctica Familia.'
    );
    error.status = response.status;
    error.code = payload?.code || 'MODULE_ACCESS_CHECK_FAILED';
    throw error;
  }

  if (payload?.allowed !== true || payload?.moduleId !== 'familia') {
    const error = new Error('No pudimos verificar tu acceso a Práctica Familia.');
    error.status = 503;
    error.code = 'CORE_INVALID_RESPONSE';
    throw error;
  }

  return payload;
}


export async function signInFromCoreEntry(code) {
  const normalizedCode = String(code || '').trim();
  if (normalizedCode.length < 32 || normalizedCode.length > 256) {
    throw new Error('El acceso temporal no es válido.');
  }

  // Si había una sesión Familia previa, se elimina localmente antes del
  // canje para que nunca quede abierta una cuenta distinta de la seleccionada.
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData?.session) {
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
    if (signOutError) throw signOutError;
  }

  const response = await fetch('/api/security', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: 'module.entry',
      code: normalizedCode
    })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || 'No pudimos validar el acceso desde Práctica Juris.');
  }

  const tokenHash = String(payload?.tokenHash || '').trim();
  if (!tokenHash) {
    throw new Error('El servidor no devolvió una autorización válida para Práctica Familia.');
  }

  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'email'
  });

  if (error) throw error;
  if (!data?.session || !data?.user) {
    throw new Error('No pudimos iniciar la sesión de Práctica Familia.');
  }

  return data;
}

// Verifica la contraseña actual de la cuenta usando un cliente Supabase
// TEMPORAL Y AISLADO -- nunca el cliente principal (`supabase`) -- para que
// la sesión que se crea al validar no reemplace ni interfiera con la
// sesión principal de CAJ-Civil, y para que el evento SIGNED_IN que dispara
// signInWithPassword no llegue jamás a los suscriptores del cliente
// principal (cada instancia de GoTrueClient tiene su propio registro de
// suscriptores, completamente separado).
//
// persistSession:false / autoRefreshToken:false / detectSessionInUrl:false
// -- el cliente temporal nunca escribe a localStorage ni programa ningún
// temporizador de refresco.
export async function verificarContrasenaActual(email, currentPassword) {
  const { createClient } = await import('@supabase/supabase-js');
  const clienteTemporal = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );
  try {
    const { error } = await clienteTemporal.auth.signInWithPassword({ email, password: currentPassword });
    if (error) throw error;
  } finally {
    // scope:'local' -- revoca ÚNICAMENTE la sesión de este cliente
    // temporal (nunca la sesión principal, que pertenece a la misma
    // cuenta pero es un token distinto en una instancia distinta). Si
    // este cleanup falla, nunca debe reemplazar ni ocultar el error de
    // autenticación real que ya se haya lanzado arriba -- solo se
    // registra como advertencia.
    try {
      await clienteTemporal.auth.signOut({ scope: 'local' });
    } catch (cleanupError) {
      console.warn('No se pudo cerrar la sesión temporal de verificación.');
    }
  }
}

// Aplica la contraseña nueva con el cliente PRINCIPAL -- a diferencia de la
// verificación, este cambio sí debe aplicarse sobre la sesión real de la
// usuaria. Dispara USER_UPDATED en el cliente principal (comportamiento
// nativo de Supabase Auth, no evitable) -- ver onAuthStateChange más abajo
// para el ajuste que evita que esto dispare una recarga completa de la app.
export async function changePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => callback(event, session));
}

// ============================================================================
// Verificación en 2 pasos (TOTP) -- infraestructura nativa de Supabase Auth,
// sin proveedor externo y sin SMS. Solo se envuelve la API ya existente del
// SDK (supabase.auth.mfa); ninguna de estas funciones imprime en consola el
// código QR, el secreto TOTP ni el código ingresado por la usuaria.
// ============================================================================

// Nivel de autenticación (AAL) de la sesión actual. currentLevel es el
// nivel real de la sesión; nextLevel es el nivel máximo alcanzable dado
// los factores inscritos. Si nextLevel es 'aal2' y currentLevel todavía no
// lo es, la usuaria tiene un factor MFA verificado pendiente de completar
// -- exactamente la señal que se usa para bloquear el acceso a la app
// hasta que verifique su TOTP.
export async function mfaGetAal() {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  return data;
}

// Lista los factores MFA ya inscritos (verificados o no) para decidir el
// estado inicial: si existe un factor TOTP verificado, ya está Activo.
export async function mfaListFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data;
}

// Inicia la inscripción de un factor TOTP nuevo (queda "unverified" hasta
// que se confirme con un código). Devuelve id del factor, el QR (SVG) y el
// secreto para ingreso manual.
export async function mfaEnrollTotp() {
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error) throw error;
  return data;
}

// Crea el desafío y verifica el código en una sola llamada (challengeAndVerify
// ya combina ambos pasos). Al verificar con éxito, Supabase promueve la
// sesión a aal2 -- esto dispara un evento de sesión (USER_UPDATED/
// TOKEN_REFRESHED, según la versión), ya manejado por onAuthStateChange sin
// recargar la app.
export async function mfaVerificarTotp(factorId, code) {
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw error;
  return data;
}

// Elimina un factor (verificado o no). Se usa tanto para desactivar un
// factor Activo como para limpiar un factor a medio inscribir si la usuaria
// cancela el proceso.
export async function mfaDesinscribir(factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}

