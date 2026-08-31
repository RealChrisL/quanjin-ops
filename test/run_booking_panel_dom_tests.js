#!/usr/bin/env node
/* =============================================================================
 * 全謹 ops dashboard — 預約面板 DOM 回歸(2026-08-31)
 *   render.js  renderBookings / bookingRow / bkBtn
 *   app.js     refreshBookings / onBookingClick(私有閉包,只能經 document 事件到達)
 *   airtable.js fetchBookings / bookingAction
 *
 * 沿用 run_close_outcome_dom_tests.js 的 idiom:最小 DOM mock → 依序載入
 * config/logic/airtable/render → 裝好 seam → 載入 app.js(boot() 觸發並註冊
 * document 監聽器)→ 合成點擊。不改任何產品碼。
 *
 * 跑法(這台沒有 node):  ~/.bun/bin/bun test/run_booking_panel_dom_tests.js
 *
 * 每一族都附突變驗證(mutate):把防線拿掉,確認同一條斷言真的會變紅。
 * ========================================================================== */
"use strict";

var fs = require("fs");
var vm = require("vm");
var path = require("path");

/* =============================================================================
 * 1) 最小 DOM mock
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
  this.value = "";
  this.type = "";
  this.disabled = false;
  this.hidden = false;
  var self = this;
  this.classList = {
    _list: function () { return String(self.className || "").split(/\s+/).filter(Boolean); },
    add: function (c) { var a = this._list(); if (a.indexOf(c) < 0) { a.push(c); self.className = a.join(" "); } },
    remove: function (c) { self.className = this._list().filter(function (x) { return x !== c; }).join(" "); },
    contains: function (c) { return this._list().indexOf(c) >= 0; },
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
Object.defineProperty(MockNode.prototype, "firstChild", { get: function () { return this.childNodes[0] || null; } });
MockNode.prototype.appendChild = function (c) { if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; };
MockNode.prototype.removeChild = function (c) { var i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; };
MockNode.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
MockNode.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; };
MockNode.prototype.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); };
MockNode.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
MockNode.prototype.focus = function () {};
MockNode.prototype.querySelector = function (s) { return qsa(this, s)[0] || null; };
MockNode.prototype.querySelectorAll = function (s) { return qsa(this, s); };
MockNode.prototype.closest = function (s) {
  var c = parseCompound(String(s).trim()), cur = this;
  while (cur && cur.tagName) { if (matchCompound(cur, c)) return cur; cur = cur.parentNode; }
  return null;
};

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
function matchCompound(n, c) {
  if (!n || !n.tagName) return false;
  if (c.tag && n.tagName !== c.tag) return false;
  if (c.id && n.getAttribute("id") !== c.id) return false;
  for (var i = 0; i < c.classes.length; i++) if (!n.classList.contains(c.classes[i])) return false;
  for (var j = 0; j < c.attrs.length; j++) {
    var a = c.attrs[j], got = n.getAttribute(a.name);
    if (a.value === null) { if (got == null) return false; }
    else if (String(got) !== a.value) return false;
  }
  return true;
}
function allDesc(n, acc) { (n.childNodes || []).forEach(function (ch) { if (ch && ch.tagName) { acc.push(ch); allDesc(ch, acc); } }); return acc; }
function qsa(root, sel) {
  var cs = String(sel).trim().split(/\s+/).map(parseCompound);
  var last = cs[cs.length - 1], anc = cs.slice(0, -1);
  var cands = allDesc(root, []).filter(function (n) { return matchCompound(n, last); });
  if (!anc.length) return cands;
  return cands.filter(function (n) {
    var i = anc.length - 1, p = n.parentNode;
    while (p && i >= 0) { if (matchCompound(p, anc[i])) i--; p = p.parentNode; }
    return i < 0;
  });
}

function makeDocument() {
  var doc = {
    nodeType: 9, readyState: "complete", _byId: {}, _listeners: {}, childNodes: [],
    hidden: false,
    createElement: function (t) { return new MockNode(t); },
    createTextNode: function (t) { return { nodeType: 3, textContent: String(t == null ? "" : t), parentNode: null }; },
    getElementById: function (id) { return Object.prototype.hasOwnProperty.call(this._byId, id) ? this._byId[id] : null; },
    addEventListener: function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    querySelector: function (s) { return qsa(this, s)[0] || null; },
    querySelectorAll: function (s) { return qsa(this, s); },
  };
  var body = new MockNode("body");
  body.parentNode = doc; doc.body = body; doc.childNodes = [body];
  return doc;
}

/* =============================================================================
 * 2) globals + seams
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

var confirmCalls = [], confirmReturn = true;
global.confirm = function (m) { confirmCalls.push(String(m)); return confirmReturn; };
window.confirm = global.confirm;

var intervals = [];   // 錄下每一個 setInterval(callback, ms) —— 用來檢查 hidden 護欄
global.setInterval = function (fn, ms) { intervals.push({ fn: fn, ms: ms }); return intervals.length; };
global.clearInterval = function () {};

var JS_DIR = path.join(__dirname, "..", "assets", "js");
function load(n) { var p = path.join(JS_DIR, n); vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p }); }
load("config.js"); load("logic.js"); load("airtable.js"); load("render.js");

localStorage.setItem(QJ.LS.proxyToken, "test-proxy-token");
QJ.auth = { ensure: function () { return true; }, getCreds: function () { return { baseId: "appTEST", tableId: "tblTEST" }; }, clear: function () {}, renderSetupGate: function () {} };

/* 預約 seam:fetchBookings 回可控資料;bookingAction 錄音 + 可控 promise */
var bkFetchCalls = 0, bkFetchData = null;
var bkActionCalls = [];         // {uid, action}
var bkActionCtl = null;         // {resolve, reject} — 手動決定何時完成
var toastCalls = [];

