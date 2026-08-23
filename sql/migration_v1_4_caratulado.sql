-- ============================================================================
-- MIGRACIÓN INCREMENTAL — v1.4 "Caratulado procesal, Informe Final"
-- ============================================================================
-- Principios:
--   - NO elimina tablas, columnas ni registros.
--   - Todo es ADD COLUMN IF NOT EXISTS, seguro de ejecutar más de una vez.
--   - Las columnas antiguas "patrocinado" y "contraparte_nombre" NO se
--     eliminan; quedan como respaldo y compatibilidad. Para causas antiguas
--     sin demandante/demandado definidos, la aplicación muestra un aviso y
--     permite regularizarlas manualmente desde Editar — nunca se infiere ni
--     se invierte automáticamente quién era demandante o demandado.
-- ============================================================================

alter table public.causas
  add column if not exists demandante_nombre text,
  add column if not exists demandado_nombre text,
  add column if not exists parte_representada text,
  add column if not exists resultado_beneficio text,
  add column if not exists observaciones_traspaso text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'causas_parte_representada_check') then
    alter table public.causas
      add constraint causas_parte_representada_check
      check (parte_representada in ('Demandante','Demandado') or parte_representada is null);
  end if;
end $$;

-- ============================================================================
-- FIN DE LA MIGRACIÓN v1.4
-- No se eliminó ninguna tabla, columna ni registro existente. "patrocinado"
-- y "contraparte_nombre" siguen intactos como respaldo. No se modificó
-- ningún dato de causas ya existentes.
-- ============================================================================
