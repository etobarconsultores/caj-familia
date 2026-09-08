-- Practica Juris - contactos de recuperacion

alter table public.profiles
  add column if not exists recovery_email text,
  add column if not exists recovery_phone text;
