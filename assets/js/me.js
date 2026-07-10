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
  var meClients = document.getElementById("me-clients");
  var me = null, polling = null;
  // 全所客戶清單（admin/developer 專屬）狀態
  var allClients = [], roster = [], clientSearch = "", clientStatus = "all",
      clientShown = 30, clientListEl = null;
  // 本日待辦行動（戰情室同款：待回=上班時段逾4h、逾期=實際逾24h）＋總結橫幅
  var todoOwner = "all", todoShown = 30, todoListEl = null, bannerEl = null,
      ownerSelEl = null, todoSubEl = null;

  function isAdmin() { return !!(me && (me.role === "admin" || me.role === "developer")); }

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
  // 本地(非 UTC)日期字串 YYYY-MM-DD，offsetDays 天後——date input 的 min/max 用；
  // 用 toISOString 會在接近午夜時差一天(它是 UTC)。
  function localISO(offsetDays) {
    var d = new Date(); d.setDate(d.getDate() + offsetDays);
    var mo = d.getMonth() + 1, dy = d.getDate();
    return d.getFullYear() + "-" + (mo < 10 ? "0" : "") + mo + "-" + (dy < 10 ? "0" : "") + dy;
  }
  // 誠實標籤：量的是系統內「最後互動時間」(LINE 端)，看不到 OA／電話聯繫——所以說「上次互動」
  // 而非「已等」(暗示客戶在乾等)，也不標「未更新」(像在指責同仁沒做事)。同仁在 OA 處理過的案子，
  // 系統本來就不知道；按「已聯繫」即可記錄並暫停提醒。
  function waitLabel(f) {
    var t = f["最後互動時間"]; if (!t) return "";
    var ms = Date.now() - new Date(t).getTime(); if (isNaN(ms) || ms < 0) return "";
    var h = ms / 3600000;
    return h < 24 ? ("上次互動 " + Math.round(h) + " 小時前") : ("上次互動 " + Math.round(h / 24) + " 天前");
  }

  function gate(msg) {
    if (polling) { clearInterval(polling); polling = null; }
    clear(head); clear(list);
    if (meClients) { clear(meClients); clientListEl = null; }  // 收起全所客戶清單
    head.appendChild(el("div", "me-title", "全謹 · 我的案件"));
    list.appendChild(el("p", "me-empty", msg));
  }

  function boot() {
    // 無 token 的引導要說「連結在哪」：同仁的專屬連結就在他們與全謹 OA 的對話紀錄裡
    // （發放時傳的那則），往上滾就找得到 — 不說位置的話同仁會卡住來問人（F2）。
    if (!token) { gate("請先開啟您的專屬連結：在與全謹的 LINE 對話中往上找「專屬頁面連結」那則訊息，點開一次即可；找不到請向全謹團隊索取。"); return; }
    // 載入中佔位：首次從 LINE 點進來會有 1～3 秒抓資料，空白畫面會被當成連結壞掉。
    clear(list); list.appendChild(el("p", "me-empty", "載入中，請稍候…"));
    api("/whoami").then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (w) { me = w; load(); startPoll(); if (isAdmin()) loadClients(); })
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
    // admin 才有全所面板,但它在個人區塊下方,首次進來不易發現(ux M1)→常駐一行導引。
    if (isAdmin()) {
      var guide = el("div", "me-count", "▽ 向下滑可查看全所客戶清單");
      guide.style.marginTop = "6px"; guide.style.fontSize = "11.5px";
      head.appendChild(guide);
    }
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
    if (todo.length) {
      todo.forEach(function (c) { list.appendChild(card(c, true)); });
    } else if (active.length) {
      list.appendChild(el("p", "me-done", "✓ 本日待辦已清空——所有案件近一日內都有進度。"));
    } else if (closed.length) {
      list.appendChild(el("p", "me-done", "✓ 目前沒有進行中的案件。"));
    } else {
      // 全新同仁、尚無指派 → 別讓空畫面看起來像連結壞了，說明之後會怎麼收到案件。
      list.appendChild(el("p", "me-empty", "目前沒有分配中的案件。有新案件指派給您時，全謹會透過 LINE 通知您 🙏"));
    }

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
    if (w) l2.appendChild(el("span", isTodo ? "me-wait me-overdue" : "me-wait", w));
    li.appendChild(l2);
    var acts = el("div", "me-acts");
    acts.appendChild(btn("已聯繫", "ink", function () { doCta(c.id, { action: "contacted", recordId: c.id }, "已記錄聯繫，暫停提醒"); }));
    acts.appendChild(btn("結案", "accent", function () { openClose(li, c.id); }));
    li.appendChild(acts);
    // 追蹤提醒列——成功後傳 load（伺服器真相重繪），不能走預設的樂觀移卡（設定提醒≠案件離場）。
    if (f["進度狀態"] === "人工接管中") li.appendChild(reminderRow(c, load));
    // 兩行分開，11px 手機上比「＝…·…」好讀；並點明「已聯繫」是暫停提醒、明日未結案會再出現，
    // 否則同仁以為按了就永久消失，隔天看到又冒出來會以為是 bug。
    li.appendChild(el("div", "me-hint", "已聯繫：記錄你已聯繫過客戶，先不提醒"));
    li.appendChild(el("div", "me-hint", "結案：案件辦完，填成交金額或標未成交"));
    li.appendChild(el("div", "me-hint", "3／7／14天：多久提醒一次（點了會取消已設的指定日期）"));
    li.appendChild(el("div", "me-hint", "日期＋設定：指定下次提醒日，該日前不提醒，之後恢復頻率"));
    return li;
  }

  // ── 追蹤提醒（人工接管中卡片限定）────────────────────────────────────────────
  // 一列：3/7/14 天間隔一鍵切換（active=目前值）＋ 日期欄一次性「下次提醒」設定。
  // 寫入走 /cta set_interval / set_next_reminder → 伺服器端仍走 LINE 同一組
  // 「追蹤間隔／下次提醒」指令（單一寫入路徑）；成功後以伺服器真相重繪（after）。
  function reminderRow(c, after) {
    var f = c.fields || {};
    var box = el("div", "me-remind");
    box.style.marginTop = "10px";
    var lab = el("div", "me-hint", "追蹤提醒");
    lab.style.marginTop = "0";
    box.appendChild(lab);
    var row = el("div", "me-chips");
    row.style.marginTop = "6px";
    var cur = Number(f["提醒間隔天數"] == null ? 0 : f["提醒間隔天數"]);
    [3, 7, 14].forEach(function (n) {
      var chip = el("button", "me-chip" + (cur === n ? " active" : ""), n + "天");
      chip.addEventListener("click", function () {
        doCta(c.id, { action: "set_interval", recordId: c.id, days: n },
              "已改為每 " + n + " 天追蹤提醒", after, "更新失敗，請重試");
      });
      row.appendChild(chip);
    });
    var di = el("input", "me-chip me-date");
    di.type = "date"; di.min = localISO(1); di.max = localISO(90);  // 明天起、最多 90 天後
    row.appendChild(di);
    var setBtn = el("button", "me-chip", "設定");
    setBtn.addEventListener("click", function () {
      var v = di.value || "";
      if (!v) { toast("請先選擇日期", "warn"); return; }
      var mo = parseInt(v.slice(5, 7), 10), dy = parseInt(v.slice(8, 10), 10);
      doCta(c.id, { action: "set_next_reminder", recordId: c.id, date: v },
            "下次提醒已設為 " + mo + " 月 " + dy + " 日", after, "更新失敗，請重試");
    });
    row.appendChild(setBtn);
    var nx = String(f["下次提醒日期"] || "");
    if (nx.length >= 10) {
      // 「7 月 25 日」與設定成功 toast 同格式；解析失敗（非 ISO 日期）→ 保留原字串。
      var nm = parseInt(nx.slice(5, 7), 10), nd = parseInt(nx.slice(8, 10), 10);
      var cueTxt = (isNaN(nm) || isNaN(nd)) ? "下次提醒：" + nx : "下次提醒：" + nm + " 月 " + nd + " 日";
      var cue = el("span", "me-hint", cueTxt);
      cue.style.marginTop = "0"; cue.style.alignSelf = "center";
      row.appendChild(cue);
    }
    box.appendChild(row);
    return box;
  }

  // after（可選）：動作成功後的自訂處理。個人清單不傳 → 樂觀移除該卡；全所客戶清單傳
  // loadClients → 以伺服器真相重繪整個面板（結案離開清單、指派/接管即時更新負責人與狀態）。
  function openClose(li, id, after) {
    var existing = li.querySelector(".me-chooser");
    if (existing) { existing.remove(); return; }   // toggle
    var ch = el("div", "me-chooser");
    ch.appendChild(el("span", "me-ch-q", "本案結果？"));
    ch.appendChild(btn("成交（填金額）", "ok", function () { amountForm(ch, id, after); }));
    ch.appendChild(btn("未成交", "ink", function () {
      doCta(id, { action: "close", recordId: id, amount: 0 }, "已結案：未成交", after);
    }));
    li.appendChild(ch);
  }

  // #3:頁內數字輸入(取代 window.prompt)——鍵盤在頁面內展開、不蓋畫面,輸入的數字看得到再確認。
  function amountForm(ch, id, after) {
    clear(ch);
    ch.appendChild(el("span", "me-ch-q", "成交金額（數字）"));
    var inp = el("input", "me-amt-input");
    inp.type = "number"; inp.setAttribute("inputmode", "numeric"); inp.placeholder = "例如 25000"; inp.min = "1";
    ch.appendChild(inp);
    var row = el("div", "me-amt-row");
    row.appendChild(btn("確認登記", "ok", function () {
      var n = parseInt(String(inp.value || "").replace(/[^0-9]/g, ""), 10);
      if (!(n > 0)) { toast("請輸入大於 0 的金額", "warn"); inp.focus(); return; }
      doCta(id, { action: "close", recordId: id, amount: n }, "已結案：成交 " + fmtMoney(n), after);
    }));
    row.appendChild(btn("取消", "ink", function () { ch.remove(); }));
    ch.appendChild(row);
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 50);
  }

  // 同一時間只允許一個動作在傳送(單人操作;慢網路下防雙觸/雙送)。
  // errMsg（可選）：失敗且伺服器沒給錯誤訊息時的替代文案（追蹤提醒用「更新失敗，請重試」）。
  var _ctaInProgress = false;
  function doCta(id, body, okMsg, after, errMsg) {
    if (_ctaInProgress) return;
    _ctaInProgress = true;
    api("/cta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        _ctaInProgress = false;
        if (res.ok && res.j && res.j.ok) {
          toast("✓ " + okMsg, "ok");
          if (typeof after === "function") { after(); return; }
          // 樂觀移除這張卡 → 同事立刻看到「動作成功」,不必等伺服器全表重抓;
          // 30 秒後的輪詢會以伺服器真相重繪(已結案進已結案區、已聯繫的回進行中區)。
          var card = list.querySelector('[data-id="' + id + '"]');
          if (card && card.parentNode) card.parentNode.removeChild(card);
        } else { toast((res.j && res.j.error) || errMsg || "操作失敗，請重試", "danger"); }
      })
      .catch(function () { _ctaInProgress = false; toast("連線失敗，請重試", "danger"); });
  }

  // ── 全所客戶清單（僅 admin/developer）────────────────────────────────────────
  var STATUS_DISP = { "跟進中": "智能助手跟進中", "人工接管中": "人工接管中", "已完成": "已完成" };
  function statusDisp(s) { return STATUS_DISP[s] || s || ""; }

  // ── 待回/逾期 口徑（照抄戰情室 logic.js，數字才會兩邊一致）────────────────────
  // 逾期＝實際經過 ≥24h（不分時段）；待回＝TPE 上班時段（一~五 09–18）經過 ≥4h，
  // 且僅計 智能助手跟進中（人工接管中=同仁自己在辦，不算「客戶在等回覆」）。
  var TPE_MS = 8 * 3600000;
  function bizHours(from, to) {
    if (!from || !to || to <= from) return 0;
    if ((to - from) > 21 * 86400000) return 189; // >3週直接視為爆表(同戰情室上限)
    var STEP = 15 * 60000, acc = 0, cur = from;
    while (cur < to) {
      var dt = new Date(cur + TPE_MS), d = dt.getUTCDay(), h = dt.getUTCHours() + dt.getUTCMinutes() / 60;
      if (d >= 1 && d <= 5 && h >= 9 && h < 18) acc += STEP;
      cur += STEP;
    }
    return acc / 3600000;
  }
  function levelOf(f, nowMs) {
    var t = f["最後互動時間"]; if (!t) return "ok";           // 無時間戳→不入待辦(同戰情室)
    var ts = new Date(t).getTime(); if (isNaN(ts) || ts > nowMs) return "ok";
    if ((nowMs - ts) / 3600000 >= 24) return "overdue";
    if (f["進度狀態"] === "人工接管中") return "ok";          // 接管中不算待回
    return bizHours(ts, nowMs) >= 4 ? "pending" : "ok";
  }
  // 一次算好全所彙總＋待辦清單（loadClients 後、每次重繪呼叫）
  function clientSummary() {
    var nowMs = Date.now(), pending = [], overdue = [], closable = 0;
    allClients.forEach(function (c) {
      var f = c.fields;
      if (f["進度狀態"] === "人工接管中") closable += 1;
      var lv = levelOf(f, nowMs);
      if (lv === "pending") pending.push(c);
      else if (lv === "overdue") overdue.push(c);
    });
    return { total: allClients.length, pending: pending, overdue: overdue, closable: closable };
  }

  function loadClients() {
    if (!meClients || !isAdmin()) return;
    api("/clients").then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) { allClients = d.cases || []; roster = d.roster || []; renderClientsPanel(); })
      .catch(function (s) {
        // 403（非 admin）→ 面板收起；其它錯誤(500/斷線/逾時) → 明說,別讓面板靜默消失
        // 讓奕溱以為功能壞了(ux B1)。若清單已渲染過,保留舊資料只提示即可。
        if (s === 403 && meClients) { clear(meClients); clientListEl = null; return; }
        if (clientListEl) { toast("客戶清單更新失敗，顯示的是稍早的資料", "warn"); return; }
        if (meClients) {
          clear(meClients); clientListEl = null;
          var errSec = el("div", "me-sec");
          errSec.appendChild(el("span", "me-sec-t", "全所客戶清單"));
          meClients.appendChild(errSec);
          meClients.appendChild(el("p", "me-empty",
            "客戶清單暫時無法載入，約 30 秒後會自動重試；若持續無法顯示，請告知全謹系統管理人員。"));
        }
      });
  }

  function filteredClients() {
    var q = clientSearch.trim();
    var arr = allClients.filter(function (c) {
      var st = c.fields["進度狀態"] || "";
      if (clientStatus !== "all" && st !== clientStatus) return false;
      if (q && String(nameOf(c.fields)).indexOf(q) < 0) return false;
      return true;
    });
    // 後端已 stalest-first;此處穩定排序把「未指派」浮到前面(同一新舊程度內最該指派)。
    arr.sort(function (a, b) { return (a.owner ? 1 : 0) - (b.owner ? 1 : 0); });
    return arr;
  }

  function renderClientsPanel() {
    if (!meClients || !isAdmin()) return;
    // 首次建立外殼(橫幅+本日待辦+標題+搜尋+狀態籤),之後只重繪內容 → 搜尋框不失焦。
    if (!clientListEl) {
      clear(meClients);

      // 壹 · 總結橫幅（戰情室同款口徑）
      bannerEl = el("div", "me-banner");
      meClients.appendChild(bannerEl);

      // 貳 · 本日待辦行動（全所 待回+逾期 佇列，承辦人可篩）
      var tsec = el("div", "me-sec");
      tsec.appendChild(el("span", "me-sec-t", "本日待辦行動（全所）"));
      todoSubEl = el("span", "me-sec-s", "");
      tsec.appendChild(todoSubEl);
      meClients.appendChild(tsec);
      ownerSelEl = el("select", "me-osel");
      ownerSelEl.addEventListener("change", function () {
        todoOwner = this.value; todoShown = 30; renderTodo();
      });
      meClients.appendChild(ownerSelEl);
      todoListEl = el("div", "me-clist");
      meClients.appendChild(todoListEl);

      var sec = el("div", "me-sec");
      sec.appendChild(el("span", "me-sec-t", "全所客戶清單"));
      sec.appendChild(el("span", "me-sec-s", ""));
      meClients.appendChild(sec);

      var ctrl = el("div", "me-cctrl");
      var search = el("input", "me-csearch");
      search.type = "search"; search.placeholder = "搜尋客戶姓名…"; search.setAttribute("inputmode", "search");
      search.addEventListener("input", function () { clientSearch = this.value || ""; clientShown = 30; renderClientList(); });
      ctrl.appendChild(search);

      var chips = el("div", "me-chips");
      [["all", "全部"], ["跟進中", "智能助手跟進中"], ["人工接管中", "人工接管中"]].forEach(function (pair) {
        var chip = el("button", "me-chip" + (pair[0] === clientStatus ? " active" : ""), pair[1]);
        chip.addEventListener("click", function () {
          clientStatus = pair[0]; clientShown = 30;
          Array.prototype.forEach.call(chips.children, function (c) { c.classList.remove("active"); });
          chip.classList.add("active");
          renderClientList();
        });
        chips.appendChild(chip);
      });
      ctrl.appendChild(chips);
      meClients.appendChild(ctrl);

      clientListEl = el("div", "me-clist");
      meClients.appendChild(clientListEl);
    }
    renderBannerAndTodo();
    renderClientList();
  }

  function renderBannerAndTodo() {
    if (!bannerEl) return;
    var s = clientSummary();
    clear(bannerEl);
    bannerEl.appendChild(el("div", "me-btext",
      "今日共 " + s.total + " 件進行中案件，" + s.pending.length +
      " 件待回覆（客戶上班時間已等超過 4 小時）、" + s.overdue.length +
      " 件逾期（逾 1 天未互動），有 " + s.closable + " 件可推進結案。"));
    var chips = el("div", "me-bstats");
    chips.appendChild(el("span", "me-bstat me-b-pend", s.pending.length + " 待回覆"));
    chips.appendChild(el("span", "me-bstat me-b-over", s.overdue.length + " 逾期"));
    chips.appendChild(el("span", "me-bstat me-b-close", s.closable + " 可結案"));
    bannerEl.appendChild(chips);
    renderTodo(s);
  }

  function renderTodo(s) {
    if (!todoListEl) return;
    s = s || clientSummary();
    var todo = s.pending.concat(s.overdue);
    todo.sort(function (a, b) { return idleHours(b.fields) - idleHours(a.fields); }); // 最久沒動在上
    // 承辦人下拉：全部 + 各承辦人(件數) + 未指派(件數)；保留目前選擇。
    var byOwner = {};
    todo.forEach(function (c) { var o = c.owner || "未指派"; byOwner[o] = (byOwner[o] || 0) + 1; });
    var keep = todoOwner;
    clear(ownerSelEl);
    var optAll = el("option", null, "全部承辦人（" + todo.length + "）"); optAll.value = "all";
    ownerSelEl.appendChild(optAll);
    Object.keys(byOwner).sort().forEach(function (o) {
      var op = el("option", null, o + "（" + byOwner[o] + "）"); op.value = o;
      ownerSelEl.appendChild(op);
    });
    ownerSelEl.value = (byOwner[keep] || keep === "all") ? keep : "all";
    todoOwner = ownerSelEl.value;
    var arr = todoOwner === "all" ? todo
            : todo.filter(function (c) { return (c.owner || "未指派") === todoOwner; });
    if (todoSubEl) todoSubEl.textContent = arr.length + " 件待跟進";
    clear(todoListEl);
    if (!arr.length) {
      todoListEl.appendChild(el("p", "me-done", "✓ 目前沒有待回覆或逾期的案件。"));
      return;
    }
    arr.slice(0, todoShown).forEach(function (c) { todoListEl.appendChild(clientCard(c)); });
    if (arr.length > todoShown) {
      var more = btn("載入更多（尚有 " + (arr.length - todoShown) + " 件）", "ink", function () {
        todoShown += 30; renderTodo();
      });
      more.classList.add("me-more");
      todoListEl.appendChild(more);
    }
  }

  function renderClientList() {
    if (!clientListEl) return;
    clear(clientListEl);
    var arr = filteredClients();
    var sub = meClients.querySelector(".me-sec .me-sec-s");
    if (sub) sub.textContent = arr.length + " 件";
    if (!arr.length) {
      var q = clientSearch.trim();
      clientListEl.appendChild(el("p", "me-empty", q
        ? "找不到「" + q + "」的客戶，試試切換上方狀態篩選。"
        : "目前沒有符合條件的客戶。"));
      return;
    }
    arr.slice(0, clientShown).forEach(function (c) { clientListEl.appendChild(clientCard(c)); });
    if (arr.length > clientShown) {
      var more = btn("載入更多（尚有 " + (arr.length - clientShown) + " 件）", "ink", function () {
        clientShown += 30; renderClientList();
      });
      more.classList.add("me-more");
      clientListEl.appendChild(more);
    }
  }

  function clientCard(c) {
    var f = c.fields, li = el("div", "me-card me-ccard"); li.setAttribute("data-id", c.id);
    var l1 = el("div", "me-l1");
    l1.appendChild(el("span", "me-name", nameOf(f)));
    if (f["優先級"] === "高優先") l1.appendChild(el("span", "me-pri", "高優先"));
    li.appendChild(l1);
    var l2 = el("div", "me-l2");
    l2.appendChild(el("span", "me-type", f["案件類型"] || "未分類"));
    l2.appendChild(el("span", "me-status", statusDisp(f["進度狀態"])));
    li.appendChild(l2);
    var l3 = el("div", "me-l3");
    l3.appendChild(el("span", c.owner ? "me-owner" : "me-owner me-unowned", "負責人：" + (c.owner || "未指派")));
    var w = waitLabel(f);
    if (w) l3.appendChild(el("span", "me-wait", w));
    li.appendChild(l3);
    var acts = el("div", "me-acts me-acts-wrap");
    acts.appendChild(btn("指派／改派", "ink", function () { openPicker(li, c.id); }));
    acts.appendChild(btn("已聯繫", "ink", function () { doCta(c.id, { action: "contacted", recordId: c.id }, "已記錄聯繫，暫停提醒", loadClients); }));
    acts.appendChild(btn("結案", "accent", function () { openClose(li, c.id, loadClients); }));
    // 接管/交回 有客戶可見的側效應(交回→客戶收到「感謝耐心等候」;接管→暖性結尾+助手靜默),
    // 手機誤觸 = 客戶收到莫名訊息 → 先展開 inline 確認(ux H1/H2),並明說客戶端會發生什麼。
    if (f["進度狀態"] === "人工接管中") {
      acts.appendChild(btn("交回智能助手", "ink", function () {
        confirmAct(li, "me-restore-confirm",
          "確認交回？系統會通知客戶「感謝耐心等候」。", "確認交回",
          function () { doCta(c.id, { action: "restore", recordId: c.id }, "已交回智能助手", loadClients); });
      }));
    }
    if (f["進度狀態"] === "跟進中") {
      acts.appendChild(btn("接管", "ink", function () {
        confirmAct(li, "me-takeover-confirm",
          "確認接管？智能助手將暫停回覆，改由人工接手。", "確認接管",
          function () { doCta(c.id, { action: "takeover", recordId: c.id }, "已接管", loadClients); });
      }));
    }
    li.appendChild(acts);
    // 追蹤提醒列（人工接管中限定）——成功後 loadClients 以伺服器真相重繪整個面板。
    if (f["進度狀態"] === "人工接管中") li.appendChild(reminderRow(c, loadClients));
    return li;
  }

  // inline 確認展開(與 openClose 同一 toggle 模式)——給有客戶側效應的動作一個撤回機會。
  function confirmAct(li, cls, question, okLabel, fn) {
    var existing = li.querySelector("." + cls);
    if (existing) { existing.remove(); return; }   // toggle
    var ch = el("div", "me-chooser " + cls);
    ch.appendChild(el("span", "me-ch-q", question));
    ch.appendChild(btn(okLabel, "ok", function () { ch.remove(); fn(); }));
    ch.appendChild(btn("取消", "ink", function () { ch.remove(); }));
    li.appendChild(ch);
  }

  function openPicker(li, id) {
    var existing = li.querySelector(".me-picker");
    if (existing) { existing.remove(); return; }   // toggle
    var pk = el("div", "me-picker");
    pk.appendChild(el("span", "me-ch-q", "指派給哪位同仁？"));
    if (!roster.length) pk.appendChild(el("span", "me-ch-q", "名冊載入中，約 30 秒後自動重試，請稍候再開。"));
    roster.forEach(function (m) {
      pk.appendChild(btn(m.name, "ink", function () {
        // toast 明說系統會 LINE 通知被指派的同仁(ux H3)——避免奕溱又去群組手動 @ 人造成雙重通知。
        doCta(id, { action: "reassign", recordId: id, owner: m.uid },
              "已指派給 " + m.name + "，系統已透過 LINE 通知對方", loadClients);
      }));
    });
    pk.appendChild(btn("取消", "ink", function () { pk.remove(); }));
    li.appendChild(pk);
  }

  var _pollTick = 0;
  function startPoll() {
    if (polling) clearInterval(polling);
    _pollTick = 0;
    polling = setInterval(function () {
      if (document.hidden) return;
      // 有開啟中的結案框/指派選單,或正在打字搜尋 → 本輪略過,避免蓋掉操作或讓搜尋框失焦。
      if (document.querySelector(".me-chooser") || document.querySelector(".me-picker")) return;
      var ae = document.activeElement;
      // 搜尋框或「下次提醒」日期欄操作中 → 略過本輪，免得重繪把輸入到一半的內容吹掉。
      if (ae && ae.classList && (ae.classList.contains("me-csearch") || ae.classList.contains("me-date"))) return;
      _pollTick += 1;
      load();
      // 全所清單資料量大(數百筆)且變化慢:面板健在時每 90 秒刷一次就夠(省行動網路流量,
      // qa Med);尚未載入成功(首次/錯誤狀態)時每 30 秒重試,配合錯誤文案的承諾。
      if (isAdmin() && (!clientListEl || _pollTick % 3 === 0)) loadClients();
    }, 30000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
