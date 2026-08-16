#!/usr/bin/env node
/* =============================================================================
 * 全謹 ops dashboard — FIRST JavaScript test harness (standalone node runner)
 *
 * The dashboard is pure window.QJ.* IIFEs with zero build step. This runner
 * emulates the browser just enough to load config.js → logic.js → airtable.js in
 * order, then exercises the PRIVATE pure functions reached via the guarded
 * test-only exports (QJ.logic.analyze + QJ.airtable._test.*).
 *
 * Pins the audit fixes shipped in commits 393cdea / 3805797:
 *   logic.js analyze  — actions id-dedup; isHuman→結案 CTA even when overdue;
 *                       team/respMap/slices.owners keyed via ownerNameOf;
 *                       未指派 excluded from overload mean + never flagged;
 *                       slices.statuses excludes 已完成.
 *   airtable.js       — buildFilterFormula allowlist; _isStaffOwnRecord id-only.
 *
 * No DOM, no network, no deps. Run:  node test/run_dashboard_tests.js
 * Mirrors the QA standalone-harness style (own check(), exit non-zero on fail).
 * ========================================================================== */
"use strict";

var fs = require("fs");
var vm = require("vm");
var path = require("path");

/* ---- browser shims ---------------------------------------------------------
 * In a browser `window` IS the global object, so `window.QJ = …` creates a
 * global `QJ` that the IIFEs also read as a bare identifier. Emulate that by
 * aliasing window → the node global; then a minimal localStorage shim (read at
 * airtable.js load time by loadFieldMapFromLS).                               */
global.window = global;
global.localStorage = {
  _d: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem: function (k, v) { this._d[k] = String(v); },
  removeItem: function (k) { delete this._d[k]; },
};

var JS_DIR = path.join(__dirname, "..", "assets", "js");
function load(name) {
  var p = path.join(JS_DIR, name);
  vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p });
}
// strict order per the module contract (logic + airtable both depend on config).
load("config.js");
load("logic.js");
load("airtable.js");

