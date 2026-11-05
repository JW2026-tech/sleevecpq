-- ============================================================
--  Signing in with Microsoft — what the database needs, on the server's
--  own Supabase. Run as supabase_admin (the trigger is on auth.users):
--
--    docker exec -i cpq-supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < inloggen-microsoft.sql
--
--  Safe to run twice. Run it BEFORE the first colleague signs in, and once
--  more after Jeroen's first sign-in (section 3 makes him admin).
-- ============================================================

-- 1. Every new account gets a profile (role 'sales'). The function came
--    over with the public schema; the trigger sits on auth.users, which the
--    move from the cloud did not copy.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- and a profile for anyone who already signed in before the trigger was there
insert into public.profiles (id, email, full_name)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')
from auth.users u
on conflict (id) do nothing;

-- 2. Links: the whole sales team works on all quotations, so everyone sees
--    and manages every quotation's link — not only the one who made it.
--    (The links made during test mode have no maker at all.)
drop policy if exists "share lezen" on public.quote_shares;
create policy "share lezen" on public.quote_shares for select to authenticated
  using (true);
drop policy if exists "share intrekken" on public.quote_shares;
create policy "share intrekken" on public.quote_shares for update to authenticated
  using (true);

-- 3. Jeroen manages the catalogue (publishing needs admin). Does nothing
--    until he has signed in once.
--    guard_role stops anyone who is not already admin from changing a role,
--    and from here there is no signed-in user at all, so it steps aside for
--    this one update.
alter table public.profiles disable trigger profiles_guard_role;
update public.profiles set role = 'admin'
where lower(email) = 'jeroen.weijers@sleevetechnology.com' and role <> 'admin';
alter table public.profiles enable trigger profiles_guard_role;

-- check: who is there, and with which role
select email, role, created_at from public.profiles order by created_at;
