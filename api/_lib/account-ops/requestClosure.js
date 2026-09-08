import { crearClienteAdmin, verificarContrasenaActualServidor, extraerJwt } from '../supabaseServer.js';

// Margen de seguridad: 29 días, no 30. El proceso de eliminación definitiva
// corre vía un cron diario -- si se programara exactamente a los 30 días,
// una ejecución del cron unas horas después del vencimiento exacto podría
// hacer que la eliminación efectiva ocurriera pasado el plazo máximo. Con
// 29 días, el cron diario siguiente siempre alcanza a procesarla dentro
// del plazo de 30 días real.
const MARGEN_RETENCION_DIAS = 29;

export async function requestClosure(req, res, usuario) {
  try {
    const { currentPassword } = req.body || {};
    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({ error: 'Ingresa tu contraseña actual.' });
    }

    // Verificación server-side, con un cliente temporal y aislado --
    // nunca importando código de src/auth.js (frontend).
    try {
      await verificarContrasenaActualServidor(usuario.email, currentPassword);
    } catch (e) {
      return res.status(403).json({ error: 'Contraseña actual incorrecta.' });
    }

    const admin = crearClienteAdmin();

    // No se debe poder extender el plazo con llamadas repetidas. Si ya
    // existe una solicitud vigente para esta usuaria, se devuelve tal
    // cual (mismo requested_at/scheduled_deletion_at originales) -- nunca
    // se reinicia el plazo. Solo reactivar primero (que borra esta fila)
    // permite luego iniciar un plazo nuevo.
    const { data: existente, error: errSelect } = await admin
      .from('account_deletion_requests')
      .select('requested_at, scheduled_deletion_at')
      .eq('user_id', usuario.id)
      .maybeSingle();
    if (errSelect) throw errSelect;

    if (existente) {
      return res.status(200).json({
        ok: true,
        requestedAt: existente.requested_at,
        scheduledDeletionAt: existente.scheduled_deletion_at,
        yaExistia: true
      });
    }

    // scheduled_deletion_at se calcula EXCLUSIVAMENTE acá, en el servidor
    // -- nunca se acepta un valor del cliente para este campo.
    const ahora = new Date();
    const scheduledDeletionAt = new Date(ahora.getTime() + MARGEN_RETENCION_DIAS * 24 * 60 * 60 * 1000).toISOString();

    // PASO 1: insertar la solicitud primero. Si esto falla, no hay nada
    // que revertir y no se intenta ninguna revocación de sesiones.
    const { error: errInsert } = await admin
      .from('account_deletion_requests')
      .insert({
        user_id: usuario.id,
        requested_at: ahora.toISOString(),
        scheduled_deletion_at: scheduledDeletionAt,
        requested_from: 'account_panel'
      });

    if (errInsert) {
      // Colisión detectada acá, en el propio INSERT (no en el SELECT
      // inicial de más arriba): significa que otra solicitud simultánea
      // ganó la carrera y ya insertó su fila. A diferencia del caso ya
      // existente detectado por el SELECT inicial, esta fila recién
      // apareció mientras esta misma petición estaba en curso -- esa
      // solicitud concurrente puede todavía estar en su propio paso de
      // revocación global de sesiones, y podría hacer ROLLBACK (borrar la
      // fila) segundos después si esa revocación le falla a ella.
      //
      // Por eso NO se devuelve 200/yaExistia:true acá: comunicar éxito en
      // este momento sería decir que el cierre quedó confirmado sin saber
      // todavía si el flujo concurrente terminó de completar su propia
      // revocación de sesiones. Se devuelve un estado controlado (409)
      // pidiendo reintentar, en vez de una confirmación prematura.
      //
      // Se distingue una colisión real (violación de unicidad sobre
      // user_id, código 23505 de Postgres) de cualquier otro error de
      // insert -- un error genuino de base de datos no relacionado con
      // concurrencia no debe enmascararse como si fuera una carrera.
      const esColision = errInsert.code === '23505' || /duplicate key|unique constraint/i.test(errInsert.message || '');
      if (esColision) {
        console.error('account.requestClosure: colisión detectada en el INSERT -- solicitud concurrente en curso, no se confirma éxito todavía.');
        return res.status(409).json({ error: 'Ya hay una solicitud de cierre de cuenta procesándose. Intenta nuevamente en unos segundos.' });
      }
      throw errInsert;
    }

    // PASO 2: recién con la solicitud ya registrada, intentar la
    // revocación global de sesiones. Si falla, se hace ROLLBACK explícito
    // borrando la fila recién insertada y se devuelve error -- nunca se
    // deja a la usuaria desconectada de sus otras sesiones sin que exista
    // una solicitud de cierre real, ni una solicitud registrada sin que
    // las sesiones se hayan invalidado. Solo se responde éxito cuando
    // ambas operaciones quedaron completas.
    const jwt = extraerJwt(req);
    try {
      const { error: errSignOut } = await admin.auth.admin.signOut(jwt, 'global');
      if (errSignOut) throw errSignOut;
    } catch (errSignOut) {
      console.error('account.requestClosure: fallo al invalidar las demás sesiones -- revirtiendo la solicitud recién creada:', errSignOut.message);
      try {
        const { error: errRollback } = await admin
          .from('account_deletion_requests')
          .delete()
          .eq('user_id', usuario.id);
        if (errRollback) throw errRollback;
      } catch (errRollback) {
        // Best-effort: si incluso el rollback falla, queda registrado en
        // el log para revisión manual -- de todas formas se informa el
        // error real a la usuaria, nunca un falso éxito.
        console.error('account.requestClosure: además falló el rollback de la solicitud tras el error de signOut:', errRollback.message);
      }
      return res.status(502).json({ error: 'No se pudo completar el cierre de forma segura (no se pudieron invalidar tus otras sesiones). Intenta nuevamente.' });
    }

    res.status(200).json({
      ok: true,
      requestedAt: ahora.toISOString(),
      scheduledDeletionAt,
      yaExistia: false
    });
  } catch (e) {
    console.error('account.requestClosure error:', e.message);
    res.status(500).json({ error: 'No se pudo procesar la solicitud de cierre.' });
  }
}
