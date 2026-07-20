import "./research-ui.js";
import { planningRecommendation } from "./journey-core.js";

const state = { model: null, triage: "t45", elapsed: 0 };

state.mode = 'planning';
state.context = null;
state.horizon = 60;
state.selectedHospital = null;
state.queuePosition = null;
state.priorityPressure = 'unknown';
state.planningPath = null;

const panel = document.querySelector('.control-panel');
panel.insertAdjacentHTML('afterbegin', `<div class='mode-switch' role='group' aria-label='使用情境'>
  <button class='active' data-mode='planning'>尚未到院 · 找最快選擇</button>
  <button data-mode='waiting'>已在急症室輪候</button>
</div>
<section class='planning-journey journey-panel' aria-labelledby='planning-title'>
  <div class='journey-heading'><span>出發前 · 約 1 分鐘</span><h2 id='planning-title'>先確認現在需要多快求助</h2><p>這不是醫療分流或診斷，答案不會被儲存。正式分流由急症室護士決定。</p></div>
  <div class='red-flag-box'>
    <strong>如有任何一項，不要繼續比較輪候時間（例子並非完整清單）：</strong>
    <ul><li>嚴重呼吸困難、不能正常說話或嘴唇發紫</li><li>失去知覺、反應異常、抽搐或突然昏厥</li><li>突然口齒不清、半邊臉或肢體無力</li><li>嚴重或持續胸痛、無法控制的出血或嚴重創傷</li><li>嚴重過敏反應，或情況正在快速惡化</li></ul>
    <button type='button' data-planning-path='emergency'>有任何一項／無法安全自行求診</button>
  </div>
  <div class='planning-choice' role='group' aria-label='以上紅旗都沒有時選擇目前情況'>
    <p>以上都沒有，選擇最接近目前的情況：</p>
    <button type='button' data-planning-path='urgent'><strong>仍然很不舒服或不確定</strong><span>就近求醫，不按輪候時間繞遠路</span></button>
    <button type='button' data-planning-path='stable_ae'><strong>情況穩定，仍打算去急症室</strong><span>查看 IV／V 類院級輪候參考</span></button>
    <button type='button' data-planning-path='primary_care'><strong>症狀輕微而且穩定</strong><span>先看看基層醫療選擇</span></button>
  </div>
  <div id='planning-advice' class='planning-advice hidden' aria-live='polite'></div>
</section>
<aside class='waiting-journey journey-panel hidden' aria-labelledby='waiting-title'>
  <div><span>已經完成登記／分流</span><h2 id='waiting-title'>等候期間，病情變化比倒數更重要</h2><p>如痛楚、呼吸、清醒程度或其他症狀轉差，立即告知分流護士，不要等待本頁刷新。</p></div>
  <button type='button' id='waiting-worse'>我的情況變差了</button>
  <div id='waiting-worse-advice' class='hidden' role='alert'><strong>現在通知急症室職員重新評估</strong><span>如無法接觸職員或情況危急，請身旁的人協助求助。此網頁不能替你重新分流。</span></div>
</aside>`);
const elapsedLabel = document.querySelector('#elapsed').closest('label');
const triageLabel = document.querySelector('#triage').closest('label');
elapsedLabel.classList.add('waiting-only', 'hidden');
elapsedLabel.insertAdjacentHTML('beforebegin', `<label class='hospital-field waiting-only hidden'>
  <span>你所在的醫院</span>
  <select id='current-hospital' aria-label='你所在的醫院'></select>
</label>`);
elapsedLabel.insertAdjacentHTML('afterend', `<div class='queue-context waiting-only hidden'>
  <label><span>你在同一分流級別中大約排第幾？（選填）</span><div class='input-with-unit'><input id='queue-position' type='number' min='1' step='1' placeholder='例如 2' aria-describedby='queue-position-help'><b>位</b></div><small class='field-help' id='queue-position-help'>例如「Cat 4 排第 2」；不是全急症室總次序。</small></label>
  <label><span>前方較高優先度個案（如知道）</span><select id='priority-pressure' aria-describedby='queue-priority-help'>
    <option value='unknown'>不知道／未獲告知</option>
    <option value='few'>約 1–2 個</option>
    <option value='several'>約 3 個或以上</option>
    <option value='continuous'>持續有新個案優先處理</option>
  </select><small class='field-help' id='queue-priority-help'>只按職員告知或確實知道的情況選擇。</small></label>
</div>`);
const hospitalField = document.querySelector('.hospital-field');
const queueContext = document.querySelector('.queue-context');

