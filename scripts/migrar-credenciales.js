// Migración única, server-side: copia causas.clave_web / causas.clave_unica
// (texto plano) hacia case_credentials.clave_web_enc / clave_unica_enc
// (cifrado con AES-256-GCM + AAD), reutilizando exactamente el mismo
// helper que usa el backend en producción (api/_lib/crypto.js), incluido
// el mismo contexto de AAD (userId + causaId + campo) que usan
// api/credentials/save.js y api/credentials/reveal.js.
//
// ESTADO: preparado, NO EJECUTADO. Se corre manualmente, una sola vez,
// después de aplicar el SQL de esta fase y de desplegar el backend nuevo.
//
// Requiere las variables de entorno: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY.
//
// Corrección de esta ronda: procesa las causas por lotes (paginación),
// en vez de depender de que una sola consulta devuelva de una vez todas
// las filas -- razonable para cualquier volumen de causas, sin cargar
// todo en memoria de golpe.
//
// Idempotente: solo procesa causas cuyo campo "_enc" correspondiente
// todavía esté vacío -- nunca sobrescribe una credencial ya migrada.
// Nunca imprime valores en texto plano ni cifrados en la consola, solo
// ids de causa y mensajes de error.

import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { cifrarCredencial } from '../api/_lib/crypto.js';

const TAMANO_LOTE = 200;

function crearClienteAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno.');
  }
  // Uso de service_role: aceptable acá y solo acá, porque esta es una
  // migración administrativa única que necesita recorrer las causas de
  // TODOS los usuarios -- no una operación normal de la app en nombre de
  // una usuaria puntual.
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

// campoOrigen/campoDestino: nombres de columna en la base (clave_web /
// clave_web_enc). campoApi: el mismo identificador que usan save.js y
// reveal.js ('claveWeb' / 'claveUnica') -- entra en el AAD, tiene que ser
// idéntico o el descifrado en producción fallará.
async function migrarCampo(admin, causa, campoOrigen, campoDestino, campoApi, resumen) {
  const valorPlano = causa[campoOrigen];
  if (!valorPlano) return; // nada que migrar en este campo para esta causa

  resumen.revisadas += 1;

  const { data: existente, error: errExistente } = await admin
    .from('case_credentials')
    .select(campoDestino)
    .eq('causa_id', causa.id)
    .maybeSingle();
  if (errExistente) {
    resumen.errores.push({ causaId: causa.id, campo: campoOrigen, mensaje: errExistente.message });
    return;
  }
  if (existente && existente[campoDestino]) {
    // Ya migrada: se salta, nunca se sobrescribe.
    resumen.yaMigradas += 1;
    return;
  }

  try {
    const cifrado = cifrarCredencial(valorPlano, { userId: causa.user_id, causaId: causa.id, campo: campoApi });
    const { error: errUpsert } = await admin
      .from('case_credentials')
      .upsert(
        { causa_id: causa.id, user_id: causa.user_id, [campoDestino]: cifrado },
        { onConflict: 'causa_id' }
      );
    if (errUpsert) throw errUpsert;
    resumen.migradas += 1;
  } catch (e) {
    resumen.errores.push({ causaId: causa.id, campo: campoOrigen, mensaje: e.message });
  }
}

// Trae un lote de causas con al menos un campo en texto plano, ordenadas
// por id para que la paginación por rango sea estable entre lotes.
async function traerLote(admin, offset, tamano) {
  const { data, error } = await admin
    .from('causas')
    .select('id, user_id, clave_web, clave_unica')
    .or('clave_web.not.is.null,clave_unica.not.is.null')
    .order('id', { ascending: true })
    .range(offset, offset + tamano - 1);
  if (error) throw error;
  return data || [];
}

export async function ejecutarMigracion() {
  const admin = crearClienteAdmin();
  const resumen = { lotes: 0, causasProcesadas: 0, revisadas: 0, migradas: 0, yaMigradas: 0, errores: [] };

  let offset = 0;
  while (true) {
    const lote = await traerLote(admin, offset, TAMANO_LOTE);
    if (lote.length === 0) break;

    resumen.lotes += 1;
    resumen.causasProcesadas += lote.length;

    for (const causa of lote) {
      await migrarCampo(admin, causa, 'clave_web', 'clave_web_enc', 'claveWeb', resumen);
      await migrarCampo(admin, causa, 'clave_unica', 'clave_unica_enc', 'claveUnica', resumen);
    }

    console.log(`  Lote ${resumen.lotes} procesado (${lote.length} causas, offset ${offset}).`);

    if (lote.length < TAMANO_LOTE) break; // último lote (más corto que el tamaño pedido)
    offset += TAMANO_LOTE;
  }

  console.log('Migración de credenciales -- resumen:');
  console.log('  Lotes procesados:', resumen.lotes);
  console.log('  Causas procesadas en total:', resumen.causasProcesadas);
  console.log('  Campos revisados (con valor a migrar):', resumen.revisadas);
  console.log('  Migrados en esta corrida:', resumen.migradas);
  console.log('  Ya estaban migrados (se saltaron):', resumen.yaMigradas);
  console.log('  Errores:', resumen.errores.length);
  if (resumen.errores.length) {
    console.log('  Detalle de errores (sin valores sensibles):', JSON.stringify(resumen.errores, null, 2));
  }
  return resumen;
}

// Permite ejecutarlo directo con `node scripts/migrar-credenciales.js`.
// No se ejecuta como parte de ningún build ni deploy automático.
//
// Comparación robusta multiplataforma: construir "file://" a mano sobre
// process.argv[1] falla en Windows (rutas con backslash y con letra de
// unidad, ej. "C:\proyecto\..."), porque no coincide con el formato real
// de import.meta.url. pathToFileURL() hace esa conversión correctamente
// en cualquier sistema operativo.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Finalización: NO se fuerza process.exit() en ningún caso. Forzar la
  // salida mientras aún pueden existir handles internos (sockets de
  // fetch/undici, temporizadores de reintento del cliente de Supabase,
  // etc.) todavía cerrándose es lo que producía el
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" reportado en
  // Windows con Node 24. Dejando que el event loop se vacíe solo, Node
  // termina de forma natural una vez que esos handles ya se cerraron.
  ejecutarMigracion()
    .catch((e) => {
      console.error('Migración abortada:', e.message);
      process.exitCode = 1;
    });
}
