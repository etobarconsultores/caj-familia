import { extraerJwt, crearClienteConJWT, crearClienteAdmin } from '../supabaseServer.js';
import { cifrarCredencial } from '../crypto.js';
import { esUuidValido, columnaParaCampo, eliminarEsValido, eliminarEsTrue } from '../validation.js';

// Lógica idéntica a la del antiguo api/credentials/save.js. El método y el
// JWT ya fueron validados una sola vez por el dispatcher (api/security.js),
// que pasa `usuario` ya resuelto.
export async function credentialsSave(req, res, usuario) {
  try {
    const { causaId, campo, valor, eliminar } = req.body || {};

    if (!esUuidValido(causaId)) {
      return res.status(400).json({ error: 'causaId inválido.' });
    }
    const columna = columnaParaCampo(campo);
    if (!columna) {
      return res.status(400).json({ error: 'campo inválido. Debe ser "claveWeb" o "claveUnica".' });
    }
    if (!eliminarEsValido(eliminar)) {
      return res.status(400).json({ error: 'eliminar debe ser un booleano explícito (true/false).' });
    }
    const seEliminar = eliminarEsTrue(eliminar);

    // "No cambiar": valor ausente y sin pedir eliminar -> no se toca nada,
    // ni siquiera se llega a validar la causa contra Supabase.
    if (!seEliminar && (valor === undefined || valor === null)) {
      return res.status(200).json({ ok: true, sinCambios: true });
    }

    // Si se está reemplazando, el valor debe ser un string explícito --
    // nunca se convierte silenciosamente un objeto/número/booleano
    // mediante String(valor). Un string vacío tampoco se acepta como
    // "reemplazar": para vaciar una credencial existe la acción explícita
    // de eliminar.
    if (!seEliminar) {
      if (typeof valor !== 'string') {
        return res.status(400).json({ error: 'valor debe ser un string.' });
      }
      if (valor.length === 0) {
        return res.status(400).json({ error: 'valor no puede ser un string vacío. Usa "eliminar" para borrar la credencial.' });
      }
    }

    // Regla obligatoria: la propiedad de la causa se verifica SIEMPRE con
    // el JWT de la propia usuaria (RLS decide), nunca con service_role.
    const jwt = extraerJwt(req);
    const clienteUsuaria = crearClienteConJWT(jwt);
    const { data: causa, error: errCausa } = await clienteUsuaria
      .from('causas')
      .select('id')
      .eq('id', causaId)
      .maybeSingle();
    if (errCausa) throw errCausa;
    if (!causa) {
      return res.status(403).json({ error: 'La causa no existe o no te pertenece.' });
    }

    const admin = crearClienteAdmin();
    const nuevoValorColumna = seEliminar
      ? null
      : cifrarCredencial(valor, { userId: usuario.id, causaId, campo });

    const { error: errUpsert } = await admin
      .from('case_credentials')
      .upsert(
        { causa_id: causaId, user_id: usuario.id, [columna]: nuevoValorColumna },
        { onConflict: 'causa_id' }
      );
    if (errUpsert) throw errUpsert;

    res.status(200).json({ ok: true, guardada: !seEliminar });
  } catch (e) {
    // Nunca se loguea el valor de la credencial, ni en texto plano ni ya
    // cifrado -- solo el mensaje técnico interno.
    console.error('credentials.save error:', e.message);
    res.status(500).json({ error: 'No se pudo guardar la credencial.' });
  }
}