function populateHospitalSelect() {
  const select = document.querySelector('#current-hospital');
  const previous = state.selectedHospital;
  select.innerHTML = state.model.hospitals.map(hospital =>
    `<option value='${hospital.id}'>${hospital.name_tc}</option>`
  ).join('');
  state.selectedHospital = state.model.hospitals.some(row => row.id === previous)
    ? previous
    : state.model.hospitals[0]?.id;
  select.value = state.selectedHospital;
}

function syncModeControls() {
  const waiting = state.mode === 'waiting';
  const planningForecast = !waiting && planningRecommendation(state.planningPath)?.showForecast;
  elapsedLabel.classList.toggle('hidden', !waiting);
  triageLabel.classList.toggle('hidden', !waiting);
  hospitalField.classList.toggle('hidden', !waiting);
  queueContext.classList.add('hidden');
  document.querySelector('.planning-journey').classList.toggle('hidden', waiting);
  document.querySelector('.waiting-journey').classList.toggle('hidden', !waiting);
  document.querySelector('.research-section')?.classList.toggle('hidden', !waiting);
  document.querySelector('.summary').classList.toggle('hidden', waiting || !planningForecast);
  document.querySelector('.results-section').classList.toggle('hidden', !waiting && !planningForecast);
  document.querySelector('.forecast-lock').classList.toggle('hidden', !waiting && !planningForecast);
  document.querySelector('.forecast-lock').innerHTML = waiting
    ? `<span>目前狀態</span><strong>院內</strong><small>只顯示所在醫院</small>`
    : `<label><span>預計抵達</span><select id='arrival-minutes' aria-label='預計抵達時間'>
        ${[15, 30, 45, 60, 90, 120].map(value => `<option value='${value}' ${value === state.horizon ? 'selected' : ''}>${value} 分鐘後</option>`).join('')}
      </select></label>`;
  document.querySelector('#arrival-minutes')?.addEventListener('change', event => {
    state.horizon = Number(event.target.value);
    render();
  });
}

function syncJourneyCopy() {
  const waiting = state.mode === 'waiting';
  document.querySelector('.hero h1').innerHTML = waiting
    ? '已經在急症室，<br><em>還要怎樣等下去？</em>'
    : '先判斷要多快求醫，<br><em>再比較等候時間。</em>';
  document.querySelector('.hero-copy').textContent = waiting
    ? '只顯示你所在醫院的院級資料，並協助記錄仍在等候、隊列事件和第一次見醫生時間。'
    : '安全檢查不會儲存答案；只有情況穩定時，才用醫管局資料比較到院後的輪候情境。';
}

