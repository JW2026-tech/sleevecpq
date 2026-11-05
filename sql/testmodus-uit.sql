-- ============================================================
--  Test mode off: without a sign-in, the database gives nothing but the
--  customer's link. Run by the pipeline after inloggen-microsoft.sql, as
--  supabase_admin; safe to run every time.
--
--  Before this, the anon key (which is in the page, so public by design)
--  could read and change every quotation, link and the catalogue: the
--  TESTMODE policies and the execute rights the RPCs gave to anon. Now
--  colleagues sign in with Microsoft, so all of that goes.
--
--  What stays open to anon: the four functions the customer's page calls
--  with the link's token (the same four the customer-facing Caddy lets
--  through, deploy/Caddyfile.cpq). They are SECURITY DEFINER and check the
--  token themselves.
-- ============================================================

-- 1. every test-mode policy
do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and policyname like 'TESTMODE%'
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- 2. no table, view or sequence for anon (RLS already shuts most of it;
--    this also covers anything without RLS)
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 3. functions: by default every function is executable by PUBLIC, which
--    anon is part of. Take that away, give colleagues (and the server) all
--    of them, and anon only the customer's four.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('get_shared_quote','update_shared_quote','reset_shared_quote','log_share_activity')
  loop
    execute format('grant execute on function %s to anon', f.sig);
  end loop;
end $$;

-- 4. and the same for whatever is created later
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
alter default privileges for role supabase_admin in schema public revoke all on tables from anon;
alter default privileges for role supabase_admin in schema public revoke all on sequences from anon;
alter default privileges for role supabase_admin in schema public revoke execute on functions from public, anon;

-- 5. test1.tester got a CPQ account on 5 Nov 2026 only because the planning
--    tool's sign-in briefly ran through the CPQ's. Kept if it ever made
--    anything here (then it is reported, not removed).
do $$
begin
  delete from auth.users where lower(email) = 'test1.tester@sleevetechnology.com';
exception when foreign_key_violation then
  raise notice 'test1.tester has made something in the CPQ; not removed';
end $$;

-- check: what anon can still do (should be the four functions, nothing else)
select 'function' as kind, p.oid::regprocedure::text as name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
union all
select 'table', c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','v','m','p')
  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')
union all
select 'policy', tablename || ': ' || policyname from pg_policies
where schemaname = 'public' and ('anon' = any(roles) or 'public' = any(roles))
order by 1, 2;
