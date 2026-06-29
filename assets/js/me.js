/* 同事「我的案件」行動頁。獨立於 admin 戰情室：身分用個人 token（從 bot 的 LINE 連結帶入），
 * 讀取走 proxy /whoami + /my-cases（伺服器端只回自己的案件），動作走 /cta（伺服器端再次授權）。
 * 不碰那把全域 Airtable PAT，也不依賴 admin 的 detectSchema/normalize。 */
(function () {
  "use strict";
  var PROXY = "https://bribe-handwoven-bobbed.ngrok-free.dev";  // 同 config.js，公開、無密
  var LS = "qj.me.token";

  // token：?k=（bot 連結帶入）→ 存起來 → 清掉網址；否則用 localStorage
  try {
    var u = new URL(location.href), qk = u.searchParams.get("k");
    if (qk) { localStorage.setItem(LS, qk); history.replaceState({}, "", location.pathname); }
  } catch (e) {}
  var token = "";
  try { token = localStorage.getItem(LS) || ""; } catch (e) {}

  var head = document.getElementById("me-head");
  var list = document.getElementById("me-list");
  var toastEl = document.getElementById("me-toast");
  var me = null, polling = null;

  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function toast(m, k) { toastEl.textContent = m; toastEl.className = "me-toast " + (k || ""); toastEl.hidden = false; setTimeout(function () { toastEl.hidden = true; }, 2600); }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "Authorization": "Bearer " + token, "ngrok-skip-browser-warning": "1" }, opts.headers || {});
    return fetch(PROXY + path, opts);
  }

  function nameOf(f) { return f["Line 備註名稱"] || f["姓名"] || f["顯示名稱"] || f["LINE顯示名稱"] || "未具名"; }
  function fmtMoney(n) { return "NT$" + Number(n || 0).toLocaleString(); }
  function waitLabel(f) {
    var t = f["最後互動時間"]; if (!t) return "";
    var ms = Date.now() - new Date(t).getTime(); if (isNaN(ms) || ms < 0) return "";
    var h = ms / 3600000;
    return h < 24 ? ("已等 " + Math.round(h) + " 小時") : ("已等 " + Math.round(h / 24) + " 天");
  }

  function gate(msg) {
    if (polling) { clearInterval(polling); polling = null; }
    clear(head); clear(list);
    head.appendChild(el("div", "me-title", "全謹 · 我的案件"));
    list.appendChild(el("p", "me-empty", msg));
  }

  function boot() {
    if (!token) { gate("請從 LINE 點開全謹傳給您的專屬連結進入。"); return; }
    api("/whoami").then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (w) { me = w; load(); startPoll(); })
      .catch(function (s) { gate(s === 401 ? "連結已失效，請向全謹團隊索取新的連結。" : "連線失敗，請稍後再試。"); });
  }

  function renderHead(n) {
    clear(head);
    var row = el("div", "me-hrow");
    row.appendChild(el("div", "me-seal", "全謹"));
    var tx = el("div", "me-htext");
    tx.appendChild(el("div", "me-title", "我的案件"));
    tx.appendChild(el("div", "me-who", (me && me.name ? me.name : "") + "　承辦人員"));
    row.appendChild(tx);
    head.appendChild(row);
    head.appendChild(el("div", "me-count", "進行中 " + n + " 件"));
  }

  function load() {
    api("/my-cases").then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) { render(d.cases || []); })
      .catch(function (s) { if (s === 401) gate("連結已失效，請向全謹團隊索取新的連結。"); else toast("讀取失敗，稍後重試", "danger"); });
  }

  function render(cases) {
    var active = cases.filter(function (c) { return (c.fields["進度狀態"] || "") !== "已完成"; });
    active.sort(function (a, b) { return new Date(a.fields["最後互動時間"] || 0) - new Date(b.fields["最後互動時間"] || 0); });
    renderHead(active.length);
    clear(list);
    if (!active.length) { list.appendChild(el("p", "me-empty", "目前沒有進行中的案件。")); return; }
    active.forEach(function (c) { list.appendChild(card(c)); });
  }

  function btn(txt, kind, fn) { var b = el("button", "me-btn me-" + kind, txt); b.addEventListener("click", fn); return b; }

  function card(c) {
    var f = c.fields, li = el("div", "me-card"); li.setAttribute("data-id", c.id);
    var l1 = el("div", "me-l1");
    l1.appendChild(el("span", "me-name", nameOf(f)));
    var amt = f["成交金額"];
    if (amt != null && amt !== "" && Number(amt) > 0) l1.appendChild(el("span", "me-amt", fmtMoney(amt)));
    li.appendChild(l1);
    var l2 = el("div", "me-l2");
    l2.appendChild(el("span", "me-type", f["案件類型"] || "未分類"));
    var w = waitLabel(f); if (w) l2.appendChild(el("span", "me-wait", w));
    li.appendChild(l2);
    var acts = el("div", "me-acts");
    acts.appendChild(btn("已聯繫", "ink", function () { doCta(c.id, { action: "contacted", recordId: c.id }, "已記錄聯繫"); }));
    acts.appendChild(btn("結案", "accent", function () { openClose(li, c.id); }));
    li.appendChild(acts);
    return li;
  }

  function openClose(li, id) {
    var existing = li.querySelector(".me-chooser");
    if (existing) { existing.remove(); return; }   // toggle
    var ch = el("div", "me-chooser");
    ch.appendChild(el("span", "me-ch-q", "本案結果？"));
    ch.appendChild(btn("成交（填金額）", "ok", function () {
      var v = window.prompt("成交金額（數字）：", "");
      if (v == null) return;
      var nn = parseInt(String(v).replace(/[^0-9]/g, ""), 10);
      if (!(nn > 0)) { toast("請輸入大於 0 的金額", "warn"); return; }
      doCta(id, { action: "close", recordId: id, amount: nn }, "已結案：成交 " + fmtMoney(nn));
    }));
    ch.appendChild(btn("未成交", "ink", function () {
      doCta(id, { action: "close", recordId: id, amount: 0 }, "已結案：未成交");
    }));
    li.appendChild(ch);
  }

  function doCta(id, body, okMsg) {
    api("/cta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) { toast("✓ " + okMsg, "ok"); load(); }
        else { toast((res.j && res.j.error) || "操作失敗，請重試", "danger"); }
      })
      .catch(function () { toast("連線失敗，請重試", "danger"); });
  }

  function startPoll() {
    if (polling) clearInterval(polling);
    polling = setInterval(function () {
      if (!document.hidden && !list.querySelector(".me-chooser")) load();
    }, 30000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
