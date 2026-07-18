create extension if not exists pgcrypto with schema extensions;
create schema if not exists research_private;
revoke all on schema research_private from public, anon, authenticated;

create type public.wait_triage as enum ('t3', 't4', 't5', 'unknown');
create type public.wait_status as enum ('waiting', 'seen_doctor', 'left_without_doctor', 'transferred', 'lost_follow_up');
create type public.wait_event_type as enum ('enrolled', 'still_waiting', 'seen_doctor', 'left_without_doctor', 'transferred');
create type public.priority_pressure as enum ('unknown', 'few', 'several', 'continuous');
create type public.model_stage as enum ('stage1_lognormal', 'stage2_hazard');

create table public.official_context_snapshots (
  id uuid primary key default gen_random_uuid(),
  captured_at timestamptz not null default now(),
  source_updated_at timestamptz,
  hospital_id text not null check (char_length(hospital_id) between 1 and 40),
  triage public.wait_triage not null,
  p50_minutes integer check (p50_minutes between 0 and 4320),
  p95_minutes integer check (p95_minutes between 0 and 4320),
  critical_signal boolean not null default false,
  emergency_signal boolean not null default false,
  multiple_resuscitation boolean not null default false,
  source_status text not null default 'available' check (source_status in ('available', 'unavailable', 'stale')),
  unique (hospital_id, triage, source_updated_at)
);

create table public.model_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  stage public.model_stage not null,
  trained_through timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  artifact jsonb not null default '{}'::jsonb,
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index one_active_model_per_stage on public.model_releases(stage) where active;

create table public.wait_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  consent_version text not null,
  hospital_id text not null check (char_length(hospital_id) between 1 and 40),
  triage public.wait_triage not null,
  arrival_at timestamptz not null,
  enrolled_at timestamptz not null default now(),
  status public.wait_status not null default 'waiting',
  same_triage_position integer check (same_triage_position between 1 and 999),
  priority_pressure public.priority_pressure not null default 'unknown',
  first_doctor_at timestamptz,
  outcome_at timestamptz,
  last_confirmed_waiting_at timestamptz,
  recovery_code_digest bytea not null unique,
  recovery_failures integer not null default 0 check (recovery_failures >= 0),
  recovery_locked_until timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (arrival_at <= enrolled_at + interval '5 minutes'),
  check (first_doctor_at is null or first_doctor_at >= arrival_at)
);
create index wait_sessions_owner_idx on public.wait_sessions(owner_user_id);
create index wait_sessions_retention_idx on public.wait_sessions(outcome_at, enrolled_at);

create table public.wait_events (
  id uuid primary key,
  session_id uuid not null references public.wait_sessions(id) on delete cascade,
  event_type public.wait_event_type not null,
  event_at timestamptz not null,
  reported_at timestamptz not null default now(),
  same_triage_position integer check (same_triage_position between 1 and 999),
  priority_pressure public.priority_pressure not null default 'unknown',
  official_context_id uuid references public.official_context_snapshots(id) on delete set null,
  client_version text check (char_length(client_version) <= 40),
  check (event_at <= reported_at + interval '5 minutes')
);
create index wait_events_session_time_idx on public.wait_events(session_id, event_at);

create table public.prediction_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.wait_sessions(id) on delete cascade,
  event_id uuid references public.wait_events(id) on delete set null,
  model_release_id uuid references public.model_releases(id) on delete set null,
  stage public.model_stage not null,
  generated_at timestamptz not null default now(),
  elapsed_minutes integer not null check (elapsed_minutes between 0 and 4320),
  remaining_p25_minutes integer,
  remaining_p50_minutes integer,
  remaining_p90_minutes integer,
  survival_probability double precision check (survival_probability between 0 and 1),
  suppressed_reason text,
  official_p50_minutes integer,
  official_p95_minutes integer,
  check (
    suppressed_reason is not null or
    (remaining_p25_minutes is not null and remaining_p50_minutes is not null and remaining_p90_minutes is not null)
  )
);

create table public.recovery_attempts (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  succeeded boolean not null default false
);
create index recovery_attempts_rate_idx on public.recovery_attempts(owner_user_id, attempted_at);

create table public.wait_aggregates (
  month date not null,
  hospital_id text not null,
  triage public.wait_triage not null,
  arrival_hour smallint not null check (arrival_hour between 0 and 23),
  completed_count integer not null check (completed_count >= 20),
  median_wait_minutes numeric not null,
  p90_wait_minutes numeric not null,
  primary key (month, hospital_id, triage, arrival_hour)
);

