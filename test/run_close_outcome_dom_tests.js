#!/usr/bin/env node
/* =============================================================================
 * 全謹 ops dashboard — DOM-level regression for the STRICT forced-outcome close UI
 * (forced-outcome shipped 2026-06-27: render.js R.openCloseOutcome + app.js close
 *  handlers). NO `node` on PATH — run with bun:
 *      ~/.bun/bin/bun test/run_close_outcome_dom_tests.js
 *
 * Why a real-DOM mock and not the pure-fn harness:
 *   The behaviour under test lives in TWO private closures inside app.js's IIFE —
 *   onClick (delegated [data-cta] click handler) and onStatusChange (status-select
 *   change handler). Neither is exported. They are only reachable through the
 *   document-level listeners that boot() registers. So this harness:
 *     1. shims a minimal DOM (createElement / append / query / closest / classList)
 *     2. loads config → logic → airtable → render (real) then installs seams
 *     3. loads app.js (boot() fires, captures the click/change listeners)
 *     4. populates state.records via the EXPORTED QJ.app.refresh() (so the private
 *        findRec() resolves), then synthesises clicks/changes and asserts.
 *
 * Interception seam: doPatch() + findRec() are private closures and cannot be
 * stubbed without a production change. The equivalent observable seam is
 * QJ.airtable.cta(id, proxyAction) — doPatch calls it synchronously with the very
 * {action, amount} object the task wants asserted. window.confirm / QJ.render.toast
 * are stubbed as call-recorders. This file changes NO production code.
 *
 * Mirrors run_dashboard_tests.js style: own check(), exit non-zero on fail,
 * final "ALL PASS (N checks)".
 * ========================================================================== */
"use strict";

var fs = require("fs");
var vm = require("vm");
var path = require("path");

/* =============================================================================
 * 1) Minimal DOM mock — only what these handlers actually touch.
 * ========================================================================== */

function MockNode(tag) {
  this.tagName = (tag || "").toUpperCase();
  this.nodeName = this.tagName;
  this.nodeType = 1;
  this.className = "";
  this.childNodes = [];
  this.parentNode = null;
  this._attrs = {};
  this.style = {};
  this._text = "";
  this._listeners = {};
  this.value = "";   // inputs / selects
  this.type = "";
  var self = this;
  this.classList = {
    _list: function () { return String(self.className || "").split(/\s+/).filter(Boolean); },
    add: function (c) { var a = this._list(); if (a.indexOf(c) < 0) { a.push(c); self.className = a.join(" "); } },
    remove: function (c) { self.className = this._list().filter(function (x) { return x !== c; }).join(" "); },
    contains: function (c) { return this._list().indexOf(c) >= 0; },
    toggle: function (c) { if (this.contains(c)) this.remove(c); else this.add(c); },
  };
}
Object.defineProperty(MockNode.prototype, "textContent", {
  get: function () {
    if (this.childNodes && this.childNodes.length) {
      return this.childNodes.map(function (c) { return c.textContent != null ? c.textContent : (c._text || ""); }).join("");
    }
    return this._text || "";
  },
  set: function (v) { this._text = String(v == null ? "" : v); this.childNodes = []; },
});
Object.defineProperty(MockNode.prototype, "firstChild", {
  get: function () { return this.childNodes[0] || null; },
});
MockNode.prototype.appendChild = function (child) { if (child.parentNode && child.parentNode.removeChild) child.parentNode.removeChild(child); child.parentNode = this; this.childNodes.push(child); return child; };
MockNode.prototype.removeChild = function (child) { var i = this.childNodes.indexOf(child); if (i >= 0) this.childNodes.splice(i, 1); child.parentNode = null; return child; };
MockNode.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
MockNode.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; };
MockNode.prototype.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); };
MockNode.prototype.addEventListener = function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); };
MockNode.prototype.focus = function () { /* no-op */ };
MockNode.prototype.querySelector = function (sel) { return engineQSA(this, sel)[0] || null; };
MockNode.prototype.querySelectorAll = function (sel) { return engineQSA(this, sel); };
MockNode.prototype.closest = function (sel) {
  var c = parseCompound(String(sel).trim());
  var cur = this;
  while (cur && cur.tagName) { if (matchCompound(cur, c)) return cur; cur = cur.parentNode; }
  return null;
};

