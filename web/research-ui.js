import QRCode from "qrcode";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import {
  CONSENT_VERSION, ensureAnonymousAuth, flushQueue, getTurnstileSiteKey, invoke,
  loadLocalSession, queueEvent, reminderDue, researchConfigured, saveLocalSession, validateEventTime,
} from "./research-core.js";

import './analytics.js';

const local = window.localStorage;
let current = loadLocalSession(local);
let startChallengeToken = "";
let recoveryChallengeToken = "";
let recoveryAuthChallengeToken = "";
const GUIDE_KEY = "aed-pred-queue-guide-v1";
const OFFICIAL_PROMPTS_KEY = "aed-pred-official-prompts-v1";
const officialSignals = new Map();
let officialPrompt = null;
let guideRunning = false;

function datetimeLocal(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function sectionHtml() {
  return `<section class="research-section hidden" id="wait-study" aria-labelledby="study-title">
    <div class="section-heading"><div><span class="section-no">研究</span><h2 id="study-title">自願記錄實際輪候</h2></div>
      <p>只適用於正在急症室等候的人；開始後可每 15 分鐘更新，直至第一次見醫生或離開</p></div>
    <div class="study-shell">
      <div id="study-status" class="study-status" role="status"></div>
      <div id="study-content"></div>
    </div>
  </section>`;
}

function setupHtml() {
  const disabled = researchConfigured() ? "" : `<p class="config-warning">研究收集尚未連接 Supabase；預測比較仍可使用。部署者需先設定公開 URL、publishable key 與 Turnstile。</p>`;
  return `${disabled}<form id="study-start">
    <div class="study-intro"><strong>怎樣參與</strong><ol><li>填寫到院及分流資料</li><li>等候期間按「仍在等候」</li><li>第一次見醫生後回報實際時間</li></ol><p>不知道的資料可以留空或選「尚未知道」，請不要猜測。</p></div>
    <div class="privacy-summary"><strong>只收集最低限度資料</strong><p>醫院、到院及回報時間、分流級別和你主動提交的隊列狀態。不要輸入籌號，也不會收集 HA Go 登入資料、螢幕截圖、姓名、身份證、電話、症狀或診斷。資料存放於 Supabase 新加坡區域；平台日誌可能包含網絡中繼資料。原始事件保留 24 個月，其後只保留最少 20 宗一組的不可逆彙總。</p></div>
    <label><span>你何時到達急症室？</span><input name="arrival_at" type="datetime-local" required value="${datetimeLocal()}" aria-describedby="arrival-help"><small class="field-help" id="arrival-help">填寫到達急症室登記處的時間，不是開始填表的時間。</small></label>
    <label><span>醫院給你的分流級別</span><select name="triage" required aria-describedby="triage-help">
      <option value="unknown">尚未知道</option><option value="t3">III 緊急</option><option value="t4">IV 次緊急</option><option value="t5">V 非緊急</option>
    </select><small class="field-help" id="triage-help">以分流紙、手帶或職員告知為準；未獲告知請選「尚未知道」。</small></label>
    <label class="consent"><input name="consent" type="checkbox" required><span>我明白這是未校準研究情境、不是個人就診承諾；我同意按上述用途收集資料，並可隨時刪除本次原始記錄。</span></label>
    <div id="turnstile-box"></div>
    <button class="primary-action" type="submit" ${researchConfigured() ? "" : "disabled"}>開始匿名輪候記錄</button>
    <button class="text-action" type="button" id="show-recover">已有恢復碼</button>
  </form>
  <form id="study-recover" class="hidden"><label><span>16 位恢復碼</span><input name="recovery_code" autocomplete="off" maxlength="24" required></label>
    <div class="privacy-summary"><strong>跨裝置恢復需要兩次防濫用驗證</strong><p>第一次建立匿名登入，第二次保護恢復碼查詢；已有本機匿名登入時仍可完成兩次驗證。</p></div>
    <div id="turnstile-recover-auth"></div><div id="turnstile-recover-code"></div>
    <button class="primary-action" type="submit">恢復並輪換代碼</button><button class="text-action" type="button" id="hide-recover">返回</button></form>`;
}

function activeHtml() {
  const session = current.session;
  const estimate = current.estimate;
  const estimateHtml = !estimate || estimate.suppressed
    ? `<strong>暫不顯示個人剩餘時間</strong><span>原因：${estimate?.suppressed || "等待下一次回報"}。官方資料中斷時仍可回報事件。</span>`
    : `<strong>中位仍需約 ${estimate.p50} 分鐘</strong><span>條件範圍約 ${estimate.p25}–${estimate.p90} 分鐘；前提是你到現在仍未見醫生。</span>`;
  const official = officialSignals.get(session.hospital_id);
  const officialText = !official ? "等待醫管局公開訊號" : official.active
    ? `${official.multipleResuscitation ? "多名病人正在搶救" : official.critical ? "正在治理危殆個案" : "正在治理危急個案"} · ${new Date(official.updatedAt).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" })}`
    : `暫無危殆／危急治理訊號 · ${new Date(official.updatedAt).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" })}`;
  const promptHtml = officialPrompt ? `<aside class="official-priority-prompt" role="alert"><strong>官方優先個案訊號剛出現</strong><p>你是否同時發現自己的隊列停滯，或 HA Go／院內螢幕的狀態不再推進？</p><div><button data-official-delay="yes">有，感到隊列停滯</button><button data-official-delay="no">沒有明顯變化</button></div></aside>` : "";
  return `<div class="active-study">
    <div class="estimate-box"><small>未校準研究情境 · 非個人就診承諾</small>${estimateHtml}<p>較高優先個案訊號另行顯示，不會用任意分鐘數調整。</p></div>
    <div class="official-signal-box"><small>醫管局公開訊號 · 約每 15 分鐘更新</small><strong>${officialText}</strong><span>這是全院級訊號，不代表你的隊列必然延長。</span></div>
    ${promptHtml}
    <p><strong>${session.hospital_id}</strong> · 到院 ${new Date(session.arrival_at).toLocaleString("zh-HK")} · ${session.triage.toUpperCase()}</p>
    <div id="reminder" class="reminder hidden">已過 15 分鐘，請確認目前狀態。</div>
    <div class="event-actions">
      <button data-event="still_waiting">仍在等候</button><button data-event="seen_doctor">第一次見到醫生</button>
      <button data-event="left_without_doctor">未見醫生便離開</button><button data-event="transferred">轉院／其他</button>
    </div>
    <section class="queue-observation-card" aria-labelledby="queue-observation-title">
      <div><h3 id="queue-observation-title">回報你看到的隊列事件</h3><button type="button" class="queue-guide-trigger">如何辨認？</button></div>
      <p>可參考 HA Go「排隊易」、院內螢幕或職員告知。不要提交籌號或截圖。</p>
      <label><span>資料來源</span><select id="observation-source"><option value="ha_go">HA Go 排隊易</option><option value="hospital_screen">急症室螢幕</option><option value="staff">職員告知</option><option value="direct_observation">現場觀察</option></select></label>
      <div class="queue-observation-actions">
        <button type="button" data-observation-kind="higher_priority_called">較高優先個案先獲處理</button>
        <button type="button" data-observation-kind="queue_not_near">尚未接近叫號</button>
        <button type="button" data-observation-kind="queue_near">顯示即將輪到我</button>
        <button type="button" data-observation-kind="queue_called">已叫號／準備見醫生</button>
      </div>
      <small>例如：你是 Cat 4，HA Go 尚未顯示即將輪到你，但螢幕連續出現多個 Cat 3 號碼，可回報「較高優先個案先獲處理」。這是分流優先事件，不代表不當插隊。</small>
    </section>
    <form id="seen-time" class="hidden"><label><span>第一次面對面接受醫生臨床評估的時間（不包括登記、分流護士、抽血或影像）</span>
      <input name="event_at" type="datetime-local" required value="${datetimeLocal()}"></label><button class="primary-action" type="submit">確認時間</button></form>
    <div class="recovery-card ${current.recovery_code ? "" : "hidden"}"><strong>請離線保存恢復碼</strong><code id="recovery-code">${current.recovery_code || ""}</code><canvas id="recovery-qr"></canvas><small>恢復連結的代碼只放在 URL fragment，不會傳給網站伺服器；每次恢復後會輪換。</small></div>
    <button id="delete-session" class="danger-action">撤回並永久刪除本次原始記錄</button>
  </div>`;
}

function setStatus(message, error = false) {
  const node = document.querySelector("#study-status");
  if (node) { node.textContent = message; node.classList.toggle("error", error); }
}

function queuedSender(item) {
  const { endpoint = "wait-session-event", ...payload } = item;
  return invoke(endpoint, payload);
}

function promptKeys() {
  try { return JSON.parse(local.getItem(OFFICIAL_PROMPTS_KEY) || "[]"); }
  catch { return []; }
}

function rememberPrompt(key) {
  const keys = [...new Set([...promptKeys(), key])].slice(-48);
  try { local.setItem(OFFICIAL_PROMPTS_KEY, JSON.stringify(keys)); } catch { /* optional */ }
}

function maybePromptOfficial(detail, includeCurrent = false) {
  if (!detail?.active || (!detail.newlyActive && !includeCurrent) || current?.session?.status !== "waiting" || current.session.hospital_id !== detail.hospitalId) return;
  const key = `${detail.hospitalId}:${detail.updatedAt}`;
  if (promptKeys().includes(key)) return;
  officialPrompt = { ...detail, key };
}

function startQueueGuide() {
  if (guideRunning || !document.querySelector(".queue-observation-card")) return;
  guideRunning = true;
  const guide = driver({
    showProgress: true, nextBtnText: "下一步", prevBtnText: "上一步", doneBtnText: "明白了",
    progressText: "{{current}} / {{total}}",
    onDestroyed: () => {
      guideRunning = false;
      try { local.setItem(GUIDE_KEY, "seen"); } catch { /* optional */ }
    },
    steps: [
      { element: ".queue-observation-card", popover: { title: "只回報你真正看到的狀態", description: "先確認自己的分流級別，再查看 HA Go、院內螢幕或職員提供的隊列資訊。不要輸入籌號。" } },
      { element: "#observation-source", popover: { title: "標明資料來源", description: "HA Go 或院內螢幕通常比自行推測可靠；來源會與事件分開保存。" } },
      { element: "[data-observation-kind='higher_priority_called']", popover: { title: "甚麼算較高優先個案事件？", description: "例如你是 Cat 4、尚未顯示即將輪到，但螢幕連續叫出多個 Cat 3 號碼。這是正常分流優先，不等於不當插隊。" } },
      { element: ".official-signal-box", popover: { title: "官方訊號會自動更新", description: "公開 API 顯示危殆或危急個案由無轉有時，我們會另問你的隊列是否同時停滯；不會自行增加固定延誤分鐘。" } },
    ],
  });
  guide.drive();
}

function render() {
  const content = document.querySelector("#study-content");
  if (!content) return;
  content.innerHTML = current?.session ? activeHtml() : setupHtml();
  if (current?.session) bindActive(); else bindSetup();
}

function renderTurnstile(target, callback) {
  if (!getTurnstileSiteKey()) return;
  const draw = () => window.turnstile?.render(target, { sitekey: getTurnstileSiteKey(), callback });
  if (window.turnstile) draw();
  else {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true; script.defer = true; script.onload = draw; document.head.append(script);
  }
}

function bindSetup() {
  renderTurnstile("#turnstile-box", (token) => { startChallengeToken = token; });
  document.querySelector("#show-recover")?.addEventListener("click", () => {
    document.querySelector("#study-start").classList.add("hidden"); document.querySelector("#study-recover").classList.remove("hidden");
    renderTurnstile("#turnstile-recover-auth", (token) => { recoveryAuthChallengeToken = token; });
    renderTurnstile("#turnstile-recover-code", (token) => { recoveryChallengeToken = token; });
  });
  document.querySelector("#hide-recover")?.addEventListener("click", () => render());
  document.querySelector("#study-start")?.addEventListener("submit", async (event) => {
    event.preventDefault(); setStatus("建立匿名研究記錄…");
    const form = new FormData(event.currentTarget);
    const hospitalId = document.querySelector("#current-hospital")?.value;
    if (!hospitalId) return setStatus("請先切換到「已在急症室輪候」並選擇醫院。", true);
    try {
      await ensureAnonymousAuth(startChallengeToken);
      const result = await invoke("wait-session-start", {
        hospital_id: hospitalId, arrival_at: new Date(String(form.get("arrival_at"))).toISOString(),
        triage: form.get("triage"), same_triage_position: null,
        priority_pressure: "unknown", consent_version: CONSENT_VERSION,
      });
      current = { ...result, recovery_code: result.recovery_code }; saveLocalSession(local, current);
      maybePromptOfficial(officialSignals.get(current.session.hospital_id), true);
      render(); setStatus("記錄已開始。");
    } catch { setStatus("未能開始記錄；請檢查網絡、驗證及到院時間。", true); }
  });
  document.querySelector("#study-recover")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setStatus("正在恢復…");
    try {
      await ensureAnonymousAuth(recoveryAuthChallengeToken);
      const result = await invoke("wait-session-recover", { recovery_code: form.get("recovery_code"), turnstile_token: recoveryChallengeToken });
      current = { ...result, recovery_code: result.recovery_code }; saveLocalSession(local, current); render(); setStatus("已恢復；舊代碼已失效。");
    } catch { setStatus("恢復失敗或嘗試過於頻密。", true); }
  });
}

