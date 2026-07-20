create or replace function public.get_model_readiness()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with eligible_sessions as (
  select * from public.wait_sessions
  where withdrawn_at is null
    and enrolled_at <= now() - interval '48 hours'
),
completed as (
  select * from eligible_sessions
  where status = 'seen_doctor' and first_doctor_at is not null
),
bounds as (
  select min(arrival_at) as first_at, max(arrival_at) as last_at from completed
),
split as (
  select first_at, last_at,
    first_at + ((last_at - first_at) * 0.8) as cutoff_at
  from bounds
),
strata as (
  select hospital_id, triage,
    count(*) filter (where arrival_at < split.cutoff_at) as train_count,
    count(*) filter (where arrival_at >= split.cutoff_at) as test_count
  from completed cross join split
  group by hospital_id, triage
),
summary as (
  select
    (select count(*) from eligible_sessions) as eligible_sessions,
    (select count(*) from completed) as completed_events,
    (select count(distinct hospital_id) from completed) as hospital_count,
    (select count(*) from strata where train_count >= 50 and test_count >= 20) as eligible_strata,
    coalesce((select extract(epoch from (last_at - first_at)) / 604800 from bounds), 0) as observation_weeks,
    coalesce((select count(*)::numeric / nullif((select count(*) from eligible_sessions), 0) from completed), 0) as completion_rate,
    coalesce((select count(*) filter (where status = 'lost_follow_up')::numeric / nullif(count(*), 0) from eligible_sessions), 0) as lost_follow_up_rate,
    coalesce((select count(*) filter (where triage = 'unknown')::numeric / nullif(count(*), 0) from eligible_sessions), 0) as unknown_triage_rate
)
select jsonb_build_object(
  'schema_version', 1,
  'eligible_sessions', eligible_sessions,
  'completed_events', completed_events,
  'hospital_count', hospital_count,
  'eligible_strata', eligible_strata,
  'observation_weeks', round(observation_weeks, 1),
  'completion_rate', round(completion_rate, 4),
  'lost_follow_up_rate', round(lost_follow_up_rate, 4),
  'unknown_triage_rate', round(unknown_triage_rate, 4),
  'eligible_to_train', completed_events >= 500
    and observation_weeks >= 8
    and hospital_count >= 10
    and eligible_strata >= 10
    and completion_rate >= 0.60
    and lost_follow_up_rate <= 0.25
    and unknown_triage_rate <= 0.20,
  'deployment_requires_backtest', true
)
from summary;
$$;

revoke all on function public.get_model_readiness() from public, anon, authenticated;
grant execute on function public.get_model_readiness() to service_role;