QJ.airtable = QJ.airtable || {};
QJ.airtable.detectSchema = function () { return Promise.resolve({ fields: [], fieldMap: {} }); };
QJ.airtable.fetchRecords = function () { return Promise.resolve([]); };
QJ.airtable.cta = function () { return Promise.resolve(); };
QJ.airtable.fetchBookings = function () { bkFetchCalls += 1; return Promise.resolve(bkFetchData); };
QJ.airtable.bookingAction = function (uid, action) {
  bkActionCalls.push({ uid: uid, action: action });
  return new Promise(function (res, rej) { bkActionCtl = { resolve: res, reject: rej }; });
};
/* fetchStaff 走真 fetch(/staff)—— 在 harness 裡會掛住整條 boot 鏈,拔掉它
   等同 boot 的 staffStep = Promise.resolve()。 */
delete QJ.airtable.fetchStaff;
delete QJ.airtable.fetchStats;
delete QJ.airtable.fetchCloseReview;
delete QJ.airtable.fetchReturnedUids;
QJ.logic.analyze = function () { return { summary: {}, kpis: {}, actions: [], slices: { types: [], owners: [], statuses: [] }, queue: [], deal: {}, team: [] }; };
QJ.render.toast = function (m, k) { toastCalls.push({ m: m, k: k }); };

/* #booking-panel 必須存在,否則 refreshBookings 拿到 null host */
var HOST = new MockNode("section");
HOST.setAttribute("id", "booking-panel");
HOST.className = "booking-panel";
HOST.hidden = true;
DOC.body.appendChild(HOST);
DOC._byId["booking-panel"] = HOST;

DOC.readyState = "complete";
load("app.js");   // boot() 觸發

/* =============================================================================
 * 3) harness
 * ========================================================================== */
var FAILS = [], PASS = 0, XFAILS = [], FETCH_AT_CLICK = 0;
function check(n, c, d) {
  if (c) { PASS += 1; console.log("  ✓ " + n); }
  else { FAILS.push(n); console.log("  ✗ " + n + (d !== undefined ? "  " + safe(d) : "")); }
}
function xfail(n, c, d) {
  if (c) { PASS += 1; console.log("  🎉 XPASS(缺口似乎已補 → 請把 xfail 改成 check)— " + n); }
  else { XFAILS.push(n); console.log("  ⚠️ KNOWN-GAP " + n + (d !== undefined ? "  " + safe(d) : "")); }
}
function safe(v) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
function section(t) { console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72)); }
function fire(type, target) {
  (DOC._listeners[type] || []).forEach(function (fn) {
    fn({ target: target, type: type, preventDefault: function () {}, stopPropagation: function () {} });
  });
}
function reset() { confirmCalls.length = 0; confirmReturn = true; toastCalls.length = 0; bkActionCalls.length = 0; bkActionCtl = null; }
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
/* boot() 是 promise 鏈(staffStep → detectSchema → refresh → 註冊計時器),
   同步斷言會在鏈跑完前就執行 —— 先把 microtask 佇列抽乾。 */
function settle(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 6); i++) p = p.then(tick);
  return p;
}

