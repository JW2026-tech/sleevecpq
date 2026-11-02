-- History of the live catalogue (catalogue_draft).
--
-- Quotations keep every saved version in quote_versions; the live catalogue kept
-- only what it holds now, so work overwritten there could not be brought back.
-- This keeps a copy of the catalogue as it was before each burst of edits:
--   * at most one copy per 10 minutes of editing,
--   * always a copy when a write makes the catalogue noticeably smaller
--     (a step or a list of options disappearing is exactly what we want back),
--   * the newest 40 copies are kept (a copy is about 2.5 MB, so ~100 MB at most).
--
-- Run once in the Supabase SQL editor. Safe to run again.

create table if not exists public.catalogue_draft_history (
  id          bigserial primary key,
  rev         bigint,
  data        jsonb not null,
  updated_by  text,
  updated_at  timestamptz,          -- when the catalogue reached this state
  saved_at    timestamptz not null default now(),
  reason      text                  -- 'burst' or 'shrink'
);
create index if not exists catalogue_draft_history_saved_at on public.catalogue_draft_history (saved_at desc);

alter table public.catalogue_draft_history enable row level security;
drop policy if exists "catalogue history is readable" on public.catalogue_draft_history;
create policy "catalogue history is readable" on public.catalogue_draft_history
  for select to anon, authenticated using (true);

create or replace function public.keep_catalogue_draft_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  last_at  timestamptz;
  old_len  bigint;
  new_len  bigint;
  why      text := null;
begin
  if old.data is not distinct from new.data then
    return new;
  end if;

  select max(saved_at) into last_at from catalogue_draft_history;
  old_len := length(old.data::text);
  new_len := length(new.data::text);

  if new_len < old_len * 0.98 then
    why := 'shrink';
  elsif last_at is null or last_at < now() - interval '10 minutes' then
    why := 'burst';
  end if;

  if why is not null then
    insert into catalogue_draft_history (rev, data, updated_by, updated_at, reason)
    values (old.rev, old.data::jsonb, old.updated_by::text, old.updated_at, why);

    delete from catalogue_draft_history
    where id in (select id from catalogue_draft_history order by saved_at desc offset 40);
  end if;

  return new;
end;
$$;

drop trigger if exists catalogue_draft_history_trg on public.catalogue_draft;
create trigger catalogue_draft_history_trg
  before update on public.catalogue_draft
  for each row execute function public.keep_catalogue_draft_history();