function choosePlanningPath(path) {
  const recommendation = planningRecommendation(path);
  if (!recommendation) return;
  state.planningPath = path;
  state.triage = 't45';
  document.querySelector('#triage').value = 't45';
  const advice = document.querySelector('#planning-advice');
  const actions = path === 'emergency'
    ? `<a class='journey-primary' data-sensitive-navigation href='tel:999'>致電 999</a>`
    : path === 'urgent'
      ? `<a class='journey-primary' data-sensitive-navigation href='https://www3.ha.org.hk/aedwt/index2.html?lang=tc' target='_blank' rel='noreferrer'>查看醫管局急症室名單</a>`
      : path === 'primary_care'
        ? `<a class='journey-primary' data-sensitive-navigation href='https://www.pcdirectory.gov.hk/' target='_blank' rel='noreferrer'>搜尋基層醫療服務</a><a data-sensitive-navigation href='https://www.ha.org.hk/fmc' target='_blank' rel='noreferrer'>普通科門診資料</a>`
        : `<button type='button' class='journey-primary' data-scroll-results>查看醫院輪候比較</button>`;
  advice.className = `planning-advice ${recommendation.tone}`;
  advice.innerHTML = `<small>行動建議</small><h3>${recommendation.title}</h3><p>${recommendation.body}</p><div>${actions}<button type='button' data-reset-planning>重新選擇</button></div>`;
  document.querySelector('.red-flag-box').classList.add('hidden');
  document.querySelector('.planning-choice').classList.add('hidden');
  syncModeControls();
  if (state.model) render();
  advice.querySelector('[data-scroll-results]')?.addEventListener('click', () =>
    document.querySelector('.results-section').scrollIntoView({ behavior: 'smooth' })
  );
  advice.querySelector('[data-reset-planning]')?.addEventListener('click', () => {
    state.planningPath = null;
    advice.className = 'planning-advice hidden';
    advice.innerHTML = '';
    document.querySelector('.red-flag-box').classList.remove('hidden');
    document.querySelector('.planning-choice').classList.remove('hidden');
    syncModeControls();
  });
}

document.querySelectorAll('[data-planning-path]').forEach(button =>
  button.addEventListener('click', () => choosePlanningPath(button.dataset.planningPath))
);
document.querySelector('#waiting-worse')?.addEventListener('click', () => {
  document.querySelector('#waiting-worse-advice').classList.remove('hidden');
});
document.addEventListener('click', event => {
  if (event.target.closest('[data-sensitive-navigation]')) event.stopImmediatePropagation();
}, true);

document.querySelectorAll('.mode-switch button').forEach(button => button.addEventListener('click', () => {
  state.mode = button.dataset.mode;
  document.querySelectorAll('.mode-switch button').forEach(item => item.classList.toggle('active', item === button));
  if (state.mode === 'waiting' && state.elapsed === 0) {
    state.elapsed = 60;
    document.querySelector('#elapsed').value = 60;
  }
  if (state.mode === 'planning') {
    state.elapsed = 0;
    document.querySelector('#elapsed').value = 0;
  }
  syncJourneyCopy();
  syncModeControls();
  if (state.model) render();
}));

document.addEventListener('click', event => {
  const card = event.target.closest('.hospital-card');
  if (!card || !state.model) return;
  const hospital = state.model.hospitals.find(row => row.id === card.dataset.id);
  const cycle = hospital.triage[state.triage].cycle_profile;
  const body = document.querySelector('.dialog-body');
  if (!body) return;
  const periods = cycle.periods.map(period => `<div><span>${period.label}</span><strong>${fmtMinutes(period.median_minutes)}</strong><small>${period.vs_overall_minutes >= 0 ? '+' : ''}${period.vs_overall_minutes} 分鐘</small></div>`).join('');
  body.insertAdjacentHTML('beforeend', `<section class='cycle-detail'><h3>這間醫院的時段週期</h3><div>${periods}</div><p>歷史高峰：${cycle.historical_peak}。<small>${cycle.note}</small></p></section>`);
});

const displayMetric = (hospital) => {
  const metric = hospital.triage[state.triage];
  if (state.mode === 'planning') return metric.forecast_by_horizon?.[String(state.horizon)] || metric.forecast_60m;
  const current = metric.current;
  return {
    p10: current.p50,
    p50: current.p50,
    p90: current.p95,
    shock_probability: metric.forecast_60m.shock_probability,
    analog_count: metric.forecast_60m.analog_count,
    definition: metric.forecast_60m.definition
  };
};

const fmtMinutes = (minutes) => {
  const value = Math.max(0, Math.round(minutes));
  if (value < 60) return `${value} 分`;
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return mins ? `${hours} 小時 ${mins} 分` : `${hours} 小時`;
};

const riskClass = (risk) => risk >= 35 ? "high" : risk >= 20 ? "medium" : "low";
const riskLabel = (risk) => risk >= 35 ? "較高延誤風險" : risk >= 20 ? "留意延誤" : "延誤風險較低";
const remaining = (value) => Math.max(0, value);

