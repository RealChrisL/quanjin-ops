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
var HL_UID = "Ud5c30f62587012a787b42f7ab04c65fe";          // 黃玲智 (roster)
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
  };
  var norm = t._normalize({
    id: "recX",
    fields: {
      "姓名": "陳小姐", "進度狀態": "跟進中", "成交金額": "30,000",
      "結案日期": "2026-06-20", "委派團隊成員": XU_FULL, "案件類型": "遺囑",
      "最後互動時間": "2026-06-24T10:00:00.000Z",
    },
  }, fieldMap);
  check("_normalize id/委託人/狀態", norm.id === "recX" && norm.委託人 === "陳小姐" && norm.狀態 === "跟進中", norm);
  check("_normalize 成交金額 numeric coercion", norm.成交金額 === 30000, norm.成交金額);
  check("_normalize 結案日期 + lastInteraction are Dates",
        norm.結案日期 instanceof Date && norm.lastInteraction instanceof Date, norm);
  check("_normalize lastInteractionField records source col",
        norm.lastInteractionField === "最後互動時間", norm.lastInteractionField);
}

/* ---- run ---- */
console.log("=== quanjin-ops dashboard test harness ===");
test_analyze();
test_isStaffOwnRecord();
test_buildFilterFormula();
test_helpers();
console.log("");
if (FAILS.length) {
  console.log("FAILED: " + FAILS.length + " — " + safe(FAILS));
  process.exit(1);
}
console.log("ALL PASS (" + PASS + " checks)");
process.exit(0);