/* ---- tiny CSS-selector engine (class / tag / [attr] / [attr="v"] + descendant) ---- */
function parseCompound(sel) {
  var c = { tag: null, id: null, classes: [], attrs: [] };
  var re = /\s*(?:([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?\])/g;
  var m;
  while ((m = re.exec(sel))) {
    if (m[1]) c.tag = m[1].toUpperCase();
    else if (m[2]) c.classes.push(m[2]);
    else if (m[3]) c.id = m[3];
    else if (m[4] !== undefined) {
      var v = (m[5] !== undefined) ? m[5] : (m[6] !== undefined) ? m[6] : (m[7] !== undefined && m[7] !== "" ? m[7] : null);
      c.attrs.push({ name: m[4], value: v });
    }
  }
  return c;
}
function matchCompound(node, c) {
  if (!node || !node.tagName) return false;
  if (c.tag && node.tagName !== c.tag) return false;
  if (c.id && node.getAttribute("id") !== c.id) return false;
  for (var i = 0; i < c.classes.length; i++) if (!node.classList.contains(c.classes[i])) return false;
  for (var j = 0; j < c.attrs.length; j++) {
    var a = c.attrs[j], got = node.getAttribute(a.name);
    if (a.value === null) { if (got == null) return false; }
    else if (String(got) !== a.value) return false;
  }
  return true;
}
function allDescendants(node, acc) {
  (node.childNodes || []).forEach(function (ch) { if (ch && ch.tagName) { acc.push(ch); allDescendants(ch, acc); } });
  return acc;
}
function engineQSA(root, sel) {
  var compounds = String(sel).trim().split(/\s+/).map(parseCompound);
  var last = compounds[compounds.length - 1];
  var ancestors = compounds.slice(0, -1);
  var cands = allDescendants(root, []).filter(function (n) { return matchCompound(n, last); });
  if (!ancestors.length) return cands;
  return cands.filter(function (n) {
    var i = ancestors.length - 1, p = n.parentNode;
    while (p && i >= 0) { if (matchCompound(p, ancestors[i])) i--; p = p.parentNode; }
    return i < 0;
  });
}

/* ---- document object ---- */
function makeDocument() {
  var doc = {
    nodeType: 9,
    readyState: "complete",
    _byId: {},
    _listeners: {},
    childNodes: [],
    createElement: function (tag) { return new MockNode(tag); },
    createTextNode: function (t) { return { nodeType: 3, textContent: String(t == null ? "" : t), parentNode: null }; },
    getElementById: function (id) { return Object.prototype.hasOwnProperty.call(this._byId, id) ? this._byId[id] : null; },
    addEventListener: function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    querySelector: function (sel) { return engineQSA(this, sel)[0] || null; },
    querySelectorAll: function (sel) { return engineQSA(this, sel); },
  };
  var body = new MockNode("body");
  body.parentNode = doc;
  doc.body = body;
  doc.childNodes = [body];
  return doc;
}

/* =============================================================================
 * 2) globals (mirror run_dashboard_tests.js: window === global; localStorage shim)
 * ========================================================================== */
global.window = global;
global.localStorage = {
  _d: {},
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem: function (k, v) { this._d[k] = String(v); },
  removeItem: function (k) { delete this._d[k]; },
};
var DOC = makeDocument();
global.document = DOC;

/* recorders + controllable confirm */
var ctaCalls = [];      // {id, action}
var toastCalls = [];    // {m, k}
var confirmCalls = [];  // message strings
var confirmReturn = true;
global.confirm = function (msg) { confirmCalls.push(String(msg)); return confirmReturn; };
window.confirm = global.confirm;

/* keep boot()'s 25s poll out of the runtime (process.exit handles it anyway) */
global.setInterval = function () { return 0; };
global.clearInterval = function () { /* no-op */ };

/* =============================================================================
 * 3) load real modules in contract order, then install seams, then app.js
 * ========================================================================== */
var JS_DIR = path.join(__dirname, "..", "assets", "js");
function load(name) {
  var p = path.join(JS_DIR, name);
  vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p });
}
load("config.js");
load("logic.js");
load("airtable.js");
load("render.js");