const queueStateText = (hospital) => {
  const waited = state.elapsed > 0 ? `已等 ${fmtMinutes(state.elapsed)}仍未見醫生` : '剛開始等候';
  const position = state.queuePosition ? `同級第 ${state.queuePosition} 位` : '同級位置未知';
  const pressureLabels = {
    unknown: '較高優先度個案數量未知',
    few: '前方有少量較高優先度個案',
    several: '前方有幾個較高優先度個案',
    continuous: '較高優先度個案持續到達'
  };
  const officialSignal = hospital.signals.multiple_resuscitation ? '官方顯示多宗復甦個案' :
    hospital.signals.critical ? '官方顯示正處理危殆個案' :
      hospital.signals.emergency ? '官方顯示正處理危急個案' : '';
  return [waited, position, pressureLabels[state.priorityPressure], officialSignal].filter(Boolean).join(' · ');
};

function renderResults() {
  const allHospitals = [...state.model.hospitals].sort((a, b) =>
    remaining(displayMetric(a).p50) - remaining(displayMetric(b).p50)
  );
  const hospitals = state.mode === 'waiting'
    ? allHospitals.filter(row => row.id === state.selectedHospital)
    : allHospitals;
  const visible = hospitals.length ? hospitals : allHospitals.slice(0, 1);
  const grid = document.querySelector('#hospital-grid');
  const heading = document.querySelector('.results-section .section-heading h2');
  const description = document.querySelector('.results-section .section-heading p');
  grid.classList.toggle('single-result', state.mode === 'waiting');
  heading.textContent = state.mode === 'waiting' ? '你的輪候估算' : '最快醫院排序';
  description.textContent = state.mode === 'waiting'
    ? `${visible[0].name_tc} · 不顯示其他醫院`
    : `按預計 ${state.horizon} 分鐘後抵達的中位輪候時間排列`;
  document.querySelector('#hospital-count').textContent = allHospitals.length;
  document.querySelector('#snapshot-count').textContent = state.model.training_window.snapshots.toLocaleString('zh-HK');
  document.querySelector('#best-wait').textContent = fmtMinutes(remaining(displayMetric(allHospitals[0]).p50));
  const maxWait = Math.max(...visible.map(hospital => displayMetric(hospital).p90), 1);
  grid.innerHTML = visible.map((hospital, index) => {
    const forecast = displayMetric(hospital);
    const risk = forecast.shock_probability ?? 0;
    const signal = hospital.signals.multiple_resuscitation ? '多宗復甦個案' :
      hospital.signals.critical ? '正處理危殆個案' : hospital.signals.emergency ? '正處理危急個案' : '';
    const rank = state.mode === 'waiting' ? '你所在的醫院' : `#${String(index + 1).padStart(2, '0')}`;
    const waiting = state.mode === 'waiting';
    const waitLabel = waiting ? '個人剩餘時間' : '預計輪候';
    return `<button class='hospital-card' data-id='${hospital.id}'>
      <div class='card-top'><span class='rank'>${rank}</span><span class='risk-pill ${riskClass(risk)}'>${risk}% · ${riskLabel(risk)}</span></div>
      <h3>${hospital.name_tc}</h3><div class='en-name'>${hospital.name_en}</div>
      <div class='wait-line'><strong>${waiting ? '未能可靠倒數' : fmtMinutes(remaining(forecast.p50)).replace(' 小時', 'h').replace(' 分', 'm')}</strong><span>${waitLabel}</span></div>
      <div class='range-track'><i style='width:${Math.min(100, forecast.p90 / maxWait * 100)}%'></i></div>
      <div class='card-meta'><span>${waiting ? `新到院者官方顯示 ${fmtMinutes(forecast.p50)}–${fmtMinutes(forecast.p90)}` : `常見範圍 ${fmtMinutes(forecast.p10)}–${fmtMinutes(forecast.p90)}`}</span><span class='signal'>${waiting ? queueStateText(hospital) : signal}</span></div>
    </button>`;
  }).join('');
  document.querySelectorAll('.hospital-card').forEach(card => card.addEventListener('click', () => openScenarioDetail(card.dataset.id)));
}

