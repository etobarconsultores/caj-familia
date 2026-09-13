-- ============================================================================
-- v1.11 — Rol admin (auth.users.app_metadata) + receptores/turnos globales
-- Estado: PROPUESTA. NO EJECUTAR sin revisión.
--
-- Diagnóstico ya confirmado por la usuaria antes de esta migración:
--   receptores_judiciales: 1 user_id distinto, 721 filas.
--   turnos_receptores:     1 user_id distinto, 270 filas.
-- No hay conflicto entre datos de múltiples cuentas -- el conjunto actual
-- se convierte en catálogo global preservando TODAS las filas, IDs y
-- relaciones. Esta migración NO recrea ninguna tabla -- todo son
-- ALTER TABLE / DROP POLICY / CREATE POLICY sobre las tablas ya existentes.
--
-- El rol en sí (auth.users.app_metadata.role = 'admin') NO se asigna acá --
-- es un paso manual aparte, fuera de esta migración (panel de Supabase o
-- Admin API), tal como se acordó.
--
-- encargos_receptor: SIN NINGÚN CAMBIO en todo este archivo -- sigue
-- exactamente por usuario/causa.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- is_admin(): lee el rol directo del JWT de quien hace la consulta.
-- Seguridad normal (sin SECURITY DEFINER) -- auth.jwt() ya es accesible
-- para el rol authenticated por diseño de Supabase; no hay ningún permiso
-- ajeno que "prestar" acá, así que SECURITY DEFINER sería una elevación de
-- privilegios innecesaria. stable: el resultado no cambia dentro de una
-- misma consulta/transacción (depende del JWT de la sesión, por eso no es
-- immutable).
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

-- ----------------------------------------------------------------------------
-- user_id pasa a ser metadato de "quién lo creó", no mecanismo de
-- autorización: se vuelve nullable, y su FK cambia de CASCADE a SET NULL --
-- así, si la cuenta que originalmente creó un receptor/turno se elimina
-- (incluido a través del cierre de cuenta a 30 días ya implementado), el
-- catálogo compartido sobrevive.
--
-- No existe "alter constraint" para cambiar ON DELETE en PostgreSQL -- hay
-- que quitar la constraint existente y crear una nueva. En vez de asumir
-- el nombre exacto de la FK (que podría no ser el estándar si alguna vez
-- se renombró a mano), este bloque la ENCUENTRA dinámicamente por tabla +
-- columna antes de quitarla -- funciona sin importar cómo se llame hoy.
-- ----------------------------------------------------------------------------
do $$
declare
  v_constraint_name text;
begin
  select tc.constraint_name into v_constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
    and tc.table_schema = kcu.table_schema
  where tc.constraint_type = 'FOREIGN KEY'
    and tc.table_schema = 'public'
    and tc.table_name = 'receptores_judiciales'
    and kcu.column_name = 'user_id'
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table public.receptores_judiciales drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.receptores_judiciales
  alter column user_id drop not null;

alter table public.receptores_judiciales
  add constraint receptores_judiciales_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

do $$
declare
  v_constraint_name text;
begin
  select tc.constraint_name into v_constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
    and tc.table_schema = kcu.table_schema
  where tc.constraint_type = 'FOREIGN KEY'
    and tc.table_schema = 'public'
    and tc.table_name = 'turnos_receptores'
    and kcu.column_name = 'user_id'
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table public.turnos_receptores drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.turnos_receptores
  alter column user_id drop not null;

alter table public.turnos_receptores
  add constraint turnos_receptores_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- ----------------------------------------------------------------------------
-- RLS: lectura abierta a cualquier autenticada (catálogo compartido);
-- escritura (insert/update/delete) restringida a is_admin().
-- "drop policy if exists" antes de cada "create policy" -- reintentable,
-- mismo patrón ya usado en migraciones anteriores. Ninguna fila se toca:
-- solo cambian las reglas de acceso, no los datos.
-- ----------------------------------------------------------------------------
drop policy if exists "receptores_select_own" on public.receptores_judiciales;
drop policy if exists "receptores_insert_own" on public.receptores_judiciales;
drop policy if exists "receptores_update_own" on public.receptores_judiciales;
drop policy if exists "receptores_delete_own" on public.receptores_judiciales;

create policy "receptores_select_authenticated" on public.receptores_judiciales
  for select to authenticated using (true);

create policy "receptores_insert_admin" on public.receptores_judiciales
  for insert to authenticated with check (public.is_admin());

create policy "receptores_update_admin" on public.receptores_judiciales
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "receptores_delete_admin" on public.receptores_judiciales
  for delete to authenticated using (public.is_admin());

drop policy if exists "turnos_select_own" on public.turnos_receptores;
drop policy if exists "turnos_insert_own" on public.turnos_receptores;
drop policy if exists "turnos_update_own" on public.turnos_receptores;
drop policy if exists "turnos_delete_own" on public.turnos_receptores;

create policy "turnos_select_authenticated" on public.turnos_receptores
  for select to authenticated using (true);

create policy "turnos_insert_admin" on public.turnos_receptores
  for insert to authenticated with check (public.is_admin());

create policy "turnos_update_admin" on public.turnos_receptores
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "turnos_delete_admin" on public.turnos_receptores
  for delete to authenticated using (public.is_admin());
