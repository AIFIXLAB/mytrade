-- Mirror Bot · Supabase schema (4-digit PIN version)
-- Run in Supabase → SQL Editor. Safe to run again; it also cleans up older versions.
--
-- Who can do what:
--   website (publishable key) → can't touch tables directly. It can only call
--       get_dashboard(pin) and send_command(pin, cmd). The PIN is checked HERE, in the database.
--   bot (secret key, on your machine) → writes everything (the secret key bypasses RLS).
--
-- Change the PIN any time:   select public.set_dashboard_pin('1234');

create extension if not exists pgcrypto with schema extensions;

-- 1) Latest bot snapshot (one row per bot, upserted every ~3 s by the bot)
create table if not exists public.bot_state (
  id text primary key,
  snapshot jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.bot_state enable row level security;

-- 2) Closed-trade history (append only)
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

-- 3) Commands the bot polls every 5 s
create table if not exists public.bot_commands (
  id bigint generated always as identity primary key,
  bot_id text not null default 'main',
  cmd text not null check (cmd in ('kill', 'resume')),
  created_at timestamptz not null default now(),
  created_by text,
  done_at timestamptz
);
alter table public.bot_commands enable row level security;

-- No direct table access for the public key (remove policies from older versions)
drop policy if exists "owner reads state" on public.bot_state;
drop policy if exists "public reads state" on public.bot_state;
drop policy if exists "owner reads trades" on public.trades;
drop policy if exists "public reads trades" on public.trades;
drop policy if exists "owner sends commands" on public.bot_commands;
drop policy if exists "owner reads commands" on public.bot_commands;
drop function if exists public.is_owner() cascade;
drop table if exists public.dashboard_owners;

-- 4) PIN (stored as a bcrypt hash) + failed-attempt log for lockout
create table if not exists public.dashboard_pin (
  id int primary key default 1 check (id = 1),
  pin_hash text not null
);
alter table public.dashboard_pin enable row level security;
create table if not exists public.pin_failures (at timestamptz not null default now());
alter table public.pin_failures enable row level security;

create or replace function public.set_dashboard_pin(p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^[0-9]{4}$' then raise exception 'PIN must be exactly 4 digits'; end if;
  insert into dashboard_pin (id, pin_hash) values (1, crypt(p_pin, gen_salt('bf', 8)))
  on conflict (id) do update set pin_hash = excluded.pin_hash;
  delete from pin_failures;
end $$;
revoke execute on function public.set_dashboard_pin(text) from public, anon, authenticated;

-- returns null when OK, or an error code
create or replace function public._pin_error(p_pin text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare h text; fails int;
begin
  delete from pin_failures where at < now() - interval '1 day';
  select count(*) into fails from pin_failures where at > now() - interval '15 minutes';
  if fails >= 20 then return 'locked'; end if;
  select pin_hash into h from dashboard_pin where id = 1;
  if h is null then return 'no_pin_set'; end if;
  if p_pin is null or crypt(p_pin, h) <> h then
    insert into pin_failures default values;
    return 'bad_pin';
  end if;
  return null;
end $$;
revoke execute on function public._pin_error(text) from public, anon, authenticated;

create or replace function public.get_dashboard(p_pin text, p_bot text default 'main') returns jsonb
language plpgsql security definer set search_path = public as $$
declare err text; r record;
begin
  err := _pin_error(p_pin);
  if err is not null then return jsonb_build_object('error', err); end if;
  select snapshot, updated_at into r from bot_state where id = p_bot;
  if not found then return jsonb_build_object('error', 'no_data'); end if;
  return jsonb_build_object('snapshot', r.snapshot, 'updated_at', r.updated_at);
end $$;

create or replace function public.send_command(p_pin text, p_cmd text, p_bot text default 'main') returns jsonb
language plpgsql security definer set search_path = public as $$
declare err text;
begin
  err := _pin_error(p_pin);
  if err is not null then return jsonb_build_object('error', err); end if;
  if p_cmd not in ('kill', 'resume') then return jsonb_build_object('error', 'bad_cmd'); end if;
  insert into bot_commands (bot_id, cmd, created_by) values (p_bot, p_cmd, 'dashboard');
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.get_dashboard(text, text) to anon, authenticated;
grant execute on function public.send_command(text, text, text) to anon, authenticated;

-- 5) Set the PIN
select public.set_dashboard_pin('2217');
