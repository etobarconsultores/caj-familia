-- ============================================================================
-- MIGRACIÓN INCREMENTAL — "Integración con Google Calendar"
-- ============================================================================
-- Principios:
--   - NO elimina tablas, columnas ni registros existentes (Agenda, causas,
--     audiencias, cronología, etc. quedan intactos).
--   - Todo es ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS, seguro
--     de ejecutar más de una vez.
--   - Las tablas nuevas que guardan tokens de Google NO tienen ninguna
--     política RLS que permita acceso desde el rol "authenticated" (el que
--     usa el frontend con la anon key). Solo el backend (Vercel Functions),
--     usando la Service Role Key de Supabase —que ignora RLS por diseño—,
--     puede leer o escribir esa tabla. El frontend nunca puede leer tokens,
--     ni siquiera el suyo propio, ni por error.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) agenda_eventos: campos de sincronización con Google Calendar
-- ----------------------------------------------------------------------------
alter table public.agenda_eventos
  add column if not exists google_event_id text,
  add column if not exists google_calendar_id text,
  add column if not exists google_sync_status text,
  add column if not exists google_last_sync_at timestamptz,
  add column if not exists google_sync_error text,
  add column if not exists recordatorios jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agenda_eventos_google_sync_status_check') then
    alter table public.agenda_eventos
      add constraint agenda_eventos_google_sync_status_check
      check (google_sync_status in ('pending', 'synced', 'error', 'deleted') or google_sync_status is null);
  end if;
end $$;

create index if not exists idx_agenda_eventos_google_sync_status on public.agenda_eventos(google_sync_status);

-- ----------------------------------------------------------------------------
-- 2) Conexión de Google Calendar por usuaria (tokens y preferencias).
--    Tabla protegida: SIN políticas RLS para "authenticated"/"anon". Solo
--    accesible desde el backend con la Service Role Key.
-- ----------------------------------------------------------------------------
create table if not exists public.google_calendar_conexiones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,

  access_token text,
  refresh_token text,
  token_expiry timestamptz,

  google_account_email text,
  calendar_id text,
  calendar_summary text,

  sync_automatica boolean not null default true,
  recordatorios_default jsonb not null default '[{"minutos":1440},{"minutos":60}]'::jsonb,
  recordatorios_por_tipo jsonb,

  ultima_sincronizacion_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_google_calendar_conexiones_user_id on public.google_calendar_conexiones(user_id);

drop trigger if exists trg_google_calendar_conexiones_updated_at on public.google_calendar_conexiones;
create trigger trg_google_calendar_conexiones_updated_at
  before update on public.google_calendar_conexiones
  for each row execute procedure public.set_updated_at();

alter table public.google_calendar_conexiones enable row level security;
-- Deliberadamente sin ninguna política: nadie autenticado vía anon key puede
-- leer ni escribir esta tabla. Solo el backend con la Service Role Key.

-- ----------------------------------------------------------------------------
-- 3) Log simple de sincronización (diagnóstico, no crítico).
--    La usuaria puede LEER sus propios registros (útil para ver errores),
--    pero solo el backend (service role) puede insertar/actualizar/eliminar.
-- ----------------------------------------------------------------------------
create table if not exists public.calendar_sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agenda_evento_id uuid references public.agenda_eventos(id) on delete cascade,
  accion text not null check (accion in ('create', 'update', 'delete', 'retry', 'bulk_sync')),
  fecha timestamptz not null default now(),
  resultado text not null check (resultado in ('success', 'error')),
  mensaje text
);

create index if not exists idx_calendar_sync_log_user_id on public.calendar_sync_log(user_id);
create index if not exists idx_calendar_sync_log_evento_id on public.calendar_sync_log(agenda_evento_id);

alter table public.calendar_sync_log enable row level security;

drop policy if exists "calendar_sync_log_select_own" on public.calendar_sync_log;
create policy "calendar_sync_log_select_own" on public.calendar_sync_log for select using (auth.uid() = user_id);
-- Sin políticas de insert/update/delete para "authenticated": solo el
-- backend (service role) escribe en este log.

-- ============================================================================
-- FIN DE LA MIGRACIÓN
-- No se eliminó ninguna tabla, columna ni registro existente. Agenda, causas,
-- audiencias y cronología quedan íntegramente intactas.
-- ============================================================================
