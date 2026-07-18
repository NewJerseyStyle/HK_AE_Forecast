# 院內等候縱向資料方案

## 研究事件定義

「第一次見醫生」指病人第一次面對面接受醫生的臨床評估；不包括登記、分流護士、抽血、影像或只收到行政通知。每個參與者建立一個 wait session，並在院內每 15 分鐘被提示明確回報：

- 仍在等候（會更新右設限時間）
- 第一次見醫生（完成事件）
- 未見醫生便離開
- 轉院／其他

官方 API 自動刷新不代表病人仍在現場。48 小時沒有明確回報的 session 會標記為 lost to follow-up，最後一次「仍在等候」是右設限時間。

## 最小資料與私隱

收集醫院、到院／事件時間、實際 Cat III／IV／V／未知、同級位置及較高優先個案壓力。不要收集姓名、身份證、電話、電郵、症狀、診斷或自由文字。

資料庫部署於 Supabase 新加坡區域。Supabase 平台日誌仍可能含 IP 等網絡中繼資料，因此公開收集前必須：

1. 填寫實際營運者及私隱聯絡方法。
2. 完成香港《個人資料（私隱）條例》及必要的研究倫理審查。
3. 啟用 Anonymous Auth CAPTCHA／Turnstile、Edge Function JWT 驗證及 production CORS allowlist。
4. 設定至少 32 bytes 的 RECOVERY_CODE_PEPPER，並確認 service-role key 只存在 Supabase secrets。

參與者可隨時刪除自己的原始 session。原始事件保存 24 個月；之後只保留至少 20 宗一格的醫院 × 分流 × 月份 × 到院小時彙總，小於 20 宗的格不保留。

## 模型發布閘門

Stage 1 使用到院時官方 p50／p95 擬合 log-normal，計算條件分布 P(T - t <= r | T > t)。

它不會用官方時間直接減去已等時間。基線缺失、p95 不大於 p50、存活機率小於 1%，或已超過擬合 p99 時停止顯示。危急／復甦訊號只另行展示，不加減任意分鐘。

Stage 2 是 15 分鐘離散時間 hazard model，正確納入右設限。第一個正式模型用 regularized pooled logistic；XGBoost 是 challenger，MLP 在資料量及校準證據足夠前不使用。07:00 容量提升、09:00 前需求及夜間人手較少屬先驗與 residual check，不硬編碼成分鐘。

只有同時符合以下條件才取代 Stage 1：

- 至少 500 個完成事件、8 週、10 間醫院。
- 每個發布分層至少 50 個訓練和 20 個測試事件。
- 時序 holdout Brier score 改善至少 10%。
- calibration error 不高於 0.10。

所有畫面必須保留「未校準研究情境，非個人就診承諾」。
