import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.5";

export type Operation = "start" | "get" | "event" | "recover" | "delete";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LIVE_URL = "https://www.ha.org.hk/opendata/aed/aedwtdata2-en.json";
const HOSPITAL_IDS = new Set([
  "yan-chai-hospital", "queen-elizabeth-hospital", "north-district-hospital",
  "north-lantau-hospital", "pok-oi-hospital", "united-christian-hospital",
  "tin-shui-wai-hospital", "prince-of-wales-hospital", "tseung-kwan-o-hospital",
  "tuen-mun-hospital", "kwong-wah-hospital", "ruttonjee-hospital",
  "caritas-medical-centre", "pamela-youde-nethersole-eastern-hospital",
  "princess-margaret-hospital", "queen-mary-hospital", "st-john-hospital",
  "alice-ho-miu-ling-nethersole-hospital",
]);

function allowedOrigins(): string[] {
  return (Deno.env.get("APP_ORIGINS") || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = (req.headers.get("origin") || "").replace(/\/$/, "");
  const allowed = allowedOrigins();
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(req) });
}

function assertOrigin(req: Request): void {
  const origin = (req.headers.get("origin") || "").replace(/\/$/, "");
  if (!allowedOrigins().includes(origin)) throw new ApiError(403, "origin_not_allowed");
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

function clients(req: Request): { user: SupabaseClient; admin: SupabaseClient } {
  const url = Deno.env.get("SUPABASE_URL");
  const publishable = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishable || !service) throw new ApiError(500, "server_configuration");
  const authorization = req.headers.get("authorization") || "";
  return {
    user: createClient(url, publishable, { global: { headers: { Authorization: authorization } } }),
    admin: createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } }),
  };
}

async function requireUser(req: Request, userClient: SupabaseClient): Promise<string> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new ApiError(401, "authentication_required");
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user?.id) throw new ApiError(401, "authentication_required");
  return data.user.id;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

function stringField(value: unknown, name: string, max = 80): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ApiError(422, `invalid_${name}`);
  return value.trim();
}

function optionalPosition(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999) throw new ApiError(422, "invalid_same_triage_position");
  return parsed;
}

function isoTime(value: unknown, name: string): string {
  const parsed = new Date(stringField(value, name));
  if (!Number.isFinite(parsed.getTime())) throw new ApiError(422, `invalid_${name}`);
  return parsed.toISOString();
}

function enumField<T extends string>(value: unknown, name: string, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new ApiError(422, `invalid_${name}`);
  return value as T;
}

function recoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let result = "";
  for (let i = 0; i < 16; i += 1) result += CROCKFORD[Number((bits >> BigInt((15 - i) * 5)) & 31n)];
  return result;
}

function normalizeCode(value: unknown): string {
  return stringField(value, "recovery_code", 40).toUpperCase().replace(/[\s-]/g, "").replace(/[O]/g, "0").replace(/[IL]/g, "1");
}