/* proxy must read as configured for doPatch to reach cta (keep real proxyConfigured) */
localStorage.setItem(QJ.LS.proxyToken, "test-proxy-token");

/* seams installed BEFORE app.js so boot() consumes them */
QJ.auth = { ensure: function () { return true; }, getCreds: function () { return { baseId: "appTEST", tableId: "tblTEST" }; }, clear: function () {}, renderSetupGate: function () {} };

var TEST_RECORDS = [
  { id: "rRoute", 委託人: "路由先生" },
  { id: "rRender", 委託人: "渲染小姐" },
  { id: "rBlank", 委託人: "空白先生" },
  { id: "rZero", 委託人: "零元小姐" },
  { id: "rDeal", 委託人: "王成交" },
  { id: "rDealNo", 委託人: "陳改念" },
  { id: "rLost", 委託人: "林未成" },
  { id: "rLostNo", 委託人: "黃猶豫" },
  { id: "rStatus", 委託人: "下拉先生" },
];
QJ.airtable = QJ.airtable || {};
QJ.airtable.detectSchema = function () { return Promise.resolve({ fields: [], fieldMap: {} }); };
QJ.airtable.fetchRecords = function () { return Promise.resolve(TEST_RECORDS); };
QJ.airtable.cta = function (id, proxyAction) { ctaCalls.push({ id: id, action: proxyAction }); return Promise.resolve(); };
/* fetchStats intentionally absent → refreshStats() returns immediately */
delete QJ.airtable.fetchStats;

/* analyze stub: render is exercised but all hosts are null → no-op; keep it benign */
QJ.logic.analyze = function () {
  return { summary: {}, kpis: {}, actions: [], slices: { types: [], owners: [], statuses: [] }, queue: [], deal: {}, team: [] };
};
/* toast recorder (app.js toast() delegates to QJ.render.toast) */
QJ.render.toast = function (m, k) { toastCalls.push({ m: m, k: k }); };

DOC.readyState = "complete";
load("app.js");   // boot() fires synchronously → registers document click/change listeners

/* =============================================================================
 * 4) harness
 * ========================================================================== */
var FAILS = [];
var PASS = 0;
function check(name, cond, detail) {
  if (cond) { PASS += 1; console.log("  ✓ " + name); }
  else { FAILS.push(name); console.log("  ✗ " + name + (detail !== undefined ? "  " + safe(detail) : "")); }
}
function safe(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }

function resetCalls() { ctaCalls.length = 0; toastCalls.length = 0; confirmCalls.length = 0; confirmReturn = true; }
function fire(type, target) {
  (DOC._listeners[type] || []).forEach(function (fn) {
    fn({ target: target, type: type, preventDefault: function () {}, stopPropagation: function () {} });
  });
}
function mountChooser(id) {
  var host = DOC.createElement("div");
  host.className = "queue-cta-cell";
  DOC.body.appendChild(host);
  QJ.render.openCloseOutcome(host, id);
  return host;
}
function btnIn(host, cta) { return host.querySelector('[data-cta="' + cta + '"]'); }

/* =============================================================================
 * 5) tests
 * ========================================================================== */
