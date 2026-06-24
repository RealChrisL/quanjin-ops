/* =============================================================================
 * 全謹代書每日營運登記簿 — config + 模組合約（單一真實來源）
 * 朱墨印譜風 · 零後端 · 方案甲（CEO 瀏覽器 ⇄ Airtable REST API）
 *
 * ⚠️ 本檔不得含任何真實 Base ID／客戶資料／私密欄位值。
 * 所有模組掛在 window.QJ 命名空間下；本檔先建立 QJ 與設定。
 * ========================================================================== */

window.QJ = window.QJ || {};

/* ---- 可調設定（執行期亦可由 localStorage 覆寫）---- */
QJ.SETTINGS = {
  apiBase:       "https://api.airtable.com/v0",
  metaBase:      "https://api.airtable.com/v0/meta/bases",
  defaultTableId:"", // 留空：由 Setup Gate 貼入（公開 bundle 不放生產 Table ID）
  overdueDays:   5,    // 逾期門檻（天）
  soonDays:      3,    // 即將逾期（天）
  pollSeconds:   25,   // 背景輪詢秒數
  monthlyTarget: null, // 本月成交金額目標（可留空 → CTA-first 不強制顯示進度）
  maxReqPerSec:  4,    // Airtable ~5 req/s/base，留餘裕
  pageSize:      100,
};

/* ---- localStorage 鍵名 ---- */
QJ.LS = { pat:"qj.pat", baseId:"qj.baseId", tableId:"qj.tableId", fieldMap:"qj.fieldMap" };

/* ---- 進度狀態值（對齊生產 CRM 三態，prod 真實值）---- */
QJ.STATUS = { OPEN:"跟進中", HUMAN:"人工接管中", DONE:"已完成" };
QJ.STATUS_DISPLAY = { "跟進中":"智能助手跟進中", "人工接管中":"人工接管中", "已完成":"已完成" };

/* ---- FIELD_MAP 預設：語意鍵 → 候選欄位名（啟發式自動對應，使用者於設定區確認/修改）----
 * 自動偵測時，對每個語意鍵取「第一個存在於 schema 的候選」。lastInteraction 特殊：取多欄最新有效值。
 */
QJ.FIELD_MAP_DEFAULTS = {
  委託人:   ["Line 備註名稱","姓名","委託人","客戶姓名","顯示名稱","Name"],
  案件類型: ["案件類型","業務類型","類型","Case Type"],
  承辦人:   ["委派團隊成員","承辦人","負責人","Owner","Assignee"],
  狀態:     ["進度狀態","狀態","Status"],
  成交金額: ["成交金額","成交金額(NT$)","Deal Amount","金額"],
  結案日期: ["結案日期","結案日","Closed Date"],
  案號:     ["案號","案件編號","Case No","編號"],
  案件說明: ["需求摘要","對話摘要","案件說明","摘要","Notes"],
  建立時間: ["建立時間","建檔時間","Created","Created time"],
  // 上次互動時間：多候選，logic.reconcileLastInteraction 取「最新有效值」
  lastInteractionCandidates: ["最後互動時間","最後音檔時間","最後回覆時間","最後聯絡時間","最後修改時間","Last Modified","建立時間"],
};

/* ---- CTA → 寫回欄位（值格式對齊 bot 慣例；patchRecord 用語意鍵，airtable.js 解析為實欄位）----
 * close     : 狀態=已完成, 結案日期=今天(YYYY-MM-DD)
 * amount    : 成交金額=Number, (結案日期若空→今天)
 * contacted : 最後互動時間=now(ISO 8601)
 * reassign  : 承辦人=「名字 (uid)」  ← bot 解析格式；v1 停用（fast-follow，待確認欄位型別）
 */
QJ.REASSIGN_ENABLED = false; // v1：先上 結案／補金額／標記已聯繫 三個安全 CTA

/* ---- 民國紀年工具（全 UI 共用）---- */
QJ.rocDate = function (d) {
  d = d || new Date();
  var wk = ["日","一","二","三","四","五","六"][d.getDay()];
  return "中華民國 " + (d.getFullYear() - 1911) + " 年 " + (d.getMonth() + 1) + " 月 " + d.getDate() + " 日（星期" + wk + "）";
};
QJ.todayISODate = function () { var d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };

