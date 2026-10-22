-- Mirror Bot · Supabase schema
-- Run once in Supabase → SQL Editor. Then replace the email at the bottom with yours.

-- 1) Who may see the dashboard and send commands (checked by email after login)
create table if not exists public.dashboard_owners (
  email text primary key
);
alter table public.dashboard_owners enable row level security;   -- no policies = nobody reads it from the browser

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.dashboard_owners o where o.email = (auth.jwt() ->> 'email'));
$$;

-- 2) Latest bot snapshot (one row per bot, upserted every ~3 s by the bot)
create table if not exists public.bot_state (
  id text primary key,
  snapshot jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.bot_state enable row level security;
drop policy if exists "owner reads state" on public.bot_state;
create policy "owner reads state" on public.bot_state for select to authenticated using (public.is_owner());

-- 3) Closed-trade history (append only)
create table if not exists public.trades (
  id bigint generated always as identity primary key,
  bot_id text not null default 'main',
  closed_at timestamptz not null,
  mode text not null,
  symbol text, mint text, leader text,
  sol_in double precision, sol_out double precision,
  pnl_sol double precision, pnl_usd double precision,
  reason text, tx text
);
create index if not exists trades_closed_at on public.trades (bot_id, closed_at desc);
alter table public.trades enable row level security;
drop policy if exists "owner reads trades" on public.trades;
create policy "owner reads trades" on public.trades for select to authenticated using (public.is_owner());

-- 4) Commands from the website → bot polls every 5 s (kill / resume only)
create table if not exists public.bot_commands (
  id bigint generated always as identity primary key,
  bot_id text not null default 'main',
  cmd text not null check (cmd in ('kill', 'resume')),
  created_at timestamptz not null default now(),
  created_by text default (auth.jwt() ->> 'email'),
  done_at timestamptz
);
alter table public.bot_commands enable row level security;
drop policy if exists "owner sends commands" on public.bot_commands;
create policy "owner sends commands" on public.bot_commands for insert to authenticated with check (public.is_owner());
drop policy if exists "owner reads commands" on public.bot_commands;
create policy "owner reads commands" on public.bot_commands for select to authenticated using (public.is_owner());

-- 5) Realtime: the dashboard updates the moment the bot writes
do $$ begin
  alter publication supabase_realtime add table public.bot_state;
exception when duplicate_object then null; end $$;

-- 6) ใส่อีเมลของคุณ (ใช้ล็อกอินด้วย magic link)
insert into public.dashboard_owners (email) values ('YOUR_EMAIL@example.com') on conflict do nothing;