async function sendEvent(type, eventAt = new Date()) {
  const position = document.querySelector("#queue-position")?.value || null;
  const pressure = document.querySelector("#priority-pressure")?.value || "unknown";
  const payload = {
    endpoint: "wait-session-event", event_id: crypto.randomUUID(), session_id: current.session.id, event_type: type, event_at: eventAt.toISOString(),
    same_triage_position: position, priority_pressure: pressure, client_version: "web-0.2.0",
  };
  queueEvent(local, payload);
  const result = await queuedSender(payload);
  current = { ...current, ...result, recovery_code: current.recovery_code };
  saveLocalSession(local, current);
  await flushQueue(local, queuedSender);
  render(); setStatus(type === "still_waiting" ? "已記錄：仍在等候。估計已按條件更新。" : "已記錄結果，謝謝。");
}

async function sendObservation(kind, source) {
  const payload = {
    endpoint: "wait-session-queue", observation_id: crypto.randomUUID(), session_id: current.session.id,
    observation_kind: kind, observation_source: source, observed_at: new Date().toISOString(), client_version: "web-0.3.0",
  };
  queueEvent(local, payload);
  await queuedSender(payload);
  await flushQueue(local, queuedSender);
  const labels = {
    higher_priority_called: "較高優先個案先獲處理", queue_not_near: "尚未接近叫號",
    queue_near: "顯示即將輪到", queue_called: "已叫號／準備見醫生",
    priority_delay_confirmed: "官方訊號出現後隊列停滯", priority_no_delay: "官方訊號出現但未見明顯停滯",
  };
  setStatus(`已記錄：${labels[kind]}。謝謝你補充現場資料。`);
}

