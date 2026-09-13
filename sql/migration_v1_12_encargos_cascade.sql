-- Práctica Juris - v1.12
-- Al eliminar una causa, elimina automáticamente sus encargos de receptor asociados.

alter table public.encargos_receptor
  drop constraint if exists encargos_receptor_causa_id_fkey;

alter table public.encargos_receptor
  add constraint encargos_receptor_causa_id_fkey
  foreign key (causa_id)
  references public.causas(id)
  on delete cascade;