/* fixtures */
function PEND(o) {
  return Object.assign({ booking_uid: "bkA", status: "pending", name: "王待確認",
    slot: "9/5（五）10:00", start: "2026-09-05T02:00:00Z", mode: "到所",
    waited_h: 30.2, until_h: 12.5, matched: false, phone: "", notes: "", nudges: 0 }, o || {});
}
function CONF(o) {
  return Object.assign({ booking_uid: "bkB", status: "confirmed", name: "陳已確認",
    slot: "9/6（六）14:00", start: "2026-09-06T06:00:00Z", mode: "電話",
    waited_h: 2.0, until_h: 40.0, matched: true, phone: "", notes: "", nudges: 0 }, o || {});
}
function render(data) { QJ.render.renderBookings(HOST, data); return HOST; }
function btn(host, action) { return host.querySelector('[data-bk-action="' + action + '"]'); }

/* =============================================================================
 * 4) tests
 * ========================================================================== */
function testWiring() {
  section("W — app.js ↔ airtable.js 接線");
  check("W1 boot() 期間呼叫過 fetchBookings(面板真的被接上輪詢鏈)", bkFetchCalls >= 1, bkFetchCalls);
  check("W2 註冊了 document click 監聽器", (DOC._listeners.click || []).length > 0);

  /* 120 秒 proxy 計時器 vs 25 秒紀錄輪詢 —— 兩者的 hidden 護欄不一致 */
  var appSrc = fs.readFileSync(path.join(JS_DIR, "app.js"), "utf8");
  var poll25 = /function startPolling\(\)[\s\S]*?document\.hidden/.test(appSrc);
  check("W3 25 秒紀錄輪詢有 document.hidden 護欄(既有行為)", poll25);
  var t120 = intervals.filter(function (i) { return i.ms === 120000; });
  check("W4 120 秒 proxy 計時器存在", t120.length === 1, intervals.map(function (i) { return i.ms; }));
  var body120 = t120.length ? String(t120[0].fn) : "";
  check("W5 120 秒計時器裡確實有 refreshBookings", /refreshBookings/.test(body120), body120);
  xfail("W6 120 秒計時器應有 document.hidden 護欄 —— 實測沒有" +
        "(分頁切到背景仍每 2 分鐘打 /booking-panel;25 秒那條有護欄,這條沒有)",
        /document\.hidden/.test(body120), body120.slice(0, 160));

  /* 取數失敗 → 顯示,不是隱藏 */
  render(null);
  check("W7 取數失敗(null)→ host 不隱藏 + 顯示 .bk-err 說明行" +
        "(「隱藏」與「壞掉」必須分得出來)",
        HOST.hidden === false && !!HOST.querySelector(".bk-err"), HOST.hidden);
  check("W8 錯誤行指向 LINE 確認卡這條退路(不是死路一條)",
        /LINE/.test(HOST.querySelector(".bk-err").textContent), HOST.querySelector(".bk-err").textContent);
  render(undefined);
  check("W9 undefined 與 null 同樣走錯誤行(fetch 契約回 null,但別人可能回 undefined)",
        !!HOST.querySelector(".bk-err"));
  render({ ok: true, pending: [], confirmed: [] });
  check("W10 0 筆 → 整區隱藏(常駐空白區會被眼睛學會跳過)",
        HOST.hidden === true && HOST.childNodes.length === 0, HOST.hidden);
}