/* =============================================================================
 * 模組合約（所有 build agent 必讀並嚴格遵守）
 *
 * 正規化紀錄 NormRecord（airtable.js 套 FIELD_MAP 後輸出，logic/render/charts 都吃這個）:
 *   {
 *     id:String,                       // Airtable record id
 *     委託人:String, 案件類型:String, 承辦人:String, 狀態:String,
 *     成交金額:Number|null, 結案日期:Date|null, 案號:String, 案件說明:String,
 *     建立時間:Date|null,
 *     lastInteraction:Date|null,       // reconcileLastInteraction 取的最新有效值
 *     lastInteractionField:String,     // 取自哪個欄位（顯示用）
 *     fields:Object                    // 原始 Airtable fields（唯讀備援）
 *   }
 *
 * QJ.airtable  (auth.js 提供憑證/Setup Gate；airtable.js 提供連線/讀寫):
 *   QJ.auth.ensure(): Boolean                         // 有無有效憑證；無則 renderSetupGate()
 *   QJ.auth.getCreds(): {pat,baseId,tableId}
 *   QJ.auth.clear()                                   // 清除憑證 → 回 Setup Gate
 *   QJ.auth.renderSetupGate()                         // 朱墨印譜設定卡（PAT/BaseID/TableID + 權限指引文案）
 *   QJ.airtable.detectSchema(): Promise<{fields:[{name,type}], fieldMap}>   // Meta API
 *   QJ.airtable.fetchRecords(): Promise<NormRecord[]>  // 只取進行中/待處理（狀態≠已完成 或 近30天結案）
 *   QJ.airtable.patchRecord(id, semanticPatch): Promise<NormRecord>
 *        // semanticPatch 例：{狀態:"已完成", 結案日期:"2026-06-25"} / {成交金額:20000} / {最後互動時間:isoNow}
 *        // 內部節流 maxReqPerSec；HTTP 非 2xx → throw Error(含 .status, .body)
 *
 * QJ.logic:
 *   QJ.logic.reconcileLastInteraction(rec): {date:Date|null, field:String}
 *   QJ.logic.analyze(records, settings): State
 *   State = {
 *     summary:{ text:String, overdue:Number, closable:Number },
 *     kpis:{ awaiting:Number, overdueRisk:Number, closableToday:Number, monthAmount:Number, overloadedOwners:Number },
 *     queue:[ { rec:NormRecord, waitDays:Number, level:'overdue'|'soon'|'ok', nextCTA:{type,label} } ],
 *     team:[ { owner:String, active:Number, overdue:Number, avgRespDays:Number|null, load:Number, flag:'overload'|'ok' } ],
 *     deal:{ monthAmount:Number, target:Number|null, closable:[NormRecord], pendingAmount:[NormRecord] },
 *     actions:[ { id, kind:'overdue'|'close'|'amount', rec, label } ],   // 本日待辦行動（CTA-first，置頂）
 *     slices:{ types:[String], owners:[String], statuses:[String] }
 *   }
 *
 * QJ.render:
 *   QJ.render.renderApp(state)                  // 全量渲染進 #app
 *   QJ.render.diffUpdate(prevState, nextState)  // 只改有變動列，保留捲動位置/展開狀態，新進件朱色高亮
 *   QJ.render.applyFilters({type,owner,status}) // 客戶佇列切片
 *   QJ.render.pushSyncLog({time,action,ok,msg}) // 角落同步紀錄面板
 *   QJ.render.toast(msg, kind)                  // kind: 'ok'|'warn'|'danger'|'info'（介面語氣，不道歉）
 *   QJ.render.setStatus(text, online)           // masthead「Airtable 即時連線中」狀態
 *
 * QJ.charts:
 *   QJ.charts.renderCharts(state)   // 甜甜圈=案件類型分布；長條=各承辦人案量；折線=成交金額趨勢 vs 月目標
 *   canvas ids（index.html 提供）: #chart-types, #chart-owners, #chart-deals
 *
 * QJ.app (app.js, orchestrator):
 *   QJ.app.boot()  // DOMContentLoaded 入口：auth.ensure → detectSchema → fetchRecords → analyze
 *                  // → renderApp + renderCharts → 啟動輪詢；綁定 CTA 與切片；綁定 visibilitychange 即時刷新
 *
 * index.html 必備 id（render/charts 目標 + app 綁定）:
 *   #setup-gate #app #masthead #clear-creds #conn-status #processed-count
 *   #summary #kpis #cta-actions #queue #slice-type #slice-owner #slice-status
 *   #deal-track #team #chart-types #chart-owners #chart-deals #sync-log
 * script 載入順序（defer）: config.js → auth.js → airtable.js → logic.js → charts.js → render.js → app.js
 *   外加 CDN: Chart.js、Google Fonts（Noto Serif TC / Noto Sans TC / IBM Plex Mono）
 * ========================================================================== */
