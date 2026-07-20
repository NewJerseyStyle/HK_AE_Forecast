export const PLANNING_PATHS = Object.freeze({
  emergency: {
    tone: "danger",
    title: "立即致電 999",
    body: "不要因比較輪候時間而延誤求助，也不要自行駕駛。告訴接線員所在位置和目前情況。",
    showForecast: false,
  },
  urgent: {
    tone: "urgent",
    title: "不要按輪候時間繞遠路",
    body: "這個網頁不能判定分流級別。請前往就近急症室；若無法安全前往、病情快速轉差或你不確定是否安全，致電 999。",
    showForecast: false,
  },
  stable_ae: {
    tone: "stable",
    title: "可查看次緊急／非緊急輪候參考",
    body: "以下只是假設到院後被分為 IV／V 類的院級參考。實際分流只能由急症室護士按臨床狀況決定。",
    showForecast: true,
  },
  primary_care: {
    tone: "alternative",
    title: "可先考慮基層醫療",
    body: "若症狀輕微、穩定且沒有紅旗，可考慮家庭醫生或普通科門診。若情況轉差，重新評估並立即求助。",
    showForecast: false,
  },
});

export function planningRecommendation(path) {
  return PLANNING_PATHS[path] || null;
}

export const CLINICAL_HANDOFF_TEMPLATE =
  "我最主要的問題是＿＿。由＿＿（時間）開始，現在是＿＿，比開始時＿＿。同時有／沒有＿＿。重要病史或藥物過敏：＿＿。今天＿＿時服用了＿＿（藥名／劑量），效果是＿＿。我最擔心／最想問的是＿＿。";