function render() {
  return renderResults();
  const hospitals = [...state.model.hospitals].sort((a, b) =>
    remaining(displayMetric(a).p50) - remaining(displayMetric(b).p50)
  );
  document.querySelector("#hospital-count").textContent = hospitals.length;
  document.querySelector("#snapshot-count").textContent = state.model.training_window.snapshots.toLocaleString("zh-HK");
  document.querySelector("#best-wait").textContent = fmtMinutes(remaining(hospitals[0].triage[state.triage].forecast_60m.p50));
  document.querySelector('#best-wait').textContent = fmtMinutes(remaining(displayMetric(hospitals[0]).p50));
  const maxWait = Math.max(...hospitals.map(h => displayMetric(h).p90), 1);
  document.querySelector("#hospital-grid").innerHTML = hospitals.map((hospital, index) => {
    const metric = hospital.triage[state.triage];
    const forecast = displayMetric(hospital);
    const risk = forecast.shock_probability ?? 0;
    const signal = hospital.signals.multiple_resuscitation ? "多宗復甦個案" :
      hospital.signals.critical ? "正處理危殆個案" : hospital.signals.emergency ? "正處理危急個案" : "";
    return `<button class="hospital-card" data-id="${hospital.id}">
      <div class="card-top"><span class="rank">#${String(index + 1).padStart(2, "0")}</span><span class="risk-pill ${riskClass(risk)}">${risk}% · ${riskLabel(risk)}</span></div>
      <h3>${hospital.name_tc}</h3><div class="en-name">${hospital.name_en}</div>
      <div class="wait-line"><strong>${fmtMinutes(remaining(forecast.p50)).replace(" 小時", "h").replace(" 分", "m")}</strong><span>預計輪候</span></div>
      <div class="range-track"><i style="width:${Math.min(100, forecast.p90 / maxWait * 100)}%"></i></div>
      <div class="card-meta"><span>常見範圍 ${fmtMinutes(remaining(forecast.p10))}–${fmtMinutes(remaining(forecast.p90))}</span><span class="signal">${signal}</span></div>
    </button>`;
  }).join("");
  document.querySelectorAll(".hospital-card").forEach(card => card.addEventListener("click", () => openDetail(card.dataset.id)));
}

function openDetail(id) {
  const hospital = state.model.hospitals.find(row => row.id === id);
  const metric = hospital.triage[state.triage];
  const forecast = displayMetric(hospital);
  const current = metric.current;
  const triageLabel = state.triage === "t3" ? "III · 緊急" : "IV / V · 次緊急、非緊急";
  document.querySelector("#dialog-content").innerHTML = `<div class="dialog-body">
    <div class="dialog-kicker">${triageLabel} · 60 MIN FORECAST</div>
    <h2>${hospital.name_tc}</h2><div class="en-name">${hospital.name_en}</div>
    <div class="dialog-metrics">
      <div><span>一小時後院級中位</span><strong>${fmtMinutes(remaining(forecast.p50))}</strong><small>沒有扣除個人已等候時間</small></div>
      <div><span>常見上緣</span><strong>${fmtMinutes(remaining(forecast.p90))}</strong><small>相似狀態第 90 百分位</small></div>
      <div><span>延誤風險</span><strong>${forecast.shock_probability}%</strong><small>${forecast.definition}</small></div>
    </div>
    <h3>隱含壓力 ${metric.pressure_score} / 100</h3>
    <div class="pressure-bar"><i style="width:${metric.pressure_score}%"></i></div>
    <p>目前官方 p50 為 ${fmtMinutes(current.p50)}、p95 為 ${fmtMinutes(current.p95)}；過去一小時變化為 ${current.trend_60m >= 0 ? "+" : ""}${current.trend_60m} 分鐘。估算會參考同院在相近時段與壓力下的歷史變化。</p>
    <p><strong>個人院內輪候：</strong>官方數字是到院時的院級分布，不會減去個人已等待時間。仍未見醫生是條件事件；沒有病人級完成資料時不作個人倒數。</p>
  </div>`;
  document.querySelector("#detail-dialog").showModal();
}

