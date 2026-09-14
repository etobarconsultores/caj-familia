-- Práctica Juris - v1.14
-- Tutores de práctica por usuario.
-- La tabla ya fue creada manualmente en Supabase durante la implementación;
-- este archivo deja la migración documentada y es seguro para reejecución.

create table if not exists public.tutores_practica (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text not null,
  orden integer not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_tutores_practica_user_id
  on public.tutores_practica(user_id);

alter table public.tutores_practica enable row level security;

grant select, insert, update, delete
  on table public.tutores_practica
  to authenticated;

drop policy if exists "tutores_practica_select_own" on public.tutores_practica;
create policy "tutores_practica_select_own"
  on public.tutores_practica
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "tutores_practica_insert_own" on public.tutores_practica;
create policy "tutores_practica_insert_own"
  on public.tutores_practica
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "tutores_practica_update_own" on public.tutores_practica;
create policy "tutores_practica_update_own"
  on public.tutores_practica
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tutores_practica_delete_own" on public.tutores_practica;
create policy "tutores_practica_delete_own"
  on public.tutores_practica
  for delete
  to authenticated
  using (auth.uid() = user_id);
