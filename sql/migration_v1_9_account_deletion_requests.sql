-- ============================================================================
-- v1.9 — Cierre de cuenta con retención de 30 días
-- Estado: PROPUESTA. NO EJECUTAR sin revisión.
--
-- La existencia de una fila en esta tabla = la cuenta está pendiente de
-- eliminación. Reactivar = borrar la fila. No se usa una columna de
-- "estado" separada: evita estados redundantes o inconsistentes.
--
-- scheduled_deletion_at se calcula EXCLUSIVAMENTE en el backend
-- (api/_lib/account-ops/requestClosure.js), como now() + 29 días (margen
-- de seguridad frente al plazo máximo de 30, dado que el proceso de
-- eliminación definitiva corre vía un cron diario) -- nunca se acepta ese
-- valor desde el cliente, y esta tabla no le pone un default por eso
-- mismo: si faltara, debe fallar la inserción, no asumir un valor.
--
-- legal_acceptances NO se toca en esta migración -- se confirmó que su
-- user_id no tiene FK hacia auth.users ni ON DELETE CASCADE, así que ya
-- sobrevive por diseño a la eliminación de la cuenta. No se agrega ninguna
-- relación nueva hacia esa tabla desde acá.
-- ============================================================================

create table if not exists public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  scheduled_deletion_at timestamptz not null,
  requested_from text
);

alter table public.account_deletion_requests enable row level security;

-- "create policy" no es idempotente por sí solo en PostgreSQL -- se
-- antepone "drop policy if exists" para que esta migración se pueda
-- reintentar sin fallar si ya se ejecutó parcialmente antes.
drop policy if exists "account_deletion_requests_select_own" on public.account_deletion_requests;
create policy "account_deletion_requests_select_own"
  on public.account_deletion_requests
  for select
  to authenticated
  using (auth.uid() = user_id);

grant select on table public.account_deletion_requests to authenticated;

grant select, insert, update, delete
on table public.account_deletion_requests
to service_role;

-- Deliberadamente SIN policies de insert/update/delete para authenticated:
-- toda escritura pasa por los endpoints con service_role
-- (account.requestClosure / account.reactivate / el proceso de cron), para
-- que scheduled_deletion_at nunca pueda fijarse ni alterarse desde el
-- cliente.