function openScenarioDetail(id) {
  openDetail(id);
  const waiting = state.mode === 'waiting';
  document.querySelector('.dialog-kicker').textContent = waiting
    ? 'IN-HOSPITAL REMAINING ESTIMATE'
    : `${state.horizon} MIN ARRIVAL FORECAST`;
  const firstMetric = document.querySelector('.dialog-metrics div');
  firstMetric.querySelector('span').textContent = waiting ? '個人條件輪候狀態' : `${state.horizon} 分鐘後中位`;
  firstMetric.querySelector('small').textContent = waiting
    ? `已等候 ${state.elapsed} 分鐘`
    : `預計 ${state.horizon} 分鐘後抵達`;
  if (waiting) {
    firstMetric.querySelector('strong').textContent = '—';
    const metrics = document.querySelectorAll('.dialog-metrics > div');
    metrics[1].querySelector('span').textContent = '新到院者官方上緣';
    metrics[1].querySelector('small').textContent = '不是你的個人剩餘時間';
    const explanation = document.querySelectorAll('.dialog-body > p');
    explanation[explanation.length - 1].innerHTML = `<strong>院內隊列：</strong>${queueStateText(state.model.hospitals.find(row => row.id === id))}。分流採優先隊列；同級位置不等於整體位置，較高優先度個案可令你的隊列暫停推進。`;
  }
  const hospital = state.model.hospitals.find(row => row.id === id);
  const forecast = displayMetric(hospital);
  const activity = state.context?.operational_context?.annual_ae_attendance_by_hospital?.[hospital.name_en];
  const cycle = hospital.triage[state.triage].cycle_profile;
  const simulation = forecast.simulation;
  const simulationText = !waiting && simulation
    ? `在 ${simulation.sample_count} 個相似轉移中，輪候不超過兩小時的比例為 ${simulation.within_120_pct}%，超過四小時為 ${simulation.over_240_pct}%。`
    : '每次刷新會在「仍未見醫生」的條件下更新隊列狀態；沒有病人級首次見醫生事件，不能提供已校準的個人完成機率。';
  document.querySelector('.dialog-body').insertAdjacentHTML('beforeend', `<section class='evidence-note'>
    <h3>如何理解這個估算</h3>${activity ? `<p>該院年度急症求診約 ${Number(activity).toLocaleString('zh-HK')} 人次；此年度規模資料不代表當值夜班人手。</p>` : ''}
    <p>同院歷史高峰時段為 ${cycle.historical_peak}，較全日中位 ${cycle.peak_vs_overall_minutes >= 0 ? '+' : ''}${cycle.peak_vs_overall_minutes} 分鐘。${cycle.historical_lowest_hour ? `每小時低位常見於 ${cycle.historical_lowest_hour}；下降最快的起始時段為 ${cycle.fastest_clearing_hour}（下一小時中位變化 ${cycle.fastest_clearing_change_next_60m >= 0 ? '+' : ''}${cycle.fastest_clearing_change_next_60m} 分）。` : ''}這是觀察到的輪候週期和隊列變化，不等同員工效率。</p>
    <p>${simulationText}</p>
  </section>`);
}

const LIVE_URL = 'https://www.ha.org.hk/opendata/aed/aedwtdata2-en.json';
const LIVE_STORAGE_KEY = 'aed-pred-live-history-v1';
const LIVE_REFRESH_MS = 5 * 60 * 1000;
const LIVE_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = LIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function parseLiveWait(value) {
  if (!value || value.toLowerCase().includes('multiple resuscitation')) return null;
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return value.toLowerCase().includes('hour') ? amount * 60 : amount;
}

