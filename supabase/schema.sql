-- ============================================================================
-- Chrome Mirror — License & Device-Binding schema
-- Run in: Supabase Dashboard → SQL Editor (or `supabase db push`)
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helper: machine_guid() returns the admin's uuid from the JWT service role.
-- Admin auth is done via Supabase Auth; the admin user's id is stored on rows.
-- ---------------------------------------------------------------------------

-- =============== TABLE: licenses ============================================
-- One row per issued license key. A key binds to AT MOST max_devices devices.
create table if not exists public.licenses (
  id              uuid primary key default gen_random_uuid(),
  license_key     text not null unique,
  label           text,                       -- customer / note (admin-facing)
  status          text not null default 'unused'
                  check (status in ('unused','active','suspended','cancelled')),
  bound_device_id text,                       -- the device this key is locked to
  bound_at        timestamptz,
  max_devices     integer not null default 1,
  created_by      uuid,                       -- admin auth.uid()
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,                -- null = never expires
  notes           text
);

-- A device can only be bound to one license per key.
create unique index if not exists licenses_bound_device_key
  on public.licenses (license_key, bound_device_id)
  where bound_device_id is not null;

create index if not exists licenses_status_idx      on public.licenses (status);
create index if not exists licenses_license_key_idx on public.licenses (license_key);

-- =============== TABLE: devices =============================================
-- Historical record of every device that ever activated a license (for audit).
create table if not exists public.devices (
  id            bigserial primary key,
  license_id    uuid not null references public.licenses(id) on delete cascade,
  device_id     text not null,
  machine_info  jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (license_id, device_id)
);

create index if not exists devices_license_id_idx on public.devices (license_id);
create index if not exists devices_device_id_idx  on public.devices (device_id);

-- =============== TABLE: heartbeats ==========================================
-- "Online" = a heartbeat row updated within the last ONLINE_WINDOW seconds.
create table if not exists public.heartbeats (
  license_id         uuid not null references public.licenses(id) on delete cascade,
  device_id          text not null,
  last_heartbeat_at  timestamptz not null default now(),
  app_version        text,
  ip                 inet,
  primary key (license_id, device_id)
);

-- =============== TABLE: audit_log (optional, admin security timeline) =======
create table if not exists public.license_events (
  id          bigserial primary key,
  license_id  uuid references public.licenses(id) on delete cascade,
  event       text not null,            -- created / activated / suspended / ...
  detail      jsonb,
  actor       text,                     -- 'admin' | 'device' | 'system'
  created_at  timestamptz not null default now()
);
create index if not exists license_events_license_idx on public.license_events (license_id, created_at desc);

-- ===========================================================================
-- SECURITY: Admin RPC functions
-- These run with the caller's privileges. We restrict to the admin user via
-- a security-definer function that checks a designated admin UUID env var.
-- ===========================================================================

-- A stable "is this caller the admin?" check. The admin user id is stored in
-- a dedicated table so you can change it without editing code.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

-- Convenience: current admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users where user_id = auth.uid()
  );
$$;

-- ===========================================================================
-- Admin: create_license(label, max_devices, expires_at, notes)
-- Returns the new license row. Only callable by the admin.
-- ===========================================================================
create or replace function public.create_license(
  p_label      text default null,
  p_max_devices integer default 1,
  p_expires_at timestamptz default null,
  p_notes      text default null
)
returns public.licenses
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.licenses;
  v_key text;
begin
  if not public.is_admin() then
    raise exception 'forbidden: admin only';
  end if;

  -- Human-readable key: CMIR-XXXX-XXXX-XXXX-XXXX (uppercase alnum, no ambiguous chars)
  v_key := 'CMIR-'
    || translate(encode(gen_random_bytes(2), 'hex'), '0123456789abcdef', '23456789BCDFGHJKM')
    || '-'
    || translate(encode(gen_random_bytes(2), 'hex'), '0123456789abcdef', '23456789BCDFGHJKM')
    || '-'
    || translate(encode(gen_random_bytes(2), 'hex'), '0123456789abcdef', '23456789BCDFGHJKM')
    || '-'
    || translate(encode(gen_random_bytes(2), 'hex'), '0123456789abcdef', '23456789BCDFGHJKM');

  insert into public.licenses (license_key, label, status, max_devices, expires_at, notes, created_by)
  values (v_key, p_label, 'unused', p_max_devices, p_expires_at, p_notes, auth.uid())
  returning * into v_row;

  insert into public.license_events (license_id, event, actor, detail)
  values (v_row.id, 'created', 'admin', jsonb_build_object('label', p_label));

  return v_row;