/* ---- tiny test harness ----------------------------------------------------- */
var FAILS = [];
var PASS = 0;
function check(name, cond, detail) {
  if (cond) { PASS += 1; console.log("  ✓ " + name); }
  else {
    FAILS.push(name);
    console.log("  ✗ " + name + (detail !== undefined ? "  " + safe(detail) : ""));
  }
}
function safe(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

/* ---- fixture helpers ------------------------------------------------------- */
var _id = 0;
function R(o) {
  return Object.assign({
    id: "r" + (++_id), 委託人: "", 案件類型: "", 承辦人: "", 狀態: QJ.STATUS.OPEN,
    成交金額: null, 結案日期: null, 建立時間: null, 首次進線時間: null,
    首次回應時間: null, lastInteraction: null, lastInteractionField: "", fields: {},
  }, o);
}
function daysAgo(n) { return new Date(Date.now() - n * 86400000); }
function minsAgo(n) { return new Date(Date.now() - n * 60000); }

var XU_UID = "U4c6dfbf4ab07c3452cf666201bf5d2de";          // 徐鈞澤 (roster)
var XU_FULL = "徐鈞澤 (" + XU_UID + ")";                    // 「名字 (uid)」 form
var HL_UID = "Ud5c30f62587012a787b42f7ab04c65fe";          // 黃玲智 (離職 2026-07-02: 不在改派名冊,顯示對照保留)
var STAFF_OA = "U3131bc24f96f966269acce66cc704f68";        // 奕溱 OA chat id (STAFF_OA_IDS)
var CLIENT_UID = "U0123456789abcdef0123456789abcdef";       // valid LINE-uid format, NOT in roster

/* ===========================================================================
 * TASK 2A — analyze() invariants (the 5 shipped fixes)
 * ======================================================================== */
function test_analyze() {
  console.log("TASK 2A — logic.analyze invariants");

  /* --- A. single-listing + 結案 CTA on a 人工接管中 + overdue case --- */
  var sA = QJ.logic.analyze([
    R({ id: "A1", 狀態: QJ.STATUS.HUMAN, 委託人: "林先生", 案件類型: "遺囑",
        承辦人: XU_FULL, lastInteraction: daysAgo(5) }),
  ]);
  var aRows = sA.actions.filter(function (a) { return a.id === "A1"; });
  check("FIX1 overdue+人工接管中 case listed ONCE in actions (id-dedup)",
        aRows.length === 1, aRows.map(function (a) { return a.kind; }));
  var qA = sA.queue.filter(function (q) { return q.rec.id === "A1"; })[0];
  check("FIX1 that case's level is overdue (so it WOULD double-list pre-fix)",
        qA && qA.level === "overdue", qA && qA.level);
  check("FIX-CTA isHuman → nextCTA 結案 even when overdue",
        qA && qA.nextCTA.type === "close" && qA.nextCTA.label === "結案",
        qA && qA.nextCTA);

  /* --- B. owner stored both as 「名字 (uid)」 and bare uid → one row, threshold not diluted --- */
  var recsB = [];
  for (var i = 0; i < 3; i++) recsB.push(R({ 狀態: QJ.STATUS.OPEN, 承辦人: XU_FULL, 案件類型: "遺囑", lastInteraction: minsAgo(5) }));
  for (var j = 0; j < 3; j++) recsB.push(R({ 狀態: QJ.STATUS.OPEN, 承辦人: XU_UID, 案件類型: "遺囑", lastInteraction: minsAgo(5) }));
  recsB.push(R({ 狀態: QJ.STATUS.OPEN, 承辦人: "黃玲智", 案件類型: "遺囑", lastInteraction: minsAgo(5) }));
  var sB = QJ.logic.analyze(recsB);
  var xuRows = sB.team.filter(function (t) { return t.owner === "徐鈞澤"; });
  check("FIX2 徐鈞澤 collapses to ONE team row (uid + 名字(uid) merged)",
        xuRows.length === 1, sB.team.map(function (t) { return t.owner; }));
  check("FIX2 merged team row active === 6 (count not split)",
        xuRows[0] && xuRows[0].active === 6, xuRows[0] && xuRows[0].active);
  check("FIX2 threshold not diluted → merged 徐鈞澤 flagged overload",
        xuRows[0] && xuRows[0].flag === "overload", xuRows[0] && xuRows[0].flag);
  check("FIX2 no team row keyed by raw uid or 名字(uid) string",
        sB.team.every(function (t) { return t.owner !== XU_UID && t.owner.indexOf("(") === -1; }),
        sB.team.map(function (t) { return t.owner; }));
  check("FIX2 slices.owners holds resolved 徐鈞澤, not the raw uid/paren form",
        sB.slices.owners.indexOf("徐鈞澤") !== -1 &&
        sB.slices.owners.indexOf(XU_UID) === -1 &&
        sB.slices.owners.indexOf(XU_FULL) === -1, sB.slices.owners);

  /* --- C. 未指派 with many cases → excluded from mean + never overload --- */
  var recsC = [];
  for (var h = 0; h < 8; h++) recsC.push(R({ 承辦人: "黃玲智", 案件類型: "遺囑", lastInteraction: minsAgo(5) }));
  for (var x = 0; x < 2; x++) recsC.push(R({ 承辦人: "徐鈞澤", 案件類型: "遺囑", lastInteraction: minsAgo(5) }));
  for (var u = 0; u < 50; u++) recsC.push(R({ 承辦人: "", 案件類型: "遺囑", lastInteraction: minsAgo(5) }));
  var sC = QJ.logic.analyze(recsC);
  var unRow = sC.team.filter(function (t) { return t.owner === "未指派"; })[0];
  var hlRow = sC.team.filter(function (t) { return t.owner === "黃玲智"; })[0];
  var xuRowC = sC.team.filter(function (t) { return t.owner === "徐鈞澤"; })[0];
  check("FIX3 未指派 row active === 50 but flag === ok (never overload)",
        unRow && unRow.active === 50 && unRow.flag === "ok", unRow);
  check("FIX3 未指派 excluded from mean → 黃玲智(8) IS flagged overload",
        hlRow && hlRow.active === 8 && hlRow.flag === "overload", hlRow);
  check("FIX3 lighter real owner 徐鈞澤(2) stays ok",
        xuRowC && xuRowC.active === 2 && xuRowC.flag === "ok", xuRowC);

  /* --- D. slices.statuses excludes 已完成 --- */
  var sD = QJ.logic.analyze([
    R({ 狀態: QJ.STATUS.OPEN, 案件類型: "遺囑", lastInteraction: minsAgo(5) }),
    R({ 狀態: QJ.STATUS.HUMAN, 案件類型: "遺囑", lastInteraction: minsAgo(5) }),
    R({ 狀態: QJ.STATUS.DONE, 案件類型: "遺囑", 結案日期: daysAgo(2) }),
  ]);
  check("FIX5 slices.statuses includes 跟進中 + 人工接管中",
        sD.slices.statuses.indexOf(QJ.STATUS.OPEN) !== -1 &&
        sD.slices.statuses.indexOf(QJ.STATUS.HUMAN) !== -1, sD.slices.statuses);
  check("FIX5 slices.statuses EXCLUDES 已完成 (a 已完成 record is absent)",
        sD.slices.statuses.indexOf(QJ.STATUS.DONE) === -1, sD.slices.statuses);
}

/* ===========================================================================
 * TASK 2B — airtable._isStaffOwnRecord truth table
 * ======================================================================== */
function test_isStaffOwnRecord() {
  console.log("TASK 2B — airtable._isStaffOwnRecord truth table");
  var f = QJ.airtable._test._isStaffOwnRecord;

  check("ISR uid-in-roster (LINE用戶ID ∈ TEAM_BY_UID) → true",
        f({ fields: { "LINE用戶ID": HL_UID } }) === true);
  check("ISR OA-id-in-staff (OA聊天ID ∈ STAFF_OA_IDS) → true",
        f({ fields: { "OA聊天ID": STAFF_OA } }) === true);
  check("ISR array-valued LINE用戶ID (first elem ∈ roster) → true",
        f({ fields: { "LINE用戶ID": [HL_UID] } }) === true);
  check("ISR ordinary client uid → false",
        f({ fields: { "LINE用戶ID": CLIENT_UID } }) === false);
  // FIXED (name-based backstop): a staff person appearing ONLY by name with NO
  // client uid / OA id is now caught by the name guard (QJ.STAFF_NAMES). A record
  // carrying a real client LINE用戶ID is NOT caught even if named like staff (it
  // came in via LINE → it's a client).
  check("ISR name-only-staff (roster name, no ids) → true (name-guard)",
        f({ fields: { "姓名": "徐鈞澤" } }) === true);
  check("ISR staff-name but real client uid → false (has client uid = real client)",
        f({ fields: { "姓名": "徐鈞澤", "LINE用戶ID": CLIENT_UID } }) === false);
}

/* ===========================================================================
 * TASK 2C — airtable.buildFilterFormula (allowlist) for full / partial / empty
 * ======================================================================== */
function test_buildFilterFormula() {
  console.log("TASK 2C — airtable.buildFilterFormula allowlist");
  var f = QJ.airtable._test.buildFilterFormula;

  var ACTIVE = "OR({進度狀態}='跟進中',{進度狀態}='人工接管中')";
  var RECENT = "AND({進度狀態}='已完成',IS_AFTER({結案日期}, DATEADD(TODAY(),-30,'days')))";

  var full = f({ "狀態": "進度狀態", "結案日期": "結案日期" });
  check("BFF full fieldMap → OR(active, recent-30d) allowlist",
        full === "OR(" + ACTIVE + "," + RECENT + ")", full);

  var partial = f({ "狀態": "進度狀態" }); // no 結案日期 → active-only
  check("BFF partial fieldMap (no 結案日期) → active-only allowlist",
        partial === ACTIVE, partial);

  var none = f({}); // no 狀態 → null (don't filter, fetch all)
  check("BFF no 狀態 field → null (no filter)", none === null, none);
}

/* ===========================================================================
 * TASK 2D — exported helper sanity (toDate / toNumber / coalesceName / _normalize)
 * ======================================================================== */
function test_helpers() {
  console.log("TASK 2D — exported helper sanity");
  var t = QJ.airtable._test;

  check("toNumber strips currency/commas 'NT$25,000' → 25000", t.toNumber("NT$25,000") === 25000);
  check("toNumber non-numeric → null", t.toNumber("—") === null);
  check("toDate ISO string → Date", t.toDate("2026-06-20") instanceof Date);
  check("toDate empty/null → null", t.toDate("") === null && t.toDate(null) === null);
  check("coalesceName 姓名 candidate → name", t.coalesceName({ "姓名": "王先生" }) === "王先生");
  check("coalesceName fallback uses LINE用戶ID only (the client field)",
        t.coalesceName({ "LINE用戶ID": CLIENT_UID }) === CLIENT_UID);
  check("coalesceName does NOT surface a uid from a non-client field (M6 fix)",
        t.coalesceName({ "委派團隊成員": CLIENT_UID }) === "");

  var fieldMap = {
    委託人: "姓名", 狀態: "進度狀態", 成交金額: "成交金額", 結案日期: "結案日期",
    承辦人: "委派團隊成員", 案件類型: "案件類型", lastInteractionCandidates: ["最後互動時間"],
    asanaGid: "Asana專案GID", asanaUrl: "Asana專案連結", oaChatId: "OA聊天ID",
  };
  var norm = t._normalize({
    id: "recX",
    fields: {
      "姓名": "陳小姐", "進度狀態": "跟進中", "成交金額": "30,000",
      "結案日期": "2026-06-20", "委派團隊成員": XU_FULL, "案件類型": "遺囑",
      "最後互動時間": "2026-06-24T10:00:00.000Z",
      "Asana專案GID": "1201234567890", "Asana專案連結": "https://app.asana.com/0/1201234567890",
    },
  }, fieldMap);
  check("_normalize id/委託人/狀態", norm.id === "recX" && norm.委託人 === "陳小姐" && norm.狀態 === "跟進中", norm);
  check("_normalize 成交金額 numeric coercion", norm.成交金額 === 30000, norm.成交金額);
  check("_normalize 結案日期 + lastInteraction are Dates",
        norm.結案日期 instanceof Date && norm.lastInteraction instanceof Date, norm);
  check("_normalize lastInteractionField records source col",
        norm.lastInteractionField === "最後互動時間", norm.lastInteractionField);
  // Phase 1.5 — Asana keys land on NormRecord end-to-end (mirror of 案號 mapping)
  check("_normalize asanaGid mapped from Asana專案GID", norm.asanaGid === "1201234567890", norm.asanaGid);
  check("_normalize asanaUrl mapped from Asana專案連結",
        norm.asanaUrl === "https://app.asana.com/0/1201234567890", norm.asanaUrl);
  // absent Asana fields → empty string (the 1,456 no-GID records: ZERO behavior change)
  var normBare = t._normalize({ id: "recY", fields: { "姓名": "王先生" } }, fieldMap);
  check("_normalize asanaGid absent → '' (no-GID records unchanged)", normBare.asanaGid === "", normBare.asanaGid);
  check("_normalize oaChatId absent → '' (unsynced records unchanged)", normBare.oaChatId === "", normBare.oaChatId);
  check("_normalize asanaUrl absent → ''", normBare.asanaUrl === "", normBare.asanaUrl);
}

/* ===========================================================================
 * TASK 2E — QJ.applyStaffRoster: backend /staff roster merge + hardcoded fallback
 * Pins the drift fix — a colleague added ONLY in the bot's config.json (surfaced
 * via /staff) is recognized by _isStaffOwnRecord without editing config.js; the
 * hardcoded roster survives a proxy-down (null) payload (graceful degradation).
 * ======================================================================== */
function test_staffLoader() {
  console.log("TASK 2E — applyStaffRoster (backend roster + hardcoded fallback)");
  var isr = QJ.airtable._test._isStaffOwnRecord;
  var NEW_UID = "Udeadbeefdeadbeefdeadbeefdeadbeef"; // valid uid-shape, NOT in hardcoded roster
  var NEW_OA = "Ufeedfacefeedfacefeedfacefeedface";  // NOT in hardcoded STAFF_OA_IDS

  // pre-apply: a backend-only staff member is not yet recognized (the drift bug)
  check("SL pre-apply backend-only uid NOT yet staff",
        isr({ fields: { "LINE用戶ID": NEW_UID } }) === false);
  check("SL pre-apply backend-only OA id NOT yet staff",
        isr({ fields: { "OA聊天ID": NEW_OA } }) === false);
  check("SL pre-apply backend uid NOT yet in 改派 roster",
        (QJ.TEAM_ROSTER || []).some(function (m) { return m.uid === NEW_UID; }) === false);

  // FALLBACK: null / non-ok payload → no-op, hardcoded roster intact
  check("SL applyStaffRoster(null) → false (no-op)", QJ.applyStaffRoster(null) === false);
  check("SL applyStaffRoster({ok:false}) → false (no-op)", QJ.applyStaffRoster({ ok: false }) === false);
  check("SL fallback preserves EX-staff display mapping (黃玲智)", QJ.TEAM_BY_UID[HL_UID] === "黃玲智");
  check("SL fallback preserves hardcoded OA id (奕溱)", QJ.STAFF_OA_IDS[STAFF_OA] === "奕溱");

  // SUCCESS: merge backend roster onto the hardcoded values (Object.assign union)
  var payload = { ok: true, staff_oa_chat_ids: {}, staff_uids: {}, assignable_uids: {},
                  staff_names: ["鍾文芳", "傅子璇", "徐鈞澤", "HSU"] };
  payload.staff_oa_chat_ids[NEW_OA] = "傅子璇";
  payload.staff_uids[NEW_UID] = "鍾文芳";
  payload.assignable_uids[NEW_UID] = "鍾文芳";
  check("SL applyStaffRoster(ok payload) → true", QJ.applyStaffRoster(payload) === true);
  check("SL STAFF_OA_IDS gains backend OA id", QJ.STAFF_OA_IDS[NEW_OA] === "傅子璇");
  check("SL TEAM_BY_UID gains backend uid", QJ.TEAM_BY_UID[NEW_UID] === "鍾文芳");
  check("SL STAFF_NAMES gains backend name (鍾文芳)", QJ.STAFF_NAMES["鍾文芳"] === true);
  check("SL merge keeps EX-staff display mapping (黃玲智)", QJ.TEAM_BY_UID[HL_UID] === "黃玲智");
  check("SL merge keeps hardcoded OA id (奕溱)", QJ.STAFF_OA_IDS[STAFF_OA] === "奕溱");
  // 改派 picker single-source: a backend-only colleague now appears in QJ.TEAM_ROSTER
  check("SL TEAM_ROSTER gains backend assignable colleague",
        (QJ.TEAM_ROSTER || []).some(function (m) { return m.uid === NEW_UID && m.name === "鍾文芳"; }) === true);
  // 離職 offboard 釘 (2026-07-02): 離職者絕不可再出現在改派名冊(不可指派)，
  // 但 uid→姓名 顯示對照與 STAFF_NAMES 過濾必須保留(歷史案件顯示+員工紀錄過濾)。
  check("SL OFFBOARD ex-staff NOT in 改派 roster (黃玲智)",
        (QJ.TEAM_ROSTER || []).some(function (m) { return m.uid === HL_UID; }) === false);
  check("SL OFFBOARD ex-staff display name still resolves", QJ.ownerName("黃玲智 (" + HL_UID + ")") === "黃玲智");
  check("SL OFFBOARD ex-staff name still staff-filtered", QJ.STAFF_NAMES["黃玲智"] === true);

  // THE DRIFT FIX: a backend-only staff member is now filtered out of the client list
  check("SL post-apply backend uid → _isStaffOwnRecord true",
        isr({ fields: { "LINE用戶ID": NEW_UID } }) === true);
  check("SL post-apply backend OA id → _isStaffOwnRecord true",
        isr({ fields: { "OA聊天ID": NEW_OA } }) === true);

  // QJ.ownerName still works AND reflects the newly-added staff
  check("SL ownerName(bare backend uid) → 鍾文芳", QJ.ownerName(NEW_UID) === "鍾文芳");
  check("SL ownerName('名字 (uid)' backend form) → 鍾文芳",
        QJ.ownerName("某人 (" + NEW_UID + ")") === "鍾文芳");
}

/* ===========================================================================
 * TASK 2F — team.maxWaitDays（取代平均首覆）：承辦人待跟進案件中最久未更新的天數
 *   誠實可行動的等候訊號——只算「待跟進(待回/逾期)」的案子，近期有動的不算。
 * ======================================================================== */
function test_maxWaitDays() {
  console.log("TASK 2F — team.maxWaitDays（最久待跟進）");
  var OWNER = "黃玲智";
  // 兩筆都逾期（idle ≥1 天 → overdue）：3 天 + 8 天 → maxWaitDays 應取 8
  var wait3 = R({ 狀態: QJ.STATUS.OPEN, 承辦人: OWNER, lastInteraction: daysAgo(3) });
  var wait8 = R({ 狀態: QJ.STATUS.OPEN, 承辦人: OWNER, lastInteraction: daysAgo(8) });
  // 剛互動過（idle ~1 小時 → 不是待跟進）→ 不應拉高 maxWaitDays
  var fresh = R({ 狀態: QJ.STATUS.OPEN, 承辦人: OWNER, lastInteraction: minsAgo(60) });
  var s = QJ.logic.analyze([wait3, wait8, fresh], {});
  var t = (s.team || []).filter(function (x) { return x.owner === OWNER; })[0];
  check("MW owner has a team entry", !!t, s.team);
  check("MW maxWaitDays = oldest waiting case (8d, not 3d, not the fresh one)",
        t && t.maxWaitDays === 8, t && t.maxWaitDays);
  check("MW overdue counts the two waiting cases only (fresh excluded)",
        t && t.overdue === 2, t && t.overdue);
  // 全部都剛互動 → 沒有待跟進 → maxWaitDays 0（不是 null/NaN，誠實的「無人在等」）
  var s2 = QJ.logic.analyze([fresh], {});
  var t2 = (s2.team || []).filter(function (x) { return x.owner === OWNER; })[0];
  check("MW all-fresh → maxWaitDays 0 (nobody waiting, not an inflated number)",
        t2 && t2.maxWaitDays === 0, t2 && t2.maxWaitDays);
}

/* ===========================================================================
 * TASK 2G — 本月結案 成交/未成交/待補 split (0 = 未成交, NOT 「尚未登記」)
 * ======================================================================== */
function test_dealOutcomeSplit() {
  console.log("TASK 2G — 本月結案 成交/未成交/待補 split");
  var t = new Date();
  var cd = new Date(t.getFullYear(), t.getMonth(), Math.min(t.getDate(), 15)); // 本月內
  function closed(amt) { return R({ 狀態: QJ.STATUS.DONE, 結案日期: cd, 成交金額: amt }); }
  var d = QJ.logic.analyze([closed(0), closed(0), closed(null), closed(50000)], {}).deal;
  check("DS monthClosedCount = 4", d.monthClosedCount === 4, d.monthClosedCount);
  check("DS 未成交(成交金額=0) → lostCount = 2", d.lostCount === 2, d.lostCount);
  check("DS 待補(blank) → pendingCount = 1", d.pendingCount === 1, d.pendingCount);
  check("DS 成交(>0) → honestCount = 1", d.honestCount === 1, d.honestCount);
  check("DS honestRecs has the 1 成交 record", d.honestRecs && d.honestRecs.length === 1, d.honestRecs && d.honestRecs.length);
}

/* ===========================================================================
 * TASK 2H — 成交紀錄 review panel: honestRecs data layer (extends 2G)
 * ======================================================================== */
function test_honestRecsPanel() {
  console.log("TASK 2H — 成交紀錄 (honestRecs data layer)");
  var now = new Date();
  function md(day) { return new Date(now.getFullYear(), now.getMonth(), day); }
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);

  var won1 = R({ 委託人: "甲", 狀態: QJ.STATUS.DONE, 結案日期: md(20), 成交金額: 10000, 案件類型: "遺囑",   承辦人: XU_FULL });
  var won2 = R({ 委託人: "乙", 狀態: QJ.STATUS.DONE, 結案日期: md(12), 成交金額: 50000, 案件類型: "繼承",   承辦人: "黃玲智" });
  var won3 = R({ 委託人: "丙", 狀態: QJ.STATUS.DONE, 結案日期: md(5),  成交金額: 30000, 案件類型: "監護宣告", 承辦人: "" });
  var lost = R({ 委託人: "丁", 狀態: QJ.STATUS.DONE, 結案日期: md(18), 成交金額: 0 });
  var pend = R({ 委託人: "戊", 狀態: QJ.STATUS.DONE, 結案日期: md(9),  成交金額: null });
  var lm   = R({ 委託人: "己", 狀態: QJ.STATUS.DONE, 結案日期: lastMonth, 成交金額: 80000 });
  var open = R({ 委託人: "庚", 狀態: QJ.STATUS.OPEN,  成交金額: 99999 });

  var d = QJ.logic.analyze([won1, won2, won3, lost, pend, lm, open], {}).deal;
  var names = (d.honestRecs || []).map(function (r) { return r.委託人; });

  check("HR honestRecs has exactly the 3 in-month 成交(>0) closes",
        d.honestRecs && d.honestRecs.length === 3, d.honestRecs && d.honestRecs.length);
  check("HR includes exactly 甲/乙/丙",
        names.indexOf("甲") !== -1 && names.indexOf("乙") !== -1 && names.indexOf("丙") !== -1, names);
  check("HR excludes 未成交(=0)/待補(blank)/上月成交/未結案",
        names.indexOf("丁") === -1 && names.indexOf("戊") === -1 &&
        names.indexOf("己") === -1 && names.indexOf("庚") === -1, names);
  check("HR honestRecs.length === honestCount",
        d.honestRecs.length === d.honestCount, [d.honestRecs.length, d.honestCount]);
  var sum = (d.honestRecs || []).reduce(function (a, r) { return a + (r.成交金額 || 0); }, 0);
  check("HR sum(honestRecs.成交金額) === honestAmount", sum === d.honestAmount, [sum, d.honestAmount]);
  check("HR honestAmount === 90000 (10000+50000+30000)", d.honestAmount === 90000, d.honestAmount);
  check("HR sorted by 結案日期 desc (甲20→乙12→丙5)",
        names[0] === "甲" && names[1] === "乙" && names[2] === "丙", names);
  var allFields = (d.honestRecs || []).every(function (r) {
    return r.委託人 !== undefined && r.成交金額 != null && r.結案日期 instanceof Date &&
           r.案件類型 !== undefined && r.承辦人 !== undefined;
  });
  check("HR each entry carries 委託人/成交金額/結案日期/案件類型/承辦人", allFields, d.honestRecs);
  var r乙 = (d.honestRecs || []).filter(function (r) { return r.委託人 === "乙"; })[0];
  check("HR entry values intact (乙: 50000 / 繼承 / 黃玲智)",
        r乙 && r乙.成交金額 === 50000 && r乙.案件類型 === "繼承" && r乙.承辦人 === "黃玲智", r乙);
  var z = QJ.logic.analyze([
    R({ 狀態: QJ.STATUS.DONE, 結案日期: md(10), 成交金額: 0 }),
    R({ 狀態: QJ.STATUS.DONE, 結案日期: md(11), 成交金額: null }),
    R({ 狀態: QJ.STATUS.DONE, 結案日期: lastMonth, 成交金額: 80000 }),
  ], {}).deal;
  check("HR-edge 0 成交 this month → honestRecs empty", z.honestRecs && z.honestRecs.length === 0, z.honestRecs);
  check("HR-edge 0 成交 → honestAmount 0", z.honestAmount === 0, z.honestAmount);
  check("HR-edge 0 成交 → honestCount 0", z.honestCount === 0, z.honestCount);
  var lmOnly = QJ.logic.analyze([
    R({ 委託人: "上月", 狀態: QJ.STATUS.DONE, 結案日期: lastMonth, 成交金額: 60000 }),
  ], {}).deal;
  check("HR-scope last-month 成交(>0) excluded", lmOnly.honestRecs.length === 0, lmOnly.honestRecs);
  check("HR-scope last-month → honestAmount 0", lmOnly.honestAmount === 0, lmOnly.honestAmount);
  var em = QJ.logic.analyze([], {}).deal;
  check("HR-edge empty input → honestRecs === [] (array, not undefined)",
        Array.isArray(em.honestRecs) && em.honestRecs.length === 0, em.honestRecs);
}