function parseLiveTimestamp(value) {
  const match = value.replace(/\s/g, '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(\d{1,2}):(\d{2})(AM|PM)/i);
  if (!match) return new Date();
  let hour = Number(match[4]) % 12;
  if (match[6].toUpperCase() === 'PM') hour += 12;
  return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), hour - 8, Number(match[5])));
}

function readLiveHistory() {
  try {
    return JSON.parse(localStorage.getItem(LIVE_STORAGE_KEY) || '[]');
  } catch (_) {
    return [];
  }
}

function saveLiveHistory(history) {
  try {
    localStorage.setItem(LIVE_STORAGE_KEY, JSON.stringify(history.slice(-192)));
  } catch (_) {
    // Private browsing or storage policies may disable localStorage.
  }
}

async function refreshLiveData() {
  const response = await fetchWithTimeout(LIVE_URL + '?t=' + Date.now(), { cache: 'no-store' });
  if (!response.ok) throw new Error('HA live HTTP ' + response.status);
  const payload = await response.json();
  const observedAt = parseLiveTimestamp(payload.updateTime);
  const liveRows = new Map(payload.waitTime.map(row => [row.hospName, row]));
  let history = readLiveHistory();
  const snapshot = { timestamp: observedAt.toISOString(), hospitals: {} };
  payload.waitTime.forEach(row => {
    snapshot.hospitals[row.hospName] = {
      t3: parseLiveWait(row.t3p50),
      t45: parseLiveWait(row.t45p50)
    };
  });
  history = history.filter(row => row.timestamp !== snapshot.timestamp);
  history.push(snapshot);
  history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const prior = [...history].reverse().find(row => {
    const age = observedAt - new Date(row.timestamp);
    return age >= 45 * 60 * 1000 && age <= 90 * 60 * 1000;
  });
  saveLiveHistory(history);

  state.model.hospitals.forEach(hospital => {
    const live = liveRows.get(hospital.name_en);
    if (!live) return;
    const critical = live.manageT1case === 'Y' || live.manageT1case === 'N/A';
    const emergency = live.manageT2case === 'Y' || live.manageT2case === 'N/A';
    const previousPriority = Boolean(hospital.signals.critical || hospital.signals.emergency || hospital.signals.multiple_resuscitation);
    hospital.signals = {
      critical,
      emergency,
      multiple_resuscitation: live.manageT1case === 'N/A' || live.manageT2case === 'N/A'
    };
    const currentPriority = critical || emergency || hospital.signals.multiple_resuscitation;
    window.dispatchEvent(new CustomEvent('aed:official-priority-status', { detail: {
      hospitalId: hospital.id, active: currentPriority, newlyActive: !previousPriority && currentPriority,
      critical, emergency, multipleResuscitation: hospital.signals.multiple_resuscitation,
      updatedAt: observedAt.toISOString(),
    } }));
    [['t3', 't3p50', 't3p95'], ['t45', 't45p50', 't45p95']].forEach(([triage, p50Field, p95Field]) => {
      const metric = hospital.triage[triage];
      const liveP50 = parseLiveWait(live[p50Field]);
      const liveP95 = parseLiveWait(live[p95Field]);
      if (liveP50 === null || liveP95 === null) return;
      const delta = liveP50 - metric.current.p50;
      Object.values(metric.forecast_by_horizon || {}).forEach(forecast => {
        forecast.p10 = Math.max(0, Math.round(forecast.p10 + delta));
        forecast.p50 = Math.max(0, Math.round(forecast.p50 + delta));
        forecast.p90 = Math.max(forecast.p50, Math.round(forecast.p90 + delta));
      });
      metric.forecast_60m = metric.forecast_by_horizon?.['60'] || metric.forecast_60m;
      metric.current.p50 = liveP50;
      metric.current.p95 = liveP95;
      const priorWait = prior?.hospitals?.[hospital.name_en]?.[triage];
      if (priorWait !== undefined && priorWait !== null) metric.current.trend_60m = Math.round(liveP50 - priorWait);
    });
  });
  state.model.as_of = observedAt.toISOString();
  state.live = true;
}

