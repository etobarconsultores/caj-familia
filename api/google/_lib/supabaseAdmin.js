import { createClient } from '@supabase/supabase-js';

// Cliente con la Service Role Key: ignora RLS por diseño de Supabase.
// SOLO se usa en este backend (Vercel Functions), nunca en el navegador.
// SUPABASE_SERVICE_ROLE_KEY NO debe tener el prefijo VITE_ — si lo tuviera,
// Vite la incluiría en el bundle público del frontend.
export function crearClienteAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Faltan las variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el backend.');
  }
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Verifica el token de sesión de Supabase que el frontend envía en el
// header Authorization: Bearer <token>. Usa la anon key (no la service
// role) solo para validar el JWT — es una operación segura y de solo
// lectura de identidad, igual que hace el propio frontend.
export async function obtenerUsuarioDesdeRequest(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
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
