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
  defaultBaseId: "appJRa7cIVBCz5xDD",            // 私有 repo：硬編 Base ID
  defaultTableId:"tbldZrv5LeKImXKQN",             // 私有 repo：硬編 Table ID（客戶紀錄）
  proxyUrl:      "https://bribe-handwoven-bobbed.ngrok-free.dev", // 寫入代理（ngrok 保留網域，硬編）
  // 兩段提醒門檻（以「實際經過時間」計，不分營業時段）
  officeHours:   { startHour: 9, endHour: 18, workdays: [1, 2, 3, 4, 5] }, // 待回門檻只算 TPE 09:00–18:00 工作日
  pendingReplyHours: 4,   // 🔴 待回：營業時段（TPE 09–18）內超過 N 小時未互動
  overdueHours:     24,   // 🟠 逾期：實際經過超過 N 小時（不分時段，預設 1 天）
  pollSeconds:   25,   // 背景輪詢秒數
  monthlyTarget: null, // 本月成交金額目標（可留空 → CTA-first 不強制顯示進度）
  maxReqPerSec:  4,    // Airtable ~5 req/s/base，留餘裕
  pageSize:      100,
};

/* ---- localStorage 鍵名 ---- */
QJ.LS = { pat:"qj.pat", baseId:"qj.baseId", tableId:"qj.tableId", fieldMap:"qj.fieldMap", proxyUrl:"qj.proxyUrl", proxyToken:"qj.proxyToken" };

/* ---- 後端寫回代理（bot-proxy）：設定後 CTA 走安全寫回（鎖／側效／稽核）；未設 → 直連 Airtable ---- */
QJ.proxyUrl = function () { return (QJ.SETTINGS.proxyUrl || "").replace(/\/+$/, ""); }; // 硬編，不再由使用者填
QJ.proxyToken = function () { try { return window.localStorage.getItem(QJ.LS.proxyToken) || ""; } catch (e) { return ""; } };
QJ.proxyConfigured = function () { return !!(QJ.proxyUrl() && QJ.proxyToken()); };

/* ---- 進度狀態值（對齊生產 CRM 三態，prod 真實值）---- */
QJ.STATUS = { OPEN:"跟進中", HUMAN:"人工接管中", DONE:"已完成" };
QJ.STATUS_DISPLAY = { "跟進中":"智能助手跟進中", "人工接管中":"人工接管中", "已完成":"已完成" };

/* ---- FIELD_MAP 預設：語意鍵 → 候選欄位名（啟發式自動對應，使用者於設定區確認/修改）----
 * 自動偵測時，對每個語意鍵取「第一個存在於 schema 的候選」。lastInteraction 特殊：取多欄最新有效值。
 */
QJ.FIELD_MAP_DEFAULTS = {
  委託人:   ["Line 備註名稱","姓名","LINE顯示名稱"],
  電話:     ["電話","聯絡電話","手機","Phone","Tel"],
  案件類型: ["案件類型","業務類型","類型","Case Type"],
  承辦人:   ["委派團隊成員","承辦人","負責人","Owner","Assignee"],
  狀態:     ["進度狀態","狀態","Status"],
  成交金額: ["成交金額","成交金額(NT$)","Deal Amount","金額"],
  結案日期: ["結案日期","結案日","Closed Date"],
  案號:     ["案號","案件編號","Case No","編號"],
  案件說明: ["需求摘要","對話摘要","案件說明","摘要","Notes"],
  待辦事項: ["待辦事項","待辦","代辦事項","To-Do","Todos"],
  首次進線時間: ["首次進線時間","首次來訊時間","建立時間","Created"],
  首次回應時間: ["首次回應時間","首覆時間","團隊首覆時間"],
  建立時間: ["建立時間","建檔時間","Created","Created time"],
  // 上次互動時間 = 客戶互動訊號（reconcileLastInteraction 依此「優先序」取第一個有值，非取最新）。
  // 刻意排除 最後音檔時間 / 最後修改時間 / Last Modified——那些是團隊端或被動更新，
  // 會把「客戶靜默」訊號洗掉（對齊 bot Guardrail 6：音檔只碰最後音檔時間、不碰最後互動時間）。
  lastInteractionCandidates: ["最後互動時間","最後回覆時間","最後聯絡時間","建立時間"],
};

