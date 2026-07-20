# Operations, analytics, and model promotion

## Supabase health

`health-check` performs a fixed database RPC and returns no patient data. The scheduled workflow calls it four times per day using the public project URL and publishable key already stored as GitHub repository variables. A failed probe opens one GitHub issue; a successful probe only reports whether the Stage 2 volume and quality gates are met.

Deploy after each schema or function change:

```powershell
npx supabase db push
npx supabase functions deploy health-check --project-ref zmpdxrlaudsgwlmzstql --use-api
```

## Queue observations and HA Go guidance

Deploy the queue-observation endpoint after pushing its migration:

```powershell
npx supabase db push
npx supabase functions deploy wait-session-queue --project-ref zmpdxrlaudsgwlmzstql --use-api
```

The browser uses Driver.js to explain how a participant can check HA Go EasyQ, the hospital screen, or staff information. A participant may report that a higher-priority category was called, that their queue is not near, that it is near, or that they have been called. Do not collect HA Go credentials, ticket numbers, screenshots, symptoms, or free text.

The public Hospital Authority A&E feed exposes hospital-level critical/emergency treatment signals, not patient-level queue numbers. When such a signal changes from inactive to active, the app asks the participant separately whether their own queue appeared to stall. Keep these two facts separate in analysis: an official priority signal is context, while delay is a participant observation. Neither alone proves causation or improper queue jumping.

GitHub disables scheduled workflows in public repositories after 60 days without repository activity. Treat this workflow as a short-term Free Plan safeguard. For durable monitoring, point an external uptime monitor at the same endpoint and send the `apikey` header containing the publishable key. Upgrade to Supabase Pro before the study becomes operationally important.

## Web analytics

Search Console measures Google search impressions and clicks. GA4 measures consented on-site usage. Create a GA4 Web data stream and add its `G-...` Measurement ID as this GitHub Actions repository variable:

```text
VITE_GA_MEASUREMENT_ID
```

The Google tag is not loaded until the visitor explicitly opts in. Analytics records ordinary GA4 page usage only. Do not add hospital, triage, queue, arrival, waiting, recovery, or outcome fields to analytics events.

The pre-arrival safety screen is deliberately ephemeral: its answer remains only in JavaScript memory and must not be sent to GA4, Supabase, local storage, logs, or model-training data. Sensitive navigation links such as 999, the A&E list, and primary-care options stop click propagation so ordinary outbound-click measurement does not infer the selected health path.

The screen is a safety gate, not a triage instrument. Hospital Authority triage categories are assigned by experienced registered nursing staff. The red-flag examples are based on official Hospital Authority, Centre for Health Protection, and Fire Services Department safety information, are not exhaustive, and must never be used to rule out an emergency.

## Stage 2 model promotion

The database now computes readiness without exporting raw participant records. `eligible_to_train` requires all of the following:

- at least 500 completed first-doctor events;
- at least 8 weeks of observations and 10 hospitals;
- at least 10 hospital/triage strata with 50 temporal-training and 20 temporal-test events;
- completion rate at least 60%;
- lost-follow-up rate at most 25%;
- unknown-triage rate at most 20%.

Reaching those thresholds opens an issue; it does not replace the production model. Promotion also requires a time-ordered holdout, Brier-score improvement of at least 10% over Stage 1, calibration error no greater than 0.10, and no material hospital/triage fairness regression. The first challenger is regularized pooled logistic discrete-time hazard. XGBoost remains a challenger; an MLP is not eligible at this data volume.

Raw participant data must remain in the configured Supabase region. Do not place raw extracts in GitHub Actions artifacts, logs, commits, Google Analytics, or the public model JSON. A future trainer should consume privacy-reviewed sufficient statistics or run in an approved environment, write a candidate to `model_releases`, and activate it only after every release gate passes.