/* ===========================================================================
 * TASK 2I — 結案審核 (review.closedRecs = ALL this-month closes)
 * ======================================================================== */
function test_closeReview() {
  console.log("TASK 2I — 結案審核 (closedRecs: all this-month closes)");
  var now = new Date();
  function md(day) { return new Date(now.getFullYear(), now.getMonth(), day); }
  var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  var won  = R({ 委託人: "甲", 狀態: QJ.STATUS.DONE, 結案日期: md(20), 成交金額: 50000 });
  var lost = R({ 委託人: "乙", 狀態: QJ.STATUS.DONE, 結案日期: md(12), 成交金額: 0 });
  var pend = R({ 委託人: "丙", 狀態: QJ.STATUS.DONE, 結案日期: md(5),  成交金額: null });
  var lm   = R({ 委託人: "丁", 狀態: QJ.STATUS.DONE, 結案日期: lastMonth, 成交金額: 30000 });
  var op   = R({ 委託人: "戊", 狀態: QJ.STATUS.OPEN });
  var rv = QJ.logic.analyze([won, lost, pend, lm, op], {}).review;
  var names = (rv.closedRecs || []).map(function (r) { return r.委託人; });
  check("CR closedRecs = all 3 in-month closes (成交+未成交+待補)",
        rv.closedRecs && rv.closedRecs.length === 3, names);
  check("CR includes 甲(成交)/乙(未成交)/丙(待補)",
        names.indexOf("甲") !== -1 && names.indexOf("乙") !== -1 && names.indexOf("丙") !== -1, names);
  check("CR excludes 上月結案/未結案", names.indexOf("丁") === -1 && names.indexOf("戊") === -1, names);
  check("CR sorted by 結案日期 desc (甲20→乙12→丙5)",
        names[0] === "甲" && names[1] === "乙" && names[2] === "丙", names);
  var em = QJ.logic.analyze([], {}).review;
  check("CR empty input → closedRecs === []",
        Array.isArray(em.closedRecs) && em.closedRecs.length === 0, em.closedRecs);
}

