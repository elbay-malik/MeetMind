-- Groq documents its upload cap as "25 MB" without saying whether that is
-- decimal or binary. The original constraint took the binary reading
-- (26,214,400), which is 1,214,400 bytes above the decimal one. Being over
-- would fail at transcription time, after the user already waited through a
-- full extraction and upload, so take the smaller reading. The cost is about
-- ten minutes of recording at 16 kbps.
--
-- The original check was declared inline and so carries a server-generated
-- name. Drop whatever check on audio_bytes exists rather than guessing it.

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'meetings'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%audio_bytes%'
  loop
    execute format('alter table public.meetings drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table public.meetings
  add constraint meetings_audio_bytes_check
  check (audio_bytes > 0 and audio_bytes <= 25000000);
