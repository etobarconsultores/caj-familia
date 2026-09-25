const MODULE_ID = 'familia';
const DEFAULT_CORE_URL = 'https://practicajuris-core.vercel.app';

function coreEndpoint() {
  const base = String(process.env.PRACTICAJURIS_CORE_URL || DEFAULT_CORE_URL)
    .trim()
    .replace(/\/+$/, '');
  return `${base}/api/module-entry`;
}

export async function moduleAccessCheck(req, res, usuario) {
  res.setHeader('Cache-Control', 'no-store');

  if (!usuario?.id) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const sharedSecret = process.env.MODULE_ENTRY_SHARED_SECRET;
  if (!sharedSecret) {
    console.error('api/security module.accessCheck: falta MODULE_ENTRY_SHARED_SECRET.');
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
        operation: 'validate-module-access',
        moduleId: MODULE_ID,
        moduleUserId: usuario.id
      })
    });
  } catch (error) {
    console.error(
      'api/security module.accessCheck: no se pudo contactar al Core:',
      error?.message || error
    );
    return res.status(503).json({
      error: 'No pudimos verificar tu acceso con Práctica Juris.',
      code: 'CORE_UNAVAILABLE'
    });
  }

  let payload = null;
  try {
    payload = await coreResponse.json();
  } catch (_) {
    payload = null;
  }

  if (!coreResponse.ok) {
    if (coreResponse.status === 403) {
      return res.status(403).json({
        error: 'Tu cuenta no tiene acceso habilitado a Práctica Familia.',
        code: 'MODULE_ACCESS_DENIED'
      });
    }

    console.error(
      'api/security module.accessCheck: Core rechazó la validación:',
      coreResponse.status
    );
    return res.status(503).json({
      error: 'No pudimos verificar tu acceso con Práctica Juris.',
      code: 'CORE_ACCESS_CHECK_FAILED'
    });
  }

  if (payload?.allowed !== true || payload?.moduleId !== MODULE_ID) {
    console.error('api/security module.accessCheck: respuesta inválida del Core.');
    return res.status(503).json({
      error: 'No pudimos verificar tu acceso con Práctica Juris.',
      code: 'CORE_INVALID_RESPONSE'
    });
  }

  return res.status(200).json({
    allowed: true,
    moduleId: MODULE_ID
  });
}
