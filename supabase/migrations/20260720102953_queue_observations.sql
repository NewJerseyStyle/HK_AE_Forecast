create type public.queue_observation_kind as enum (
  'higher_priority_called',
  'queue_not_near',
  'queue_near',
  'queue_called',
  'priority_delay_confirmed',
  'priority_no_delay'
);

create type public.queue_observation_source as enum (
  'ha_go',
  'hospital_screen',
  'staff',
  'direct_observation',
  'official_api_prompt'
);

create table public.queue_observations (
  id uuid primary key,
  session_id uuid not null references public.wait_sessions(id) on delete cascade,
  observation_kind public.queue_observation_kind not null,
  observation_source public.queue_observation_source not null,
  observed_at timestamptz not null,
  reported_at timestamptz not null default now(),
  official_context_id uuid references public.official_context_snapshots(id) on delete set null,
  client_version text check (char_length(client_version) <= 40),
  check (observed_at <= reported_at + interval '5 minutes')
);

create index queue_observations_session_time_idx
  on public.queue_observations(session_id, observed_at);
create index queue_observations_context_idx
  on public.queue_observations(official_context_id)
  where official_context_id is not null;

alter table public.queue_observations enable row level security;
revoke all on table public.queue_observations from public, anon, authenticated;
grant all on table public.queue_observations to service_role;

comment on table public.queue_observations is
  'Minimal queue-state observations. Never store HA Go credentials, ticket numbers, screenshots, symptoms, or free text.';