async function refreshLiveAndRender() {
  if (!state.model) return;
  try {
    await refreshLiveData();
  } catch (_) {
    state.live = false;
  }
  render();
}

async function init() {
  try {
    const response = await fetch("data/model.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.model = await response.json();
    populateHospitalSelect();
    syncModeControls();
    // Show the precomputed forecast immediately; optional live/context requests
    // must not leave the results area empty.
    render();
    try {
      const contextResponse = await fetch('data/context.json', { cache: 'no-store' });
      if (contextResponse.ok) {
        state.context = await contextResponse.json();
        state.model.sources = [...state.model.sources, ...state.context.sources];
        let banner = document.querySelector('.season-banner');
        if (!banner) {
          document.querySelector('.hero').insertAdjacentHTML('afterend', `<section class='season-banner'></section>`);
          banner = document.querySelector('.season-banner');
        }
        const seasonal = state.context.seasonal_pressure;
        const operational = state.context.operational_context;
        banner.innerHTML = `<div><span>季節背景 · 截至 ${seasonal.week_ending}</span><strong>流感壓力 ${seasonal.level}</strong></div>
          <p>急症室流感樣疾病率 ${seasonal.aed_ili_rate}，較前週 ${seasonal.aed_ili_change >= 0 ? '+' : ''}${seasonal.aed_ili_change}；最近三年百分位 ${seasonal.aed_ili_percentile_3y}%。<small>${seasonal.note}</small><small>${operational?.note || ''}</small></p>`;
      }
    } catch (_) {
      // Seasonal context is optional; core waiting-time predictions still render.
    }
    try {
      await refreshLiveData();
    } catch (_) {
      state.live = false;
    }
    const asOf = new Date(state.model.as_of);
    const ageHours = (Date.now() - asOf.getTime()) / 36e5;
    const freshness = document.querySelector("#freshness");
    freshness.classList.toggle("stale", ageHours > 2);
    freshness.innerHTML = `<span class="status-dot"></span>資料截至 ${asOf.toLocaleString("zh-HK", { timeZone: "Asia/Hong_Kong", hour12: false })}${ageHours > 2 ? " · 可能已過期" : ""}`;
    document.querySelector("#pressure-definition").textContent = state.model.model.pressure_definition;
    const modelNotes = [...(state.model.model.expert_assumptions || []), ...state.model.model.limitations];
    document.querySelector("#limitations").innerHTML = modelNotes.map(text => `<li>${text}</li>`).join("");
    document.querySelector("#sources").innerHTML = state.model.sources.map(source => `<a href="${source.url}" target="_blank" rel="noreferrer">${source.label}</a>`).join("");
    render();
    if (state.live) document.querySelector('#freshness').insertAdjacentHTML('beforeend', ' · 醫管局即時直連');
  } catch (error) {
    document.querySelector("#freshness").innerHTML = `<span class="status-dot"></span>無法載入模型資料`;
    document.querySelector("#hospital-grid").innerHTML = `<p>資料載入失敗：${error.message}</p>`;
  }
}

document.querySelector("#triage").addEventListener("change", event => { state.triage = event.target.value; render(); });
document.querySelector("#elapsed").addEventListener("input", event => { state.elapsed = Math.max(0, Number(event.target.value) || 0); render(); });
document.querySelector(".dialog-close").addEventListener("click", () => document.querySelector("#detail-dialog").close());
document.querySelector("#detail-dialog").addEventListener("click", event => { if (event.target.nodeName === "DIALOG") event.target.close(); });
document.querySelector('#current-hospital').addEventListener('change', event => {
  state.selectedHospital = event.target.value;
  render();
});
document.querySelector('#queue-position').addEventListener('input', event => {
  const value = Number(event.target.value);
  state.queuePosition = value >= 1 ? Math.floor(value) : null;
  render();
});
document.querySelector('#priority-pressure').addEventListener('change', event => {
  state.priorityPressure = event.target.value;
  render();
});
syncJourneyCopy();
init();
setInterval(refreshLiveAndRender, LIVE_REFRESH_MS);