async function digestCode(code: string): Promise<string> {
  const pepper = Deno.env.get("RECOVERY_CODE_PEPPER");
  if (!pepper || pepper.length < 32) throw new ApiError(500, "server_configuration");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(code)));
  return "\\x" + [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function parseWait(value: unknown): number | null {
  if (typeof value !== "string" || /multiple resuscitation/i.test(value)) return null;
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return /hour/i.test(value) ? Math.round(amount * 60) : Math.round(amount);
}

async function officialContext(admin: SupabaseClient, hospitalId: string, triage: "t3" | "t4" | "t5" | "unknown") {
  const context = { id: null as string | null, p50: null as number | null, p95: null as number | null, status: "unavailable" };
  if (triage === "unknown") return context;
  try {
    const response = await fetch(LIVE_URL, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return context;
    const payload = await response.json();
    const row = payload.waitTime?.find((item: Record<string, unknown>) => slug(String(item.hospName || "")) === hospitalId);
    if (!row) return context;
    const prefix = triage === "t3" ? "t3" : "t45";
    const p50 = parseWait(row[`${prefix}p50`]);
    const p95 = parseWait(row[`${prefix}p95`]);
    const record = {
      hospital_id: hospitalId, triage, p50_minutes: p50, p95_minutes: p95,
      critical_signal: row.manageT1case === "Y" || row.manageT1case === "N/A",
      emergency_signal: row.manageT2case === "Y" || row.manageT2case === "N/A",
      multiple_resuscitation: row.manageT1case === "N/A" || row.manageT2case === "N/A",
      source_status: p50 === null || p95 === null ? "unavailable" : "available",
    };
    const { data } = await admin.from("official_context_snapshots").insert(record).select("id").single();
    return { id: data?.id || null, p50, p95, status: record.source_status };
  } catch {
    return context;
  }
}

function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

function normalInv(p: number): number {
  if (p <= 0 || p >= 1) throw new Error("probability");
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q = p - 0.5, r = q*q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

export function conditionalEstimate(p50: number | null, p95: number | null, elapsed: number) {
  if (p50 === null || p95 === null) return { suppressed: "official_baseline_unavailable" };
  if (p50 <= 0 || p95 <= p50) return { suppressed: "invalid_official_distribution" };
  const mu = Math.log(p50);
  const sigma = (Math.log(p95) - mu) / normalInv(0.95);
  const cdfElapsed = elapsed <= 0 ? 0 : normalCdf((Math.log(elapsed) - mu) / sigma);
  const survival = 1 - cdfElapsed;
  const p99 = Math.exp(mu + sigma * normalInv(0.99));
  if (survival < 0.01 || elapsed > p99) return { suppressed: "outside_supported_tail", survival };
  const quantile = (q: number) => Math.max(0, Math.exp(mu + sigma * normalInv(cdfElapsed + q * survival)) - elapsed);
  return {
    suppressed: null, survival,
    p25: Math.round(quantile(0.25)), p50: Math.round(quantile(0.5)), p90: Math.round(quantile(0.9)),
  };
}

async function verifyTurnstile(token: unknown): Promise<void> {
  if (Deno.env.get("TURNSTILE_DISABLED") === "true") return;
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret || typeof token !== "string") throw new ApiError(403, "challenge_required");
  const form = new FormData();
  form.set("secret", secret); form.set("response", token);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const result = await response.json();
  if (!result.success) throw new ApiError(403, "challenge_failed");
}

function publicSession(session: Record<string, unknown>) {
  const { recovery_code_digest: _, recovery_failures: __, recovery_locked_until: ___, owner_user_id: ____, ...safe } = session;
  return safe;
}

async function ownedSession(admin: SupabaseClient, sessionId: string, userId: string) {
  const { data, error } = await admin.from("wait_sessions").select("*").eq("id", sessionId).eq("owner_user_id", userId).maybeSingle();
  if (error) throw new ApiError(500, "storage_error");
  if (!data) throw new ApiError(404, "session_not_found");
  return data;
}

async function perform(req: Request, operation: Operation, admin: SupabaseClient, userId: string) {
  const input = await body(req);
  if (operation === "start") {
    const hospitalId = stringField(input.hospital_id, "hospital_id", 40);
    if (!HOSPITAL_IDS.has(hospitalId)) throw new ApiError(422, "invalid_hospital_id");
    const triage = enumField(input.triage, "triage", ["t3", "t4", "t5", "unknown"] as const);
    const arrivalAt = isoTime(input.arrival_at, "arrival_at");
    const arrivalMillis = new Date(arrivalAt).getTime();
    if (arrivalMillis > Date.now() + 5 * 60_000) throw new ApiError(422, "arrival_in_future");
    if (arrivalMillis < Date.now() - 48 * 60 * 60_000) throw new ApiError(422, "arrival_too_old");
    const code = recoveryCode();
    const context = await officialContext(admin, hospitalId, triage);
    const record = {
      owner_user_id: userId, consent_version: stringField(input.consent_version, "consent_version", 20),
      hospital_id: hospitalId, triage, arrival_at: arrivalAt,
      same_triage_position: optionalPosition(input.same_triage_position),
      priority_pressure: enumField(input.priority_pressure || "unknown", "priority_pressure", ["unknown", "few", "several", "continuous"] as const),
      last_confirmed_waiting_at: new Date().toISOString(), recovery_code_digest: await digestCode(code),
    };
    const { data, error } = await admin.from("wait_sessions").insert(record).select("*").single();
    if (error || !data) throw new ApiError(500, "storage_error");
    const { error: enrolledError } = await admin.from("wait_events").insert({ id: crypto.randomUUID(), session_id: data.id, event_type: "enrolled", event_at: data.enrolled_at, official_context_id: context.id });
    if (enrolledError) {
      await admin.from("wait_sessions").delete().eq("id", data.id);
      throw new ApiError(500, "storage_error");
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(arrivalAt).getTime()) / 60_000));
    const estimate = conditionalEstimate(context.p50, context.p95, elapsed);
    await admin.from("prediction_logs").insert({
      session_id: data.id, stage: "stage1_lognormal", elapsed_minutes: elapsed,
      remaining_p25_minutes: estimate.p25, remaining_p50_minutes: estimate.p50, remaining_p90_minutes: estimate.p90,
      survival_probability: estimate.survival, suppressed_reason: estimate.suppressed,
      official_p50_minutes: context.p50, official_p95_minutes: context.p95,
    });
    return { session: publicSession(data), recovery_code: code, estimate, official_status: context.status };
  }

  if (operation === "recover") {
    await verifyTurnstile(input.turnstile_token);
    const code = normalizeCode(input.recovery_code);
    const digest = await digestCode(code);
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const { count } = await admin.from("recovery_attempts").select("id", { count: "exact", head: true }).eq("owner_user_id", userId).gte("attempted_at", since);
    if ((count || 0) >= 5) throw new ApiError(429, "recovery_rate_limited");
    const { data: attempt } = await admin.from("recovery_attempts").insert({ owner_user_id: userId }).select("id").single();
    const { data } = await admin.from("wait_sessions").select("*").eq("recovery_code_digest", digest).maybeSingle();
    if (!data) throw new ApiError(404, "recovery_failed");
    if (attempt?.id) await admin.from("recovery_attempts").update({ succeeded: true }).eq("id", attempt.id);
    const nextCode = recoveryCode();
    const { data: updated, error } = await admin.from("wait_sessions").update({ owner_user_id: userId, recovery_code_digest: await digestCode(nextCode), recovery_failures: 0, recovery_locked_until: null }).eq("id", data.id).select("*").single();
    if (error || !updated) throw new ApiError(500, "storage_error");
    return { session: publicSession(updated), recovery_code: nextCode };
  }

  const sessionId = stringField(input.session_id, "session_id", 50);
  const session = await ownedSession(admin, sessionId, userId);
  if (operation === "get") {
    const { data: events } = await admin.from("wait_events").select("id,event_type,event_at,reported_at,same_triage_position,priority_pressure").eq("session_id", sessionId).order("event_at");
    return { session: publicSession(session), events: events || [] };
  }
  if (operation === "delete") {
    const { error } = await admin.from("wait_sessions").delete().eq("id", sessionId).eq("owner_user_id", userId);
    if (error) throw new ApiError(500, "storage_error");
    return { deleted: true };
  }

  if (session.status !== "waiting") throw new ApiError(409, "session_closed");
  const eventType = enumField(input.event_type, "event_type", ["still_waiting", "seen_doctor", "left_without_doctor", "transferred"] as const);
  const eventAt = isoTime(input.event_at, "event_at");
  if (new Date(eventAt) < new Date(session.arrival_at)) throw new ApiError(422, "event_before_arrival");
  const eventId = stringField(input.event_id, "event_id", 50);
  const context = await officialContext(admin, session.hospital_id, session.triage);
  const eventRecord = {
    id: eventId, session_id: sessionId, event_type: eventType, event_at: eventAt,
    same_triage_position: optionalPosition(input.same_triage_position),
    priority_pressure: enumField(input.priority_pressure || "unknown", "priority_pressure", ["unknown", "few", "several", "continuous"] as const),
    official_context_id: context.id, client_version: typeof input.client_version === "string" ? input.client_version.slice(0, 40) : null,
  };
  const { data: priorEvent } = await admin.from("wait_events").select("id,session_id,event_type,event_at").eq("id", eventId).maybeSingle();
  if (priorEvent) {
    if (priorEvent.session_id !== sessionId || priorEvent.event_type !== eventType || priorEvent.event_at !== eventAt) {
      throw new ApiError(409, "event_id_conflict");
    }
    return { session: publicSession(session), replayed: true };
  }
  const { data: updated, error: updateError } = await admin.rpc("apply_wait_event", {
    p_event_id: eventRecord.id,
    p_session_id: sessionId,
    p_owner_user_id: userId,
    p_event_type: eventType,
    p_event_at: eventAt,
    p_same_triage_position: eventRecord.same_triage_position,
    p_priority_pressure: eventRecord.priority_pressure,
    p_official_context_id: context.id,
    p_client_version: eventRecord.client_version,
  });
  if (updateError || !updated) throw new ApiError(409, "event_not_applied");
  const elapsed = Math.max(0, Math.floor((new Date(eventAt).getTime() - new Date(session.arrival_at).getTime()) / 60_000));
  const estimate = eventType === "still_waiting" ? conditionalEstimate(context.p50, context.p95, elapsed) : { suppressed: "session_closed" };
  await admin.from("prediction_logs").insert({
    session_id: sessionId, event_id: eventId, stage: "stage1_lognormal", elapsed_minutes: elapsed,
    remaining_p25_minutes: estimate.p25, remaining_p50_minutes: estimate.p50, remaining_p90_minutes: estimate.p90,
    survival_probability: estimate.survival, suppressed_reason: estimate.suppressed,
    official_p50_minutes: context.p50, official_p95_minutes: context.p95,
  });
  return { session: publicSession(updated), estimate, official_status: context.status };
}

export async function handle(req: Request, operation: Operation): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    assertOrigin(req);
    const { user, admin } = clients(req);
    const userId = await requireUser(req, user);
    return json(req, await perform(req, operation, admin, userId));
  } catch (error) {
    const known = error instanceof ApiError ? error : new ApiError(500, "internal_error");
    return json(req, { error: known.code }, known.status);
  }
}