function run() {
  console.log("=== quanjin-ops forced-outcome close UI — DOM regression ===");

  /* ---- SETUP sanity: boot() bound the delegated handlers --------------- */
  console.log("SETUP — boot() bound document listeners");
  check("click listener registered on document", (DOC._listeners.click || []).length > 0);
  check("change listener registered on document", (DOC._listeners.change || []).length > 0);

  /* ---- CASE 0: app.js cta==="close" routes to openCloseOutcome (NOT openInlineAmount) */
  console.log("CASE 0 — close CTA opens the forced-outcome chooser");
  resetCalls();
  var host0 = DOC.createElement("div");
  DOC.body.appendChild(host0);
  var closeBtn = DOC.createElement("button");
  closeBtn.setAttribute("data-cta", "close");
  closeBtn.setAttribute("data-id", "rRoute");
  host0.appendChild(closeBtn);
  fire("click", closeBtn);
  check("C0 chooser .inline-edit.close-outcome rendered into host", !!host0.querySelector(".close-outcome"));
  check("C0 chooser carries 未成交 (close-lost) → proves openCloseOutcome, not openInlineAmount",
        !!btnIn(host0, "close-lost"));
  check("C0 chooser carries co-label 本案結果？",
        host0.querySelector(".co-label") && host0.querySelector(".co-label").textContent === "本案結果？",
        host0.querySelector(".co-label") && host0.querySelector(".co-label").textContent);
  check("C0 no bare close fired (cta not called on opening the chooser)", ctaCalls.length === 0, ctaCalls);

  /* ---- CASE 1: chooser content + the 暫不記錄/close-skip escape is GONE -- */
  console.log("CASE 1 — chooser content; old 暫不記錄/close-skip removed");
  var host1 = mountChooser("rRender");
  check("C1 co-label text === 本案結果？",
        host1.querySelector(".co-label") && host1.querySelector(".co-label").textContent === "本案結果？");
  check("C1 exactly one .amt-input present", host1.querySelectorAll(".amt-input").length === 1, host1.querySelectorAll(".amt-input").length);
  var cc = btnIn(host1, "close-confirm");
  check("C1 成交結案 button (data-cta=close-confirm) present + labelled",
        cc && cc.textContent === "成交結案", cc && cc.textContent);
  var cl = btnIn(host1, "close-lost");
  check("C1 未成交 button (data-cta=close-lost) present + labelled",
        cl && cl.textContent === "未成交", cl && cl.textContent);
  check("C1 取消 button present", host1.querySelectorAll("button").some(function (b) { return b.textContent === "取消"; }),
        host1.querySelectorAll("button").map(function (b) { return b.textContent; }));
  check("C1 NO close-skip button rendered", host1.querySelectorAll('[data-cta="close-skip"]').length === 0);
  check("C1 NO 暫不記錄 text anywhere in the chooser", host1.querySelector(".close-outcome").textContent.indexOf("暫不記錄") === -1,
        host1.querySelector(".close-outcome").textContent);

  /* ---- CASE 2: 成交結案 with blank / 0 → toast, NO doPatch (no cta) ----- */
  console.log("CASE 2 — 成交結案 blank/0 → toast, no write");
  resetCalls();
  var host2 = mountChooser("rBlank");                 // input left blank
  fire("click", btnIn(host2, "close-confirm"));
  check("C2a blank amount → toast warned", toastCalls.length >= 1, toastCalls);
  check("C2a blank amount → cta NOT called (no bare/zero close)", ctaCalls.length === 0, ctaCalls);

  resetCalls();
  var host2b = mountChooser("rZero");
  host2b.querySelector(".amt-input").value = "0";     // explicit 0
  fire("click", btnIn(host2b, "close-confirm"));
  check("C2b amount 0 → toast warned", toastCalls.length >= 1, toastCalls);
  check("C2b amount 0 → cta NOT called", ctaCalls.length === 0, ctaCalls);

  /* ---- CASE 3: 成交結案 with 80000 → cta {action:'close', amount:80000} - */
  console.log("CASE 3 — 成交結案 80000 → close write with amount 80000");
  resetCalls();
  var host3 = mountChooser("rDeal");
  host3.querySelector(".amt-input").value = "80000";
  confirmReturn = true;
  fire("click", btnIn(host3, "close-confirm"));
  check("C3 window.confirm prompted before write", confirmCalls.length === 1, confirmCalls);
  check("C3 cta called exactly once", ctaCalls.length === 1, ctaCalls);
  check("C3 cta target id === rDeal", ctaCalls[0] && ctaCalls[0].id === "rDeal", ctaCalls[0]);
  check("C3 proxyAction === {action:'close', amount:80000}",
        ctaCalls[0] && ctaCalls[0].action && ctaCalls[0].action.action === "close" && ctaCalls[0].action.amount === 80000,
        ctaCalls[0] && ctaCalls[0].action);

  resetCalls();
  var host3n = mountChooser("rDealNo");
  host3n.querySelector(".amt-input").value = "80000";
  confirmReturn = false;                              // operator cancels the confirm
  fire("click", btnIn(host3n, "close-confirm"));
  check("C3' confirm declined → cta NOT called", ctaCalls.length === 0, ctaCalls);

  /* ---- CASE 4: 未成交 (close-lost) → cta {action:'close', amount:0} ----- */
  console.log("CASE 4 — 未成交 → close write with amount 0");
  resetCalls();
  var host4 = mountChooser("rLost");
  confirmReturn = true;
  fire("click", btnIn(host4, "close-lost"));
  check("C4 window.confirm prompted before write", confirmCalls.length === 1, confirmCalls);
  check("C4 cta called exactly once", ctaCalls.length === 1, ctaCalls);
  check("C4 cta target id === rLost", ctaCalls[0] && ctaCalls[0].id === "rLost", ctaCalls[0]);
  check("C4 proxyAction === {action:'close', amount:0}",
        ctaCalls[0] && ctaCalls[0].action && ctaCalls[0].action.action === "close" && ctaCalls[0].action.amount === 0,
        ctaCalls[0] && ctaCalls[0].action);

  resetCalls();
  var host4n = mountChooser("rLostNo");
  confirmReturn = false;
  fire("click", btnIn(host4n, "close-lost"));
  check("C4' confirm declined → cta NOT called", ctaCalls.length === 0, ctaCalls);

  /* ---- CASE 5: status dropdown → 已完成 opens chooser, no bare close ---- */
  console.log("CASE 5 — status-select → 已完成 opens chooser (no bypass close)");
  resetCalls();
  var td = DOC.createElement("td");
  DOC.body.appendChild(td);
  var sel = DOC.createElement("select");
  sel.className = "status-select pill";
  sel.setAttribute("data-id", "rStatus");
  sel.setAttribute("data-current", QJ.STATUS.OPEN);   // 跟進中
  td.appendChild(sel);
  sel.value = QJ.STATUS.DONE;                          // operator picks 已完成
  fire("change", sel);
  check("C5 selecting 已完成 did NOT bare-close (cta not called)", ctaCalls.length === 0, ctaCalls);
  check("C5 forced-outcome chooser opened into the row cell", !!td.querySelector(".close-outcome"));
  check("C5 chooser carries 成交結案 + 未成交",
        !!td.querySelector('[data-cta="close-confirm"]') && !!td.querySelector('[data-cta="close-lost"]'));
  check("C5 status-select reverted to 跟進中 (not left on 已完成)", sel.value === QJ.STATUS.OPEN, sel.value);

  /* ---- CASE 6: 結案審核 board — uniform list (no 系統外 emphasis) + server-sourced ---- */
  console.log("CASE 6 — 結案審核 板：統一清單、伺服器來源、降級");
  // P1-1: the targeted refresh (app.js refreshCloseReview) calls QJ.render.renderCloseReview —
  // it MUST be exported, else the post-write/120s refresh is dead.
  check("C6 renderCloseReview exported on QJ.render", typeof QJ.render.renderCloseReview === "function");

  var crHost = DOC.createElement("div");
  DOC._byId["close-review"] = crHost;
  var ym = (function () { var n = new Date(); return n.getFullYear() + "-" + ("0" + (n.getMonth() + 1)).slice(-2); })();
  var crState = { review: { closedRecs: [
    { id: "rIn",  委託人: "系統客", 案件類型: "遺囑", 結案日期: new Date(), 成交金額: 25000, 承辦人: "謝代書" },
    { id: "rExt", 委託人: "外部客", 案件類型: "遺囑", 結案日期: new Date(), 成交金額: 0,     承辦人: "" },
  ] } };

  // (a) UNIFORM list — no 系統外 chip / banner / hint / vermilion, no external-first ordering
  QJ.closeReview = { ok: true, cases: [
    { id: "sExt", name: "外部客", caseType: "買賣", closedDate: ym + "-20", amount: 0,     owner: "",       external: true,  closer: "",     source: "external"  },
    { id: "sIn",  name: "系統客", caseType: "遺囑", closedDate: ym + "-25", amount: 30000, owner: "黃玲智", external: false, closer: "戰情室", source: "dashboard" }
  ] };
  QJ.render.renderCloseReview({ review: { closedRecs: [] } });
  var rows = crHost.querySelectorAll(".review-row");
  check("C6a all closed cases listed (2 rows)", rows.length === 2, rows.length);
  check("C6a NO 系統外 chip anywhere", !crHost.querySelector(".rv-srcflag"));
  check("C6a NO 系統外待核對 banner", !crHost.querySelector(".rm-extflag"));
  check("C6a NO is-external styling", !crHost.querySelector(".review-row.is-external"));
  check("C6a NO 來源：後台 / 系統外 text", crHost.textContent.indexOf("系統外") < 0 && crHost.textContent.indexOf("後台") < 0);
  check("C6a neutral meta line", crHost.querySelector(".review-meta") &&
        crHost.querySelector(".review-meta").textContent.indexOf("本月共 2 件結案") >= 0);
  check("C6a most-recent first (sIn 25th before sExt 20th)",
        rows[0].getAttribute("data-id") === "sIn" && rows[1].getAttribute("data-id") === "sExt");
  check("C6a outcome badges (成交 / 未成交) + 修正結果 button",
        !!crHost.querySelector(".rv-won") && !!crHost.querySelector(".rv-lost") &&
        !!crHost.querySelector('[data-cta="close"]'));
  check("C6a delegatee shown when assigned (承辦：黃玲智), absent when none",
        crHost.querySelector('[data-id="sIn"]').textContent.indexOf("承辦：黃玲智") >= 0 &&
        crHost.querySelector('[data-id="sExt"]').textContent.indexOf("承辦") < 0);

  // (b) the headline regression: closedRecs EMPTY but server cases present → STILL renders
  QJ.render.renderCloseReview({ review: { closedRecs: [] } });
  check("C6b closedRecs EMPTY + cases present → board STILL renders (the empty-board bug)",
        crHost.querySelectorAll(".review-row").length === 2);

  // (c) endpoint down → fall back to browser closedRecs
  QJ.closeReview = null;
  QJ.render.renderCloseReview(crState);
  check("C6c endpoint down → renders from closedRecs", crHost.querySelectorAll(".review-row").length === 2);
  check("C6c fallback still has no 系統外 chip", !crHost.querySelector(".rv-srcflag"));

  // (d) cases authoritative over closedRecs when BOTH present
  QJ.closeReview = { ok: true, cases: [
    { id: "sOnly", name: "只在伺服器", caseType: "遺囑", closedDate: ym + "-10", amount: 0, external: true }
  ] };
  QJ.render.renderCloseReview(crState);  // closedRecs has rIn/rExt; cases has sOnly
  check("C6d cases win over closedRecs (server row present, browser rows absent)",
        !!crHost.querySelector('[data-id="sOnly"]') && !crHost.querySelector('[data-id="rExt"]'));

  /* ---- CASE 7: write-proxy liveness banner (setWriteStatus) ---- */
  console.log("CASE 7 — 寫入代理存活指示燈");
  check("C7 setWriteStatus exported on QJ.render", typeof QJ.render.setWriteStatus === "function");
  var wsHost = DOC.createElement("span");
  wsHost.hidden = true;
  DOC._byId["write-status"] = wsHost;
  QJ.render.setWriteStatus("true", "寫入正常");
  check("C7 ok → data-ok=true + text + unhidden",
        wsHost.getAttribute("data-ok") === "true" && wsHost.textContent === "寫入正常" && wsHost.hidden === false);
  QJ.render.setWriteStatus("false", "⚠ 無法寫入");
  check("C7 down → data-ok=false + warn text",
        wsHost.getAttribute("data-ok") === "false" && wsHost.textContent.indexOf("無法寫入") >= 0);
  QJ.render.setWriteStatus("off", "未設定寫入");
  check("C7 unconfigured → data-ok=off", wsHost.getAttribute("data-ok") === "off");

  /* ---- CASE 8: 已結案回訊 CTA 列（方案 E 前端分流 · 真 DOM）----------------
   * 後端 legacy_return_flip 把舊客的 已完成 靜默翻成 人工接管中；戰情室必須把
   * 這種列跟「辦完待歸檔」分開。這裡走「真 producer → 真 render」：重新載入
   * logic.js 復原上面被 stub 掉的 analyze（CASE 8 是最後一段，不影響前面），
   * 用真紀錄跑 analyze() 產生 actions，再交給真 render 畫出 DOM——不手搓
   * action 物件（手搓的卡片形狀測不到 producer 漏欄位）。
   * fixture 待辦事項取自真實個案 李鎧華（Ue446843…3fc2f）的第一、二條。
   * --------------------------------------------------------------------- */
  console.log("CASE 8 — 已結案回訊 CTA 列（真 analyze → 真 render）");
  load("logic.js");   // 復原真 analyze（前面為隔離 render 而 stub 過）
  check("C8-0 真 analyze 已復原（非上面的 stub）",
        QJ.logic.analyze([{ id: "probe", 狀態: QJ.STATUS.HUMAN, lastInteraction: new Date() }], {})
          .queue.length === 1);

  var REAL_TODO = [
    "・【客戶顧慮・建議給她一段可轉述的說法】01:21 客戶說「怕他們覺得 要傳個人身份證會擔心」 — 她擔心開口要姐姐與弟弟的身分證會讓對方有疑慮。請承辦人告訴她：需要哪些項目、為什麼需要、本所如何保管，讓她能直接轉述給家人；必要時也可說明是否有其他替代方式",
    "・【客戶的下一步】她將向姐姐與弟弟索取身分證字號，並在這幾天整理資料交給謝代書。若還需其他文件請一次講清楚",
  ].join("\n");
  function hoursAgoD(n) { return new Date(Date.now() - n * 3600000); }
  function daysAgoD(n) { return new Date(Date.now() - n * 86400000); }

  var ctaHost = DOC.createElement("div");
  DOC._byId["cta-actions"] = ctaHost;
  var caseRecs = [
    // 已結案回訊：人工接管中 + 結案日期 + 互動晚於結案
    { id: "rRet", 委託人: "李鎧華", 案件類型: "夫妻贈與", 承辦人: "謝代書",
      狀態: QJ.STATUS.HUMAN, 結案日期: daysAgoD(30), lastInteraction: hoursAgoD(2),
      待辦事項: REAL_TODO, fields: {} },
    // 一般可結案（護欄組）：同樣人工接管中，但沒有結案日期
    { id: "rClose", 委託人: "王待歸", 案件類型: "遺囑", 承辦人: "謝代書",
      狀態: QJ.STATUS.HUMAN, 結案日期: null, lastInteraction: hoursAgoD(3),
      待辦事項: "・請確認文件收訖", fields: {} },
  ];
  QJ.render._last = QJ.logic.analyze(caseRecs, { pendingReplyHours: 0, overdueHours: 24 });
  check("C8-0b producer 真的產出 returned 與 close 各一列",
        QJ.render._last.actions.map(function (a) { return a.kind; }).sort().join(",") === "close,returned",
        QJ.render._last.actions.map(function (a) { return a.kind; }));
  QJ.render.applyCtaFilter("kind", "");   // 匯出的入口，觸發 renderCtaActions

  var retRow = ctaHost.querySelector('.cta-row[data-id="rRet"]');
  var clsRow = ctaHost.querySelector('.cta-row[data-id="rClose"]');
  check("C8a 已結案回訊列渲染出來", !!retRow);
  check("C8a2 一般可結案列同時渲染（護欄組）", !!clsRow);
  if (retRow && clsRow) {
    check("C8b 該列 class 帶 kind-returned", retRow.classList.contains("kind-returned"), retRow.className);
    var desc = retRow.querySelector(".cta-desc");
    check("C8c 類別字樣為「已結案回訊」",
          desc && desc.textContent.indexOf("已結案回訊") === 0, desc && desc.textContent);

    // 摘要行：回訊：{待辦第一條}，不是整包待辦
    var line = retRow.querySelector(".cta-returned-line");
    check("C8d 有 .cta-returned-line 摘要行", !!line);
    check("C8d2 以「回訊：」開頭（非「待辦：」）",
          line && line.textContent.indexOf("回訊：") === 0, line && line.textContent.slice(0, 12));
    check("C8e [真實資料] 只帶待辦第一條（含【客戶顧慮…】）",
          line && line.textContent.indexOf("【客戶顧慮") !== -1, line && line.textContent);
    check("C8e2 [真實資料] 不含第二條（【客戶的下一步】）",
          line && line.textContent.indexOf("【客戶的下一步】") === -1, line && line.textContent);
    check("C8e3 摘要行有界（含「回訊：」不超過 100 字，掃視型元件不長高）",
          line && line.textContent.length <= 100, line && line.textContent.length);
    check("C8e4 摘要行為單行（無換行）",
          line && line.textContent.indexOf("\n") === -1);

    // 按鈕：已聯繫 + 結案（結案中性色）
    var retClose = retRow.querySelector('.cta-ctrls [data-cta="close"]');
    var retCont = retRow.querySelector('.cta-ctrls [data-cta="contacted"]');
    check("C8f 已結案回訊列仍有「已聯繫」鈕", !!retCont && retCont.textContent === "已聯繫");
    check("C8f2 已結案回訊列仍有「結案」鈕（路徑保留，不移除）",
          !!retClose && retClose.textContent === "結案");
    check("C8g [關鍵] 已結案回訊列的結案鈕為中性色（無 cta-ok）",
          retClose && !retClose.classList.contains("cta-ok"), retClose && retClose.className);

    // 護欄：一般可結案列不得被改壞
    var clsClose = clsRow.querySelector('.cta-ctrls [data-cta="close"]');
    check("C8h [護欄] 一般可結案列的結案鈕仍是 cta-ok（肯定色）",
          clsClose && clsClose.classList.contains("cta-ok"), clsClose && clsClose.className);
    check("C8h2 [護欄] 一般可結案列不套 kind-returned",
          !clsRow.classList.contains("kind-returned"), clsRow.className);
    check("C8h3 [護欄] 一般可結案列沒有 .cta-returned-line",
          !clsRow.querySelector(".cta-returned-line"));
    var clsTodo = clsRow.querySelector(".cta-todo-line");
    check("C8h4 [護欄] 一般可結案列維持「待辦：」行",
          clsTodo && clsTodo.textContent.indexOf("待辦：") === 0, clsTodo && clsTodo.textContent);

    // legend + 類別下拉
    var legend = ctaHost.querySelector(".cta-legend");
    check("C8i legend 說明「已結案回訊」是什麼、且點明系統未回覆客戶",
          legend && legend.textContent.indexOf("已結案回訊＝原本已結案的客戶又傳訊息") !== -1 &&
          legend && legend.textContent.indexOf("系統未回覆客戶") !== -1,
          legend && legend.textContent);
    var kindSel = ctaHost.querySelector('.cta-slice[data-facet="kind"]');
    var optTexts = kindSel ? kindSel.querySelectorAll("option").map(function (o) { return o.textContent; }) : [];
    check("C8j 類別篩選下拉出現「已結案回訊（1）」選項（同仁可只看這一類）",
          optTexts.some(function (t) { return t.indexOf("已結案回訊") === 0; }), optTexts);
    check("C8j2 該選項 value 為 returned（篩選鍵＝kind）",
          kindSel && kindSel.querySelectorAll("option").some(function (o) { return o.value === "returned"; }),
          optTexts);
  }

  /* ---- done ---- */
  console.log("");
  if (FAILS.length) { console.log("FAILED: " + FAILS.length + " — " + safe(FAILS)); process.exit(1); }
  console.log("ALL PASS (" + PASS + " checks)");
  process.exit(0);
}

/* drive state.records through the EXPORTED refresh so the private findRec() resolves,
 * then run synchronously (no awaits → deferred success-path microtasks never interfere). */
QJ.app.refresh(false).then(function () {
  try { run(); }
  catch (e) { console.log("THREW: " + (e && e.stack || e)); process.exit(1); }
});