end;
$$;

-- ===========================================================================
-- Admin: set_license_status(id, status) — suspend / reactivate / cancel
-- ===========================================================================
create or replace function public.set_license_status(
  p_id     uuid,
  p_status text
)
returns public.licenses
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.licenses;
begin
  if not public.is_admin() then
    raise exception 'forbidden: admin only';
  end if;
  if p_status not in ('unused','active','suspended','cancelled') then
    raise exception 'invalid status';
  end if;

  update public.licenses set status = p_status where id = p_id returning * into v_row;
  if not found then raise exception 'license not found'; end if;

  insert into public.license_events (license_id, event, actor, detail)
  values (p_id, p_status, 'admin', null);

  return v_row;
end;
$$;

-- ===========================================================================
-- Admin: unbind_license(id) — releases the device binding so the key can be
-- moved to a new machine.
-- ===========================================================================
create or replace function public.unbind_license(p_id uuid)
returns public.licenses
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.licenses;
begin
  if not public.is_admin() then
    raise exception 'forbidden: admin only';
  end if;
  update public.licenses
     set bound_device_id = null, bound_at = null, status = 'unused'
   where id = p_id
  returning * into v_row;
  if not found then raise exception 'license not found'; end if;

  insert into public.license_events (license_id, event, actor, detail)
  values (p_id, 'unbound', 'admin', null);

  return v_row;
end;
$$;

-- ===========================================================================
-- ROW LEVEL SECURITY
-- - Anonymous clients: NO direct table access. All app traffic flows through
--   the Edge Functions, which use the SERVICE ROLE key (bypasses RLS).
-- - Admin: full access, gated by is_admin().
-- ===========================================================================
alter table public.licenses        enable row level security;
alter table public.devices         enable row level security;
alter table public.heartbeats      enable row level security;
alter table public.license_events  enable row level security;
alter table public.admin_users     enable row level security;

-- Admin can read/write everything.
create policy "admin all licenses"   on public.licenses       for all using (public.is_admin()) with check (public.is_admin());
create policy "admin all devices"    on public.devices        for all using (public.is_admin()) with check (public.is_admin());
create policy "admin all heartbeats" on public.heartbeats     for all using (public.is_admin()) with check (public.is_admin());
create policy "admin all events"     on public.license_events for all using (public.is_admin()) with check (public.is_admin());

-- admin_users: a user may read their own row (so is_admin() works for them),
-- nothing else.
create policy "read own admin row" on public.admin_users for select using (user_id = auth.uid());

-- ===========================================================================
-- View: admin dashboard data (online status precomputed)
-- ===========================================================================
create or replace view public.v_licenses_admin with (security_invoker = true) as
select
  l.id, l.license_key, l.label, l.status, l.bound_device_id, l.bound_at,
  l.max_devices, l.created_at, l.expires_at, l.notes,
  h.last_heartbeat_at,
  (h.last_heartbeat_at is not null
     and h.last_heartbeat_at > now() - interval '2 minutes') as is_online,
  h.app_version
from public.licenses l
left join public.heartbeats h on h.license_id = l.id and h.device_id = l.bound_device_id
order by l.created_at desc;

-- ===========================================================================
-- Online status view (safe to expose broadly if ever needed)
-- ===========================================================================
create or replace view public.v_online_status with (security_invoker = true) as
select license_id, device_id, last_heartbeat_at,
       (last_heartbeat_at > now() - interval '2 minutes') as is_online
from public.heartbeats;
