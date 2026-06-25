# 全謹代書營運戰情室

朱墨印譜風 · 零後端 · 完整隱私 · 即時雙向的 CEO 營運儀表板。瀏覽器直連既有 Airtable（方案甲），部署於 GitHub Pages，**公開網址不存放任何客戶資料**。

> 風格：朱墨印譜（朱紅×墨黑、方形朱印、墨底白字表頭、民國紀年、大寫序號）。CTA-first：本日待辦行動置頂，聚焦結案與補登成交金額。

## 架構（方案甲）
`CEO 瀏覽器 ⇄ Airtable REST API`（HTTPS 直連）。零後端、零外部系統、零成本。第三方函式庫走 CDN（Chart.js、Google Fonts），無建置步驟，全相對路徑（GitHub Pages 子路徑安全）。

```
config.js  合約/設定 · auth.js  憑證+Setup Gate · airtable.js  連線/schema/讀寫
logic.js   分析(上次互動校正/佇列/團隊/行動/摘要) · render.js  朱墨印譜渲染
charts.js  圖表 · app.js  orchestrator(boot/輪詢/CTA 寫回)
```

## 部署到 GitHub Pages（專案頁）
1. 推到 `main`（本 repo 已含 `.nojekyll`，停用 Jekyll）。
2. GitHub → Settings → Pages → Build and deployment → Source = **Deploy from a branch** → Branch = `main` / `/ (root)` → Save。
3. 約 1 分鐘後開：`https://realchrisl.github.io/quanjin-ops/`。
4. 全相對路徑，子路徑可正常運作；無建置步驟。

## 首次設定（Setup Gate）與 PAT 建立
首次開啟只會看到一張朱墨印譜設定卡，貼入三項即啟用（之後存在本機，不再詢問）：
1. **Airtable Personal Access Token（PAT）** — 在 Airtable → [Developer hub → Personal access tokens](https://airtable.com/create/tokens) 建立 **scoped PAT**：
   - **Scopes（僅勾三個）**：`data.records:read`、`data.records:write`、`schema.bases:read`
   - **Access**：僅授權**這一個 Base**（不要 all bases）
   - 建議僅於 CEO 自有裝置使用，網址勿外流。
2. **Base ID**（形如 `app…`）。
3. **Table ID**（預設帶入起點值，可改）。
右上角「清除憑證」可一鍵抹除並回到設定卡。

## 隱私
- repo／Pages **不含**任何客戶資料、Base ID、欄位名稱。
- PAT／Base ID 僅存於這台瀏覽器的 `localStorage`（`qj.pat` / `qj.baseId` / `qj.tableId` / `qj.fieldMap`）。
- 全程 HTTPS 直連 Airtable，不經第三方。沒有權杖，公開網址什麼都看不到。

## FIELD_MAP 自動對應
載入後以 Meta API 自動偵測 schema，依欄位名啟發式對應語意欄位（委託人／案件類型／承辦人／狀態／成交金額／案號／案件說明／建立時間，以及「上次互動時間」的多個候選欄位）。**上次互動時間**取多個候選欄位中的**最新有效值**。解析結果存於 `localStorage['qj.fieldMap']`。
> v1 為自動偵測；若某欄位對錯，可清除憑證重設或進階手改 `qj.fieldMap`。**視覺化 FIELD_MAP 確認/修正面板列為 fast-follow。**

## 四個 CTA 即時寫回（原地、不轉跳）
全部樂觀更新 UI → `PATCH` Airtable →（成功）以伺服器回傳值校正＋角落同步紀錄；（失敗）回滾並顯示清楚錯誤。

| CTA | 寫回 | 狀態 |
|---|---|---|
| 送件結案 | `進度狀態`→已完成 ＋ `結案日期`＝今天；就地展開成交金額，確認即一併寫回 | ✅ v1 |
| 補登成交金額 | `成交金額`（數字），結案日期若空補今天 | ✅ v1 |
| 標記已聯繫 | `最後互動時間`→現在（直接消除逾期） | ✅ v1 |
| 改派承辦人 | `委派團隊成員` | ⏳ fast-follow（停用中） |

### 與生產 CRM 的對齊注意（重要）
本工具寫的是 LINE Agent 在用的**同一個生產 CRM**，CTA 繞過了 bot 的副作用，故：
- **進度狀態**只用三態（跟進中／人工接管中／已完成）；結案→已完成，bot 對已完成客戶的再進線會自動 reactivate（正常）。
- **標記已聯繫** 只更新 `最後互動時間`；bot 的 `已聯繫` 指令還會額外寫一條 audit row 讓提醒不再出現——本工具不寫那條，故 bot 端的逾時摘要可能仍會列入。可接受。
- **改派**（fast-follow）：bot 解析 `委派團隊成員` 期望「名字 (uid)」格式；啟用前須先以實際 schema 確認欄位型別與格式，避免打斷 bot 的委派路由。故 v1 停用。

## 即時更新
載入即抓；背景輪詢（預設 25 秒，`config.js:SETTINGS.pollSeconds`）只更新有變動的列、保留捲動與展開狀態；視窗切回前景立即刷新；CTA 後以伺服器值校正。

## 進階（模組化保留）
- **OAuth 2.0 + PKCE**：以公開 client（無 secret、redirect = 本 Pages 網址）取代手貼 PAT。預設先用 PAT。
- **絕對零憑證**：若不願在瀏覽器存任何權杖，改用 **Airtable Interface**（Airtable 原生介面，無自有前端）。本工具的取捨是換取朱墨印譜 UI、CTA-first 與離線可控。

## 安全
`.gitignore` 阻擋憑證/資料檔；全程 HTTPS；介面文案明確說明資料不離開 Airtable／本機；PAT 僅存本機、可一鍵清除。