function testRender() {
  section("R — 渲染契約");
  var h = render({ ok: true, pending: [PEND()], confirmed: [CONF()] });
  check("R1 pending 列渲染 確認預約 + 婉拒 兩顆",
        !!btn(h, "confirm") && !!btn(h, "decline"));
  var pendRow = h.querySelector(".bk-row.bk-pend");
  check("R2 pending 列**沒有**取消預約(取消的語意是『已確認的會議』)",
        !pendRow.querySelector('[data-bk-action="cancel"]'));
  var confRow = h.querySelector(".bk-row.bk-conf");
  check("R3 confirmed 列只有 取消預約,沒有 確認/婉拒",
        !!confRow.querySelector('[data-bk-action="cancel"]')
        && !confRow.querySelector('[data-bk-action="confirm"]')
        && !confRow.querySelector('[data-bk-action="decline"]'));
  check("R4 ⭐ confirmed 的按鈕字是「取消預約」不是「婉拒」" +
        "—— 操作者按下去的字必須和客戶讀到的字對得上(客戶收到的是「您的預約已取消」)",
        confRow.querySelector('[data-bk-action="cancel"]').textContent === "取消預約",
        confRow.querySelector('[data-bk-action="cancel"]').textContent);

  var b = btn(h, "confirm");
  check("R5 按鈕帶齊 data-bk-action/uid/name/slot(app.js 的二次確認文案靠它們)",
        b.getAttribute("data-bk-uid") === "bkA" && b.getAttribute("data-bk-name") === "王待確認"
        && b.getAttribute("data-bk-slot") === "9/5（五）10:00",
        [b.getAttribute("data-bk-uid"), b.getAttribute("data-bk-name"), b.getAttribute("data-bk-slot")]);
  check("R6 按鈕 type=button(在 form 內不會誤送出)", b.type === "button", b.type);

  /* chip 只在有訊號時出現 */
  h = render({ pending: [PEND({ nudges: 0, matched: true })], confirmed: [] });
  check("R7 nudges=0 不渲染催辦 chip(每筆必然有 1 次申請卡,寫出來是純噪音)",
        h.textContent.indexOf("已在 LINE 提醒") < 0, h.textContent);
  h = render({ pending: [PEND({ nudges: 2, matched: true })], confirmed: [] });
  check("R8 nudges=2 → 渲染「已在 LINE 提醒 2 次」",
        h.textContent.indexOf("已在 LINE 提醒 2 次") >= 0);
  check("R9 matched=true 不渲染「尚未連結客戶紀錄」", h.textContent.indexOf("尚未連結") < 0);
  h = render({ pending: [PEND({ matched: false })], confirmed: [] });
  check("R10 matched=false 才渲染「尚未連結客戶紀錄」", h.textContent.indexOf("尚未連結") >= 0);

  /* 電話 */
  h = render({ pending: [PEND({ phone: "0912-345 678" })], confirmed: [] });
  var tel = h.querySelector(".bk-tel");
  check("R11 phone → tel: 連結,href 只留數字與 +(不把使用者輸入原樣塞進 URL)",
        tel && tel.href === "tel:0912345678", tel && tel.href);
  h = render({ pending: [PEND({ phone: "" })], confirmed: [] });
  check("R12 phone 空字串不渲染撥號 chip", !h.querySelector(".bk-tel"));

  /* 敵意輸入:name/notes 都是客戶在 cal 表單自填的字 */
  var evil = '<img src=x onerror="globalThis.__XSS=1">';
  h = render({ pending: [PEND({ name: evil, notes: evil })], confirmed: [] });
  check("R13 ⭐ 客戶自填的 name/notes 走 textContent(零 element 子節點 = 沒被當標記解析)",
        h.querySelector(".bk-name").childNodes.length === 0
        && h.querySelector(".bk-name").textContent === evil
        && global.__XSS === undefined,
        h.querySelector(".bk-name").childNodes.length);
  check("R14 備註以「客戶備註：」前綴渲染(不與系統文字混淆)",
        /^客戶備註：/.test(h.querySelector(".bk-note").textContent));

  /* 標題依賴後端排序 */
  h = render({ pending: [PEND({ booking_uid: "b1", slot: "第一筆", until_h: 3 }),
                         PEND({ booking_uid: "b2", slot: "第二筆", until_h: 90 })],
               confirmed: [] });
  check("R15 標題的「最近一筆」直接取 pending[0](排序責任在後端 → WR4.15 那條是它的對邊)",
        h.querySelector(".bk-head").textContent.indexOf("第一筆") >= 0,
        h.querySelector(".bk-head").textContent);
  check("R16 until_h < 24 → 標題用急迫措辭「就在」", h.querySelector(".bk-head").textContent.indexOf("就在") >= 0);
  h = render({ pending: [PEND({ until_h: 90, slot: "很久以後" })], confirmed: [] });
  check("R17 until_h ≥ 24 → 不用急迫措辭", h.querySelector(".bk-head").textContent.indexOf("就在") < 0);

  /* class 加了但 CSS 沒有 = 看不出差別 */
  var css = fs.readFileSync(path.join(__dirname, "..", "assets", "css", "styles.css"), "utf8");
  var need = ["booking-panel", "bk-head", "bk-head2", "bk-sub", "bk-err", "bk-row",
              "bk-pend", "bk-conf", "bk-main", "bk-name", "bk-slot", "bk-mode",
              "bk-meta", "bk-chip", "bk-tel", "bk-note", "bk-acts"];
  var missing = need.filter(function (c) { return !(new RegExp("\\." + c + "\\b")).test(css); });
  check("R18 render 用到的每個 class 在 styles.css 都有定義(class 加了卻沒樣式 = 沒分流)",
        missing.length === 0, missing);
  check("R19 ⭐ pending/confirmed 用左緣色帶,**不**沿用 .row-new 朱色" +
        "(朱色的既定語意是「新客戶進線」—— 已結案回訊那次的教訓)",
        // 2026-08-31:原本只認 `border-left-color`,但 `border-left: 6px solid
        // var(--warn)` 一次寫全是達到同一效果的合法寫法(而且那正是既有
        // .cta-row.kind-pending 的寫法)。判定式要對得上不變量 ——「有沒有用
        // 左緣色帶分辨類別」,不是「有沒有用某個特定 CSS 屬性名」。
        !/\.bk-(row|pend|conf)[^{]*\{[^}]*row-new/.test(css)
        && /\.bk-row\.bk-pend\s*\{[^}]*border-left(-color)?\s*:/.test(css)
        && /\.bk-row\.bk-conf\s*\{[^}]*border-left(-color)?\s*:/.test(css));

  var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  check("R20 index.html 有 #booking-panel 且預設 hidden(首屏不閃一塊空白)",
        /id="booking-panel"[^>]*hidden/.test(html));
}

function testClick() {
  section("C — 按鈕互動 / 二次確認 / 錯誤處理");
  render({ pending: [PEND()], confirmed: [CONF()] });

  /* 攔截順序:預約按鈕必須先於 data-cta */
  reset();
  var dual = DOC.createElement("button");
  dual.setAttribute("data-bk-action", "confirm");
  dual.setAttribute("data-bk-uid", "bkA");
  dual.setAttribute("data-cta", "close");        // 同時帶兩種屬性
  dual.setAttribute("data-id", "recXX");
  HOST.appendChild(dual);
  confirmReturn = false;
  fire("click", dual);
  check("C1 ⭐ 同時帶 data-bk-action 與 data-cta 的按鈕走**預約**路徑" +
        "(onClick 先攔預約 —— 預約的鍵是 booking_uid,不是 Airtable recordId)",
        confirmCalls.length === 1 && /預約/.test(confirmCalls[0]), confirmCalls);
  HOST.removeChild(dual);

  /* 三個動作都要二次確認,取消時不發請求 */
  ["confirm", "decline", "cancel"].forEach(function (act) {
    reset();
    render({ pending: [PEND()], confirmed: [CONF()] });
    confirmReturn = false;
    fire("click", btn(HOST, act));
    check("C2." + act + " 有 window.confirm 且使用者取消時**不**發請求",
          confirmCalls.length === 1 && bkActionCalls.length === 0,
          [confirmCalls.length, bkActionCalls.length]);
  });

  reset();
  render({ pending: [], confirmed: [CONF()] });
  confirmReturn = false;
  fire("click", btn(HOST, "cancel"));
  check("C3 ⭐ 取消已確認預約的二次確認文案要說明「客戶先前已收到確認通知」" +
        "(這是不可逆且客戶可見的動作,不能和婉拒同一句話)",
        /先前已收到確認/.test(confirmCalls[0] || ""), confirmCalls[0]);
  check("C4 婉拒/取消的文案分別對應客戶端會讀到的字",
        /取消/.test(confirmCalls[0] || ""), confirmCalls[0]);

  /* 樂觀更新:不可以有 */
  reset();
  render({ pending: [PEND()], confirmed: [] });
  var b = btn(HOST, "confirm");
  var beforeText = HOST.textContent;
  confirmReturn = true;
  FETCH_AT_CLICK = bkFetchCalls;
  fire("click", b);
  check("C5 送出後按鈕 disabled(擋住同一顆按鈕的連點)", b.disabled === true);
  check("C6 ⭐ **零樂觀更新** —— 伺服器回來前列的內容一字未改" +
        "(確認有兩層可獨立失敗:cal.com 回寫 + 客戶推播;先顯示成功會說謊)",
        HOST.textContent === beforeText, [beforeText.slice(0, 40), HOST.textContent.slice(0, 40)]);
  check("C7 送出後尚未 toast(等伺服器真相)", toastCalls.length === 0, toastCalls);
  return b;
}

function testAsync(b) {
  section("A — 伺服器回應處理(逐字轉達 dispatcher)");
  /* 成功 + changed */
  bkActionCtl.resolve({ ok: true, changed: true, message: "✅ 已確認「王待確認」的預約 9/5 到所，已通知客戶" });
  return tick().then(function () {
    check("A1 changed=true → toast 帶 ✓ 且 kind=ok",
          toastCalls.length === 1 && toastCalls[0].k === "ok" && /^✓ /.test(toastCalls[0].m), toastCalls);
    check("A2 ⭐ 逐字轉達 dispatcher 的話(它把四種通知結果說得比任何 UI 文案都準)",
          toastCalls[0].m.indexOf("已通知客戶") >= 0, toastCalls[0].m);
    check("A3 成功後重新取數(不靠樂觀更新,靠重新整理)",
          bkFetchCalls > FETCH_AT_CLICK, [FETCH_AT_CLICK, bkFetchCalls]);

    /* changed=false —— 不能顯示成功勾 */
    reset();
    render({ pending: [PEND()], confirmed: [] });
    fire("click", btn(HOST, "confirm"));
    bkActionCtl.resolve({ ok: true, changed: false, message: "ℹ️ 「王待確認」的預約先前已確認，未重複通知客戶" });
    return tick();
  }).then(function () {
    check("A4 ⭐ changed=false → kind=info 且**不**加 ✓" +
          "(狀態沒變卻打勾 = 對操作者說謊)",
          toastCalls.length === 1 && toastCalls[0].k === "info" && !/^✓/.test(toastCalls[0].m), toastCalls);

    /* HTTP 失敗 */
    reset();
    render({ pending: [PEND()], confirmed: [] });
    var bb = btn(HOST, "confirm");
    fire("click", bb);
    var err = new Error("forbidden"); err.status = 403;
    bkActionCtl.reject(err);
    return tick().then(function () { return { bb: bb }; });
  }).then(function (ctx) {
    check("A5 HTTP 失敗 → 按鈕回復可按(可重試)", ctx.bb.disabled === false);
    check("A6 HTTP 失敗 → kind=danger 且帶狀態碼", toastCalls[0].k === "danger" && /403/.test(toastCalls[0].m), toastCalls);
    check("A7 ⭐ HTTP 失敗的文案明說「客戶沒有收到任何訊息」" +
          "(這是操作者最需要知道的一件事)", /客戶沒有收到/.test(toastCalls[0].m), toastCalls[0].m);

    /* 網路失敗(無 status)—— 必須是**不同**的話 */
    reset();
    render({ pending: [PEND()], confirmed: [] });
    fire("click", btn(HOST, "confirm"));
    bkActionCtl.reject(new Error("network down"));
    return tick();
  }).then(function () {
    check("A8 ⭐ 網路失敗(拿不到 status)→ 說「無法確定是否已送出」,不謊稱沒送出" +
          "(請求可能已抵達伺服器並已執行)",
          /無法確定/.test(toastCalls[0].m) && !/客戶沒有收到/.test(toastCalls[0].m), toastCalls[0].m);
    check("A9 網路失敗 kind=warn(與 HTTP 失敗的 danger 分級)", toastCalls[0].k === "warn", toastCalls[0].k);
  });
}

function testRace() {
  section("RACE — 120 秒輪詢 vs 進行中的按鈕(qa 2026-08-31 點名的競態)");
  reset();
  render({ pending: [PEND()], confirmed: [] });
  var b1 = btn(HOST, "confirm");
  fire("click", b1);
  check("RACE1 動作進行中,原按鈕 disabled", b1.disabled === true && bkActionCalls.length === 1);

  /* 輪詢在 in-flight 時抵達 → renderBookings 先 clear(host) 再重建整區 */
  render({ pending: [PEND()], confirmed: [] });
  var b2 = btn(HOST, "confirm");
  check("RACE2 輪詢重繪後,原按鈕已不在面板內(renderBookings 先 clear(host) 再整區重建)",
        b2 !== b1 && HOST.querySelectorAll('[data-bk-action="confirm"]').indexOf(b1) < 0,
        { same: b2 === b1, count: HOST.querySelectorAll('[data-bk-action="confirm"]').length });
  xfail("RACE3 ⭐ 重繪後的新按鈕**應**仍為 disabled(同一 buid 有動作在途)" +
        " —— 實測是全新 enabled 按鈕:disabled 狀態只在 DOM 節點上,不在任何 in-flight 狀態裡",
        b2.disabled === true, b2.disabled);

  var before = bkActionCalls.length;
  confirmReturn = true;
  fire("click", b2);
  xfail("RACE4 ⭐⭐ 對同一 booking_uid **不應**能發出第二次請求 —— 實測會" +
        "(後端也沒有 per-buid 鎖 → 兩個子行程同時跑 dispatcher;" +
        "客戶推播由 push_once 擋住不會雙發,但 cal.com 會被打兩次、操作者會收到互相矛盾的 toast)",
        bkActionCalls.length === before,
        { before: before, after: bkActionCalls.length, calls: bkActionCalls });

  /* 動作進行中若輪詢把該筆整個移除(別人先處理掉了),不得炸掉 */
  reset();
  render({ pending: [PEND()], confirmed: [] });
  var b3 = btn(HOST, "confirm");
  fire("click", b3);
  render({ pending: [], confirmed: [] });     // 該筆消失
  var threw = false;
  try { bkActionCtl.reject(Object.assign(new Error("x"), { status: 404 })); } catch (e) { threw = true; }
  return tick().then(function () {
    check("RACE5 動作在途時該筆從清單消失 → 錯誤處理不 throw(btn 已脫離 DOM,設 disabled 是無害 no-op)",
          !threw && toastCalls.length === 1, [threw, toastCalls]);
  });
}

/* =============================================================================
 * 5) 突變驗證
 * ========================================================================== */
function mutate(name, apply, restore, assertFn) {
  apply();
  var red;
  try { red = !assertFn(); } catch (e) { red = true; }
  restore();
  var back;
  try { back = assertFn(); } catch (e) { back = false; }
  MUT.push({ name: name, red: red });
  console.log((red ? "  ✓ 突變 " : "  ✗ 突變未變紅 ") + name);
  if (!back) console.log("     ⚠️ restore 後斷言未回綠 —— 這條突變污染了狀態");
  return red;
}
var MUT = [];

function testMutations() {
  section("MUTATION — 把防線拿掉,確認斷言真的會變紅");

  /* M1 — el() 改用 innerHTML(最常見的「順手」寫法)→ R13 XSS 斷言變紅 */
  var realRender = QJ.render.renderBookings;
  function unsafeRender(host, data) {
    while (host.firstChild) host.removeChild(host.firstChild);
    host.hidden = false;
    (data && data.pending || []).forEach(function (r) {
      var row = DOC.createElement("div"); row.className = "bk-row bk-pend";
      var nm = DOC.createElement("span"); nm.className = "bk-name";
      // 模擬 innerHTML:把字串當標記解析 → 產生 element 子節點
      var kid = DOC.createElement("img"); kid.setAttribute("src", "x");
      nm.appendChild(kid);
      row.appendChild(nm); host.appendChild(row);
    });
  }
  mutate("M1 name 改用 innerHTML 路徑(產生 element 子節點)→ R13 應變紅",
    function () { QJ.render.renderBookings = unsafeRender; },
    function () { QJ.render.renderBookings = realRender; },
    function () {
      render({ pending: [PEND({ name: "<img src=x>" })], confirmed: [] });
      var n = HOST.querySelector(".bk-name");
      return n && n.childNodes.length === 0;
    });

  /* M2 — 0 筆時不隱藏 → W10 變紅 */
  mutate("M2 0 筆時不隱藏整區 → W10(空區隱藏)應變紅",
    function () { QJ.render.renderBookings = function (h) { h.hidden = false; }; },
    function () { QJ.render.renderBookings = realRender; },
    function () { render({ pending: [], confirmed: [] }); return HOST.hidden === true; });

  /* M3 — 取數失敗改成靜靜隱藏 → W7 變紅(「隱藏」與「壞掉」混為一談) */
  mutate("M3 取數失敗改成靜靜隱藏 → W7(壞掉要看得出來)應變紅",
    function () { QJ.render.renderBookings = function (h, d) { if (d == null) { h.hidden = true; return; } realRender(h, d); }; },
    function () { QJ.render.renderBookings = realRender; },
    function () { render(null); return HOST.hidden === false && !!HOST.querySelector(".bk-err"); });

  /* M4 — confirmed 列也給婉拒鈕 → R3/R4 變紅 */
  mutate("M4 confirmed 列也渲染婉拒鈕 → R3(語意分離)應變紅",
    function () {
      QJ.render.renderBookings = function (h, d) {
        realRender(h, d);
        var cr = h.querySelector(".bk-row.bk-conf");
        if (cr) { var x = DOC.createElement("button"); x.setAttribute("data-bk-action", "decline"); cr.appendChild(x); }
      };
    },
    function () { QJ.render.renderBookings = realRender; },
    function () {
      var h = render({ pending: [], confirmed: [CONF()] });
      var cr = h.querySelector(".bk-row.bk-conf");
      return !cr.querySelector('[data-bk-action="decline"]');
    });

  /* M5 — 樂觀更新:點擊當下就把列改成「已確認」→ C6 變紅 */
  var realBA = QJ.airtable.bookingAction;
  mutate("M5 加上樂觀更新(點擊當下就改列文字)→ C6(零樂觀更新)應變紅",
    function () {
      QJ.airtable.bookingAction = function (uid, action) {
        var row = HOST.querySelector('.bk-row');
        if (row) row.appendChild(DOC.createElement("span")).textContent = "（已確認）";
        return realBA(uid, action);
      };
    },
    function () { QJ.airtable.bookingAction = realBA; },
    function () {
      reset(); render({ pending: [PEND()], confirmed: [] });
      var before = HOST.textContent;
      confirmReturn = true;
      fire("click", btn(HOST, "confirm"));
      var same = HOST.textContent === before;
      if (bkActionCtl) bkActionCtl.reject(Object.assign(new Error("cleanup"), { status: 1 }));
      return same;
    });

  /* M6b — bkBtn 漏掉 data-bk-uid → R5 變紅。app.js 的 `if (!act || !uid) return`
     會靜默什麼都不做:按鈕看起來正常、按下去毫無反應,是最難察覺的壞法。 */
  mutate("M6b 按鈕漏掉 data-bk-uid → R5(屬性齊全)應變紅",
    function () {
      QJ.render.renderBookings = function (h, d) {
        realRender(h, d);
        h.querySelectorAll("[data-bk-uid]").forEach(function (b) { b.setAttribute("data-bk-uid", ""); });
      };
    },
    function () { QJ.render.renderBookings = realRender; },
    function () {
      var h = render({ pending: [PEND()], confirmed: [] });
      return h.querySelector('[data-bk-action="confirm"]').getAttribute("data-bk-uid") === "bkA";
    });

  /* M6c — tel: href 不消毒 → R11 變紅 */
  mutate("M6c tel: href 直接串原始 phone(不消毒)→ R11 應變紅",
    function () {
      QJ.render.renderBookings = function (h, d) {
        realRender(h, d);
        var a = h.querySelector(".bk-tel");
        if (a) a.href = "tel:" + (((d.pending || [])[0] || {}).phone || "");
      };
    },
    function () { QJ.render.renderBookings = realRender; },
    function () {
      var h = render({ pending: [PEND({ phone: "0912-345 678" })], confirmed: [] });
      var a = h.querySelector(".bk-tel");
      return !!a && a.href === "tel:0912345678";
    });

  /* M6 — 拿掉二次確認 → C2 變紅 */
  var realConfirm = global.confirm;
  mutate("M6 window.confirm 永遠回 true(等同拿掉二次確認)→ C2(取消即不送)應變紅",
    function () { global.confirm = window.confirm = function (m) { confirmCalls.push(String(m)); return true; }; },
    function () { global.confirm = window.confirm = realConfirm; },
    function () {
      reset(); render({ pending: [PEND()], confirmed: [] });
      confirmReturn = false;
      fire("click", btn(HOST, "confirm"));
      var ok = confirmCalls.length === 1 && bkActionCalls.length === 0;
      if (bkActionCtl) bkActionCtl.reject(Object.assign(new Error("cleanup"), { status: 1 }));
      return ok;
    });
}

/* =============================================================================
 * 6) run
 * ========================================================================== */
console.log("=== quanjin-ops 預約面板 — DOM 回歸 ===");
var inflightBtn;
settle(8)                       // 等 boot() 的 promise 鏈跑完(計時器/首次取數都在鏈尾)
  .then(function () {
    testWiring();
    testRender();
    inflightBtn = testClick();
    return testAsync(inflightBtn);
  })
  .then(testRace)
  .then(function () {
    testMutations();
    var red = MUT.filter(function (m) { return m.red; }).length;
    console.log("\n" + "-".repeat(72));
    console.log("突變驗證：" + red + "/" + MUT.length + " 條防線拿掉後確實變紅");
    if (XFAILS.length) {
      console.log("\n⚠️ 已知缺口 " + XFAILS.length + " 條（不計入失敗，待產品側決定）：");
      XFAILS.forEach(function (n) { console.log("   · " + n.split("——")[0].trim().slice(0, 92)); });
    }
    if (FAILS.length || red !== MUT.length) {
      console.log("\nFAILED: " + FAILS.length + " — " + safe(FAILS));
      process.exit(1);
    }
    console.log("\nALL PASS (" + PASS + " checks" + (XFAILS.length ? ", +" + XFAILS.length + " known-gap" : "") + ")");
    process.exit(0);
  })
  .catch(function (e) {
    console.log("HARNESS ERROR: " + (e && e.stack || e));
    process.exit(1);
  });
