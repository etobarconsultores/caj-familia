-- ============================================================================
-- Práctica Juris · Gestión de Causas
-- Esquema de base de datos para Supabase (PostgreSQL)
-- Ejecutar completo en el SQL Editor de tu proyecto Supabase.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. PERFILES (uno por usuario autenticado)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  nombre_completo text,
  telefono text,
  avatar_url text,
  recovery_email text,
  recovery_phone text,
  created_at timestamptz not null default now()
);

-- Crea automáticamente un perfil cuando alguien se registra
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. CAUSAS (tabla principal)
-- ----------------------------------------------------------------------------
create table if not exists public.causas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  titulo text not null,
  categoria text not null default 'tramitacion' check (categoria in ('tramitacion','nueva','terminada')),
  subcategoria text,

  rol text,
  rol_ingreso text,
  folio text,
  tribunal text,
  materia text,
  submateria text,
  parte text,
  representacion text,
  recurso text,
  rol_ca text,
  tutor text,

  patrocinado text,
  rut text,
  correo text,
  correo_alt text,
  telefono text,
  nota text,
  clave_web text,
  clave_unica text,

  prioridad text,
  etapa text,
  plazo date,
  clave text,
  estado text,
  objetivo_apelacion text,
  resumen text,
  comentarios text,

  fecha_ingreso date,
  fecha_audiencia date,
  hora_audiencia text,
  modalidad text,

  detalle_instruccion text,
  instruccion_fecha_limite date,
  instruccion_estado text check (instruccion_estado in ('Pendiente','Gestionado') or instruccion_estado is null),

  notif_estado text check (notif_estado in ('Notificado','Pendiente') or notif_estado is null),
  notif_nombre text,

  drive_folder_url text,

  ultima_revision_at timestamptz,

  tipo_tribunal text check (tipo_tribunal in (
    'Juzgado Civil','Juzgado de Familia','Juzgado de Letras del Trabajo',
    'Juzgado de Cobranza Laboral y Previsional','Tribunal Tributario y Aduanero',
    'Juzgado de Policía Local','Corte de Apelaciones','Corte Suprema','Otro'
  ) or tipo_tribunal is null),
  numero_tribunal text,
  ciudad_tribunal text,
  contraparte_nombre text,

  demandante_nombre text,
  demandado_nombre text,
  parte_representada text check (parte_representada in ('Demandante','Demandado') or parte_representada is null),
  resultado_beneficio text,
  observaciones_traspaso text,
  baj_estado text check (baj_estado in ('acompanado', 'solicitar', 'no_acompanado') or baj_estado is null),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_causas_user_id on public.causas(user_id);
create index if not exists idx_causas_categoria on public.causas(categoria);
create index if not exists idx_causas_rol on public.causas(rol);

-- ----------------------------------------------------------------------------
-- 3. GESTIONES PENDIENTES
-- ----------------------------------------------------------------------------
create table if not exists public.gestiones_pendientes (
  id uuid primary key default gen_random_uuid(),
  causa_id uuid not null references public.causas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  descripcion text not null,
  drive_link text,
  categoria text,
  prioridad text check (prioridad in ('Urgente','Semi urgente','No prioritario') or prioridad is null),
  estado text not null default 'Pendiente' check (estado in ('Pendiente','En espera','Realizada','Cancelada')),
  fecha_revision date,
  fecha_limite date,
  observaciones text,
  created_at timestamptz not null default now()
);

create index if not exists idx_gestpend_causa_id on public.gestiones_pendientes(causa_id);
create index if not exists idx_gestpend_user_id on public.gestiones_pendientes(user_id);
create index if not exists idx_gestpend_estado on public.gestiones_pendientes(estado);
create index if not exists idx_gestpend_fecha_revision on public.gestiones_pendientes(fecha_revision);

