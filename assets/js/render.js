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
  R._ctaFilters = { owner: "", type: "", kind: "" };

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
  /* 承辦人顯示名：優先用 uid 對名冊取真實姓名（HSU→徐鈞澤）；否則去掉「(uid)」取名字部分。 */
  function displayOwner(raw) {
    // 全站唯一解析來源 QJ.ownerName（config.js）；保留同名函式作為呼叫端介面
    if (window.QJ && QJ.ownerName) return QJ.ownerName(raw);
    return String(raw == null ? "" : raw).trim();
  }
  /* 客戶顯示名：匿名（只有 LINE userId）客戶 → 「未命名・末6碼」；真正空白才「未具名委託人」。 */
  function clientLabel(name) {
    var s = String(name == null ? "" : name).trim();
    if (!s) return "未具名委託人";
    if (/^U[0-9a-f]{16,}$/i.test(s)) return "未命名・" + s.slice(-6);
    return s;
  }
  function avatar(name, opts) {
    var disp = displayOwner(name);
    var a = el("span", "avatar", initials(disp));
    if (!name || /未指派|未分派|無/.test(String(name))) { a.classList.add("unassigned"); a.textContent = "—"; }
    if (opts && opts.title) a.title = disp || "未指派";
    a.setAttribute("aria-hidden", "true");
    return a;
  }
  function nowHM() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  var STATUS_DISPLAY = (window.QJ && QJ.STATUS_DISPLAY) || {};
  function statusDisplay(s) { return STATUS_DISPLAY[s] || s || "—"; }
  /* 狀態下拉：跟進中／人工接管中／已完成 → app 經 proxy 走 bot 接管／恢復／結案 */
  var STATUS_FLOW = (window.QJ && QJ.STATUS) ? [QJ.STATUS.OPEN, QJ.STATUS.HUMAN, QJ.STATUS.DONE] : ["跟進中", "人工接管中", "已完成"];
  function statusSelect(id, current, level) {
    var sel = el("select", "status-select pill " + (LEVEL_PILL[level] || "ok"));
    sel.setAttribute("data-id", id || "");
    sel.setAttribute("data-current", current || "");
    sel.setAttribute("title", "變更狀態");
    if (current && STATUS_FLOW.indexOf(current) === -1) {
      var oc = el("option", null, statusDisplay(current)); oc.value = current; oc.selected = true; sel.appendChild(oc);
    }
    STATUS_FLOW.forEach(function (s) {
      var o = el("option", null, statusDisplay(s)); o.value = s;
      if (s === current) o.selected = true;
      sel.appendChild(o);
    });
    return sel;
  }
  // 待回 = 紅（danger）、逾期 = 琥珀（warn）；對映既有 pill 配色 overdue(紅)/soon(琥珀)
  var LEVEL_PILL = { pending: "soon", overdue: "overdue", ok: "ok" };
  var LEVEL_LABEL = { pending: "待回", overdue: "逾期", ok: "正常" };

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

    var f0 = el("span", "sum-fig sum-pending");
    f0.appendChild(el("b", null, String(s.pending || 0)));
    f0.appendChild(el("span", null, "件待回覆"));
    figs.appendChild(f0);

    var f1 = el("span", "sum-fig sum-overdue");
    f1.appendChild(el("b", null, String(s.overdue || 0)));
    f1.appendChild(el("span", null, "件逾期"));
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
    host.appendChild(kpiCell("kpi-pending", String(k.pending || 0), "🟠 待回（上班時間 4 小時）"));
    host.appendChild(kpiCell("kpi-risk", String(k.overdueRisk || 0), "🔴 逾期（1 天）"));
    host.appendChild(kpiCell("kpi-close", String(k.closableToday || 0), "可推進結案（人工接管中）"));
    host.appendChild(kpiCell("kpi-money", String(k.monthClosed || 0), "本月結案件數"));
    host.appendChild(kpiCell("kpi-overload", String(k.overloadedOwners || 0), "超載承辦人"));
  }

  /* 智能助手 24/7 戰績橫幅（資料來自 proxy /stats）。數字皆「實測」；ROI 行為「估算」，
     誠實標示——不漏接（即時回應建檔），非「處理完」（成交在 OA 端，日誌看不到）。 */
  R.renderAgentBanner = function (stats) {
    var host = $("agent-banner"); if (!host) return;
    var tk = (stats && stats.takeovers) || {}, rp = (stats && stats.replies) || {};
    if (!stats || stats.ok === false || (tk.total == null && rp.total == null)) { host.hidden = true; return; }
    clear(host); host.hidden = false;
    host.appendChild(el("div", "ab-head", "智能助手全天守線 · 近 " + (stats.window_days || 30) + " 天（自主處理量，非成交數）"));
    var row = el("div", "ab-stats");
    function stat(num, label, sub) {
      var s = el("span", "ab-stat");
      s.appendChild(el("b", "ab-num", String(num)));
      s.appendChild(el("span", "ab-label", label));
      if (sub) s.appendChild(el("span", "ab-sub", sub));
      return s;
    }
    if (tk.total != null) row.appendChild(stat(tk.total, "件自動辨識並轉專人", "其中 " + (tk.after_hours || 0) + " 件下班時間即時接住"));
    if (rp.total != null) row.appendChild(stat(rp.total, "次自動回覆客戶", (rp.after_hours || 0) + " 次在非營業時間"));
    if (rp.blocked) row.appendChild(stat(rp.blocked, "次攔截可疑回覆", "防止亂報價／亂答"));
    host.appendChild(row);
    // 一旦開始登記真實成交金額，改顯示實測值，避免與「本月結案進度」面板的真實數字矛盾。
    if (R._honestAmount > 0) {
      host.appendChild(el("div", "ab-roi", "近 30 天已登記成交 " + (R._honestCount || 0) + " 件，合計 " + fmtMoney(R._honestAmount)));
    } else {
      host.appendChild(el("div", "ab-roi", "估算守住可挽回名單 NT$38 萬+（保守估算；待成交金額開始登記後轉為實測）"));
    }
  };

  /* =============================================================================
   * 壹 · CTA 待辦行動
   * ========================================================================== */
  var ACTION_KIND_LABEL = { pending: "待回覆", overdue: "逾期跟進", close: "可結案", amount: "待補金額" };
  var TIP_CONTACTED = "已聯繫：記下你已回覆或聯繫這位客戶，案件暫時不再提醒；客戶再來訊會自動重新計時。";
  var TIP_CLOSE = "結案：案件辦理完成，會移出清單（之後要逐筆「恢復」才能拉回）。結案時需選「成交（填金額）」或「未成交」。";

  function ctaButton(label, ctaType, id, variant, disabled, title) {
    var b = el("button", "cta" + (variant ? " " + variant : ""), label);
    b.type = "button";
    b.setAttribute("data-cta", ctaType);
    b.setAttribute("data-id", id);
    if (disabled) { b.disabled = true; }
    if (title) b.title = title;
    return b;
  }

  // 已聯繫
  function ctaContacted(id) {
    return ctaButton("已聯繫", "contacted", id, "cta-ink", false, TIP_CONTACTED);
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

    var slicers = el("div", "slicers cta-slicers");
    slicers.appendChild(ctaSlicer("owner", "全部承辦人", actions, function (a) { return displayOwner((a.rec || {}).承辦人); }, null));
    slicers.appendChild(ctaSlicer("type", "全部案型", actions, function (a) { return (a.rec || {}).案件類型; }, null));
    slicers.appendChild(ctaSlicer("kind", "全部類別", actions, function (a) { return a.kind; }, function (k) { return ACTION_KIND_LABEL[k] || k; }));
    host.appendChild(slicers);

    host.appendChild(el("div", "cta-legend",
      "已聯繫＝我已回覆／聯繫（暫不提醒，客戶再來訊自動重新計時）　·　結案＝案件辦理完成（移出清單，可逐筆恢復）"));

    var visible = actions.filter(function (act) { return ctaMatch(act, null); });
    if (!visible.length) {
      host.appendChild(el("div", "empty-state", "此條件下今日無待辦行動 — 請調整上方篩選。"));
      return;
    }
    visible.forEach(function (act) { host.appendChild(buildActionRow(act)); });
  }

  /* 待辦行動的 facet 篩選（承辦人／案型／類別），互不阻擋計數：算某 facet 的選項時略過該 facet 本身 */
  function ctaMatch(act, except) {
    var rec = act.rec || {};
    if (except !== "owner" && R._ctaFilters.owner && displayOwner(rec.承辦人) !== R._ctaFilters.owner) return false;
    if (except !== "type" && R._ctaFilters.type && (rec.案件類型 || "") !== R._ctaFilters.type) return false;
    if (except !== "kind" && R._ctaFilters.kind && act.kind !== R._ctaFilters.kind) return false;
    return true;
  }
  function ctaSlicer(facet, allLabel, actions, valueOf, labelOf) {
    var counts = {};
    actions.forEach(function (act) { if (!ctaMatch(act, facet)) return; var v = valueOf(act); if (v) counts[v] = (counts[v] || 0) + 1; });
    var s = el("select", "slice-select cta-slice"); s.setAttribute("data-facet", facet);
    var all = el("option", null, allLabel); all.value = ""; s.appendChild(all);
    Object.keys(counts).sort().forEach(function (k) {
      var o = el("option", null, (labelOf ? labelOf(k) : k) + "（" + counts[k] + "）"); o.value = k;
      if (R._ctaFilters[facet] === k) o.selected = true;
      s.appendChild(o);
    });
    var lab = el("label", "slice-field"); lab.appendChild(s);
    return lab;
  }
  R.applyCtaFilter = function (facet, value) {
    if (R._ctaFilters.hasOwnProperty(facet)) R._ctaFilters[facet] = value || "";
    if (R._last) renderCtaActions(R._last);
  };

  /* 該筆 Airtable 紀錄連結（base/table 來自憑證，recordId 來自 act）。 */
  function airtableUrl(id) {
    try {
      var c = (window.QJ && QJ.auth && QJ.auth.getCreds) ? QJ.auth.getCreds() : {};
      if (!c || !c.baseId || !c.tableId || !id) return null;
      return "https://airtable.com/" + c.baseId + "/" + c.tableId + "/" + id;
    } catch (e) { return null; }
  }

  function buildActionRow(act) {
    var rec = act.rec || {};
    var id = act.id || rec.id;
    var row = el("div", "cta-row kind-" + (act.kind || "overdue"));
    row.setAttribute("data-id", id || "");

    var meta = el("div", "cta-meta");
    var name = el("div", "cta-name", clientLabel(rec.委託人));
    meta.appendChild(name);
    var dsc = (ACTION_KIND_LABEL[act.kind] || "");
    if (rec.案件類型) dsc += "｜" + rec.案件類型;
    dsc += "｜承辦：" + (displayOwner(rec.承辦人) || "未指派");
    meta.appendChild(el("div", "cta-desc", dsc));

    // 等候時間 ＋ 待辦事項（行動上下文）
    var extra = el("div", "cta-extra");
    if (act.waitLabel) extra.appendChild(el("span", "cta-chip cta-wait", "已等 " + act.waitLabel));
    if (rec.電話) { var ph = el("a", "cta-chip cta-phone", "📞 " + rec.電話); ph.setAttribute("href", "tel:" + rec.電話); extra.appendChild(ph); }
    var cv = (window.QJ && QJ.caseValue) ? QJ.caseValue(rec.案件類型) : null;
    if (cv) extra.appendChild(el("span", "cta-chip cta-value", "約值 NT$" + cv.toLocaleString("en-US")));
    if (extra.childNodes.length) meta.appendChild(extra);
    var todos = rec.待辦事項 ? String(rec.待辦事項).replace(/\s*\n+\s*/g, "；").trim() : "";
    if (todos) {
      if (todos.length > 200) todos = todos.slice(0, 200) + "…";
      meta.appendChild(el("div", "cta-todo-line", "待辦：" + todos));
    }
    row.appendChild(meta);

    var ctrls = el("div", "cta-ctrls");
    if (act.kind === "pending" || act.kind === "overdue" || act.kind === "close") {
      // 一致排序與字樣：每列皆「已聯繫（墨）｜送件結案（綠）」
      ctrls.appendChild(ctaContacted(id));
      ctrls.appendChild(ctaButton("結案", "close", id, "cta-ok", false, TIP_CLOSE));
    } else if (act.kind === "amount") {
      ctrls.appendChild(ctaButton("補成交金額", "amount", id, "cta-accent"));
    }
    var rs = reassignSelect(id);
    if (rs) ctrls.appendChild(rs);
    var url = airtableUrl(id);
    if (url) {
      var lk = el("a", "cta cta-link", "🔗 詳情");
      lk.setAttribute("href", url);
      lk.setAttribute("target", "_blank");
      lk.setAttribute("rel", "noopener noreferrer");
      ctrls.appendChild(lk);
    }
    row.appendChild(ctrls);
    return row;
  }

  /* =============================================================================
   * 貳 · 切片下拉
   * ========================================================================== */
  function fillSelect(sel, values, allLabel, current, labelFn) {
    if (!sel) return;
    var prev = current != null ? current : sel.value;
    clear(sel);
    var optAll = el("option", null, allLabel);
    optAll.value = "";
    sel.appendChild(optAll);
    (values || []).forEach(function (v) {
      if (v == null || v === "") return;
      var o = el("option", null, labelFn ? labelFn(v) : v);
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
    R._owners = sl.owners || [];
    fillSelect($("slice-owner"), sl.owners, "全部承辦人", R._filters.owner, displayOwner);
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
  var QUEUE_COLS = ["委託人", "案件類型", "承辦人", "狀態", "等候", "下一步"];

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
    if (f.owner && displayOwner(rec.承辦人) !== f.owner) return false;
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
    tdName.appendChild(el("span", "client-name", clientLabel(rec.委託人)));
    if (rec.電話) tdName.appendChild(el("a", "client-phone", "📞 " + rec.電話)).setAttribute("href", "tel:" + rec.電話);
    tr.appendChild(tdName);

    // 案件類型
    tr.appendChild(el("td", null, rec.案件類型 || "—"));

    // 承辦人（方形頭像）
    var tdOwner = el("td");
    var oc = el("span", "owner-cell");
    oc.appendChild(avatar(rec.承辦人, { title: true }));
    oc.appendChild(el("span", null, displayOwner(rec.承辦人) || "未指派"));
    tdOwner.appendChild(oc);
    tr.appendChild(tdOwner);

    // 狀態：可變更下拉（跟進中／人工接管中／已完成 → 經 proxy 走 bot 接管／恢復／結案）
    var tdStatus = el("td");
    tdStatus.appendChild(statusSelect(rec.id, rec.狀態, item.level));
    tr.appendChild(tdStatus);

    // 等候天數
    var tdWait = el("td");
    var w = el("span", "wait-days lvl-" + (item.level || "ok"), item.waitLabel || fmtDays(item.waitDays));
    tdWait.appendChild(w);
    tr.appendChild(tdWait);

    // 下一步 CTA
    var tdCta = el("td", "queue-cta-cell");
    tdCta.appendChild(buildQueueCta(item));
    tr.appendChild(tdCta);

    return tr;
  }

  /* 改派下拉：來源＝團隊名冊（QJ.TEAM_ROSTER）；寫回「名字 (uid)」相容 bot 委派團隊成員。 */
  function reassignSelect(id) {
    if (!(window.QJ && QJ.REASSIGN_ENABLED === true)) return null;
    var roster = (window.QJ && QJ.TEAM_ROSTER) || [];
    if (!roster.length) return null;
    var sel = el("select", "reassign-select");
    sel.setAttribute("data-id", id || "");
    sel.setAttribute("title", "改派承辦人");
    var ph = el("option", null, "改派給…"); ph.value = ""; sel.appendChild(ph);
    roster.forEach(function (m) {
      var o = el("option", null, m.name); o.value = QJ.delegateeValue(m); sel.appendChild(o);
    });
    return sel;
  }

  function buildQueueCta(item) {
    var rec = item.rec || {};
    var next = item.nextCTA || { type: "contacted", label: "已聯繫" };
    var id = rec.id;
    var t = next.type;
    var wrap = el("span", "qcta-wrap");
    if (t === "close") wrap.appendChild(ctaButton(next.label || "結案", "close", id, "cta-ok", false, TIP_CLOSE));
    else if (t === "amount") wrap.appendChild(ctaButton(next.label || "補金額", "amount", id, "cta-accent"));
    else wrap.appendChild(ctaButton(next.label || "已聯繫", "contacted", id, "cta-ink"));
    var rs = reassignSelect(id);
    if (rs) wrap.appendChild(rs);
    return wrap;
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
        ? "這個篩選條件下沒有案件，調整看看上面的篩選。"
        : "目前沒有進行中的案件。";
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

  /* 結案分組清單：{label,count}[] → 「名稱 … N 件」行（最多 cap 條，其餘摺疊為「其他 M 件」） */
  function closedList(title, rows, cls, emptyText, cap) {
    var box = el("div", "deal-sub " + cls);
    box.appendChild(el("h4", null, title));
    if (!rows || !rows.length) {
      box.appendChild(el("p", "deal-empty", emptyText));
      return box;
    }
    cap = cap || 6;
    var ul = el("ul");
    rows.slice(0, cap).forEach(function (r) {
      var li = el("li", "dl-row");
      li.appendChild(el("span", "dl-left", r.label));
      li.appendChild(el("span", "dl-count", (r.count || 0) + " 件"));
      ul.appendChild(li);
    });
    var rest = rows.slice(cap);
    if (rest.length) {
      var more = rest.reduce(function (s, r) { return s + (r.count || 0); }, 0);
      var li2 = el("li", "dl-row dl-overflow");
      li2.appendChild(el("span", "dl-left", "其餘類型"));
      li2.appendChild(el("span", "dl-count", more + " 件"));
      ul.appendChild(li2);
    }
    box.appendChild(ul);
    return box;
  }

  /* 成交紀錄：本月成交（金額>0）的唯讀帳本。只呈現「已成交」——肯定而非催促，絕不顯示缺口
   * （未成交/待補已在上方「其中」行）。空狀態是引導，不是 NT$0 指控。金色合計＝他的業績。 */
  function renderDealsReview(d, host) {
    var recs = d.honestRecs || [];
    var box = el("div", "deal-sub deals-review");
    var h = el("h4", null, "成交紀錄");
    h.appendChild(el("span", "dr-scope", "本月（" + ((new Date()).getMonth() + 1) + " 月 1 日起）"));
    box.appendChild(h);
    if (!recs.length) {
      box.appendChild(el("p", "deal-empty",
        "本月尚無成交紀錄。案件結案並登記成交後，紀錄會顯示在這裡。"));
      host.appendChild(box); return;
    }
    box.appendChild(el("div", "dr-sum", fmtMoney(d.honestAmount)));
    box.appendChild(el("div", "dr-sum-label", "本月成交合計・共 " + d.honestCount + " 件"));
    var ul = el("ul", "dr-list");
    recs.forEach(function (r) {
      var li = el("li", "dr-row");
      var l1 = el("div", "dr-l1");
      l1.appendChild(el("span", "dr-name", clientLabel(r.委託人)));
      l1.appendChild(el("span", "dr-amt", fmtMoney(r.成交金額)));
      li.appendChild(l1);
      var l2 = el("div", "dr-l2");
      var cd = (r.結案日期 instanceof Date) ? r.結案日期 : null;  // 已正規化為 Date；render 無 toDate
      l2.appendChild(el("span", "dr-meta",
        (r.案件類型 || "未分類")
        + (cd ? "・" + (cd.getMonth() + 1) + "/" + cd.getDate() + " 結案" : "")
        + "・" + (displayOwner(r.承辦人) || "未指派")));
      var url = airtableUrl(r.id);
      if (url) {
        var a = el("a", "dr-link", "🔗");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        a.title = "在 Airtable 開啟（如金額有誤可於此修正）";
        l2.appendChild(a);
      }
      li.appendChild(l2);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    host.appendChild(box);
  }

  function renderDealTrack(state) {
    var host = $("deal-track"); if (!host) return;
    clear(host);
    var d = state.deal || { monthClosedCount: 0, byType: [], byOwner: [], honestCount: 0, honestAmount: 0, closable: [] };
    R._honestAmount = d.honestAmount || 0; R._honestCount = d.honestCount || 0; // 供守線橫幅判斷是否已有實測成交

    host.appendChild(el("h3", null, "本月結案進度"));

    host.appendChild(el("div", "deal-amount", String(d.monthClosedCount || 0)));
    host.appendChild(el("div", "deal-amount-label",
      (d.monthClosedCount > 0) ? "本月已結案件數" : "本月尚無結案記錄"));

    if (d.monthClosedCount > 0 && d.dailyPace != null) {
      var pace = (d.dailyPace % 1 === 0) ? String(d.dailyPace) : d.dailyPace.toFixed(1);
      host.appendChild(el("div", "deal-pace", "本月已過 " + d.daysElapsed + " 天・平均每天 " + pace + " 件"));
    }
    // 結果分布：純二元——成交（金額>0）・未成交（金額=0）。「待補」不顯示。
    if (d.monthClosedCount > 0) {
      var parts = [];
      if (d.honestCount > 0) parts.push("成交 " + d.honestCount + " 件（" + fmtMoney(d.honestAmount) + "）");
      if (d.lostCount > 0) parts.push("未成交 " + d.lostCount + " 件");
      if (parts.length) host.appendChild(el("div", "deal-target", "其中：" + parts.join("・")));
      renderDealsReview(d, host);  // 成交紀錄帳本（只收成交，肯定而非催促）
    }

    host.appendChild(closedList("案件類型分布", d.byType, "by-type", "本月暫無結案案件", 6));
    host.appendChild(closedList("各承辦人結案件數", d.byOwner, "by-owner", "本月暫無結案案件", 5));
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
      hwrap.appendChild(el("div", "team-name", displayOwner(t.owner) || "未指派"));
      hwrap.appendChild(el("div", "team-load-label", "進行中 " + (t.load != null ? t.load : "—") + " 件"));
      head.appendChild(hwrap);
      card.appendChild(head);

      var stats = el("div", "team-stats");
      var s1 = el("div", "team-stat active");
      s1.appendChild(el("b", null, String(t.active || 0)));
      s1.appendChild(el("span", null, "進行中"));
      stats.appendChild(s1);
      var s2 = el("div", "team-stat overdue");
      s2.appendChild(el("b", null, String(t.overdue || 0)));
      s2.appendChild(el("span", null, "待跟進"));
      stats.appendChild(s2);
      card.appendChild(stats);

      if (t.avgRespHrs != null && !isNaN(t.avgRespHrs)) {
        var meta = el("div", "team-meta");
        var rtxt = t.avgRespHrs < 24 ? (Math.round(t.avgRespHrs) + " 小時") : (Math.round(t.avgRespHrs / 2.4) / 10 + " 天");
        var respWin = (window.QJ && QJ.RESP_WINDOW_DAYS) || 14;
        meta.appendChild(document.createTextNode("平均首覆 " + rtxt));
        meta.appendChild(el("span", "team-meta-sub", "（近 " + respWin + " 天進線）"));
        meta.title = "近 " + respWin + " 天進線案件的系統內首次回應時間平均；OA Manager 的回覆系統無法記錄，不計入。";
        card.appendChild(meta);
      }

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
  // 結案結果選擇器（forced-outcome 2026-06-27, 嚴格版）：結案一律必須選「成交（填金額）」
  // 或「未成交（一鍵）」—— 取代原本「金額留空直接結案」的零摩擦跳過。成交金額登記率的關鍵
  // 槓桿；狀態下拉改為已完成時也走這個選擇器（無旁路）。
  R.openCloseOutcome = function (host, id) {
    if (!host) return;
    var exist = host.querySelector('.inline-edit[data-edit-id="' + cssEscape(id) + '"]');
    if (exist) { var i0 = exist.querySelector(".amt-input"); if (i0) i0.focus(); return; }

    var wrap = el("span", "inline-edit close-outcome");
    wrap.setAttribute("data-edit-id", id);
    wrap.setAttribute("data-edit-cta", "close");
    wrap.appendChild(el("span", "co-label", "本案結果？"));

    var inp = el("input", "amt-input");
    inp.type = "number"; inp.min = "1"; inp.step = "1";
    inp.placeholder = "成交金額";
    inp.setAttribute("data-id", id);
    inp.setAttribute("aria-label", "成交金額");
    wrap.appendChild(inp);

    wrap.appendChild(ctaButton("成交結案", "close-confirm", id, "cta-ok", false, "填入成交金額後送件結案"));
    wrap.appendChild(ctaButton("未成交", "close-lost", id, "cta-accent", false, "本案未成交結案（成交金額記為 0）"));

    var cancel = el("button", "cta", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", function () {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    });
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