/* ===========================================================================
 * TASK OA — LINE OA Manager 深連結 builder (Wave-1)
 *   war-room QJ.oaChatUrl (config.js, loaded above) — URL shape / empty-guard /
 *   encoding — PLUS a DRIFT pin: me.js carries its OWN self-contained oaChatUrl
 *   (me.js does not load config.js), so both must produce the IDENTICAL string
 *   for a sample id or the two dashboards diverge silently.
 * ======================================================================== */
function test_oaChatUrl() {
  var SAMPLE = "Uclientchatid00000000000000000001";
  var BOT = "Ua835fb338982510049d22f8bfea446f9";   // public OA bot id (both files)

  // (1) URL shape
  check("OA war-room oaChatUrl shape",
        QJ.oaChatUrl(SAMPLE) === "https://chat.line.biz/" + BOT + "/chat/" + SAMPLE,
        QJ.oaChatUrl(SAMPLE));
  // (2) empty-guard — null / "" / whitespace-ish falsy → "" (no bare bot-id URL)
  check("OA war-room empty-guard: '' → ''", QJ.oaChatUrl("") === "");
  check("OA war-room empty-guard: null → ''", QJ.oaChatUrl(null) === "");
  check("OA war-room empty-guard: undefined → ''", QJ.oaChatUrl(undefined) === "");
  // (3) encoding — a space becomes %20 (encodeURIComponent runs on the id)
  check("OA war-room encodes id (space → %20)",
        QJ.oaChatUrl("U abc").indexOf("%20") !== -1, QJ.oaChatUrl("U abc"));

  // (4) DRIFT pin — extract me.js's self-contained oaChatUrl + OA_BOT_ID, eval in a
  // fresh sandbox (me.js is an IIFE that assumes a browser DOM, so we cannot load
  // it wholesale — mirror the harness vm pattern and eval just the two lines).
  var meSrc = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "me.js"), "utf8");
  var botM = meSrc.match(/var\s+OA_BOT_ID\s*=\s*"([^"]+)"/);
  var fnM = meSrc.match(/function\s+oaChatUrl\s*\([\s\S]*?\}\s*$/m);
  check("OA drift: me.js OA_BOT_ID literal found", !!botM, "regex miss");
  check("OA drift: me.js oaChatUrl fn found", !!fnM, "regex miss");
  if (botM && fnM) {
    check("OA drift: me.js OA_BOT_ID === war-room QJ.OA_BOT_ID",
          botM[1] === QJ.OA_BOT_ID, botM[1] + " vs " + QJ.OA_BOT_ID);
    var sandbox = {};
    vm.runInNewContext(
      "var OA_BOT_ID=" + JSON.stringify(botM[1]) + ";\n" + fnM[0] +
      "\nthis.__oa = oaChatUrl;", sandbox);
    var ids = [SAMPLE, "U abc", "Uf9a2", ""];
    for (var i = 0; i < ids.length; i++) {
      check("OA drift: me.js oaChatUrl === QJ.oaChatUrl for " + JSON.stringify(ids[i]),
            sandbox.__oa(ids[i]) === QJ.oaChatUrl(ids[i]),
            sandbox.__oa(ids[i]) + " vs " + QJ.oaChatUrl(ids[i]));
    }
  }
}

