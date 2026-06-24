/* =============================================================================
 * 全謹代書每日營運登記簿 — render.js
 * window.QJ.render — 朱墨印譜 呈現層
 *
 * 合約 (config.js):
 *   renderApp(state)                  全量渲染進 #app
 *   diffUpdate(prevState, nextState)  只改有變動列；保留捲動/展開；新進件朱色高亮
 *   applyFilters({type,owner,status}) 客戶佇列切片
 *   pushSyncLog({time,action,ok,msg}) 角落同步紀錄
 *   toast(msg, kind)                  kind: 'ok'|'warn'|'danger'|'info'
 *   setStatus(text, online)           masthead 連線狀態
 *   setProcessedCount(n)              本次已處理 N 項
 *
 * CTA 微合約（app.js 以事件委派綁定，render 只負責「渲染控制項」，絕不發網路）：
 *   每個 CTA 按鈕帶 data-cta="close|amount|contacted" + data-id="<recId>"
 *   amount / close 點擊後展開 inline <input class="amt-input" data-id> + 確認鈕
 *      data-cta="amount-confirm" / "close-confirm" data-id
 *   改派 CTA：渲染但 disabled（QJ.REASSIGN_ENABLED===false）+ title 提示
 * ========================================================================== */

(function () {
  "use strict";
  window.QJ = window.QJ || {};

  var R = {};            // QJ.render
  R._last = null;        // 最近一次 state（applyFilters 用）
  R._filters = { type: "", owner: "", status: "" };

  /* ---------- 小工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) { return String(s == null ? "" : s); } // textContent 已防注入，留語意接口
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function fmtMoney(n) {
    if (n == null || isNaN(n)) return "—";
    return "NT$ " + Math.round(n).toLocaleString("en-US");
  }
  function fmtDays(d) {
    if (d == null || isNaN(d)) return "—";
    return d + " 天";
  }
  function initials(name) {
    var s = String(name || "").trim();
    if (!s) return "？";
    // 中文取末一字（姓名慣例顯示名）；英文取首字母
    if (/[一-鿿]/.test(s)) return s.slice(-1);
    return s.slice(0, 1).toUpperCase();
  }
  function avatar(name, opts) {
    var a = el("span", "avatar", initials(name));
    if (!name || /未指派|未分派|無/.test(String(name))) { a.classList.add("unassigned"); a.textContent = "—"; }
    if (opts && opts.title) a.title = name || "未指派";
    a.setAttribute("aria-hidden", "true");
    return a;
  }
  function nowHM() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  var STATUS_DISPLAY = (window.QJ && QJ.STATUS_DISPLAY) || {};
  function statusDisplay(s) { return STATUS_DISPLAY[s] || s || "—"; }
  var LEVEL_PILL = { overdue: "overdue", soon: "soon", ok: "ok" };
  var LEVEL_LABEL = { overdue: "逾期", soon: "即將逾期", ok: "正常" };

  /* =============================================================================
   * 報頭：民國日期
   * ========================================================================== */
  function renderMasthead() {
    var dn = $("roc-date");
    if (dn && QJ.rocDate) dn.textContent = QJ.rocDate();
  }

  /* =============================================================================
   * 摘要 SUMMARY
   * ========================================================================== */
  function renderSummary(state) {
    var host = $("summary"); if (!host) return;
    clear(host);
    var s = state.summary || { text: "", overdue: 0, closable: 0 };

    host.appendChild(el("p", "sum-text", s.text || "本日尚無摘要。"));

    var figs = el("div", "sum-figs");

    var f1 = el("span", "sum-fig sum-overdue");
    f1.appendChild(el("b", null, String(s.overdue || 0)));
    f1.appendChild(el("span", null, "件逾期待處理"));
    figs.appendChild(f1);

    var f2 = el("span", "sum-fig sum-closable");
    f2.appendChild(el("b", null, String(s.closable || 0)));
    f2.appendChild(el("span", null, "件可結案"));
    figs.appendChild(f2);

    host.appendChild(figs);
  }

  /* =============================================================================
   * KPI 五格
   * ========================================================================== */
  function kpiCell(cls, num, label) {
    var c = el("div", "kpi " + cls);
    c.appendChild(el("div", "kpi-num", num));
    c.appendChild(el("div", "kpi-label", label));
    return c;
  }
  function renderKpis(state) {
    var host = $("kpis"); if (!host) return;
    clear(host);
    var k = state.kpis || {};
    host.appendChild(kpiCell("kpi-await", String(k.awaiting || 0), "待回覆案件"));
    host.appendChild(kpiCell("kpi-risk", String(k.overdueRisk || 0), "逾期風險"));
    host.appendChild(kpiCell("kpi-close", String(k.closableToday || 0), "今日可結案"));
    host.appendChild(kpiCell("kpi-money", fmtMoney(k.monthAmount), "本月成交金額"));
    host.appendChild(kpiCell("kpi-overload", String(k.overloadedOwners || 0), "超載承辦人"));
  }

  /* =============================================================================
   * 壹 · CTA 待辦行動
   * ========================================================================== */
  var ACTION_KIND_LABEL = { overdue: "逾期跟進", close: "可結案", amount: "待補金額" };

  function ctaButton(label, ctaType, id, variant, disabled, title) {
    var b = el("button", "cta" + (variant ? " " + variant : ""), label);
    b.type = "button";
    b.setAttribute("data-cta", ctaType);
    b.setAttribute("data-id", id);
    if (disabled) { b.disabled = true; }
    if (title) b.title = title;
    return b;
  }

  // 標記已聯繫
  function ctaContacted(id) {
    return ctaButton("標記已聯繫", "contacted", id, "cta-ink");
  }
  // 改派（v1 停用）
  function ctaReassign(id) {
    var enabled = window.QJ && QJ.REASSIGN_ENABLED === true;
    var b = ctaButton("改派", "reassign", id, null, !enabled,
      enabled ? null : "待確認承辦人欄位格式後啟用");
    return b;
  }

  function renderCtaActions(state) {
    var host = $("cta-actions"); if (!host) return;
    clear(host);
    var actions = state.actions || [];

    if (!actions.length) {
      var e = el("div", "empty-state");
      e.appendChild(el("span", "empty-mark", "✓ "));
      e.appendChild(document.createTextNode("本日待辦已清空 — 無需即時處理的行動。"));
      host.appendChild(e);
      return;
    }

    actions.forEach(function (act) {
      host.appendChild(buildActionRow(act));
    });
  }

  function buildActionRow(act) {
    var rec = act.rec || {};
    var row = el("div", "cta-row kind-" + (act.kind || "overdue"));
    row.setAttribute("data-id", act.id || rec.id || "");

    var meta = el("div", "cta-meta");
    var name = el("div", "cta-name", rec.委託人 || "未具名委託人");
    if (rec.案號) {
      var no = el("span", "cta-no", rec.案號);
      name.appendChild(no);
    }
    meta.appendChild(name);
    meta.appendChild(el("div", "cta-desc",
      (ACTION_KIND_LABEL[act.kind] || "") + "｜" + (act.label || rec.案件類型 || "")));
    row.appendChild(meta);

    var ctrls = el("div", "cta-ctrls");
    var id = act.id || rec.id;

    if (act.kind === "overdue") {
      ctrls.appendChild(ctaContacted(id));
      ctrls.appendChild(ctaButton("標記可結案", "close", id, "cta-ok"));
    } else if (act.kind === "close") {
      ctrls.appendChild(ctaButton("結案", "close", id, "cta-ok"));
      ctrls.appendChild(ctaContacted(id));
    } else if (act.kind === "amount") {
      ctrls.appendChild(ctaButton("補成交金額", "amount", id, "cta-accent"));
    }
    row.appendChild(ctrls);
    return row;
  }

  /* =============================================================================
   * 貳 · 切片下拉
   * ========================================================================== */
  function fillSelect(sel, values, allLabel, current) {
    if (!sel) return;
    var prev = current != null ? current : sel.value;
    clear(sel);
    var optAll = el("option", null, allLabel);
    optAll.value = "";
    sel.appendChild(optAll);
    (values || []).forEach(function (v) {
      if (v == null || v === "") return;
      var o = el("option", null, v);
      o.value = v;
      sel.appendChild(o);
    });
    // 維持先前選擇（若仍存在）
    if (prev && Array.prototype.some.call(sel.options, function (o) { return o.value === prev; })) {
      sel.value = prev;
    } else {
      sel.value = "";
    }
  }
  function renderSlicers(state) {
    var sl = state.slices || { types: [], owners: [], statuses: [] };
    fillSelect($("slice-type"), sl.types, "全部類型", R._filters.type);
    fillSelect($("slice-owner"), sl.owners, "全部承辦人", R._filters.owner);
    fillSelect($("slice-status"),
      (sl.statuses || []).map(statusDisplay).length ? sl.statuses : sl.statuses,
      "全部狀態", R._filters.status);
    // 狀態下拉顯示生產顯示值，但 option.value 仍為原始狀態值（供 app 過濾）
    var ss = $("slice-status");
    if (ss) {
      Array.prototype.forEach.call(ss.options, function (o) {
        if (o.value) o.textContent = statusDisplay(o.value);
      });
    }
  }

  /* =============================================================================
   * 貳 · 佇列表
   * ========================================================================== */
  var QUEUE_COLS = ["委託人", "案號", "案件類型", "承辦人", "狀態", "等候天數", "下一步"];

  function buildQueueHead() {
    var thead = el("thead");
    var tr = el("tr");
    QUEUE_COLS.forEach(function (c) {
      var th = el("th", null, c);
      th.scope = "col";
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    return thead;
  }

  function passesFilter(item) {
    var f = R._filters, rec = item.rec || {};
    if (f.type && rec.案件類型 !== f.type) return false;
    if (f.owner && (rec.承辦人 || "") !== f.owner) return false;
    if (f.status && rec.狀態 !== f.status) return false;
    return true;
  }

  function buildQueueRow(item) {
    var rec = item.rec || {};
    var tr = el("tr", "lvl-" + (item.level || "ok"));
    tr.setAttribute("data-id", rec.id || "");
    tr.setAttribute("data-rowsig", rowSig(item));

    // 委託人
    var tdName = el("td");
    tdName.appendChild(el("span", "client-name", rec.委託人 || "未具名"));
    tr.appendChild(tdName);

    // 案號 (mono)
    var tdNo = el("td");
    tdNo.appendChild(el("span", "case-no", rec.案號 || "—"));
    tr.appendChild(tdNo);

    // 案件類型
    tr.appendChild(el("td", null, rec.案件類型 || "—"));

    // 承辦人（方形頭像）
    var tdOwner = el("td");
    var oc = el("span", "owner-cell");
    oc.appendChild(avatar(rec.承辦人, { title: true }));
    oc.appendChild(el("span", null, rec.承辦人 || "未指派"));
    tdOwner.appendChild(oc);
    tr.appendChild(tdOwner);

    // 狀態藥丸（用 level 對映 danger/warn/ok 視覺；文字用生產顯示值）
    var tdStatus = el("td");
    var pill = el("span", "pill " + (LEVEL_PILL[item.level] || "ok"), statusDisplay(rec.狀態));
    tdStatus.appendChild(pill);
    tr.appendChild(tdStatus);

    // 等候天數
    var tdWait = el("td");
    var w = el("span", "wait-days lvl-" + (item.level || "ok"), fmtDays(item.waitDays));
    tdWait.appendChild(w);
    tr.appendChild(tdWait);

    // 下一步 CTA
    var tdCta = el("td", "queue-cta-cell");
    tdCta.appendChild(buildQueueCta(item));
    tr.appendChild(tdCta);

    return tr;
  }

  function buildQueueCta(item) {
    var rec = item.rec || {};
    var next = item.nextCTA || { type: "contacted", label: "標記已聯繫" };
    var id = rec.id;
    var t = next.type;
    if (t === "close") return ctaButton(next.label || "結案", "close", id, "cta-ok");
    if (t === "amount") return ctaButton(next.label || "補金額", "amount", id, "cta-accent");
    if (t === "reassign") return ctaReassign(id);
    // 預設 contacted
    return ctaButton(next.label || "標記已聯繫", "contacted", id, "cta-ink");
  }

  // 列簽章：用於 diffUpdate 判斷是否需重繪該列
  function rowSig(item) {
    var r = item.rec || {};
    return [r.委託人, r.案號, r.案件類型, r.承辦人, r.狀態,
            item.waitDays, item.level,
            (item.nextCTA && item.nextCTA.type)].join("¦");
  }

  function renderQueue(state) {
    var table = $("queue"); if (!table) return;
    clear(table);
    table.appendChild(buildQueueHead());
    var tbody = el("tbody");
    table.appendChild(tbody);

    var rows = (state.queue || []).filter(passesFilter);
    if (!rows.length) {
      var tr = el("tr");
      var td = el("td");
      td.colSpan = QUEUE_COLS.length;
      var msg = (R._filters.type || R._filters.owner || R._filters.status)
        ? "此切片條件下沒有案件 — 調整上方篩選。"
        : "目前沒有逾期案件 — 佇列乾淨。";
      var e = el("div", "empty-state", msg);
      td.appendChild(e);
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(function (item) { tbody.appendChild(buildQueueRow(item)); });
  }

  /* =============================================================================
   * 貳 · 成交進度欄 #deal-track
   * ========================================================================== */
  function dealList(title, recs, cls, emptyText) {
    var box = el("div", "deal-sub " + cls);
    box.appendChild(el("h4", null, title));
    if (!recs || !recs.length) {
      box.appendChild(el("p", "deal-empty", emptyText));
      return box;
    }
    var ul = el("ul");
    recs.slice(0, 8).forEach(function (rec) {
      var li = el("li");
      var left = el("span");
      left.appendChild(document.createTextNode((rec.委託人 || "未具名") + " "));
      if (rec.案號) left.appendChild(el("span", "dl-no", rec.案號));
      li.appendChild(left);
      li.appendChild(el("b", null,
        (rec.成交金額 != null && !isNaN(rec.成交金額)) ? fmtMoney(rec.成交金額) : "待補"));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  function renderDealTrack(state) {
    var host = $("deal-track"); if (!host) return;
    clear(host);
    var d = state.deal || { monthAmount: 0, target: null, closable: [], pendingAmount: [] };

    host.appendChild(el("h3", null, "本月成交進度"));

    var amt = el("div", "deal-amount", fmtMoney(d.monthAmount || 0));
    host.appendChild(amt);
    host.appendChild(el("div", "deal-amount-label", "本月累計成交"));

    if (d.target != null && d.target > 0) {
      var pct = Math.max(0, Math.min(100, Math.round((d.monthAmount || 0) / d.target * 100)));
      host.appendChild(el("div", "deal-target", "目標 " + fmtMoney(d.target) + "　達成 " + pct + "%"));
      var bar = el("div", "deal-bar");
      var fill = el("span"); fill.style.width = pct + "%";
      bar.appendChild(fill);
      host.appendChild(bar);
    } else {
      host.appendChild(el("div", "deal-target", "未設定本月目標。"));
    }

    host.appendChild(dealList("可結案", d.closable, "closable", "無可結案案件。"));
    host.appendChild(dealList("待補金額", d.pendingAmount, "pending", "金額皆已登錄。"));
  }

  /* =============================================================================
   * 參 · 承辦團隊
   * ========================================================================== */
  function renderTeam(state) {
    var host = $("team"); if (!host) return;
    clear(host);
    var team = state.team || [];
    if (!team.length) {
      host.appendChild(el("div", "empty-state", "尚無承辦人指派紀錄。"));
      return;
    }
    team.forEach(function (t) {
      var card = el("div", "team-card" + (t.flag === "overload" ? " overload" : ""));

      var head = el("div", "team-head");
      head.appendChild(avatar(t.owner, { title: true }));
      var hwrap = el("div");
      hwrap.appendChild(el("div", "team-name", t.owner || "未指派"));
      hwrap.appendChild(el("div", "team-load-label", "負荷指數 " + (t.load != null ? t.load : "—")));
      head.appendChild(hwrap);
      card.appendChild(head);

      var stats = el("div", "team-stats");
      var s1 = el("div", "team-stat active");
      s1.appendChild(el("b", null, String(t.active || 0)));
      s1.appendChild(el("span", null, "進行中"));
      stats.appendChild(s1);
      var s2 = el("div", "team-stat overdue");
      s2.appendChild(el("b", null, String(t.overdue || 0)));
      s2.appendChild(el("span", null, "逾期"));
      stats.appendChild(s2);
      card.appendChild(stats);

      var meta = el("div", "team-meta");
      meta.appendChild(document.createTextNode("平均回應 "));
      meta.appendChild(el("span", "tm-resp",
        (t.avgRespDays != null && !isNaN(t.avgRespDays)) ? (t.avgRespDays + " 天") : "—"));
      card.appendChild(meta);

      host.appendChild(card);
    });
  }

  /* =============================================================================
   * 公開 API
   * ========================================================================== */
  R.renderApp = function (state) {
    if (!state) return;
    R._last = state;
    var app = $("app");
    if (app && app.hidden) app.hidden = false;

    renderMasthead();
    renderSummary(state);
    renderKpis(state);
    renderCtaActions(state);
    renderSlicers(state);
    renderQueue(state);
    renderDealTrack(state);
    renderTeam(state);
    // 圖譜由 QJ.charts.renderCharts(state) 在 app.js 中觸發
  };

  // 只更新有變動的佇列列；保留捲動位置與展開中的 inline input
  R.diffUpdate = function (prevState, nextState) {
    if (!nextState) return;
    var table = $("queue");
    // 若整體結構（KPI/摘要/CTA/團隊/成交）需要更新，照舊全量這些輕量區塊
    R._last = nextState;
    renderMasthead();
    renderSummary(nextState);
    renderKpis(nextState);
    renderCtaActions(nextState);
    renderDealTrack(nextState);
    renderTeam(nextState);
    renderSlicers(nextState);

    if (!table || !table.tBodies.length) { renderQueue(nextState); return; }

    var tbody = table.tBodies[0];
    var scroller = table.closest(".queue-scroll");
    var scrollTop = scroller ? scroller.scrollTop : 0;

    // 記住展開中的 inline 編輯（依 data-id），稍後復原
    var openEdits = {};
    Array.prototype.forEach.call(tbody.querySelectorAll(".inline-edit"), function (ie) {
      var inp = ie.querySelector(".amt-input");
      openEdits[ie.getAttribute("data-edit-id")] = {
        cta: ie.getAttribute("data-edit-cta"),
        val: inp ? inp.value : ""
      };
    });

    var nextRows = (nextState.queue || []).filter(passesFilter);
    var nextById = {};
    nextRows.forEach(function (it) { nextById[(it.rec || {}).id] = it; });

    var prevIds = {};
    Array.prototype.forEach.call(tbody.querySelectorAll("tr[data-id]"), function (tr) {
      prevIds[tr.getAttribute("data-id")] = tr;
    });

    // 空 → 重建
    if (!nextRows.length) { renderQueue(nextState); restoreScroll(scrollTop); return; }
    // 先前是空狀態（無 data-id 列）→ 重建
    if (!Object.keys(prevIds).length) { renderQueue(nextState); restoreScroll(scrollTop); reopenEdits(openEdits); return; }

    // 1) 更新或新增，依 nextRows 的順序重排
    var frag = document.createDocumentFragment();
    nextRows.forEach(function (item) {
      var id = (item.rec || {}).id;
      var existing = prevIds[id];
      if (existing) {
        if (existing.getAttribute("data-rowsig") !== rowSig(item)) {
          var fresh = buildQueueRow(item);
          frag.appendChild(fresh);
        } else {
          frag.appendChild(existing); // 移動既有節點，保留 inline edit 子樹
        }
        delete prevIds[id];
      } else {
        var nrow = buildQueueRow(item);
        nrow.classList.add("row-new"); // 新進件朱色高亮
        frag.appendChild(nrow);
      }
    });
    // 2) 殘餘（已不在 next）的列移除
    Object.keys(prevIds).forEach(function (id) {
      var tr = prevIds[id];
      if (tr && tr.parentNode) tr.parentNode.removeChild(tr);
    });
    clear(tbody);
    tbody.appendChild(frag);

    reopenEdits(openEdits);
    restoreScroll(scrollTop);

    function restoreScroll(top) {
      var sc = table.closest(".queue-scroll");
      if (sc) sc.scrollTop = top;
    }
  };

  // 復原 diffUpdate 前展開的 inline 編輯框
  function reopenEdits(openEdits) {
    Object.keys(openEdits || {}).forEach(function (id) {
      var info = openEdits[id];
      var row = document.querySelector('#queue tr[data-id="' + cssEscape(id) + '"]');
      if (!row) return;
      var cell = row.querySelector(".queue-cta-cell");
      if (!cell) return;
      R.openInlineAmount(cell, id, info.cta, info.val);
    });
  }
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /* ---------- inline 金額/結案 編輯（render 提供，app 在點擊 close/amount 時調用） ---------- */
  // host = 含按鈕的容器（td.queue-cta-cell 或 .cta-ctrls）
  R.openInlineAmount = function (host, id, kind, presetVal) {
    if (!host) return;
    // 已展開則聚焦
    var exist = host.querySelector('.inline-edit[data-edit-id="' + cssEscape(id) + '"]');
    if (exist) { var i0 = exist.querySelector(".amt-input"); if (i0) i0.focus(); return; }

    var confirmCta = (kind === "close") ? "close-confirm" : "amount-confirm";
    var wrap = el("span", "inline-edit");
    wrap.setAttribute("data-edit-id", id);
    wrap.setAttribute("data-edit-cta", kind);

    var inp = el("input", "amt-input");
    inp.type = "number";
    inp.min = "0";
    inp.step = "1";
    inp.placeholder = (kind === "close") ? "成交金額（可留空）" : "成交金額";
    inp.setAttribute("data-id", id);
    inp.setAttribute("aria-label", "成交金額");
    if (presetVal != null) inp.value = presetVal;

    var ok = ctaButton("確認", confirmCta, id, "cta-accent");
    var cancel = el("button", "cta", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    });

    wrap.appendChild(inp);
    wrap.appendChild(ok);
    wrap.appendChild(cancel);
    host.appendChild(wrap);
    inp.focus();
  };
  // 移除某 id 的 inline 編輯（app 在寫回成功後調用）
  R.closeInlineAmount = function (id) {
    var ies = document.querySelectorAll('.inline-edit[data-edit-id="' + cssEscape(id) + '"]');
    Array.prototype.forEach.call(ies, function (ie) {
      if (ie.parentNode) ie.parentNode.removeChild(ie);
    });
  };
  // 取得某 id inline input 的值（app 寫回時調用）
  R.getInlineAmount = function (id) {
    var inp = document.querySelector('.inline-edit[data-edit-id="' + cssEscape(id) + '"] .amt-input');
    return inp ? inp.value : null;
  };

  /* ---------- applyFilters ---------- */
  R.applyFilters = function (f) {
    f = f || {};
    R._filters = {
      type: f.type != null ? f.type : R._filters.type,
      owner: f.owner != null ? f.owner : R._filters.owner,
      status: f.status != null ? f.status : R._filters.status
    };
    if (R._last) renderQueue(R._last);
  };

  /* ---------- pushSyncLog ---------- */
  R.pushSyncLog = function (entry) {
    entry = entry || {};
    var host = $("sync-log"); if (!host) return;
    if (!host.querySelector(".sl-head")) {
      host.appendChild(el("div", "sl-head", "同步紀錄"));
    }
    var line = el("div", "sl-line " + (entry.ok ? "ok" : "err"));
    line.appendChild(el("span", "sl-time", entry.time || nowHM()));
    line.appendChild(el("span", "sl-mark", entry.ok ? "✓" : "✗"));
    var msg = (entry.action ? entry.action + "　" : "") + (entry.msg || "");
    line.appendChild(el("span", "sl-msg", msg || (entry.ok ? "完成" : "失敗")));
    // prepend 在 head 之後
    var head = host.querySelector(".sl-head");
    host.insertBefore(line, head.nextSibling);
    // 上限保留 60 行
    var lines = host.querySelectorAll(".sl-line");
    for (var i = lines.length - 1; i >= 60; i--) {
      if (lines[i] && lines[i].parentNode) lines[i].parentNode.removeChild(lines[i]);
    }
  };

  /* ---------- toast ---------- */
  R.toast = function (msg, kind) {
    kind = kind || "info";
    var wrap = document.querySelector(".qj-toasts");
    if (!wrap) {
      wrap = el("div", "qj-toasts");
      document.body.appendChild(wrap);
    }
    var t = el("div", "qj-toast " + kind, msg || "");
    t.setAttribute("role", "status");
    wrap.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity 200ms";
      t.style.opacity = "0";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }, 3200);
  };

  /* ---------- setStatus ---------- */
  R.setStatus = function (text, online) {
    var n = $("conn-status"); if (!n) return;
    if (text != null) n.textContent = text;
    // online: true|false|'error'
    var v = (online === "error") ? "error" : (online ? "true" : "false");
    n.setAttribute("data-online", v);
  };

  /* ---------- setProcessedCount ---------- */
  R.setProcessedCount = function (n) {
    var node = $("processed-count"); if (!node) return;
    node.textContent = "本次已處理 " + (n || 0) + " 項";
  };

  window.QJ.render = R;
})();
