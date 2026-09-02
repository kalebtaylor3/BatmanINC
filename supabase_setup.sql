-- Batman Reading Tracker — Supabase setup
-- Paste this into Supabase Dashboard > SQL Editor > New query > Run.

create table if not exists public.batman_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  progress jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.batman_progress enable row level security;

-- Restrict table access to signed-in users.
revoke all on table public.batman_progress from anon, authenticated;
grant select, insert, update on table public.batman_progress to authenticated;

drop policy if exists "Batman progress select own" on public.batman_progress;
create policy "Batman progress select own"
on public.batman_progress
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Batman progress insert own" on public.batman_progress;
create policy "Batman progress insert own"
on public.batman_progress
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Batman progress update own" on public.batman_progress;
create policy "Batman progress update own"
on public.batman_progress
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