/* ===========================================================================
 * TASK 2J — 已結案回訊（方案 E 前端分流 · logic 層）
 *
 * 後端「舊客回訊靜默翻轉」(lib/legacy_return_flip.py) 把已完成的舊客紀錄悄悄
 * 翻成 人工接管中；戰情室必須把這種列跟「辦完待歸檔」的 人工接管中 分開來看。
 * 判斷式 isReturnedFromClosed() 是 logic.js 的私有函式，這裡一律經由 PUBLIC
 * 出口 analyze() 觀察（queue[].returned / queue[].nextCTA / actions[].kind），
 * 不為了測試在 production 開新出口。
 *
 * 釘的東西分四組：
 *   LR1-9    真值表（含壞資料 / reconcile 路徑 / 建立時間不算證據）
 *   LR10-13  nextCTAOf —— 含「一般人工接管中仍是結案」的既有行為護欄
 *   LR14-20  actions 分流（去重 / kind / 排序位置 / overdue 優先）
 *   LR21-28  不變量（不進 closedRecs / honestRecs / monthClosed；KPI 語意不動）
 * ======================================================================== */
function test_returnedFromClosed() {
  console.log("TASK 2J — 已結案回訊 (isReturnedFromClosed via analyze)");

  function hoursAgo(n) { return new Date(Date.now() - n * 3600000); }
  // queue 一定含所有非已完成列 → 取單筆的 queue item
  function q1(rec, settings) {
    var s = QJ.logic.analyze([rec], settings || {});
    return s.queue.filter(function (q) { return q.rec.id === rec.id; })[0];
  }

  /* ---- LR1-9 真值表 ---------------------------------------------------- */
  var trueCase = R({ id: "LRt", 委託人: "李回訊", 狀態: QJ.STATUS.HUMAN, 案件類型: "遺囑",
                     結案日期: daysAgo(30), lastInteraction: hoursAgo(2) });
  check("LR1 人工接管中 + 結案日期 + 互動晚於結案 → returned true",
        q1(trueCase).returned === true, q1(trueCase));

  check("LR2 跟進中（同樣有結案日期且互動晚於它）→ returned false（狀態閘）",
        q1(R({ id: "LR2", 狀態: QJ.STATUS.OPEN, 結案日期: daysAgo(30),
               lastInteraction: hoursAgo(2) })).returned === false);

  check("LR3 人工接管中 + 無結案日期 → returned false（判不出來就不標）",
        q1(R({ id: "LR3", 狀態: QJ.STATUS.HUMAN, 結案日期: null,
               lastInteraction: hoursAgo(2) })).returned === false);

  /* ★ LR3b —— 已知缺口（實測 2026-08-16，QA）★
   * isReturnedFromClosed 的唯一訊號是「結案日期」，但線上 934 筆符合方案 E 翻轉
   * 條件的舊客已完成紀錄裡，只有 43 筆（4.6%）有結案日期，891 筆（95.4%）是空的
   * （scripts/backfill_close_dates.py dry-run: targets=79 / would_write=0 —— 稽核
   * 日誌已補無可補）。近 7 天有互動的 58 筆裡也只有 9 筆有日期。
   *
   * 後果：方案 E 上線後，約 8 成的翻轉列在戰情室會判 returned=false →
   *   ① actions kind 落回 close（綠色 cta-ok 結案鈕）
   *   ② diffUpdate 給 row-new（朱色＝新客戶進線）—— 正是要防的誤標
   * 這條刻意把「現況」釘住，讓缺口在測試輸出可見而不是只存在報告裡。
   *
   * ⚠ 修好之後（例如把 legacy_return_flip 的翻轉 uid 經 dashboard_proxy 餵進
   *   前端當第二訊號），這條會轉紅 —— 那是預期的，請連同註解一起更新。 */
  var gapRec = R({ id: "LR3b", 委託人: "無結案日期的翻轉紀錄", 狀態: QJ.STATUS.HUMAN,
                   結案日期: null, lastInteraction: hoursAgo(2) });
  var gapQ = q1(gapRec);
  var gapS = QJ.logic.analyze([gapRec], {});
  check("LR3b [已知缺口] 891/934 舊客紀錄無結案日期 → returned false（尚無第二訊號）",
        gapQ.returned === false, gapQ.returned);
  check("LR3b2 [已知缺口] 因此該列 kind 落回 close、CTA 落回結案（非已結案回訊）",
        gapS.actions[0].kind === "close" && gapQ.nextCTA.type === "close",
        [gapS.actions[0].kind, gapQ.nextCTA.type]);

  /* ★ LR3c-g —— 第二訊號（後端翻轉名冊 /returned-uids）補上缺口 ★
   * 名冊由 dashboard_proxy 的 GET /returned-uids 提供（來源＝方案 E 自己的
   * state 檔，依構造為權威）。有名冊 → 無結案日期的翻轉列也判 returned=true，
   * 上面 LR3b 的 8 成誤標缺口關閉；名冊取不到 → 行為與 LR3b 完全相同。 */
  var _savedRoster = QJ.returnedUids;
  QJ.returnedUids = { "Uroster001": true };
  var rosterRec = R({ id: "LR3c", 委託人: "名冊命中·無結案日期", 狀態: QJ.STATUS.HUMAN,
                      結案日期: null, lastInteraction: hoursAgo(2) });
  rosterRec.fields = { "LINE用戶ID": "Uroster001" };
  var rosterQ = q1(rosterRec);
  var rosterS = QJ.logic.analyze([rosterRec], {});
  check("LR3c 名冊命中 → 無結案日期也判 returned（缺口關閉）",
        rosterQ.returned === true, rosterQ.returned);
  check("LR3d 名冊命中 → kind=returned 且 CTA 為已聯繫（不是綠色結案）",
        rosterS.actions[0].kind === "returned" && rosterQ.nextCTA.type === "contacted",
        [rosterS.actions[0].kind, rosterQ.nextCTA.type]);
  var otherRec = R({ id: "LR3e", 委託人: "名冊未命中", 狀態: QJ.STATUS.HUMAN,
                     結案日期: null, lastInteraction: hoursAgo(2) });
  otherRec.fields = { "LINE用戶ID": "Unotinroster" };
  check("LR3e 名冊未命中且無結案日期 → 仍 false（名冊不得放寬到全體）",
        q1(otherRec).returned === false);
  var openRec = R({ id: "LR3f", 委託人: "名冊命中但跟進中", 狀態: QJ.STATUS.OPEN,
                    結案日期: null, lastInteraction: hoursAgo(2) });
  openRec.fields = { "LINE用戶ID": "Uroster001" };
  check("LR3f 名冊命中但狀態是跟進中 → false（isHuman 閘不得被名冊繞過）",
        q1(openRec).returned === false);
  QJ.returnedUids = null;
  check("LR3g 名冊取不到（null）→ 退回結案日期訊號，與 LR3b 行為相同",
        q1(rosterRec).returned === false);
  QJ.returnedUids = _savedRoster;

  check("LR4 人工接管中 + 結案日期 + 完全無最後互動時間 → returned false",
        q1(R({ id: "LR4", 狀態: QJ.STATUS.HUMAN, 結案日期: daysAgo(30),
               lastInteraction: null })).returned === false);

  check("LR5 互動早於結案（結案後沒再來訊）→ returned false",
        q1(R({ id: "LR5", 狀態: QJ.STATUS.HUMAN, 結案日期: daysAgo(3),
               lastInteraction: daysAgo(10) })).returned === false);

  var same = daysAgo(5);
  check("LR6 互動時間 === 結案日期（嚴格大於，相等不算回訊）→ returned false",
        q1(R({ id: "LR6", 狀態: QJ.STATUS.HUMAN, 結案日期: same,
               lastInteraction: new Date(same.getTime()) })).returned === false);

  var doneRec = R({ id: "LR7", 狀態: QJ.STATUS.DONE, 結案日期: daysAgo(30),
                    lastInteraction: hoursAgo(2) });
  var s7 = QJ.logic.analyze([doneRec], {});
  check("LR7 已完成紀錄根本不進 queue（翻轉前的狀態，戰情室看不到）",
        s7.queue.length === 0, s7.queue.length);

  var bad = R({ id: "LR8", 狀態: QJ.STATUS.HUMAN, 結案日期: "not-a-date",
                lastInteraction: hoursAgo(2) });
  var q8 = null, threw8 = false;
  try { q8 = q1(bad); } catch (e) { threw8 = true; }
  check("LR8 壞的結案日期字串 → 不炸", threw8 === false);
  check("LR8b 壞的結案日期字串 → returned false（toDate 回 null）",
        q8 && q8.returned === false, q8 && q8.returned);

  // 走 reconcileLastInteraction（rec.lastInteraction 缺、fields 有候選欄位）
  var viaFields = R({ id: "LR9", 狀態: QJ.STATUS.HUMAN, 結案日期: daysAgo(30),
                      lastInteraction: null,
                      fields: { 最後互動時間: hoursAgo(2).toISOString() } });
  check("LR9 lastInteraction 缺、fields.最後互動時間 有 → 仍判 returned true（走 lastInteractionOf）",
        q1(viaFields).returned === true, q1(viaFields));

  // 建立時間 ≠ 客戶來訊證據：isReturnedFromClosed 用 lastInteractionOf（不含
  // interactionBase 的建立時間退路），所以只有建立時間的紀錄不會被誤標。
  check("LR9b 只有（頂層）建立時間、無最後互動時間 → returned false（建立時間不算回訊證據）",
        q1(R({ id: "LR9b", 狀態: QJ.STATUS.HUMAN, 結案日期: daysAgo(30),
               lastInteraction: null, 建立時間: hoursAgo(2) })).returned === false);

  /* ---- LR10-13 nextCTAOf ---------------------------------------------- */
  var qT = q1(trueCase);
  check("LR10 returned 案 → nextCTA.type === contacted",
        qT.nextCTA.type === "contacted", qT.nextCTA);
  check("LR10b returned 案 → nextCTA.label === 已聯繫（文字說等回覆，就別跳成交選擇器）",
        qT.nextCTA.label === "已聯繫", qT.nextCTA);

  // ★ 既有行為護欄：一般 人工接管中 仍必須是「結案」——這條被改壞代表整個
  //   戰情室的主要動線（辦完 → 送件結案）被 returned 分支吃掉。
  var plainHuman = q1(R({ id: "LR11", 狀態: QJ.STATUS.HUMAN, lastInteraction: hoursAgo(2) }));
  check("LR11 [護欄] 一般人工接管中（無結案日期）→ nextCTA 仍是 close/結案",
        plainHuman.nextCTA.type === "close" && plainHuman.nextCTA.label === "結案",
        plainHuman.nextCTA);

  var humanOverdue = q1(R({ id: "LR12", 狀態: QJ.STATUS.HUMAN, lastInteraction: daysAgo(5) }));
  check("LR12 [護欄] 人工接管中 + 逾期（無結案日期）→ nextCTA 仍是 close（既有 FIX-CTA 不變）",
        humanOverdue.level === "overdue" && humanOverdue.nextCTA.type === "close",
        humanOverdue.nextCTA);

  var openOverdue = q1(R({ id: "LR13", 狀態: QJ.STATUS.OPEN, lastInteraction: daysAgo(5) }));
  check("LR13 [護欄] 跟進中 + 逾期 → nextCTA 仍是 contacted（不受 returned 影響）",
        openOverdue.nextCTA.type === "contacted", openOverdue.nextCTA);

  /* ---- LR14-20 actions 分流 -------------------------------------------- */
  // pendingReplyHours=0 讓「待回」不依賴跑測試當下的營業時段 → 排序測試不 flaky
  var ORD = { pendingReplyHours: 0, overdueHours: 24 };
  var rP  = R({ id: "ordP",  委託人: "待回客", 狀態: QJ.STATUS.OPEN,  lastInteraction: hoursAgo(2) });
  var rO  = R({ id: "ordO",  委託人: "逾期客", 狀態: QJ.STATUS.OPEN,  lastInteraction: daysAgo(5) });
  var rRt = R({ id: "ordRt", 委託人: "回訊客", 狀態: QJ.STATUS.HUMAN, 結案日期: daysAgo(30), lastInteraction: hoursAgo(1) });
  var rC  = R({ id: "ordC",  委託人: "待歸檔",  狀態: QJ.STATUS.HUMAN, lastInteraction: hoursAgo(3) });
  var sOrd = QJ.logic.analyze([rC, rRt, rO, rP], ORD);   // 故意亂序輸入
  var acts = sOrd.actions;
  function idxOf(id) { for (var i = 0; i < acts.length; i++) if (acts[i].id === id) return i; return -1; }
  function kindsOf(id) { return acts.filter(function (a) { return a.id === id; }).map(function (a) { return a.kind; }); }

  check("LR14 returned 案在 actions 中恰好出現一次（actionSeen 去重）",
        kindsOf("ordRt").length === 1, kindsOf("ordRt"));
  check("LR15 該列 kind === returned", kindsOf("ordRt")[0] === "returned", kindsOf("ordRt"));
  check("LR16 [去重] 同一筆不得同時出現在 returned 與 close",
        kindsOf("ordRt").indexOf("close") === -1, kindsOf("ordRt"));
  check("LR17 排序：pending < returned", idxOf("ordP") < idxOf("ordRt"),
        [idxOf("ordP"), idxOf("ordRt")]);
  check("LR17b 排序：overdue < returned", idxOf("ordO") < idxOf("ordRt"),
        [idxOf("ordO"), idxOf("ordRt")]);
  check("LR17c 排序：returned < close", idxOf("ordRt") < idxOf("ordC"),
        [idxOf("ordRt"), idxOf("ordC")]);
  check("LR17d 四列各自恰好一次、總數 4",
        acts.length === 4 && kindsOf("ordP").length === 1 && kindsOf("ordO").length === 1 &&
        kindsOf("ordC").length === 1, acts.map(function (a) { return a.kind; }));
  check("LR18 label 前綴「已結案回訊：」+ 委託人",
        acts[idxOf("ordRt")].label === "已結案回訊：回訊客", acts[idxOf("ordRt")].label);

  var noName = R({ id: "ordX", 委託人: "", 狀態: QJ.STATUS.HUMAN,
                   結案日期: daysAgo(30), lastInteraction: hoursAgo(1) });
  var sNoName = QJ.logic.analyze([noName], ORD);
  check("LR18b 無委託人 → 「已結案回訊：（未具名）」",
        sNoName.actions[0] && sNoName.actions[0].label === "已結案回訊：（未具名）",
        sNoName.actions[0]);

  // returned 且已逾期：overdue 先佔位（既有 actionSeen 語意）→ kind 是 overdue，
  // 但 queue 列的 returned 旗標仍為 true（row-returned 高亮不受影響）。
  var rRtOld = R({ id: "ordRtOld", 委託人: "久未回", 狀態: QJ.STATUS.HUMAN,
                   結案日期: daysAgo(30), lastInteraction: daysAgo(5) });
  var sOld = QJ.logic.analyze([rRtOld], ORD);
  check("LR19 returned + 已逾期 → actions kind 為 overdue（逾期優先，仍只列一次）",
        sOld.actions.length === 1 && sOld.actions[0].kind === "overdue",
        sOld.actions.map(function (a) { return a.kind; }));
  check("LR19b 同一筆的 queue.returned 仍為 true（高亮分流不被 actions 分類影響）",
        sOld.queue[0].returned === true, sOld.queue[0].returned);

  /* ---- LR20 queue 旗標普遍存在 ---------------------------------------- */
  check("LR20 每一列 queue item 都帶 boolean returned（不得 undefined）",
        sOrd.queue.length === 4 && sOrd.queue.every(function (q) { return typeof q.returned === "boolean"; }),
        sOrd.queue.map(function (q) { return typeof q.returned; }));
  check("LR20b 只有 returned 案為 true，其餘三列為 false（row-returned/row-new 分流的唯一依據）",
        sOrd.queue.filter(function (q) { return q.returned; })
                  .map(function (q) { return q.rec.id; }).join(",") === "ordRt",
        sOrd.queue.filter(function (q) { return q.returned; }).map(function (q) { return q.rec.id; }));

  /* ---- LR21-28 不變量 -------------------------------------------------- */
  var now = new Date();
  function md(day) { return new Date(now.getFullYear(), now.getMonth(), day); }
  // returned 案的結案日期就落在本月 → 若閘門寫錯（用結案日期而非 isDone）就會被統計進去
  var rtThisMonth = R({ id: "invRt", 委託人: "本月回訊", 狀態: QJ.STATUS.HUMAN,
                        結案日期: md(2), 成交金額: 88000, lastInteraction: hoursAgo(1) });
  var realDone = R({ id: "invDone", 委託人: "真結案", 狀態: QJ.STATUS.DONE,
                     結案日期: md(3), 成交金額: 50000 });
  var sInv = QJ.logic.analyze([rtThisMonth, realDone], ORD);
  var closedIds = (sInv.review.closedRecs || []).map(function (r) { return r.id; });
  check("LR21 returned 案不得進 review.closedRecs（它已不是已完成）",
        closedIds.indexOf("invRt") === -1 && closedIds.indexOf("invDone") !== -1, closedIds);
  var honestIds = (sInv.deal.honestRecs || []).map(function (r) { return r.id; });
  check("LR22 returned 案不得進 deal.honestRecs（即使有成交金額 88000）",
        honestIds.indexOf("invRt") === -1 && honestIds.indexOf("invDone") !== -1, honestIds);
  check("LR23 kpis.monthClosed 只算真已完成（1 筆，不是 2）",
        sInv.kpis.monthClosed === 1, sInv.kpis.monthClosed);
  check("LR23b deal.honestAmount 不含 returned 案金額（50000，非 138000）",
        sInv.deal.honestAmount === 50000, sInv.deal.honestAmount);
  check("LR24 returned 案算在 kpis.awaiting（非已完成 → 待處理），語意不變",
        sInv.kpis.awaiting === 1, sInv.kpis.awaiting);
  check("LR24b returned 案算在 kpis.closableToday（仍是人工接管中）",
        sInv.kpis.closableToday === 1, sInv.kpis.closableToday);

  // 差分不變量：同一批紀錄，只差在「有沒有結案日期」（＝有沒有被判成 returned），
  // 其餘 KPI 必須逐項相同。returned 只換分類與高亮，不動任何計數。
  function stripClosed(r) { var c = {}; for (var k in r) c[k] = r[k]; c.結案日期 = null; c.id = r.id + "_b"; return c; }
  var withFlag = QJ.logic.analyze([rP, rO, rRt, rC], ORD).kpis;
  var without  = QJ.logic.analyze([rP, rO, stripClosed(rRt), rC], ORD).kpis;
  ["pending", "overdueRisk", "awaiting", "closableToday", "monthClosed", "overloadedOwners"]
    .forEach(function (k) {
      check("LR25 差分不變量：kpis." + k + " 不因 returned 判定而改變",
            withFlag[k] === without[k], [k, withFlag[k], without[k]]);
    });
  check("LR25b 差分不變量：actions 筆數不變（只換 kind，不多列也不少列）",
        QJ.logic.analyze([rP, rO, rRt, rC], ORD).actions.length ===
        QJ.logic.analyze([rP, rO, stripClosed(rRt), rC], ORD).actions.length);
  check("LR25c 差分對照：無結案日期時該列回到 kind close（證明差別確實只在 returned）",
        QJ.logic.analyze([rP, rO, stripClosed(rRt), rC], ORD).actions
          .filter(function (a) { return a.id === "ordRt_b"; })
          .map(function (a) { return a.kind; })[0] === "close");
  check("LR26 slices.statuses 仍排除已完成、且含人工接管中（下拉語意不變）",
        sInv.slices.statuses.indexOf(QJ.STATUS.DONE) === -1 &&
        sInv.slices.statuses.indexOf(QJ.STATUS.HUMAN) !== -1, sInv.slices.statuses);
  var emptyS = QJ.logic.analyze([], {});
  check("LR27 空輸入 → 不炸、queue/actions 皆為空陣列",
        Array.isArray(emptyS.queue) && emptyS.queue.length === 0 &&
        Array.isArray(emptyS.actions) && emptyS.actions.length === 0);
}

