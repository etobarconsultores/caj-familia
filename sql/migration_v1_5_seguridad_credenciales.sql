-- ============================================================================
-- Fase 1 — Contacto + Cuenta/Seguridad: PIN y credenciales cifradas
-- Estado: PROPUESTA. NO EJECUTAR sin revisión.
--
-- No modifica ninguna tabla existente salvo la FK estrictamente necesaria
-- de case_credentials hacia causas. No toca Agenda, Familia, ni ninguna
-- otra tabla ajena a este alcance.
--
-- CORRECCIÓN CRÍTICA de esta ronda: se reemplaza por completo
-- security_pin_register_attempt (comparaba el PIN antes de contabilizar
-- el intento, lo que permitía que miles de solicitudes concurrentes
-- ejecutaran bcrypt.compare en paralelo antes de que existiera cualquier
-- bloqueo) por 2 funciones nuevas que implementan el modelo correcto:
-- "reservar autorización ATÓMICA antes de comparar". Ver el comentario
-- extenso junto a security_pin_begin_attempt más abajo.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- security_settings — un PIN hasheado por usuario, con control de intentos.
-- Sin policies para authenticated/anon: con RLS habilitado y ninguna
-- policy que coincida, cualquier consulta desde esos roles devuelve cero
-- filas. Solo service_role (que ignora RLS por diseño de Supabase) puede
-- leer/escribir esta tabla, y ese rol se usa exclusivamente en el backend
-- de Vercel.
-- ----------------------------------------------------------------------------
create table if not exists public.security_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz null,
  last_failed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.security_settings enable row level security;
revoke all on public.security_settings from authenticated, anon;
grant select, insert, update, delete on public.security_settings to service_role;

-- Deliberadamente NO se crea ningún "create policy" para authenticated/anon
-- en esta tabla.


