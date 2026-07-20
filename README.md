# ER / ETA — 香港急症室抵達時間預測

這是一個可部署到 GitHub Pages 的靜態資料產品。它使用醫管局每 15 分鐘發佈、由 DATA.GOV.HK 保存的歷史快照，估計各急症室在 15 至 120 分鐘後的：

- 分流 III、IV/V 的預計 p50 與常見範圍；
- 「突然延誤」的歷史情境機率；
- 相對於該院自身歷史的隱含壓力（constraint proxy）。

`constraint` 並非實際容量。官方資料沒有到達人數、人手、床位、服務率或個別病人完成時間，因此本專案不宣稱能反推出真實排隊容量，也不預測某一宗急救個案。

## 本機執行

需求：Python 3.11+ 與 [uv](https://docs.astral.sh/uv/)。專案本身沒有第三方 Python runtime dependency。

```powershell
uv run python -m unittest discover -s tests
uv run aed-pred bootstrap --days 45 --workers 24
uv run python -m http.server 8000 --directory web
```

開啟 `http://localhost:8000`。`bootstrap` 會從官方歷史 API 下載 15 分鐘快照，寫出：

- `data/training_state.json.gz`：壓縮後的相似狀態池，供後續刷新；
- `web/data/model.json`：GitHub Pages 只讀取的精簡公開模型。

如只想快速驗證流程，可加入 `--sample-every 4`，每小時取一筆。正式建模建議至少 90 天完整 15 分鐘資料。

## 模型

對每間醫院、每個分流組別，模型以當前 p50、p95-p50 差距、最近一小時趨勢、時段、星期、公眾假期與危急／危殆訊號，找出最多 240 個相似歷史狀態，再讀取這些狀態 15、30、45、60、90、120 分鐘後的等待時間分布。資料按時間分成 60% 訓練、20% 校準與 20% 最終測試；校準窗在 persistence、趨勢外推、歷史類比及三種混合權重中選模，最後測試若不勝 persistence 便使用基準保護。

有經驗醫生口述夜間人手較少，因此 00–06 被視為獨立容量 regime，夜間狀態會更優先配對夜間歷史。由於沒有逐院逐更人手數或容量減幅，模型不會武斷加入固定延誤分鐘。

目前提交的訓練狀態包含 2,795 個官方快照，涵蓋 2026-06-13 至 2026-07-13；15 分鐘相鄰間隔佔 98.1%。這比原型資料多約 4.4 倍，但仍未涵蓋完整流感季節，正式模型仍建議逐步擴展至一年。

壓力分數為同院同分流歷史百分位：`72% × p50 百分位 + 28% × (p95-p50) 百分位`。它適合比較某院「相對自己平常有多擠」，不適合直接比較兩院的真實醫療資源。

## GitHub Pages

Health monitoring, consent-gated GA4 setup, and Stage 2 model release gates are documented in [docs/operations.md](docs/operations.md).

Web app 有兩個使用情境：

- 「尚未到院」先選預計抵達時間，再按該時距的中位輪候估算由快至慢排序 18 間急症室；
- 「已在急症室輪候」只顯示用戶所在醫院，以最新官方 p50/p95、已等候分鐘及最近一小時惡化幅度，提供粗略剩餘時間情境。

頁面每五分鐘直接讀取醫管局 JSON，並在同一瀏覽器的 localStorage 保留最多兩天快照作當日趨勢。GitHub Actions 只在 push 或手動執行時部署靜態檔案，不定時抓取醫療資料。每週季節背景隨模型重建更新；外部來源的採用理由與限制見 [外部資料評估](docs/data-source-assessment.md)。

1. 把 repository 的預設 branch 設為 `main`。
2. 在 GitHub 的 **Settings → Pages → Source** 選擇 **GitHub Actions**。
3. Push 到 main 或手動執行 `Deploy Pages`。部署後，瀏覽器會直接向醫管局刷新即時資料。

訓練狀態必須先由 `bootstrap` 產生並提交。正式重訓可按週或按月手動執行；DATA.GOV.HK 已保存官方 15 分鐘歷史快照，所以無需由本 repository 重複收集。

## 官方來源

- [DATA.GOV.HK 急症室等候時間](https://data.gov.hk/tc-data/dataset/hospital-hadata-ae-waiting-time)
- [醫管局 JSON](https://www.ha.org.hk/opendata/aed/aedwtdata2-en.json)
- [資料字典](https://www.ha.org.hk/opendata/Data-Specification-for-A%26E-Waiting-Time-tc.pdf)
- [歷史資料 API 規格](https://data.gov.hk/tc/help/api-spec)

本工具不是醫療建議。遇到危急情況請致電 999。
院內輪候模式不會把已等待時間從官方醫院級估算直接扣除。它只顯示同級位置、較高優先度壓力和官方新到院者資料；沒有病人級隊列、分流到達率與每更完成率時，不提供虛假的個人倒數。現場觀察及尚待驗證的容量／需求假設見 [docs/field-observations.md](docs/field-observations.md)。

「再等一段時間仍未見醫生」會被當成條件存活事件，而不是官方 p50 的數值變化；模型目標、可識別限制與所需資料見 [docs/conditional-wait-model.md](docs/conditional-wait-model.md)。

歷史下載會按月寫入 data/archive-cache/，中斷後可續傳；目前公開模型使用 2026-04-15 起約 90 天、8,561 個完整 15 分鐘快照。