alter table public.official_context_snapshots enable row level security;
alter table public.model_releases enable row level security;
alter table public.wait_sessions enable row level security;
alter table public.wait_events enable row level security;
alter table public.prediction_logs enable row level security;
alter table public.recovery_attempts enable row level security;
alter table public.wait_aggregates enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to service_role;
grant all on public.official_context_snapshots, public.model_releases, public.wait_sessions,
  public.wait_events, public.prediction_logs, public.recovery_attempts, public.wait_aggregates to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.apply_wait_event(
  p_event_id uuid,
  p_session_id uuid,
  p_owner_user_id uuid,
  p_event_type public.wait_event_type,
  p_event_at timestamptz,
  p_same_triage_position integer,
  p_priority_pressure public.priority_pressure,
  p_official_context_id uuid,
  p_client_version text
)
returns public.wait_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_session public.wait_sessions;
  existing_event public.wait_events;
begin
  select * into current_session
  from public.wait_sessions
  where id = p_session_id and owner_user_id = p_owner_user_id
  for update;

  if not found then
    raise exception 'session_not_found';
  end if;

  select * into existing_event from public.wait_events where id = p_event_id;
  if found then
    if existing_event.session_id <> p_session_id
      or existing_event.event_type <> p_event_type
      or existing_event.event_at <> p_event_at then
      raise exception 'event_id_conflict';
    end if;
    return current_session;
  end if;

  if current_session.status <> 'waiting' or p_event_type = 'enrolled' then
    raise exception 'session_closed';
  end if;
  if p_event_at < current_session.arrival_at or p_event_at > now() + interval '5 minutes' then
    raise exception 'invalid_event_time';
  end if;

  insert into public.wait_events (
    id, session_id, event_type, event_at, same_triage_position,
    priority_pressure, official_context_id, client_version
  ) values (
    p_event_id, p_session_id, p_event_type, p_event_at, p_same_triage_position,
    p_priority_pressure, p_official_context_id, p_client_version
  );

  update public.wait_sessions
  set same_triage_position = p_same_triage_position,
      priority_pressure = p_priority_pressure,
      last_confirmed_waiting_at = case when p_event_type = 'still_waiting' then p_event_at else last_confirmed_waiting_at end,
      status = case p_event_type
        when 'seen_doctor' then 'seen_doctor'::public.wait_status
        when 'left_without_doctor' then 'left_without_doctor'::public.wait_status
        when 'transferred' then 'transferred'::public.wait_status
        else status
      end,
      first_doctor_at = case when p_event_type = 'seen_doctor' then p_event_at else first_doctor_at end,
      outcome_at = case when p_event_type in ('seen_doctor', 'left_without_doctor', 'transferred') then p_event_at else outcome_at end
  where id = p_session_id
  returning * into current_session;

  return current_session;
end;
$$;
revoke all on function public.apply_wait_event(uuid, uuid, uuid, public.wait_event_type, timestamptz, integer, public.priority_pressure, uuid, text)
  from public, anon, authenticated;
grant execute on function public.apply_wait_event(uuid, uuid, uuid, public.wait_event_type, timestamptz, integer, public.priority_pressure, uuid, text)
  to service_role;

create or replace function research_private.touch_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function research_private.touch_updated_at() from public, anon, authenticated;

create trigger wait_sessions_touch_updated_at before update on public.wait_sessions
for each row execute function research_private.touch_updated_at();

create or replace function research_private.expire_inactive_sessions()
returns integer language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  update public.wait_sessions
  set status = 'lost_follow_up', outcome_at = coalesce(last_confirmed_waiting_at, enrolled_at)
  where status = 'waiting'
    and coalesce(last_confirmed_waiting_at, enrolled_at) < now() - interval '48 hours';
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function research_private.apply_retention()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform research_private.expire_inactive_sessions();

  insert into public.wait_aggregates
    (month, hospital_id, triage, arrival_hour, completed_count, median_wait_minutes, p90_wait_minutes)
  select date_trunc('month', arrival_at)::date, hospital_id, triage,
    extract(hour from arrival_at)::smallint, count(*)::integer,
    percentile_cont(0.5) within group (order by extract(epoch from (first_doctor_at - arrival_at)) / 60),
    percentile_cont(0.9) within group (order by extract(epoch from (first_doctor_at - arrival_at)) / 60)
  from public.wait_sessions
  where first_doctor_at is not null and enrolled_at < now() - interval '24 months'
  group by 1, 2, 3, 4
  having count(*) >= 20
  on conflict (month, hospital_id, triage, arrival_hour) do update set
    completed_count = excluded.completed_count,
    median_wait_minutes = excluded.median_wait_minutes,
    p90_wait_minutes = excluded.p90_wait_minutes;

  delete from public.wait_sessions where enrolled_at < now() - interval '24 months';
  delete from public.official_context_snapshots where captured_at < now() - interval '24 months';
  delete from public.recovery_attempts where attempted_at < now() - interval '24 hours';
end;
$$;
revoke all on function research_private.expire_inactive_sessions() from public, anon, authenticated;
revoke all on function research_private.apply_retention() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema extensions;
    if not exists (select 1 from cron.job where jobname = 'aed-pred-monthly-retention') then
      perform cron.schedule(
        'aed-pred-monthly-retention',
        '17 3 1 * *',
        'select research_private.apply_retention()'
      );
    end if;
  end if;
end
$$;
