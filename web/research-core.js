import { createClient } from "@supabase/supabase-js";

export const CONSENT_VERSION = "2026-07-15-v1";
export const SESSION_KEY = "aed-pred-research-session-v1";
export const QUEUE_KEY = "aed-pred-research-queue-v1";

const config = {
  url: import.meta.env.VITE_SUPABASE_URL || "",
  key: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "",
  turnstileSiteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY || "",
};

let client;
export function researchConfigured() {
  return /^https:\/\//.test(config.url) && config.key.startsWith("sb_") && Boolean(config.turnstileSiteKey);
}

export function getResearchClient() {
  if (!researchConfigured()) return null;
  client ||= createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}

export function getTurnstileSiteKey() {
  return config.turnstileSiteKey;
}

export async function ensureAnonymousAuth(captchaToken) {
  const supabase = getResearchClient();
  if (!supabase) throw new Error("research_not_configured");
  const { data: existing } = await supabase.auth.getSession();
  if (existing.session) return existing.session;
  const options = captchaToken ? { captchaToken } : undefined;
  const { data, error } = await supabase.auth.signInAnonymously({ options });
  if (error) throw error;
  return data.session;
}

export async function invoke(name, payload) {
  const supabase = getResearchClient();
  if (!supabase) throw new Error("research_not_configured");
  const { data, error } = await supabase.functions.invoke(name, { body: payload });
  if (error) throw error;
  return data;
}

export function readJson(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}

export function saveLocalSession(storage, value) {
  if (value) storage.setItem(SESSION_KEY, JSON.stringify(value));
  else storage.removeItem(SESSION_KEY);
}

export function loadLocalSession(storage) {
  return readJson(storage, SESSION_KEY, null);
}

export function queueEvent(storage, item) {
  const items = readJson(storage, QUEUE_KEY, []);
  const itemId = item.event_id || item.observation_id;
  if (!items.some((entry) => (entry.event_id || entry.observation_id) === itemId)) items.push(item);
  storage.setItem(QUEUE_KEY, JSON.stringify(items));
  return items;
}

export async function flushQueue(storage, sender) {
  const items = readJson(storage, QUEUE_KEY, []);
  const remaining = [];
  for (const item of items) {
    try { await sender(item); }
    catch { remaining.push(item); }
  }
  if (remaining.length) storage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  else storage.removeItem(QUEUE_KEY);
  return { sent: items.length - remaining.length, remaining: remaining.length };
}

export function validateEventTime(arrivalAt, eventAt, now = new Date()) {
  const arrival = new Date(arrivalAt);
  const event = new Date(eventAt);
  if (!Number.isFinite(arrival.getTime()) || !Number.isFinite(event.getTime())) return false;
  return event >= arrival && event <= new Date(now.getTime() + 5 * 60_000);
}

export function reminderDue(session, now = new Date()) {
  if (!session || session.status !== "waiting") return false;
  const last = new Date(session.last_confirmed_waiting_at || session.enrolled_at);
  return Number.isFinite(last.getTime()) && now.getTime() - last.getTime() >= 15 * 60_000;
}

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-z*z));
  return 0.5 * (1 + sign * erf);
}

function normalInv(p) {
  if (!(p > 0 && p < 1)) throw new RangeError("p");
  const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924];
  const b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857];
  const c=[-.00778489400243029,-.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878];
  const d=[.00778469570904146,.32246712907004,2.445134137143,3.75440866190742];
  if(p<.02425){const q=Math.sqrt(-2*Math.log(p));return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
  if(p>.97575){const q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
  const q=p-.5,r=q*q;return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

export function conditionalRemaining(p50, p95, elapsed) {
  if (!Number.isFinite(p50) || !Number.isFinite(p95)) return { suppressed: "official_baseline_unavailable" };
  if (p50 <= 0 || p95 <= p50 || elapsed < 0) return { suppressed: "invalid_official_distribution" };
  const mu = Math.log(p50), sigma = (Math.log(p95)-mu)/normalInv(.95);
  const priorCdf = elapsed <= 0 ? 0 : normalCdf((Math.log(elapsed)-mu)/sigma);
  const survival = 1-priorCdf;
  const p99 = Math.exp(mu+sigma*normalInv(.99));
  if (survival < .01 || elapsed > p99) return { suppressed: "outside_supported_tail", survival };
  const q = (probability) => Math.max(0, Math.exp(mu+sigma*normalInv(priorCdf+probability*survival))-elapsed);
  return { suppressed:null, survival, p25:Math.round(q(.25)), p50:Math.round(q(.5)), p90:Math.round(q(.9)) };
}
