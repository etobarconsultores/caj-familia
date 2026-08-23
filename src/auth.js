import { supabase } from './supabaseClient.js';

export async function signUp(email, password, nombreCompleto) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { nombre_completo: nombreCompleto || null }
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
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin
  });
  if (error) throw error;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}
