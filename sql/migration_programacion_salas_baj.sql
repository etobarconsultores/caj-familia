-- ============================================================================
-- MIGRACIÓN INCREMENTAL — "BAJ y Programación de salas"
-- ============================================================================
-- Principios:
--   - NO elimina tablas, columnas ni registros.
--   - Todo es ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS, seguro
--     de ejecutar más de una vez.
--   - No modifica RLS ni políticas de ninguna tabla existente, salvo para
--     habilitar RLS en la tabla nueva "revisiones_sala".
--   - No toca "revision_pjud"/"ultima_revision_at" ni ningún otro control ya
--     existente: Programación de salas es un control independiente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) BAJ (Beneficio de Asistencia Judicial) — nuevo campo en causas
-- ----------------------------------------------------------------------------
alter table public.causas
  add column if not exists baj_estado text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'causas_baj_estado_check') then
    alter table public.causas
      add constraint causas_baj_estado_check
      check (baj_estado in ('acompanado', 'solicitar', 'no_acompanado') or baj_estado is null);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2) PROGRAMACIÓN DE SALAS — historial de revisiones de tabla de alegatos
--    para causas con recurso de apelación. Control independiente de
--    Revisión PJUD: no comparte checkbox ni fecha de revisión con ella.
-- ----------------------------------------------------------------------------
create table if not exists public.revisiones_sala (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  causa_id uuid not null references public.causas(id) on delete cascade,

  fecha date not null default current_date,
  hora text,
  resultado text not null default 'Sin programación' check (resultado in (
    'Sin programación', 'En tabla', 'Suspendida', 'Reprogramada', 'Vista', 'Otro'
  )),
  observacion text,

  -- Datos opcionales cuando el resultado es "En tabla"
  fecha_alegato date,
  sala text,
  numero_tabla text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_revisiones_sala_user_id on public.revisiones_sala(user_id);
create index if not exists idx_revisiones_sala_causa_id on public.revisiones_sala(causa_id);
create index if not exists idx_revisiones_sala_fecha on public.revisiones_sala(fecha);

drop trigger if exists trg_revisiones_sala_updated_at on public.revisiones_sala;
create trigger trg_revisiones_sala_updated_at
  before update on public.revisiones_sala
  for each row execute procedure public.set_updated_at();

alter table public.revisiones_sala enable row level security;

drop policy if exists "revisiones_sala_select_own" on public.revisiones_sala;
create policy "revisiones_sala_select_own" on public.revisiones_sala for select using (auth.uid() = user_id);
drop policy if exists "revisiones_sala_insert_own" on public.revisiones_sala;
create policy "revisiones_sala_insert_own" on public.revisiones_sala for insert with check (auth.uid() = user_id);
drop policy if exists "revisiones_sala_update_own" on public.revisiones_sala;
create policy "revisiones_sala_update_own" on public.revisiones_sala for update using (auth.uid() = user_id);
drop policy if exists "revisiones_sala_delete_own" on public.revisiones_sala;
create policy "revisiones_sala_delete_own" on public.revisiones_sala for delete using (auth.uid() = user_id);

-- ============================================================================
-- FIN DE LA MIGRACIÓN
-- No se eliminó ninguna tabla, columna ni registro existente. Eliminar una
-- revisión de sala nunca elimina la causa (on delete cascade es solo en la
-- dirección revisiones_sala -> causas, no al revés).
-- ============================================================================
