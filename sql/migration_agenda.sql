-- ============================================================================
-- MIGRACIÓN INDEPENDIENTE — Agenda Jurídica (v1.6.0)
-- ============================================================================
-- Qué hace este script:
--   1) Crea la tabla agenda_eventos (si no existe) con índices, trigger de
--      updated_at y políticas RLS.
--   2) Migra las audiencias ya registradas en la columna fecha_audiencia de
--      "causas" hacia agenda_eventos como eventos de tipo 'Audiencia'.
--   3) Es seguro volver a ejecutar este script: no crea duplicados y no
--      modifica ni elimina la tabla "causas" ni sus columnas de audiencia.
--
-- La tabla "audiencias" (si existe en tu proyecto) NO se toca ni se elimina;
-- queda disponible como respaldo. Desde esta versión, la aplicación pasa a
-- leer y mostrar las audiencias/eventos desde "agenda_eventos".
--
-- Cómo ejecutarlo: pega todo este archivo en el SQL Editor de tu proyecto
-- Supabase y presiona "Run". Puedes ejecutarlo más de una vez sin riesgo.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Crear tabla agenda_eventos (si no existe)
-- ----------------------------------------------------------------------------
create table if not exists public.agenda_eventos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  causa_id uuid not null references public.causas(id) on delete cascade,

  tipo text not null check (tipo in (
    'Audiencia','Cita con usuario','Reunión con tutor','Llamada','Plazo procesal',
    'Presentación de escrito','Revisión de causa','Gestión importante','Recordatorio','Otro'
  )),
  titulo text not null,
  descripcion text,

  fecha date not null,
  hora_inicio text,
  hora_termino text,
  modalidad text,
  ubicacion text,
  enlace text,

  estado text not null default 'Pendiente' check (estado in (
    'Pendiente','Confirmado','Realizado','Suspendido','Reprogramado','Cancelado'
  )),
  prioridad text check (prioridad in ('Urgente','Semi urgente','No prioritario') or prioridad is null),
  observaciones text,

  creado_por text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2) Índices
-- ----------------------------------------------------------------------------
create index if not exists idx_agenda_user_id on public.agenda_eventos(user_id);
create index if not exists idx_agenda_causa_id on public.agenda_eventos(causa_id);
create index if not exists idx_agenda_fecha on public.agenda_eventos(fecha);
create index if not exists idx_agenda_tipo on public.agenda_eventos(tipo);
create index if not exists idx_agenda_estado on public.agenda_eventos(estado);

-- ----------------------------------------------------------------------------
-- 3) Trigger de actualización automática de updated_at
--    (reutiliza public.set_updated_at() ya creada por schema.sql; si por
--    alguna razón no existiera en tu proyecto, se crea aquí también)
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_agenda_updated_at on public.agenda_eventos;
create trigger trg_agenda_updated_at
  before update on public.agenda_eventos
  for each row execute procedure public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4) Row Level Security (no afecta las políticas de ninguna otra tabla)
-- ----------------------------------------------------------------------------
alter table public.agenda_eventos enable row level security;

drop policy if exists "agenda_select_own" on public.agenda_eventos;
create policy "agenda_select_own" on public.agenda_eventos for select using (auth.uid() = user_id);

drop policy if exists "agenda_insert_own" on public.agenda_eventos;
create policy "agenda_insert_own" on public.agenda_eventos for insert with check (auth.uid() = user_id);

drop policy if exists "agenda_update_own" on public.agenda_eventos;
create policy "agenda_update_own" on public.agenda_eventos for update using (auth.uid() = user_id);

drop policy if exists "agenda_delete_own" on public.agenda_eventos;
create policy "agenda_delete_own" on public.agenda_eventos for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 5) Migrar audiencias existentes (columna causas.fecha_audiencia) hacia
--    agenda_eventos como eventos de tipo 'Audiencia'.
--    La condición NOT EXISTS evita duplicados si el script se ejecuta de nuevo.
-- ----------------------------------------------------------------------------
insert into public.agenda_eventos
  (user_id, causa_id, tipo, titulo, descripcion, fecha, hora_inicio, hora_termino,
   modalidad, ubicacion, enlace, estado, prioridad, observaciones, creado_por, created_at)
select
  c.user_id,
  c.id,
  'Audiencia',
  'Audiencia — ' || coalesce(nullif(trim(c.titulo), ''), 'Causa sin título'),
  null,
  c.fecha_audiencia,
  c.hora_audiencia,
  null,
  c.modalidad,
  null,
  null,
  'Pendiente',
  null,
  null,
  null,
  now()
from public.causas c
where c.fecha_audiencia is not null
  and not exists (
    select 1 from public.agenda_eventos ae
    where ae.causa_id = c.id
      and ae.tipo = 'Audiencia'
      and ae.fecha = c.fecha_audiencia
      and coalesce(ae.hora_inicio, '') = coalesce(c.hora_audiencia, '')
  );

-- ----------------------------------------------------------------------------
-- 6) (Opcional) También migra desde la tabla "audiencias" si tu proyecto la
--    llegó a usar como tabla independiente en algún momento. No falla si la
--    tabla no existe o está vacía.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='audiencias') then
    insert into public.agenda_eventos
      (user_id, causa_id, tipo, titulo, descripcion, fecha, hora_inicio, hora_termino,
       modalidad, ubicacion, enlace, estado, prioridad, observaciones, creado_por, created_at)
    select
      a.user_id,
      a.causa_id,
      'Audiencia',
      'Audiencia — ' || coalesce(nullif(trim(c.titulo), ''), 'Causa sin título'),
      null,
      a.fecha,
      a.hora,
      null,
      a.modalidad,
      null,
      null,
      'Pendiente',
      null,
      a.observaciones,
      null,
      now()
    from public.audiencias a
    join public.causas c on c.id = a.causa_id
    where a.fecha is not null
      and not exists (
        select 1 from public.agenda_eventos ae
        where ae.causa_id = a.causa_id
          and ae.tipo = 'Audiencia'
          and ae.fecha = a.fecha
          and coalesce(ae.hora_inicio, '') = coalesce(a.hora, '')
      );
  end if;
end $$;

-- ============================================================================
-- FIN DE LA MIGRACIÓN
-- La tabla "audiencias" y las columnas fecha_audiencia / hora_audiencia /
-- modalidad de "causas" NO fueron eliminadas. Quedan como respaldo.
-- ============================================================================