function bindActive() {
  document.querySelector("#reminder")?.classList.toggle("hidden", !reminderDue(current.session));
  if (current.recovery_code) {
    const link = `${location.origin}${location.pathname}#recover=${encodeURIComponent(current.recovery_code)}`;
    QRCode.toCanvas(document.querySelector("#recovery-qr"), link, { width: 148, margin: 1 }).catch(() => {});
  }
  document.querySelectorAll("[data-event]").forEach((button) => button.addEventListener("click", async () => {
    const type = button.dataset.event;
    if (type === "seen_doctor") return document.querySelector("#seen-time").classList.remove("hidden");
    try { await sendEvent(type); } catch { setStatus("網絡中斷：回報已留在此裝置，稍後會以同一事件代碼重試。", true); }
  }));
  document.querySelector(".queue-guide-trigger")?.addEventListener("click", startQueueGuide);
  document.querySelectorAll("[data-observation-kind]").forEach((button) => button.addEventListener("click", async () => {
    const source = document.querySelector("#observation-source")?.value || "direct_observation";
    try { await sendObservation(button.dataset.observationKind, source); }
    catch { setStatus("網絡中斷：隊列事件已留在此裝置，稍後會重試。", true); }
  }));
  document.querySelectorAll("[data-official-delay]").forEach((button) => button.addEventListener("click", async () => {
    const prompt = officialPrompt;
    if (!prompt) return;
    const kind = button.dataset.officialDelay === "yes" ? "priority_delay_confirmed" : "priority_no_delay";
    try {
      await sendObservation(kind, "official_api_prompt");
      rememberPrompt(prompt.key); officialPrompt = null; render();
    } catch { setStatus("暫時未能提交確認；請稍後再試。", true); }
  }));
  if (!local.getItem(GUIDE_KEY)) setTimeout(startQueueGuide, 300);
  document.querySelector("#seen-time")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("event_at");
    const time = new Date(String(value));
    if (!validateEventTime(current.session.arrival_at, time)) return setStatus("時間必須介乎到院與現在。", true);
    try { await sendEvent("seen_doctor", time); } catch { setStatus("網絡中斷：回報已排隊稍後重試。", true); }
  });
  document.querySelector("#delete-session")?.addEventListener("click", async () => {
    if (!confirm("永久刪除本次原始記錄？此操作不可復原。")) return;
    try { await invoke("wait-session-delete", { session_id: current.session.id }); current = null; saveLocalSession(local, null); render(); setStatus("本次原始記錄已永久刪除。"); }
    catch { setStatus("暫時未能刪除，請稍後重試。", true); }
  });
}

async function boot() {
  document.querySelector(".control-panel")?.insertAdjacentHTML("afterend", sectionHtml());
  const fragmentCode = new URLSearchParams(location.hash.replace(/^#/, "")).get("recover");
  render();
  if (fragmentCode && !current) {
    const recover = document.querySelector("#study-recover input");
    document.querySelector("#show-recover")?.click();
    if (recover) recover.value = fragmentCode;
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (navigator.onLine) flushQueue(local, queuedSender).catch(() => {});
  window.addEventListener("online", () => flushQueue(local, queuedSender).catch(() => {}));
  setInterval(() => document.querySelector("#reminder")?.classList.toggle("hidden", !reminderDue(current?.session)), 60_000);
}

window.addEventListener("aed:official-priority-status", (event) => {
  const detail = event.detail;
  if (!detail?.hospitalId) return;
  officialSignals.set(detail.hospitalId, detail);
  const wasPrompted = officialPrompt;
  maybePromptOfficial(detail);
  if (current?.session?.hospital_id === detail.hospitalId && !guideRunning &&
      (wasPrompted !== officialPrompt || document.querySelector(".active-study"))) render();
});

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
