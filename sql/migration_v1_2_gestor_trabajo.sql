-- ============================================================================
-- MIGRACIÓN INCREMENTAL — v1.2 "Gestor de Trabajo Jurídico"
-- ============================================================================
-- Principios de esta migración:
--   - NO elimina tablas.
--   - NO elimina columnas ni registros.
--   - Todos los cambios son ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
--     EXISTS, así que es seguro ejecutarla más de una vez.
--   - Las columnas antiguas de "instrucción del tutor" en "causas"
--     (detalle_instruccion, instruccion_fecha_limite, instruccion_estado)
--     NO se eliminan; se migran hacia una tabla nueva de historial y quedan
--     como respaldo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) GESTIONES: se extiende gestiones_pendientes con los campos de la nueva
--    "unidad de trabajo" (categoría, prioridad, estado ampliado, fecha de
--    revisión, fecha límite opcional, observaciones). Las filas existentes
--    quedan automáticamente en estado 'Pendiente'.
-- ----------------------------------------------------------------------------
alter table public.gestiones_pendientes
  add column if not exists categoria text,
  add column if not exists prioridad text,
  add column if not exists estado text not null default 'Pendiente',
  add column if not exists fecha_revision date,
  add column if not exists fecha_limite date,
  add column if not exists observaciones text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'gestiones_pendientes_estado_check'
  ) then
    alter table public.gestiones_pendientes
      add constraint gestiones_pendientes_estado_check
      check (estado in ('Pendiente','En espera','Realizada','Cancelada'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'gestiones_pendientes_prioridad_check'
  ) then
    alter table public.gestiones_pendientes
      add constraint gestiones_pendientes_prioridad_check
      check (prioridad in ('Urgente','Semi urgente','No prioritario') or prioridad is null);
  end if;
end $$;

create index if not exists idx_gestpend_estado on public.gestiones_pendientes(estado);
create index if not exists idx_gestpend_fecha_revision on public.gestiones_pendientes(fecha_revision);

-- ----------------------------------------------------------------------------
-- 2) INSTRUCCIONES DEL TUTOR: pasan de ser 3 columnas en "causas" a un
--    historial (tabla nueva). Las columnas antiguas de "causas" NO se tocan.
-- ----------------------------------------------------------------------------
create table if not exists public.instrucciones_tutor (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  causa_id uuid not null references public.causas(id) on delete cascade,
  tutor text,
  fecha date not null default current_date,
  instruccion text not null,
  fecha_limite date,
  estado text not null default 'Pendiente' check (estado in ('Pendiente','Cumplida')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_instrucciones_user_id on public.instrucciones_tutor(user_id);
create index if not exists idx_instrucciones_causa_id on public.instrucciones_tutor(causa_id);

drop trigger if exists trg_instrucciones_updated_at on public.instrucciones_tutor;
create trigger trg_instrucciones_updated_at
  before update on public.instrucciones_tutor
  for each row execute procedure public.set_updated_at();

alter table public.instrucciones_tutor enable row level security;

drop policy if exists "instrucciones_select_own" on public.instrucciones_tutor;
create policy "instrucciones_select_own" on public.instrucciones_tutor for select using (auth.uid() = user_id);
drop policy if exists "instrucciones_insert_own" on public.instrucciones_tutor;
create policy "instrucciones_insert_own" on public.instrucciones_tutor for insert with check (auth.uid() = user_id);
drop policy if exists "instrucciones_update_own" on public.instrucciones_tutor;
create policy "instrucciones_update_own" on public.instrucciones_tutor for update using (auth.uid() = user_id);
drop policy if exists "instrucciones_delete_own" on public.instrucciones_tutor;
create policy "instrucciones_delete_own" on public.instrucciones_tutor for delete using (auth.uid() = user_id);

-- Migrar la instrucción única que ya existía por causa (si tenía contenido),
-- evitando duplicados si el script se ejecuta más de una vez.
insert into public.instrucciones_tutor (user_id, causa_id, tutor, fecha, instruccion, fecha_limite, estado, created_at)
select
  c.user_id,
  c.id,
  c.tutor,
  coalesce(c.fecha_ingreso, c.created_at::date, current_date),
  c.detalle_instruccion,
  c.instruccion_fecha_limite,
  case when c.instruccion_estado = 'Gestionado' then 'Cumplida' else 'Pendiente' end,
  now()
from public.causas c
where c.detalle_instruccion is not null
  and trim(c.detalle_instruccion) <> ''
  and not exists (
    select 1 from public.instrucciones_tutor it
    where it.causa_id = c.id and it.instruccion = c.detalle_instruccion
  );

-- ----------------------------------------------------------------------------
-- 3) ÚLTIMA REVISIÓN PJUD (por causa): un solo timestamp de control interno.
--    Usado tanto por el módulo "Revisión PJUD" como por el botón individual
--    "Actualizar revisión" dentro de cada causa.
-- ----------------------------------------------------------------------------
alter table public.causas
  add column if not exists ultima_revision_at timestamptz;

-- ----------------------------------------------------------------------------
-- 4) ENCARGO RECEPTOR: nuevo campo "Estado de gestión", independiente de la
--    urgencia de la diligencia.
-- ----------------------------------------------------------------------------
alter table public.encargos_receptor
  add column if not exists estado_gestion text not null default 'Pendiente de encargo';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'encargos_receptor_estado_gestion_check'
  ) then
    alter table public.encargos_receptor
      add constraint encargos_receptor_estado_gestion_check
      check (estado_gestion in ('Pendiente de encargo','Encargado'));
  end if;
end $$;

-- ============================================================================
-- FIN DE LA MIGRACIÓN v1.2
-- No se eliminó ninguna tabla, columna ni registro existente.
-- ============================================================================
