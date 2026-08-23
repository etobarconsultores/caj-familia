import { obtenerUsuarioDesdeRequest, crearClienteAdmin, requerirMetodo } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (!requerirMetodo(req, res, 'GET')) return;
  try {
    const usuario = await obtenerUsuarioDesdeRequest(req);
    if (!usuario) return res.status(401).json({ error: 'No autenticado' });

    const admin = crearClienteAdmin();
    const { data, error } = await admin
      .from('google_calendar_conexiones')
      .select('google_account_email,calendar_id,calendar_summary,sync_automatica,recordatorios_default,recordatorios_por_tipo,ultima_sincronizacion_at,refresh_token')
      .eq('user_id', usuario.id)
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      return res.status(200).json({ conectado: false });
    }

    // Nunca se devuelve access_token ni refresh_token al frontend: solo se
    // usa aquí, server-side, para calcular si hay una conexión utilizable.
    res.status(200).json({
      conectado: !!data.refresh_token,
      cuenta: data.google_account_email || null,
      calendarId: data.calendar_id || null,
      calendarNombre: data.calendar_summary || null,
      syncAutomatica: data.sync_automatica,
      recordatoriosDefault: data.recordatorios_default,
      recordatoriosPorTipo: data.recordatorios_por_tipo,
      ultimaSincronizacion: data.ultima_sincronizacion_at
    });
  } catch (e) {
    console.error('status error:', e);
    res.status(500).json({ error: e.message });
  }
}
