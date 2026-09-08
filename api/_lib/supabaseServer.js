import { createClient } from '@supabase/supabase-js';

// Cliente con la Service Role Key: ignora RLS por diseño de Supabase.
// SOLO se usa en este backend (Vercel Functions), nunca en el navegador.
// SUPABASE_SERVICE_ROLE_KEY NO debe tener el prefijo VITE_ -- si lo tuviera,
// Vite la incluiría en el bundle público del frontend.
//
// Regla obligatoria de esta fase: este cliente NUNCA se usa para decidir
// si una causa pertenece a la usuaria -- eso se resuelve siempre con
// crearClienteConJWT (abajo). Este cliente solo se usa contra
// security_settings / case_credentials, que no tienen ninguna policy para
// authenticated/anon y por eso requieren service_role.
export function crearClienteAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Faltan las variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el backend.');
  }
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Cliente que actúa CON LA IDENTIDAD de la propia usuaria (su JWT, no la
// service role) -- así RLS decide qué causas puede ver/editar, sin que el
// backend reimplemente a mano el chequeo de propiedad. Se usa siempre que
// la operación sea "leer/escribir una causa de esta usuaria".
export function crearClienteConJWT(jwt) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Faltan las variables de entorno SUPABASE_URL o SUPABASE_ANON_KEY en el backend.');
  }
  if (!jwt) {
    throw new Error('Falta el JWT de la usuaria para instanciar un cliente que respete RLS.');
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } }
  });
}

// Extrae el token del header Authorization: Bearer <token>.
export function extraerJwt(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  return token || null;
}

// Verifica el token de sesión que el frontend envía en el header
// Authorization: Bearer <token>. Usa la anon key (no la service role) solo
// para validar el JWT -- una operación segura y de solo lectura de
// identidad, igual que ya hace el backend de Google Calendar.
export async function obtenerUsuarioDesdeRequest(req) {
  const token = extraerJwt(req);
  if (!token) return null;

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Faltan las variables de entorno SUPABASE_URL o SUPABASE_ANON_KEY en el backend.');
  }
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export function requerirMetodo(req, res, metodos) {
  const lista = Array.isArray(metodos) ? metodos : [metodos];
  if (!lista.includes(req.method)) {
    res.status(405).json({ error: `Método no permitido. Usa: ${lista.join(', ')}` });
    return false;
  }
  return true;
}

// Verifica la contraseña actual de una usuaria ya autenticada, del lado
// del SERVIDOR. Deliberadamente NO importa nada de src/auth.js -- ese
// archivo es frontend (usa import.meta.env de Vite, que no existe en el
// entorno de ejecución de Vercel Functions) y no debe mezclarse con
// código de backend.
//
// Mismo mecanismo que la versión frontend (cliente Supabase temporal y
// aislado, persistSession:false, autoRefreshToken:false), reimplementado
// nativo para Node con las variables de entorno ya usadas por el resto de
// este backend (SUPABASE_URL/SUPABASE_ANON_KEY, sin prefijo VITE_).
export async function verificarContrasenaActualServidor(email, currentPassword) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Faltan las variables de entorno SUPABASE_URL o SUPABASE_ANON_KEY en el backend.');
  }
  const clienteTemporal = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  try {
    const { error } = await clienteTemporal.auth.signInWithPassword({ email, password: currentPassword });
    if (error) throw error;
  } finally {
    // scope:'local' -- revoca ÚNICAMENTE la sesión de este cliente
    // temporal. Si este cleanup falla, nunca debe reemplazar ni ocultar
    // el error de autenticación real que ya se haya lanzado arriba --
    // solo se registra como advertencia.
    try {
      await clienteTemporal.auth.signOut({ scope: 'local' });
    } catch (cleanupError) {
      console.warn('No se pudo cerrar la sesión temporal de verificación (backend).');
    }
  }
}
