-- =============================================================
-- Mis Apuestas · Esquema de base de datos para Supabase
-- Ejecuta todo este archivo en: Supabase → SQL Editor → New query → Run
-- Se puede volver a ejecutar sin problema.
-- =============================================================

-- ---------- Apuestas ----------
create table if not exists public.bets (
  user_id        uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  id             text        not null,
  bet_date       date        not null,                 -- fecha de la apuesta
  settled_date   date,                                 -- fecha de liquidación (null si está pendiente)
  sport          text        not null default '',
  league         text        not null default '',
  event          text        not null default '',
  selection      text        not null default '',
  type           text        not null check (type in ('simple', 'parlay')),
  legs           jsonb       not null default '[]'::jsonb,   -- selecciones del parlay: [{event, selection}]
  book           text        not null default '',            -- casa de apuestas
  stake_cents    bigint      not null check (stake_cents > 0),
  odds_format    text        not null check (odds_format in ('american', 'decimal')),
  odds           numeric     not null,
  status         text        not null check (status in ('pendiente', 'ganada', 'perdida', 'anulada', 'cashout')),
  cashout_cents  bigint      check (cashout_cents is null or cashout_cents >= 0),
  notes          text        not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, id),
  constraint odds_valid check (
    (odds_format = 'american' and (odds <= -100 or odds >= 100)) or
    (odds_format = 'decimal'  and odds > 1)
  ),
  constraint cashout_required  check (status <> 'cashout' or cashout_cents is not null),
  constraint settled_after_bet check (settled_date is null or settled_date >= bet_date)
);

create index if not exists bets_user_date_idx on public.bets (user_id, bet_date desc);

alter table public.bets enable row level security;

drop policy if exists "bets_select_own" on public.bets;
drop policy if exists "bets_insert_own" on public.bets;
drop policy if exists "bets_update_own" on public.bets;
drop policy if exists "bets_delete_own" on public.bets;

create policy "bets_select_own" on public.bets for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "bets_insert_own" on public.bets for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "bets_update_own" on public.bets for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "bets_delete_own" on public.bets for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------- Preferencias del usuario ----------
create table if not exists public.user_settings (
  user_id    uuid        primary key default auth.uid() references auth.users(id) on delete cascade,
  currency   text        not null default 'MXN' check (currency in ('MXN', 'USD')),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "settings_select_own" on public.user_settings;
drop policy if exists "settings_insert_own" on public.user_settings;
drop policy if exists "settings_update_own" on public.user_settings;

create policy "settings_select_own" on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "settings_insert_own" on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "settings_update_own" on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ---------- Tiempo real (sincroniza celular y computadora al instante) ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bets'
  ) then
    alter publication supabase_realtime add table public.bets;
  end if;
end $$;