/* ---- CTA → 寫回欄位（值格式對齊 bot 慣例；patchRecord 用語意鍵，airtable.js 解析為實欄位）----
 * close     : 狀態=已完成, 結案日期=今天(YYYY-MM-DD)
 * amount    : 成交金額=Number, (結案日期若空→今天)
 * contacted : 最後互動時間=now(ISO 8601)
 * reassign  : 承辦人=「名字 (uid)」  ← bot 解析格式；v1 停用（fast-follow，待確認欄位型別）
 */
QJ.REASSIGN_ENABLED = true; // 改派啟用

/* ---- 團隊名冊（改派下拉來源；對齊 bot roles_meta）----
 * 注意：姓名＋uid 會打包進公開 bundle；uid 為內部同仁 LINE id（非客戶資料）。
 * 顯示一律用真實姓名（例如 HSU → 徐鈞澤）。改派寫回格式＝「名字 (uid)」相容 bot 委派團隊成員。 */
QJ.TEAM_ROSTER = [
  { name: "黃玲智", uid: "Ud5c30f62587012a787b42f7ab04c65fe" },
  { name: "徐鈞澤", uid: "U4c6dfbf4ab07c3452cf666201bf5d2de" },
  { name: "黃薏任", uid: "U8744479371832d0e93d18ce56a9f6e30" },
  { name: "曹宜琪", uid: "Uaa58c929d155715574849a20e740c578" },
  { name: "林思瑩", uid: "U4e74f528831c42815e352e0418d5cd48" },
  { name: "盧柏元", uid: "Ud7d29d26a96e74aa5b3529e0d1d52cfb" },
  { name: "周珈儀", uid: "U322a5fbaae39a85d4d409c045d4571d5" },
  { name: "傅子璇", uid: "U148c9d0793c77152c3678b8bcb0516e4" },
  { name: "謝代書", uid: "U506e5fade9587ae3bb2f142831f07ac8" },
  { name: "奕溱",   uid: "Ubf15d6f0c8983b1369784ae002c9b6b4" }
];
QJ.TEAM_BY_UID = {};
QJ.TEAM_ROSTER.forEach(function (m) { QJ.TEAM_BY_UID[m.uid] = m.name; });
QJ.delegateeValue = function (m) { return m.name + " (" + m.uid + ")"; }; // bot 委派團隊成員格式

/* 同仁的 OA Manager 聊天 ID（chat.line.biz id ≠ webhook uid）。OA 對話建立的同仁
 * 本人紀錄沒有 LINE用戶ID，只能靠 OA聊天ID 認出——這些不該列入待辦客戶清單。
 * 若日後有新同仁出現在客戶清單，把他的 OA聊天ID 加在這裡。 */
QJ.STAFF_OA_IDS = {
  "U3131bc24f96f966269acce66cc704f68": "奕溱",
  "U2050b9d34a2d8c0400899b7af66d1f6d": "徐鈞澤(HSU)",
  "Uf6fdd9f3512c740cb037a1f5b45d7a72": "黃玲智"
};
// 承辦人顯示名：「名字 (uid)」→名字、純 uid→名字、其餘原樣。全站唯一 owner→name 解析來源。
QJ.ownerName = function (raw) {
  var s = String(raw == null ? "" : raw).trim();
  if (!s) return s;
  var byUid = QJ.TEAM_BY_UID || {};
  var m = s.match(/[\(（]([^()（）]+)[\)）]\s*$/);
  var uid = m ? m[1].trim() : "";
  if (uid && byUid[uid]) return byUid[uid];
  if (byUid[s]) return byUid[s];
  if (uid) return s.replace(/\s*[\(（][^()（）]+[\)）]\s*$/, "").trim() || s;
  return s;
};

/* ---- 案型估值（business_guide confirmed_price；未列者不顯示金額）---- */
QJ.CASE_VALUE = { "監護宣告": 20000, "輔助宣告": 20000, "遺囑": 25000 };
QJ.caseValue = function (t) { var v = QJ.CASE_VALUE[t]; return (typeof v === "number") ? v : null; };

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
