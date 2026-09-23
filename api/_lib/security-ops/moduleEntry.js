import { crearClienteAdmin } from '../supabaseServer.js';

const MODULE_ID = 'familia';
const DEFAULT_CORE_URL = 'https://practicajuris-core.vercel.app';

function coreEndpoint() {
  const base = String(process.env.PRACTICAJURIS_CORE_URL || DEFAULT_CORE_URL)
    .trim()
    .replace(/\/+$/, '');
  return `${base}/api/module-entry`;
}

export async function moduleEntry(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (code.length < 32 || code.length > 256) {
    return res.status(400).json({ error: 'Código de acceso no válido.' });
  }

  const sharedSecret = process.env.MODULE_ENTRY_SHARED_SECRET;
  if (!sharedSecret) {
    console.error('api/security module.entry: falta MODULE_ENTRY_SHARED_SECRET.');
    return res.status(500).json({ error: 'Configuración del servidor incompleta.' });
  }

  let coreResponse;
  try {
    coreResponse = await fetch(coreEndpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-practicajuris-module-secret': sharedSecret
      },
      body: JSON.stringify({
        operation: 'consume',
        moduleId: MODULE_ID,
        code
      })
    });
  } catch (error) {
    console.error('api/security module.entry: no se pudo contactar al Core:', error?.message || error);
    return res.status(502).json({ error: 'No pudimos validar el acceso con Práctica Juris.' });
  }

  let corePayload = null;
  try {
    corePayload = await coreResponse.json();
  } catch {
    corePayload = null;
  }

  if (!coreResponse.ok) {
    const safeMessage =
      corePayload?.error === 'El acceso temporal no es válido o ya expiró.'
        ? corePayload.error
        : 'No pudimos validar el acceso temporal.';
    return res.status(coreResponse.status === 401 ? 401 : 403).json({ error: safeMessage });
  }

  const moduleUserId = String(corePayload?.moduleUserId || '').trim();
  if (corePayload?.moduleId !== MODULE_ID || !moduleUserId) {
    console.error('api/security module.entry: respuesta inválida del Core.');
    return res.status(502).json({ error: 'Respuesta inválida de Práctica Juris.' });
  }

  const admin = crearClienteAdmin();

  // El Core entrega solo el UUID vinculado. Familia vuelve a resolver al
  // usuario directamente en SU propio proyecto Supabase antes de generar acceso.
  const { data: userData, error: userError } = await admin.auth.admin.getUserById(moduleUserId);
  const moduleUser = userData?.user;

  if (userError || !moduleUser?.email || moduleUser.id !== moduleUserId) {
    console.error('api/security module.entry: usuario Familia vinculado no encontrado.');
    return res.status(403).json({ error: 'La cuenta no está vinculada correctamente con Práctica Familia.' });
  }

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: moduleUser.email
  });

  const tokenHash = linkData?.properties?.hashed_token;
  const generatedUserId = linkData?.user?.id;

  if (linkError || !tokenHash || generatedUserId !== moduleUserId) {
    console.error('api/security module.entry: no se pudo generar el acceso Supabase Familia:', linkError?.message || 'respuesta incompleta');
    return res.status(500).json({ error: 'No pudimos iniciar la sesión de Práctica Familia.' });
  }

  return res.status(200).json({
    tokenHash,
    verificationType: 'magiclink'
  });
}