-- ----------------------------------------------------------------------------
-- 4. CRONOLOGÍA (historial de gestiones realizadas)
-- ----------------------------------------------------------------------------
create table if not exists public.cronologia (
  id uuid primary key default gen_random_uuid(),
  causa_id uuid not null references public.causas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  descripcion text not null,
  drive_link text,
  usuario_nombre text,
  fecha timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_cronologia_causa_id on public.cronologia(causa_id);
create index if not exists idx_cronologia_user_id on public.cronologia(user_id);
create index if not exists idx_cronologia_fecha on public.cronologia(fecha desc);

-- ----------------------------------------------------------------------------
-- 5. DOMICILIOS / NOTIFICACIÓN
-- ----------------------------------------------------------------------------
create table if not exists public.domicilios_notificacion (
  id uuid primary key default gen_random_uuid(),
  causa_id uuid not null references public.causas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  domicilio text,
  estado text check (estado in ('Negativa','Señalar','Señalado') or estado is null),
  fecha date,
  folio text,
  informado_por text,
  created_at timestamptz not null default now()
);

create index if not exists idx_domicilios_causa_id on public.domicilios_notificacion(causa_id);
create index if not exists idx_domicilios_user_id on public.domicilios_notificacion(user_id);

-- ----------------------------------------------------------------------------
-- 6. AUDIENCIAS (histórico; la próxima audiencia también vive en causas)
-- ----------------------------------------------------------------------------
create table if not exists public.audiencias (
  id uuid primary key default gen_random_uuid(),
  causa_id uuid not null references public.causas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  fecha date,
  hora text,
  modalidad text,
  observaciones text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audiencias_causa_id on public.audiencias(causa_id);
create index if not exists idx_audiencias_user_id on public.audiencias(user_id);

-- ----------------------------------------------------------------------------
-- 7. PRÓXIMOS HITOS (guía visual del flujo esperado del expediente)
-- ----------------------------------------------------------------------------
create table if not exists public.hitos (
  id uuid primary key default gen_random_uuid(),
  causa_id uuid not null references public.causas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  descripcion text not null,
  orden int not null default 0,
  completado boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_hitos_causa_id on public.hitos(causa_id);
create index if not exists idx_hitos_user_id on public.hitos(user_id);

-- ----------------------------------------------------------------------------
-- 7B. INSTRUCCIONES DEL TUTOR (historial — antecedente, no determina prioridad)
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

-- ----------------------------------------------------------------------------
-- 7C. PROGRAMACIÓN DE SALAS — historial de revisiones de tabla de alegatos
--     (control independiente de Revisión PJUD)
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

-- ----------------------------------------------------------------------------
-- 8. ENCARGO RECEPTOR
-- ----------------------------------------------------------------------------
create table if not exists public.encargos_receptor (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  causa_id uuid references public.causas(id) on delete set null,

  folio text,
  depto text,
  centro_encarga text,
  abogado_encarga text,
  fecha_encargo date,
  materia text,
  patrocinado_nombre text,
  patrocinado_sexo text,
  contraparte_nombre text,
  contraparte_sexo text,
  tipo_diligencia text,
  urgencia text,
  estado_gestion text not null default 'Pendiente de encargo' check (estado_gestion in ('Pendiente de encargo','Encargado')),

  fecha_resolucion date,
  receptor_turno_nombre text,
  telefono_receptor text,
  domicilio_receptor text,
  correo_receptor text,
  receptor_sugerido_id uuid,
  receptor_confirmado_id uuid,
  turno_id uuid,
  fuente_turno text,
  fecha_confirmacion_receptor timestamptz,
  direccion text,
  comuna text,
  tribunal text,
  rol text,
  jurisdiccion text,
  observaciones text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_encargos_user_id on public.encargos_receptor(user_id);

-- ----------------------------------------------------------------------------
-- 8B. CATÁLOGO DE RECEPTORES JUDICIALES
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
-- 8C. CATÁLOGO DE TURNOS
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

alter table public.encargos_receptor
  add constraint encargos_receptor_sugerido_fk foreign key (receptor_sugerido_id) references public.receptores_judiciales(id) on delete set null,
  add constraint encargos_receptor_confirmado_fk foreign key (receptor_confirmado_id) references public.receptores_judiciales(id) on delete set null,
  add constraint encargos_receptor_turno_fk foreign key (turno_id) references public.turnos_receptores(id) on delete set null;

-- ----------------------------------------------------------------------------
-- 8B. GOOGLE CALENDAR — conexión (tokens) y log de sincronización.
--     google_calendar_conexiones queda SIN políticas RLS para el rol
--     "authenticated": solo el backend, usando la Service Role Key, puede
--     leer o escribir tokens. El frontend nunca los ve.
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

-- ----------------------------------------------------------------------------
-- 9. CONFIGURACIÓN (preferencias por usuario)
-- ----------------------------------------------------------------------------
create table if not exists public.configuracion (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferencias jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- TRIGGERS: actualización automática de updated_at
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_causas_updated_at on public.causas;
create trigger trg_causas_updated_at
  before update on public.causas
  for each row execute procedure public.set_updated_at();

drop trigger if exists trg_encargos_updated_at on public.encargos_receptor;
create trigger trg_encargos_updated_at
  before update on public.encargos_receptor
  for each row execute procedure public.set_updated_at();

drop trigger if exists trg_config_updated_at on public.configuracion;
create trigger trg_config_updated_at
  before update on public.configuracion
  for each row execute procedure public.set_updated_at();

-- Trigger: al marcar una gestión pendiente como realizada, se elimina de
-- gestiones_pendientes y se registra en cronologia. Esta parte se maneja
-- desde la aplicación (transacción de 2 pasos) para poder registrar también
-- el enlace de Drive y el nombre de usuario tal como los ingresó la persona.

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.causas enable row level security;
alter table public.gestiones_pendientes enable row level security;
alter table public.cronologia enable row level security;
alter table public.domicilios_notificacion enable row level security;
alter table public.audiencias enable row level security;
alter table public.hitos enable row level security;
alter table public.instrucciones_tutor enable row level security;
alter table public.revisiones_sala enable row level security;
alter table public.encargos_receptor enable row level security;
alter table public.receptores_judiciales enable row level security;
alter table public.turnos_receptores enable row level security;
alter table public.google_calendar_conexiones enable row level security;
alter table public.calendar_sync_log enable row level security;
alter table public.configuracion enable row level security;

-- profiles: cada quien ve y edita solo su propio perfil
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- causas
create policy "causas_select_own" on public.causas for select using (auth.uid() = user_id);
create policy "causas_insert_own" on public.causas for insert with check (auth.uid() = user_id);
create policy "causas_update_own" on public.causas for update using (auth.uid() = user_id);
create policy "causas_delete_own" on public.causas for delete using (auth.uid() = user_id);

-- gestiones_pendientes
create policy "gestpend_select_own" on public.gestiones_pendientes for select using (auth.uid() = user_id);
create policy "gestpend_insert_own" on public.gestiones_pendientes for insert with check (auth.uid() = user_id);
create policy "gestpend_update_own" on public.gestiones_pendientes for update using (auth.uid() = user_id);
create policy "gestpend_delete_own" on public.gestiones_pendientes for delete using (auth.uid() = user_id);

-- cronologia
create policy "cronologia_select_own" on public.cronologia for select using (auth.uid() = user_id);
create policy "cronologia_insert_own" on public.cronologia for insert with check (auth.uid() = user_id);
create policy "cronologia_update_own" on public.cronologia for update using (auth.uid() = user_id);
create policy "cronologia_delete_own" on public.cronologia for delete using (auth.uid() = user_id);

-- domicilios_notificacion
create policy "domicilios_select_own" on public.domicilios_notificacion for select using (auth.uid() = user_id);
create policy "domicilios_insert_own" on public.domicilios_notificacion for insert with check (auth.uid() = user_id);
create policy "domicilios_update_own" on public.domicilios_notificacion for update using (auth.uid() = user_id);
create policy "domicilios_delete_own" on public.domicilios_notificacion for delete using (auth.uid() = user_id);

-- audiencias
create policy "audiencias_select_own" on public.audiencias for select using (auth.uid() = user_id);
create policy "audiencias_insert_own" on public.audiencias for insert with check (auth.uid() = user_id);
create policy "audiencias_update_own" on public.audiencias for update using (auth.uid() = user_id);
create policy "audiencias_delete_own" on public.audiencias for delete using (auth.uid() = user_id);

-- hitos
create policy "hitos_select_own" on public.hitos for select using (auth.uid() = user_id);
create policy "hitos_insert_own" on public.hitos for insert with check (auth.uid() = user_id);
create policy "hitos_update_own" on public.hitos for update using (auth.uid() = user_id);
create policy "hitos_delete_own" on public.hitos for delete using (auth.uid() = user_id);

-- instrucciones_tutor
create policy "instrucciones_select_own" on public.instrucciones_tutor for select using (auth.uid() = user_id);
create policy "instrucciones_insert_own" on public.instrucciones_tutor for insert with check (auth.uid() = user_id);
create policy "instrucciones_update_own" on public.instrucciones_tutor for update using (auth.uid() = user_id);
create policy "instrucciones_delete_own" on public.instrucciones_tutor for delete using (auth.uid() = user_id);

-- revisiones_sala
create policy "revisiones_sala_select_own" on public.revisiones_sala for select using (auth.uid() = user_id);
create policy "revisiones_sala_insert_own" on public.revisiones_sala for insert with check (auth.uid() = user_id);
create policy "revisiones_sala_update_own" on public.revisiones_sala for update using (auth.uid() = user_id);
create policy "revisiones_sala_delete_own" on public.revisiones_sala for delete using (auth.uid() = user_id);

-- encargos_receptor
create policy "encargos_select_own" on public.encargos_receptor for select using (auth.uid() = user_id);
create policy "encargos_insert_own" on public.encargos_receptor for insert with check (auth.uid() = user_id);
create policy "encargos_update_own" on public.encargos_receptor for update using (auth.uid() = user_id);
create policy "encargos_delete_own" on public.encargos_receptor for delete using (auth.uid() = user_id);

-- receptores_judiciales
create policy "receptores_select_own" on public.receptores_judiciales for select using (auth.uid() = user_id);
create policy "receptores_insert_own" on public.receptores_judiciales for insert with check (auth.uid() = user_id);
create policy "receptores_update_own" on public.receptores_judiciales for update using (auth.uid() = user_id);
create policy "receptores_delete_own" on public.receptores_judiciales for delete using (auth.uid() = user_id);

-- turnos_receptores
create policy "turnos_select_own" on public.turnos_receptores for select using (auth.uid() = user_id);
create policy "turnos_insert_own" on public.turnos_receptores for insert with check (auth.uid() = user_id);
create policy "turnos_update_own" on public.turnos_receptores for update using (auth.uid() = user_id);
create policy "turnos_delete_own" on public.turnos_receptores for delete using (auth.uid() = user_id);

-- google_calendar_conexiones: SIN políticas para "authenticated"/"anon" a
-- propósito. Solo el backend con la Service Role Key puede leer o escribir
-- esta tabla (la Service Role Key ignora RLS por diseño de Supabase).

-- calendar_sync_log: la usuaria puede leer su propio historial de
-- sincronización; solo el backend puede escribirlo.
create policy "calendar_sync_log_select_own" on public.calendar_sync_log for select using (auth.uid() = user_id);

-- configuracion
create policy "config_select_own" on public.configuracion for select using (auth.uid() = user_id);
create policy "config_insert_own" on public.configuracion for insert with check (auth.uid() = user_id);
create policy "config_update_own" on public.configuracion for update using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 9B. AGENDA JURÍDICA (eventos por causa: audiencias, citas, plazos, etc.)
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

  google_event_id text,
  google_calendar_id text,
  google_sync_status text check (google_sync_status in ('pending', 'synced', 'error', 'deleted') or google_sync_status is null),
  google_last_sync_at timestamptz,
  google_sync_error text,
  recordatorios jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agenda_eventos_google_sync_status on public.agenda_eventos(google_sync_status);

create index if not exists idx_agenda_user_id on public.agenda_eventos(user_id);
create index if not exists idx_agenda_causa_id on public.agenda_eventos(causa_id);
create index if not exists idx_agenda_fecha on public.agenda_eventos(fecha);
create index if not exists idx_agenda_tipo on public.agenda_eventos(tipo);
create index if not exists idx_agenda_estado on public.agenda_eventos(estado);

drop trigger if exists trg_agenda_updated_at on public.agenda_eventos;
create trigger trg_agenda_updated_at
  before update on public.agenda_eventos
  for each row execute procedure public.set_updated_at();

alter table public.agenda_eventos enable row level security;

create policy "agenda_select_own" on public.agenda_eventos for select using (auth.uid() = user_id);
create policy "agenda_insert_own" on public.agenda_eventos for insert with check (auth.uid() = user_id);
create policy "agenda_update_own" on public.agenda_eventos for update using (auth.uid() = user_id);
create policy "agenda_delete_own" on public.agenda_eventos for delete using (auth.uid() = user_id);

-- ============================================================================
-- Cierre de cuenta -- ver migration_v1_9_account_deletion_requests.sql
-- PENDIENTE DE EJECUCIÓN -- este objeto todavía NO existe en Supabase.
-- ============================================================================
create table if not exists public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  scheduled_deletion_at timestamptz not null,
  requested_from text
);

alter table public.account_deletion_requests enable row level security;

drop policy if exists "account_deletion_requests_select_own" on public.account_deletion_requests;
create policy "account_deletion_requests_select_own" on public.account_deletion_requests for select to authenticated using (auth.uid() = user_id);

-- ============================================================================
-- FIN DEL ESQUEMA
-- ============================================================================
