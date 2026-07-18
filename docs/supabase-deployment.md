# Supabase 部署

## 一次性設定

1. 建立 Singapore region 的 Supabase project。
2. 安裝 Supabase CLI，先查看 supabase、migration 及 functions deploy 的 help，再 link project。
3. 套用 supabase/migrations，然後部署五個 wait-session functions。
4. 在 Supabase secrets 設定 APP_ORIGINS、RECOVERY_CODE_PEPPER、TURNSTILE_SECRET_KEY。
5. Auth 啟用 anonymous sign-ins 及 Cloudflare Turnstile。production 不可設定 TURNSTILE_DISABLED=true。
6. GitHub Pages variables 只設定 VITE_SUPABASE_URL、VITE_SUPABASE_PUBLISHABLE_KEY、VITE_TURNSTILE_SITE_KEY。絕不設定 service-role key。

## 驗證清單

- 從非 allowlist origin 呼叫任何 function 得到 403。
- 沒有 JWT 得到 401。
- A 的匿名帳戶不能讀、寫、刪除 B 的 session。
- 直接用 publishable key 查研究表得不到資料，亦不能 insert/update。
- 重送同一 event UUID 不會建立第二個事件。
- 恢復錯誤訊息不洩漏代碼是否存在，15 分鐘最多五次並有 Turnstile。
- 撤回後 session、events、prediction logs 都因 cascade 被刪除。
- HA API 中斷時仍能記錄事件，但 estimate 為 suppressed。
- 每月 retention job 存在並成功執行；小於 20 宗的彙總格不出現。

本 repo 沒有 project ref 或 secrets，所以本機交付不包含遠端 link、migration push 或 function deploy。
