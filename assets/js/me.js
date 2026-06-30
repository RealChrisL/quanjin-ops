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

  function idleHours(f) {
    var t = f["最後互動時間"]; if (!t) return 9999;   // 從未互動 → 視為最該跟進
    var ms = Date.now() - new Date(t).getTime();
    return (isNaN(ms) || ms < 0) ? 0 : ms / 3600000;
  }
  // 待辦門檻依狀態:跟進中(智能助手在跑、客戶在等)較急 24h;人工接管中(同仁自己在 OA/電話辦)
  // 給較長緩衝 72h——否則辦理中的案子每天都被標紅,反而被無視。
  function todoHours(f) { return (f["進度狀態"] === "人工接管中") ? 72 : 24; }
  function isTodo(f) { return idleHours(f) >= todoHours(f); }

  function renderHead(n, todoN) {
    clear(head);
    var row = el("div", "me-hrow");
    row.appendChild(el("div", "me-seal", "全謹"));
    var tx = el("div", "me-htext");
    tx.appendChild(el("div", "me-title", "我的案件"));
    tx.appendChild(el("div", "me-who", (me && me.name ? me.name : "") + "　承辦人員"));
    row.appendChild(tx);
    head.appendChild(row);
    var cnt = "進行中 " + n + " 件";
    if (todoN) cnt += "　·　待辦 " + todoN + " 件";
    head.appendChild(el("div", "me-count", cnt));
  }

  function load() {
    api("/my-cases").then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) { render(d.cases || []); })
      .catch(function (s) { if (s === 401) gate("連結已失效，請向全謹團隊索取新的連結。"); else toast("讀取失敗，稍後重試", "danger"); });
  }

  function render(cases) {
    var active = cases.filter(function (c) { return (c.fields["進度狀態"] || "") !== "已完成"; });
    var closed = cases.filter(function (c) { return (c.fields["進度狀態"] || "") === "已完成" && c.fields["結案日期"]; });
    active.sort(function (a, b) { return idleHours(b.fields) - idleHours(a.fields); });  // 最久沒動的在上
    var todo = active.filter(function (c) { return isTodo(c.fields); });
    var rest = active.filter(function (c) { return !isTodo(c.fields); });
    renderHead(active.length, todo.length);
    clear(list);

    // 壹 · 本日待辦行動（超過一天未互動 → 優先跟進或結案）
    list.appendChild(section("本日待辦行動", todo.length ? (todo.length + " 件待跟進") : ""));
    if (todo.length) todo.forEach(function (c) { list.appendChild(card(c, true)); });
    else list.appendChild(el("p", "me-done", active.length ? "✓ 本日待辦已清空——所有案件近一日內都有進度。" : "✓ 目前沒有待辦案件。"));

    // 貳 · 其他進行中
    if (rest.length) {
      list.appendChild(section("其他進行中", rest.length + " 件"));
      rest.forEach(function (c) { list.appendChild(card(c, false)); });
    }

    // 參 · 已結案（複核——可補登／更正成交金額）
    if (closed.length) {
      closed.sort(function (a, b) { return String(b.fields["結案日期"] || "").localeCompare(String(a.fields["結案日期"] || "")); });
      list.appendChild(section("已結案（可複核）", closed.length + " 件"));
      closed.forEach(function (c) { list.appendChild(closedCard(c)); });
    }
  }

  function closedCard(c) {
    var f = c.fields, li = el("div", "me-card me-closed"); li.setAttribute("data-id", c.id);
    var l1 = el("div", "me-l1");
    l1.appendChild(el("span", "me-name", nameOf(f)));
    var amt = f["成交金額"], n = (amt == null || amt === "") ? null : Number(amt), badge;
    if (n != null && n > 0) badge = el("span", "me-out me-won", "成交 " + fmtMoney(n));
    else if (n === 0) badge = el("span", "me-out me-lost", "未成交");
    else badge = el("span", "me-out me-pend", "結果待補");
    l1.appendChild(badge);
    li.appendChild(l1);
    var cd = f["結案日期"];
    li.appendChild(el("div", "me-l2", (f["案件類型"] || "未分類") + (cd ? "・" + String(cd).slice(5) + " 結案" : "")));
    var acts = el("div", "me-acts");
    acts.appendChild(btn("修正結果", "ink", function () { openClose(li, c.id); }));
    li.appendChild(acts);
    li.appendChild(el("div", "me-hint", "修正結果＝補登或更正本案的成交金額／未成交"));
    return li;
  }

  function section(title, sub) {
    var s = el("div", "me-sec");
    s.appendChild(el("span", "me-sec-t", title));
    if (sub) s.appendChild(el("span", "me-sec-s", sub));
    return s;
  }

  function btn(txt, kind, fn) { var b = el("button", "me-btn me-" + kind, txt); b.addEventListener("click", fn); return b; }

  function card(c, isTodo) {
    var f = c.fields, li = el("div", "me-card" + (isTodo ? " is-todo" : "")); li.setAttribute("data-id", c.id);
    var l1 = el("div", "me-l1");
    l1.appendChild(el("span", "me-name", nameOf(f)));
    var amt = f["成交金額"];
    if (amt != null && amt !== "" && Number(amt) > 0) l1.appendChild(el("span", "me-amt", fmtMoney(amt)));
    li.appendChild(l1);
    var l2 = el("div", "me-l2");
    l2.appendChild(el("span", "me-type", f["案件類型"] || "未分類"));
    var w = waitLabel(f);
    if (w) l2.appendChild(el("span", isTodo ? "me-wait me-overdue" : "me-wait", w + (isTodo ? "・未更新" : "")));
    li.appendChild(l2);
    var acts = el("div", "me-acts");
    acts.appendChild(btn("已聯繫", "ink", function () { doCta(c.id, { action: "contacted", recordId: c.id }, "已記錄聯繫"); }));
    acts.appendChild(btn("結案", "accent", function () { openClose(li, c.id); }));
    li.appendChild(acts);
    li.appendChild(el("div", "me-hint", "已聯繫＝已電話／OA 聯繫過先記錄　·　結案＝案件辦完，登記成交／未成交"));
    return li;
  }

  function openClose(li, id) {
    var existing = li.querySelector(".me-chooser");
    if (existing) { existing.remove(); return; }   // toggle
    var ch = el("div", "me-chooser");
    ch.appendChild(el("span", "me-ch-q", "本案結果？"));
    ch.appendChild(btn("成交（填金額）", "ok", function () { amountForm(ch, id); }));
    ch.appendChild(btn("未成交", "ink", function () {
      doCta(id, { action: "close", recordId: id, amount: 0 }, "已結案：未成交");
    }));
    li.appendChild(ch);
  }

  // #3:頁內數字輸入(取代 window.prompt)——鍵盤在頁面內展開、不蓋畫面,輸入的數字看得到再確認。
  function amountForm(ch, id) {
    clear(ch);
    ch.appendChild(el("span", "me-ch-q", "成交金額（數字）"));
    var inp = el("input", "me-amt-input");
    inp.type = "number"; inp.setAttribute("inputmode", "numeric"); inp.placeholder = "例如 25000"; inp.min = "1";
    ch.appendChild(inp);
    var row = el("div", "me-amt-row");
    row.appendChild(btn("確認登記", "ok", function () {
      var n = parseInt(String(inp.value || "").replace(/[^0-9]/g, ""), 10);
      if (!(n > 0)) { toast("請輸入大於 0 的金額", "warn"); inp.focus(); return; }
      doCta(id, { action: "close", recordId: id, amount: n }, "已結案：成交 " + fmtMoney(n));
    }));
    row.appendChild(btn("取消", "ink", function () { ch.remove(); }));
    ch.appendChild(row);
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 50);
  }

  function doCta(id, body, okMsg) {
    api("/cta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) {
          toast("✓ " + okMsg, "ok");
          // 樂觀移除這張卡 → 同事立刻看到「動作成功」,不必等伺服器全表重抓;
          // 30 秒後的輪詢會以伺服器真相重繪(已結案進已結案區、已聯繫的回進行中區)。
          var card = list.querySelector('[data-id="' + id + '"]');
          if (card && card.parentNode) card.parentNode.removeChild(card);
        } else { toast((res.j && res.j.error) || "操作失敗，請重試", "danger"); }
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