-- ----------------------------------------------------------------------------
-- case_credentials — credenciales cifradas por causa, en una tabla separada
-- de "causas". Mismo criterio de RLS sin policies: solo accesible por
-- service_role.
-- ----------------------------------------------------------------------------
create table if not exists public.case_credentials (
  causa_id uuid primary key references public.causas(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  clave_web_enc text null,
  clave_unica_enc text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_case_credentials_user_id on public.case_credentials(user_id);

alter table public.case_credentials enable row level security;
revoke all on public.case_credentials from authenticated, anon;
grant select, insert, update, delete on public.case_credentials to service_role;

-- Deliberadamente NO se crea ningún "create policy" para authenticated/anon
-- en esta tabla. La verificación de que la causa pertenece a la usuaria
-- ocurre ANTES, contra "causas" (que sí tiene sus policies normales por
-- auth.uid() = user_id), usando el JWT de la propia usuaria.


-- ----------------------------------------------------------------------------
-- updated_at automático — reutiliza public.set_updated_at(), ya existente
-- en el esquema actual. No se redefine, solo se agregan los triggers.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_security_settings_updated_at on public.security_settings;
create trigger trg_security_settings_updated_at
  before update on public.security_settings
  for each row execute procedure public.set_updated_at();

drop trigger if exists trg_case_credentials_updated_at on public.case_credentials;
create trigger trg_case_credentials_updated_at
  before update on public.case_credentials
  for each row execute procedure public.set_updated_at();


-- ============================================================================
-- security_pin_begin_attempt — reserva ATÓMICA de un intento, ANTES de que
-- el backend compare el PIN.
--
-- Por qué reemplaza a la versión anterior: comparar primero y registrar
-- después deja una ventana real donde miles de solicitudes concurrentes
-- pueden ejecutar bcrypt.compare en paralelo, todas ANTES de que exista
-- cualquier bloqueo -- el registro atómico posterior no puede deshacer
-- comparaciones que ya ocurrieron. La corrección: el backend debe pedir
-- autorización acá PRIMERO; si no la obtiene, ni siquiera lee pin_hash.
--
-- Con `select ... for update`, de miles de llamadas concurrentes para el
-- mismo user_id, la primera en tomar el lock decide; las siguientes en la
-- cola ven siempre el estado ya actualizado por la anterior. Esto acota
-- matemáticamente a un máximo de 5 "allowed = true" por ciclo de 15
-- minutos, sin importar cuántas solicitudes lleguen al mismo tiempo: la
-- 6ta (y todas las siguientes mientras el bloqueo esté vigente) ven
-- locked_until ya fijado por la 5ta y son rechazadas de inmediato, sin
-- incrementar nada más.
--
-- Semántica exacta:
--  - Si ya está bloqueada (locked_until vigente): allowed=false, no
--    incrementa nada.
--  - Si el bloqueo anterior ya venció: el ciclo se reinicia desde 0 antes
--    de reservar este intento.
--  - Reserva el intento (incrementa failed_attempts en 1) y SIEMPRE
--    permite ese intento (allowed=true), incluido el que llega a 5 -- el
--    bloqueo se fija para el SIGUIENTE intento, nunca para el que
--    completa el quinto.
--
-- Nunca expone pin_hash. No permite indicar un user_id arbitrario desde
-- el frontend: solo la invoca el backend (service_role), con el user_id
-- ya resuelto desde el JWT validado.
-- ============================================================================
create or replace function public.security_pin_begin_attempt(p_user_id uuid)
returns table (
  allowed boolean,
  attempt_number integer,
  locked_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.security_settings%rowtype;
  v_bloqueo_vigente boolean;
  v_ciclo_base integer;
  v_nuevos_intentos integer;
  v_nuevo_locked_until timestamptz;
begin
  -- El "for update" es la pieza que hace esto seguro frente a
  -- concurrencia: bloquea la fila hasta el final de esta función,
  -- serializando cualquier llamada simultánea para el mismo p_user_id.
  select * into v_row from public.security_settings where user_id = p_user_id for update;
  if not found then
    raise exception 'No existe configuración de seguridad para user_id %', p_user_id;
  end if;

  v_bloqueo_vigente := v_row.locked_until is not null and v_row.locked_until > now();

  if v_bloqueo_vigente then
    -- Ya bloqueada y el bloqueo sigue vigente: se rechaza sin reservar
    -- nada ni tocar los contadores.
    return query select false, v_row.failed_attempts, v_row.locked_until;
    return;
  end if;

  -- No bloqueada ahora mismo (nunca lo estuvo, o el bloqueo anterior ya
  -- venció): si venció, el ciclo se reinicia desde 0 antes de reservar.
  v_ciclo_base := case
    when v_row.locked_until is not null and v_row.locked_until <= now() then 0
    else v_row.failed_attempts
  end;
  v_nuevos_intentos := v_ciclo_base + 1;

  if v_nuevos_intentos >= 5 then
    v_nuevo_locked_until := now() + interval '15 minutes';
  else
    v_nuevo_locked_until := null;
  end if;

  update public.security_settings
  set failed_attempts = v_nuevos_intentos,
      locked_until = v_nuevo_locked_until,
      last_failed_at = now()
  where user_id = p_user_id;

  -- El intento reservado (1 a 5) SIEMPRE se permite -- el bloqueo aplica
  -- recién al intento SIGUIENTE, nunca al que completa el quinto.
  return query select true, v_nuevos_intentos, v_nuevo_locked_until;
end;
$$;

revoke all on function public.security_pin_begin_attempt(uuid) from public, anon, authenticated;
grant execute on function public.security_pin_begin_attempt(uuid) to service_role;


-- ============================================================================
-- security_pin_reset_attempts — reinicio ATÓMICO del ciclo tras un PIN
-- correcto. Se llama SIEMPRE que compararPin() devuelva true para un
-- intento ya reservado por security_pin_begin_attempt.
--
-- Nunca expone pin_hash. Mismo criterio de acceso: solo service_role,
-- nunca acepta un user_id que no haya sido resuelto por el backend desde
-- el JWT validado.
-- ============================================================================
create or replace function public.security_pin_reset_attempts(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.security_settings
  set failed_attempts = 0,
      locked_until = null
  where user_id = p_user_id;
end;
$$;

revoke all on function public.security_pin_reset_attempts(uuid) from public, anon, authenticated;
grant execute on function public.security_pin_reset_attempts(uuid) to service_role;
