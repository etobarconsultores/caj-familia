-- ============================================================================
-- MIGRACIÓN INCREMENTAL — v1.3 "Normalización de causas, Encargo receptor
-- y administración de turnos de receptores"
-- ============================================================================
-- Principios:
--   - NO elimina tablas, columnas ni registros.
--   - Todo es CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, seguro
--     de ejecutar más de una vez.
--   - La columna antigua "causas.tribunal" (texto libre) NO se elimina;
--     queda como respaldo. Los nuevos campos normalizados quedan vacíos
--     para las causas existentes: no se adivina su contenido.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) CAUSAS: tribunal normalizado + nombre de contraparte (para el
--    identificador abreviado de partes)
-- ----------------------------------------------------------------------------
alter table public.causas
  add column if not exists tipo_tribunal text,
  add column if not exists numero_tribunal text,
  add column if not exists ciudad_tribunal text,
  add column if not exists contraparte_nombre text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'causas_tipo_tribunal_check') then
    alter table public.causas add constraint causas_tipo_tribunal_check check (tipo_tribunal in (
      'Juzgado Civil','Juzgado de Familia','Juzgado de Letras del Trabajo',
      'Juzgado de Cobranza Laboral y Previsional','Tribunal Tributario y Aduanero',
      'Juzgado de Policía Local','Corte de Apelaciones','Corte Suprema','Otro'
    ) or tipo_tribunal is null);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2) ENCARGO RECEPTOR: datos del receptor judicial, fecha de resolución y
--    trazabilidad de la asignación (sugerido / confirmado)
-- ----------------------------------------------------------------------------
alter table public.encargos_receptor
  add column if not exists fecha_resolucion date,
  add column if not exists receptor_turno_nombre text,
  add column if not exists telefono_receptor text,
  add column if not exists domicilio_receptor text,
  add column if not exists correo_receptor text,
  add column if not exists receptor_sugerido_id uuid,
  add column if not exists receptor_confirmado_id uuid,
  add column if not exists turno_id uuid,
  add column if not exists fuente_turno text,
  add column if not exists fecha_confirmacion_receptor timestamptz;

-- ----------------------------------------------------------------------------
-- 3) CATÁLOGO DE RECEPTORES JUDICIALES
-- ----------------------------------------------------------------------------
create table if not exists public.receptores_judiciales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre_completo text not null,
  telefono text,
  correo text,
  domicilio text,
  jurisdiccion text,
  materia text default 'Civil',
  activo boolean not null default true,
  observaciones text,
  fuente_oficial text,
  fecha_actualizacion date default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_receptores_user_id on public.receptores_judiciales(user_id);
create index if not exists idx_receptores_activo on public.receptores_judiciales(activo);

drop trigger if exists trg_receptores_updated_at on public.receptores_judiciales;
create trigger trg_receptores_updated_at
  before update on public.receptores_judiciales
  for each row execute procedure public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4) CATÁLOGO DE TURNOS
-- ----------------------------------------------------------------------------
create table if not exists public.turnos_receptores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  receptor_id uuid not null references public.receptores_judiciales(id) on delete cascade,
  fecha_inicio date not null,
  fecha_fin date not null,
  jurisdiccion text,
  materia text default 'Civil',
  region text not null default 'Metropolitana',
  fuente_oficial text,
  archivo_nombre text,
  enlace_origen text,
  fecha_importacion timestamptz not null default now(),
  observaciones text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint turnos_fechas_validas check (fecha_fin >= fecha_inicio)
);

create index if not exists idx_turnos_user_id on public.turnos_receptores(user_id);
create index if not exists idx_turnos_receptor_id on public.turnos_receptores(receptor_id);
create index if not exists idx_turnos_fechas on public.turnos_receptores(fecha_inicio, fecha_fin);
create index if not exists idx_turnos_jurisdiccion on public.turnos_receptores(jurisdiccion);

drop trigger if exists trg_turnos_updated_at on public.turnos_receptores;
create trigger trg_turnos_updated_at
  before update on public.turnos_receptores
  for each row execute procedure public.set_updated_at();

-- Vínculos de encargos_receptor hacia los catálogos nuevos (se agregan ahora
-- porque las tablas referenciadas recién se crearon arriba).
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'encargos_receptor_sugerido_fk'
  ) then
    alter table public.encargos_receptor
      add constraint encargos_receptor_sugerido_fk
      foreign key (receptor_sugerido_id) references public.receptores_judiciales(id) on delete set null;
  end if;
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'encargos_receptor_confirmado_fk'
  ) then
    alter table public.encargos_receptor
      add constraint encargos_receptor_confirmado_fk
      foreign key (receptor_confirmado_id) references public.receptores_judiciales(id) on delete set null;
  end if;
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'encargos_receptor_turno_fk'
  ) then
    alter table public.encargos_receptor
      add constraint encargos_receptor_turno_fk
      foreign key (turno_id) references public.turnos_receptores(id) on delete set null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5) ROW LEVEL SECURITY (tablas nuevas únicamente)
-- ----------------------------------------------------------------------------
alter table public.receptores_judiciales enable row level security;
drop policy if exists "receptores_select_own" on public.receptores_judiciales;
create policy "receptores_select_own" on public.receptores_judiciales for select using (auth.uid() = user_id);
drop policy if exists "receptores_insert_own" on public.receptores_judiciales;
create policy "receptores_insert_own" on public.receptores_judiciales for insert with check (auth.uid() = user_id);
drop policy if exists "receptores_update_own" on public.receptores_judiciales;
create policy "receptores_update_own" on public.receptores_judiciales for update using (auth.uid() = user_id);
drop policy if exists "receptores_delete_own" on public.receptores_judiciales;
create policy "receptores_delete_own" on public.receptores_judiciales for delete using (auth.uid() = user_id);

alter table public.turnos_receptores enable row level security;
drop policy if exists "turnos_select_own" on public.turnos_receptores;
create policy "turnos_select_own" on public.turnos_receptores for select using (auth.uid() = user_id);
drop policy if exists "turnos_insert_own" on public.turnos_receptores;
create policy "turnos_insert_own" on public.turnos_receptores for insert with check (auth.uid() = user_id);
drop policy if exists "turnos_update_own" on public.turnos_receptores;
create policy "turnos_update_own" on public.turnos_receptores for update using (auth.uid() = user_id);
drop policy if exists "turnos_delete_own" on public.turnos_receptores;
create policy "turnos_delete_own" on public.turnos_receptores for delete using (auth.uid() = user_id);

-- ============================================================================
-- FIN DE LA MIGRACIÓN v1.3
-- No se eliminó ninguna tabla, columna ni registro existente. El campo
-- "causas.tribunal" (texto libre) se conserva íntegro como respaldo; los
-- campos normalizados (tipo_tribunal / numero_tribunal / ciudad_tribunal)
-- quedan vacíos para causas existentes y se completan manualmente desde la
-- aplicación (Editar → Tribunal).
-- ============================================================================
