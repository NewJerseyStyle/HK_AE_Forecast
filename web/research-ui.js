import QRCode from "qrcode";
import {
  CONSENT_VERSION, ensureAnonymousAuth, flushQueue, getTurnstileSiteKey, invoke,
  loadLocalSession, queueEvent, reminderDue, researchConfigured, saveLocalSession, validateEventTime,
} from "./research-core.js";

const local = window.localStorage;
let current = loadLocalSession(local);
let startChallengeToken = "";
let recoveryChallengeToken = "";
let recoveryAuthChallengeToken = "";

function datetimeLocal(date = new Date()) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function sectionHtml() {
  return `<section class="research-section" id="wait-study" aria-labelledby="study-title">
    <div class="section-heading"><div><span class="section-no">LIVE</span><h2 id="study-title">記錄你的實際等候</h2></div>
      <p>每次明確回報都能補足「何時真正第一次見醫生」的資料缺口</p></div>
    <div class="study-shell">
      <div id="study-status" class="study-status" role="status"></div>
      <div id="study-content"></div>
    </div>
  </section>`;
}

function setupHtml() {
  const disabled = researchConfigured() ? "" : `<p class="config-warning">研究收集尚未連接 Supabase；預測比較仍可使用。部署者需先設定公開 URL、publishable key 與 Turnstile。</p>`;
  return `${disabled}<form id="study-start">
    <div class="privacy-summary"><strong>只收集最低限度資料</strong><p>醫院、到院及回報時間、分流級別、隊列情境。絕不填寫姓名、身份證、電話、症狀或診斷。資料存放於 Supabase 新加坡區域；平台日誌可能包含網絡中繼資料。原始事件保留 24 個月，其後只保留最少 20 宗一組的不可逆彙總。</p></div>
    <label><span>到院時間</span><input name="arrival_at" type="datetime-local" required value="${datetimeLocal()}"></label>
    <label><span>實際分流級別</span><select name="triage" required>
      <option value="unknown">尚未知道</option><option value="t3">III 緊急</option><option value="t4">IV 次緊急</option><option value="t5">V 非緊急</option>
    </select></label>
    <label><span>同級位置（如知道）</span><input name="same_triage_position" type="number" min="1" max="999"></label>
    <label><span>較高優先病人</span><select name="priority_pressure"><option value="unknown">不知道</option><option value="few">少量</option><option value="several">幾個</option><option value="continuous">持續插隊</option></select></label>
    <label class="consent"><input name="consent" type="checkbox" required><span>我明白這是未校準研究情境、不是個人就診承諾；我同意按上述用途收集資料，並可隨時刪除本次原始記錄。</span></label>
    <div id="turnstile-box"></div>
    <button class="primary-action" type="submit" ${researchConfigured() ? "" : "disabled"}>開始記錄</button>
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
  return `<div class="active-study">
    <div class="estimate-box"><small>未校準研究情境 · 非個人就診承諾</small>${estimateHtml}<p>較高優先個案訊號另行顯示，不會用任意分鐘數調整。</p></div>
    <p><strong>${session.hospital_id}</strong> · 到院 ${new Date(session.arrival_at).toLocaleString("zh-HK")} · ${session.triage.toUpperCase()}</p>
    <div id="reminder" class="reminder hidden">已過 15 分鐘，請確認目前狀態。</div>
    <div class="event-actions">
      <button data-event="still_waiting">仍在等候</button><button data-event="seen_doctor">第一次見到醫生</button>
      <button data-event="left_without_doctor">未見醫生便離開</button><button data-event="transferred">轉院／其他</button>
    </div>
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
        triage: form.get("triage"), same_triage_position: form.get("same_triage_position") || null,
        priority_pressure: form.get("priority_pressure"), consent_version: CONSENT_VERSION,
      });
      current = { ...result, recovery_code: result.recovery_code }; saveLocalSession(local, current); render(); setStatus("記錄已開始。");
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
    event_id: crypto.randomUUID(), session_id: current.session.id, event_type: type, event_at: eventAt.toISOString(),
    same_triage_position: position, priority_pressure: pressure, client_version: "web-0.2.0",
  };
  queueEvent(local, payload);
  const result = await invoke("wait-session-event", payload);
  current = { ...current, ...result, recovery_code: current.recovery_code };
  saveLocalSession(local, current);
  await flushQueue(local, (item) => invoke("wait-session-event", item));
  render(); setStatus(type === "still_waiting" ? "已記錄：仍在等候。估計已按條件更新。" : "已記錄結果，謝謝。");
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
  if (navigator.onLine) flushQueue(local, (item) => invoke("wait-session-event", item)).catch(() => {});
  window.addEventListener("online", () => flushQueue(local, (item) => invoke("wait-session-event", item)).catch(() => {}));
  setInterval(() => document.querySelector("#reminder")?.classList.toggle("hidden", !reminderDue(current?.session)), 60_000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