/* ===========================================================================
 * TASK 2K — 已結案回訊（render 層合約）
 *
 * render.js 是 DOM 相依的 IIFE，這支 harness 沒有 DOM，所以沿用本檔既有的
 * 「抽出來丟進 vm sandbox 跑」模式（同 TASK OA 的 me.js drift pin）：
 *   · firstTodoExcerpt / safeTruncate / balanceQuotes —— 純字串函式，直接跑真行為
 *   · diffUpdate 的 row-returned/row-new 分支 —— 抽出該分支、餵假 nrow 跑兩極性
 *   · ACTION_KIND_LABEL —— 直接 eval 物件字面值
 * 抽取失敗（改名/搬家）本身就是失敗檢查，不會靜默略過。
 *
 * fixture 用真實資料：李鎧華（Ue446843c8420c87f34b8786496a3fc2f）是活生生的
 * 「已完成但仍在往返」個案，待辦事項 29 條、第一條 127 字、含「」引號。
 * ======================================================================== */
var LI_KAI_HUA_TODO = [
  "・【客戶顧慮・建議給她一段可轉述的說法】01:21 客戶說「怕他們覺得 要傳個人身份證會擔心」 — 她擔心開口要姐姐與弟弟的身分證會讓對方有疑慮。請承辦人告訴她：需要哪些項目、為什麼需要、本所如何保管，讓她能直接轉述給家人；必要時也可說明是否有其他替代方式",
  "・【客戶的下一步】她將向姐姐與弟弟索取身分證字號，並在這幾天整理資料交給謝代書。若還需其他文件請一次講清楚",
  "・【需承辦人明確回覆】客戶問若動產實際不到她寫的 1,000 萬是否也沒關係 — 屬法律效果判斷",
  "・【客戶完整的分配意向】大里那筆不動產 → 姐姐與弟弟；其餘不動產 → 先生；動產（自估約 1,000 萬）→ 先生",
].join("\n");
var LI_KAI_HUA_SUMMARY =
  "財產分配安排（備註為夫妻贈與＋遺囑）：台中大里那筆不動產給姐姐與弟弟；其餘不動產及動產（客戶自估約 1,000 萬）全部給先生。資料已於 7/20 交付謝代書，客戶希望改以電話溝通";

function test_returnedRenderContract() {
  console.log("TASK 2K — 已結案回訊 render 合約 (render.js 抽取執行)");

  var rSrc = fs.readFileSync(path.join(__dirname, "..", "assets", "js", "render.js"), "utf8");

  /* ---- (1) firstTodoExcerpt 家族 --------------------------------------- */
  var exM = rSrc.match(/var TODO_BOUNDARY[\s\S]*?\n  function firstTodoExcerpt\(rec\) \{[\s\S]*?\n  \}\n/);
  check("RT0 render.js 抽得到 TODO_BOUNDARY…firstTodoExcerpt 區塊", !!exM, "regex miss");
  if (exM) {
    var sb = {};
    vm.runInNewContext(exM[0] +
      "\nthis.__f = firstTodoExcerpt; this.__t = safeTruncate; this.__b = balanceQuotes;", sb);
    var f = sb.__f;

    // 真實 fixture：只取第一條
    var out = f({ 待辦事項: LI_KAI_HUA_TODO });
    check("RT1 [真實資料] 只取待辦第一條（開頭是第一條的標題）",
          out.indexOf("【客戶顧慮・建議給她一段可轉述的說法】") === 0, out);
    check("RT1b [真實資料] 不含第二條的內容（【客戶的下一步】）",
          out.indexOf("【客戶的下一步】") === -1, out);
    check("RT1c [真實資料] 開頭的「・」項目符號已剝除",
          out.charAt(0) !== "・", out.charAt(0));
    check("RT2 [真實資料] 127 字原文被截短（<= 90）且非空",
          out.length > 0 && out.length <= 90, out.length);
    check("RT2b [真實資料] 切在句讀（結尾為 。！？；」』 之一）",
          "。！？；」』".indexOf(out.charAt(out.length - 1)) !== -1, out.slice(-6));
    var op = (out.match(/「/g) || []).length, cl = (out.match(/」/g) || []).length;
    check("RT3 [真實資料] 引號成對（不把客戶原話斷章）", op === cl, [op, cl, out]);

    // 逐條掃全部真實待辦：任何一條當第一條都不得吐出不成對引號
    var allItems = LI_KAI_HUA_TODO.split(/\n(?=・)/);
    var unbal = allItems.filter(function (it) {
      var o = f({ 待辦事項: it });
      return (o.match(/「/g) || []).length !== (o.match(/」/g) || []).length;
    });
    check("RT3b [真實資料] 4 條待辦逐一當第一條 → 皆無不成對引號", unbal.length === 0, unbal);

    // 引號延伸：」落在 [90, 106] → safeTruncate 硬切後由 balanceQuotes 補到收尾引號
    var head = "【待承辦人明確回覆・受讓人身分資料要到什麼程度】客戶連問了兩次語氣有點不安，她說";
    var quoted = "「如果只是要給姐姐和弟弟的身分證字號是不是就不用再多提供其他任何文件了呢」";
    var longQ = head + quoted + "，請承辦人明確回覆";
    var outQ = f({ 待辦事項: "・" + longQ });
    check("RT4 引號不成對時延伸到收尾引號（含 「 與 」）",
          outQ.indexOf("「") !== -1 && outQ.indexOf("」") !== -1, outQ);
    check("RT4b 延伸後引號成對",
          (outQ.match(/「/g) || []).length === (outQ.match(/」/g) || []).length, outQ);
    check("RT4c 延伸後長度超過 75（證明確實走了延伸分支，不是剛好切在 75）",
          outQ.length > 75, outQ.length);
    check("RT4d 延伸幅度有界（<= 75 + 1 + 30 + 1）", outQ.length <= 107, outQ.length);

    // 引號離得太遠（> 30 字）→ 不延伸，維持硬截斷
    var farClose = head + "「" + new Array(80).join("字") + "」";
    var outFar = f({ 待辦事項: "・" + farClose });
    check("RT4e 收尾引號超過 30 字外 → 不延伸（維持有界截斷）",
          outFar.length <= 76, outFar.length);

    // 硬截斷（整段找不到句讀）→ 末尾「…」
    var noPunct = new Array(200).join("甲");
    var outNo = f({ 待辦事項: "・" + noPunct });
    check("RT5 全無句讀的長字串 → 硬截斷且結尾「…」",
          outNo.length === 76 && outNo.charAt(75) === "…", [outNo.length, outNo.slice(-3)]);

    // 短內容不動
    var shortTodo = "・【客戶希望改用電話與謝代書溝通・待團隊確認】";
    check("RT5b 短於 75 字 → 原文照出、不加「…」",
          f({ 待辦事項: shortTodo }) === "【客戶希望改用電話與謝代書溝通・待團隊確認】",
          f({ 待辦事項: shortTodo }));

    // 退路：待辦空 → 案件說明
    check("RT6 [真實資料] 待辦空 → 退回 案件說明（需求摘要）",
          f({ 待辦事項: "", 案件說明: LI_KAI_HUA_SUMMARY })
            .indexOf("財產分配安排") === 0,
          f({ 待辦事項: "", 案件說明: LI_KAI_HUA_SUMMARY }));
    check("RT6b 待辦只有空白字元 → 一樣退回 案件說明",
          f({ 待辦事項: "   \n  ", 案件說明: "案情摘要甲" }) === "案情摘要甲",
          f({ 待辦事項: "   \n  ", 案件說明: "案情摘要甲" }));
    check("RT6c 待辦缺欄位（undefined）→ 退回 案件說明",
          f({ 案件說明: "案情摘要乙" }) === "案情摘要乙");

    // 兩者皆空 → 固定文字（不放假內容）
    var EMPTY_TEXT = "（尚無摘要，請點詳情查看對話）";
    check("RT7 待辦與案件說明皆空 → 固定文字", f({}) === EMPTY_TEXT, f({}));
    check("RT7b 兩者皆空字串 → 固定文字",
          f({ 待辦事項: "", 案件說明: "" }) === EMPTY_TEXT);
    check("RT7c rec 為 null → 固定文字、不炸", f(null) === EMPTY_TEXT);
    check("RT7d rec 為 undefined → 固定文字、不炸", f(undefined) === EMPTY_TEXT);

    // 單條內含換行 → 併成一行（不讓掃視型元件長高）
    check("RT8 條目內的換行併成「；」（單列高度不變）",
          f({ 待辦事項: "・甲項\n  乙項" }).indexOf("\n") === -1,
          f({ 待辦事項: "・甲項\n  乙項" }));

    // 「多條只取第一條」的分隔語意：只在「換行 + ・」處切
    check("RT8b 分隔只認「換行＋・」：句中的「・」不當成新條目",
          f({ 待辦事項: "・甲・乙\n・丙" }) === "甲・乙",
          f({ 待辦事項: "・甲・乙\n・丙" }));
  }

  /* ---- (2) diffUpdate 的 row-returned / row-new 分流 -------------------- */
  var brM = rSrc.match(/if \(item && item\.returned\) \{[^\n]*\}\s*\n\s*else \{[^\n]*\}/);
  check("RT9 render.js 抽得到 diffUpdate 的新列 class 分支", !!brM, "regex miss");
  if (brM) {
    function runBranch(item) {
      var added = [];
      var sb2 = { item: item, nrow: { classList: { add: function (c) { added.push(c); } } } };
      vm.runInNewContext(brM[0], sb2);
      return added;
    }
    var addedRt = runBranch({ returned: true });
    var addedNew = runBranch({ returned: false });
    check("RT10 [關鍵不變量] item.returned === true → 只加 row-returned",
          addedRt.length === 1 && addedRt[0] === "row-returned", addedRt);
    check("RT10b [關鍵不變量] 已結案回訊「絕不」被標成 row-new（朱色＝新客戶進線）",
          addedRt.indexOf("row-new") === -1, addedRt);
    check("RT11 [護欄] item.returned === false → 維持 row-new（新進件高亮不被改壞）",
          addedNew.length === 1 && addedNew[0] === "row-new", addedNew);
    check("RT11b returned 缺欄位（舊 state 物件）→ 退回 row-new，不炸",
          runBranch({}).join() === "row-new", runBranch({}));
  }

  /* ---- (3) ACTION_KIND_LABEL + buildActionRow 的 returned 分支 ---------- */
  var lblM = rSrc.match(/var ACTION_KIND_LABEL = \{[\s\S]*?\};/);
  check("RT12 render.js 抽得到 ACTION_KIND_LABEL", !!lblM, "regex miss");
  if (lblM) {
    var sb3 = {};
    vm.runInNewContext(lblM[0] + "\nthis.__L = ACTION_KIND_LABEL;", sb3);
    check("RT12b ACTION_KIND_LABEL.returned === 已結案回訊",
          sb3.__L.returned === "已結案回訊", sb3.__L);
    ["pending", "overdue", "close", "amount"].forEach(function (k) {
      check("RT12c [護欄] ACTION_KIND_LABEL." + k + " 既有字樣未被動到",
            sb3.__L[k] === { pending: "待回覆", overdue: "逾期跟進", close: "可結案", amount: "待補金額" }[k],
            sb3.__L[k]);
    });
  }
  check("RT13 returned 列的待辦行走 firstTodoExcerpt 並以「回訊：」開頭",
        /act\.kind === "returned"[\s\S]{0,600}?"回訊："\s*\+\s*firstTodoExcerpt\(rec\)/.test(rSrc),
        "pattern miss");
  check("RT14 returned 列的結案鈕用中性色（variant null，非 cta-ok）",
        /act\.kind === "returned" \? null : "cta-ok"/.test(rSrc), "pattern miss");
  check("RT15 returned 列仍渲染兩顆鈕（已聯繫 + 結案）——路徑保留不移除",
        /act\.kind === "pending" \|\| act\.kind === "overdue" \|\| act\.kind === "close"[\s\S]{0,120}?act\.kind === "returned"/.test(rSrc),
        "pattern miss");
  check("RT16 legend 補上「已結案回訊」說明（含「系統未回覆客戶」）",
        rSrc.indexOf("已結案回訊＝原本已結案的客戶又傳訊息") !== -1 &&
        rSrc.indexOf("系統未回覆客戶") !== -1, "legend miss");

  /* ---- (4) styles.css 有對應樣式（沒 class 就等於沒分流） -------------- */
  var css = fs.readFileSync(path.join(__dirname, "..", "assets", "css", "styles.css"), "utf8");
  check("RT17 styles.css 定義了 .row-returned（否則 class 加了也看不出差別）",
        /\.row-returned\b/.test(css), "css miss");
  check("RT17b styles.css 仍保有 .row-new（既有新進件高亮未被取代）",
        /\.row-new\b/.test(css), "css miss");
}

/* ---- run ---- */
console.log("=== quanjin-ops dashboard test harness ===");
test_analyze();
test_isStaffOwnRecord();
test_buildFilterFormula();
test_helpers();
test_staffLoader();
test_maxWaitDays();
test_dealOutcomeSplit();
test_honestRecsPanel();
test_closeReview();
test_oaChatUrl();
test_returnedFromClosed();
test_returnedRenderContract();
console.log("");
if (FAILS.length) {
  console.log("FAILED: " + FAILS.length + " — " + safe(FAILS));
  process.exit(1);
}
console.log("ALL PASS (" + PASS + " checks)");
process.exit(0);
