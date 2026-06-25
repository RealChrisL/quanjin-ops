/* =============================================================================
 * 全謹代書每日營運登記簿 — logic.js（分析／邏輯層）
 * 純函式 · 無 DOM · 無網路 · 掛在 window.QJ.logic
 *
 * 吃 airtable.js 正規化後的 NormRecord[]，吐出 render/charts 共用的 State。
 * 嚴格依照 config.js 合約實作。所有啟發式皆以中文註解說明。
 * ========================================================================== */

(function () {
  "use strict";

  window.QJ = window.QJ || {};

  var DAY_MS = 24 * 60 * 60 * 1000;

  /* ---------------------------------------------------------------------------
   * 小工具：防禦性的型別轉換（缺欄位／null／字串日期／非數字金額都不可炸）
   * ------------------------------------------------------------------------- */

  // 寬鬆轉 Date：接受 Date 物件、ISO 字串、可被 Date 解析的字串。
  // 無效（null/空字串/NaN/非合理年份）一律回 null，呼叫端統一以 null 處理。
  function toDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return isValidDate(v) ? v : null;
    if (typeof v === "number") {
      var dn = new Date(v);
      return isValidDate(dn) ? dn : null;
    }
    if (typeof v === "string") {
      var s = v.trim();
      if (!s) return null;
      var d = new Date(s);
      return isValidDate(d) ? d : null;
    }
    return null;
  }

  function isValidDate(d) {
    if (!(d instanceof Date)) return false;
    var t = d.getTime();
    if (isNaN(t)) return false;
    // 防呆：拒絕明顯不合理的年份（Airtable 不會有 < 1970 或 > 此刻 +10 年的營運日期）
    var y = d.getFullYear();
    if (y < 1970 || y > new Date().getFullYear() + 10) return false;
    return true;
  }

  // 寬鬆轉數字：接受 number、可解析的字串（含逗號/全形空白/貨幣符號）。
  // 非數字 → null。
  function toNumber(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string") {
      var s = v.replace(/[,\s　$＄NT元]/g, "").trim();
      if (!s) return null;
      var n = Number(s);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  // 寬鬆取字串（trim）；缺值 → ""。
  function toStr(v) {
    if (v == null) return "";
    return String(v).trim();
  }

  /* ---------------------------------------------------------------------------
   * reconcileLastInteraction(rec)
   * 「上次互動時間取多欄最新值」正確性需求。
   *
   * 邏輯：讀 QJ.airtable.fieldMap.lastInteractionCandidates（若無，退回
   *       config.js 的 QJ.FIELD_MAP_DEFAULTS.lastInteractionCandidates），
   *       逐一從 rec.fields 取出可解析為有效 Date 的候選，回傳「最新」的那個
   *       與其來源欄位名。
   *
   * 防禦：① rec / rec.fields 可能缺；② 若已預先算好（rec.lastInteraction），
   *       且本函式從候選欄位找不到任何有效值時，退回已算好的值；③ 無效日期、
   *       字串日期、null 一律忽略。
   * ------------------------------------------------------------------------- */
  function reconcileLastInteraction(rec) {
    var EMPTY = { date: null, field: "" };
    if (!rec || typeof rec !== "object") return EMPTY;

    var fields = (rec.fields && typeof rec.fields === "object") ? rec.fields : null;

    // 取候選欄位清單：優先 airtable.fieldMap（執行期使用者確認過的對應），
    // 否則退回 config 預設。
    var candidates = null;
    try {
      if (window.QJ && QJ.airtable && QJ.airtable.fieldMap &&
          Array.isArray(QJ.airtable.fieldMap.lastInteractionCandidates)) {
        candidates = QJ.airtable.fieldMap.lastInteractionCandidates;
      }
    } catch (e) { /* 忽略：退回預設 */ }
    if (!candidates) {
      try {
        if (window.QJ && QJ.FIELD_MAP_DEFAULTS &&
            Array.isArray(QJ.FIELD_MAP_DEFAULTS.lastInteractionCandidates)) {
          candidates = QJ.FIELD_MAP_DEFAULTS.lastInteractionCandidates;
        }
      } catch (e2) { /* 仍無 → candidates 留 null */ }
    }

    var best = null;     // 目前最新的 Date
    var bestField = "";  // 來源欄位名

    if (fields && candidates) {
      // 優先序 coalesce（非取最新）：依候選順序取「第一個有值」的欄位即停。
      for (var i = 0; i < candidates.length; i++) {
        var key = candidates[i];
        if (!key) continue;
        if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
        var d = toDate(fields[key]);
        if (!d) continue;
        best = d;
        bestField = key;
        break;
      }
    }

    // 退回已預先計算好的值（NormRecord.lastInteraction / lastInteractionField）
    if (best === null) {
      var pre = toDate(rec.lastInteraction);
      if (pre) {
        return { date: pre, field: toStr(rec.lastInteractionField) };
      }
      return EMPTY;
    }

    return { date: best, field: bestField };
  }

  /* ---------------------------------------------------------------------------
   * 取一筆紀錄的「上次互動時間」：先用已正規化的 rec.lastInteraction，
   * 缺則用 reconcileLastInteraction 重新對帳。
   * ------------------------------------------------------------------------- */
  function lastInteractionOf(rec) {
    var d = toDate(rec.lastInteraction);
    if (d) return d;
    return reconcileLastInteraction(rec).date;
  }

  // 案件是否已完成（狀態對齊 prod 三態的「已完成」）。
  function isDone(rec) {
    return toStr(rec && rec.狀態) === QJ.STATUS.DONE;
  }
  // 是否人工接管中。
  function isHuman(rec) {
    return toStr(rec && rec.狀態) === QJ.STATUS.HUMAN;
  }

  /* ---------------------------------------------------------------------------
   * waitDays：距今幾天未互動。
   * 啟發式：以「上次互動時間」為基準；若無 → 退回「建立時間」；兩者皆無 → 0。
   *         floor((now − base)/day)，負值夾為 0（時鐘偏移/未來日期防呆）。
   * 僅對「非已完成」紀錄計算。
   * ------------------------------------------------------------------------- */
  function computeWaitDays(rec, now) {
    var base = lastInteractionOf(rec);
    if (!base) base = toDate(rec.建立時間);
    if (!base) return 0;
    var diff = now.getTime() - base.getTime();
    if (diff < 0) diff = 0;
    return Math.floor(diff / DAY_MS);
  }

  /* 互動基準時間：客戶最後互動，缺則退回建立時間。 */
  function interactionBase(rec) { return lastInteractionOf(rec) || toDate(rec.建立時間); }

  /* 經過時數：from→to 的實際經過小時數（不分時段）。逾期門檻用。 */
  function elapsedHours(from, to) {
    if (!from || !to || to <= from) return 0;
    return (to.getTime() - from.getTime()) / 3600000;
  }

  /* 營業時數：from→to 落在 TPE 工作日營業時段（預設 09–18）內的小時數。待回門檻用。
     台北無日光節約 → 以 UTC+8 牆鐘判斷，與瀏覽器時區無關。 */
  var TPE_OFFSET_MS = 8 * 3600000;
  var DEFAULT_OH = { startHour: 9, endHour: 18, workdays: [1, 2, 3, 4, 5] };
  function businessHoursBetween(from, to, oh) {
    if (!from || !to || to <= from) return 0;
    oh = oh || DEFAULT_OH;
    if ((to.getTime() - from.getTime()) > 21 * 86400000) return 21 * Math.max(1, oh.endHour - oh.startHour);
    var work = {}; (oh.workdays || DEFAULT_OH.workdays).forEach(function (d) { work[d] = true; });
    var STEP = 15 * 60 * 1000, acc = 0, cur = from.getTime(), end = to.getTime();
    while (cur < end) {
      var dt = new Date(cur + TPE_OFFSET_MS), h = dt.getUTCHours() + dt.getUTCMinutes() / 60;
      if (work[dt.getUTCDay()] && h >= oh.startHour && h < oh.endHour) acc += STEP;
      cur += STEP;
    }
    return acc / 3600000;
  }

  /* level：逾期＝實際經過 ≥ overdueHours（不分時段）；待回＝營業時段經過 ≥ pendingReplyHours。 */
  function levelOf(realH, bizH, settings) {
    var pendingH = numOr(settings && settings.pendingReplyHours, 4);
    var overdueH = numOr(settings && settings.overdueHours, 24);
    if (realH >= overdueH) return "overdue";
    if (bizH >= pendingH) return "pending";
    return "ok";
  }
  /* 等候標籤：實際經過時間 → 「N 分鐘」/「N 小時」/「N 天」。 */
  function waitLabelOf(eh) {
    if (eh < 1) { var m = Math.max(1, Math.round(eh * 60)); return m + " 分鐘"; }
    if (eh < 24) return Math.round(eh) + " 小時";
    return Math.floor(eh / 24) + " 天";
  }

  function numOr(v, dflt) {
    var n = (typeof v === "number" && isFinite(v)) ? v : Number(v);
    return isFinite(n) ? n : dflt;
  }

  /* ---------------------------------------------------------------------------
   * 月份判斷：結案日期是否落在「此刻」的當月（本地時區、日曆月）。
   * ------------------------------------------------------------------------- */
  function inCurrentMonth(d, now) {
    if (!d) return false;
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }

  /* ---------------------------------------------------------------------------
   * nextCTA：佇列每列的下一步行動建議。
   *   逾期(overdue)      → 標記已聯繫（先把熱度補回來）
   *   人工接管中         → 送件結案（人已接手，下一步通常是結案）
   *   其他               → 標記已聯繫
   * ------------------------------------------------------------------------- */
  function nextCTAOf(rec, level) {
    if (level === "pending" || level === "overdue") {
      return { type: "contacted", label: "標記已聯繫" };
    }
    if (isHuman(rec)) {
      return { type: "close", label: "送件結案" };
    }
    return { type: "contacted", label: "標記已聯繫" };
  }

  /* ---------------------------------------------------------------------------
   * analyze(records, settings) → State（嚴格依 config.js 合約）
   * ------------------------------------------------------------------------- */
  function analyze(records, settings) {
    var now = new Date();
    settings = settings || (window.QJ && QJ.SETTINGS) || {};
    var recs = Array.isArray(records) ? records.filter(function (r) { return r && typeof r === "object"; }) : [];

    var monthlyTarget = (settings.monthlyTarget == null) ? null : numOr(settings.monthlyTarget, null);

    /* ---- 逐筆計算 waitDays / level（僅非已完成）並組 queue ---- */
    var queue = [];
    var active = [];   // 非已完成
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i];
      if (isDone(rec)) continue;
      active.push(rec);
      var eh = elapsedHours(interactionBase(rec), now);
      var bh = businessHoursBetween(interactionBase(rec), now, settings.officeHours);
      var lv = levelOf(eh, bh, settings);
      queue.push({
        rec: rec,
        waitDays: computeWaitDays(rec, now),
        waitHours: eh,
        waitLabel: waitLabelOf(eh),
        level: lv,
        nextCTA: nextCTAOf(rec, lv),
      });
    }
    // 等候最久者置頂
    queue.sort(function (a, b) { return b.waitHours - a.waitHours; });

    var pendingRows = queue.filter(function (q) { return q.level === "pending"; }); // 🔴 待回
    var pendingCount = pendingRows.length;
    var overdueRows = queue.filter(function (q) { return q.level === "overdue"; }); // 🟠 逾期
    var overdueCount = overdueRows.length;

    /* ---- deal：本月結案吞吐量（不再衡量金額——事務所結案多半不登成交金額）---- */
    // 可結案（actionable）：狀態===人工接管中 = 人已接手、下一步即送件結案。
    var closable = active.filter(function (r) { return isHuman(r); });
    // 本月結案集：已完成 + 結案日期落在當月 → 統計件數／案型／承辦人／已登金額。
    var monthClosedCount = 0, honestCount = 0, honestAmount = 0;
    var closeTypeMap = {}, closeOwnerMap = {};
    for (var mi = 0; mi < recs.length; mi++) {
      var mr = recs[mi];
      if (!isDone(mr)) continue;
      var mcd = toDate(mr.結案日期);
      if (!mcd || !inCurrentMonth(mcd, now)) continue;
      monthClosedCount += 1;
      var mty = toStr(mr.案件類型) || "未分類";
      closeTypeMap[mty] = (closeTypeMap[mty] || 0) + 1;
      var mow = (typeof QJ !== "undefined" && QJ.ownerName ? QJ.ownerName(toStr(mr.承辦人)) : toStr(mr.承辦人)) || "未指派";
      closeOwnerMap[mow] = (closeOwnerMap[mow] || 0) + 1;
      var mamt = toNumber(mr.成交金額);
      if (mamt != null && mamt > 0) { honestCount += 1; honestAmount += mamt; }
    }
    var byType = Object.keys(closeTypeMap).map(function (k) { return { label: k, count: closeTypeMap[k] }; }).sort(function (a, b) { return b.count - a.count; });
    var byOwner = Object.keys(closeOwnerMap).map(function (k) { return { label: k, count: closeOwnerMap[k] }; }).sort(function (a, b) { return b.count - a.count; });

    /* ---- team：依承辦人分組 ---- */
    // 空承辦人 → 歸「未指派」。avgRespDays 誠實設 null（無回應歷史可算）。
    var teamMap = {};   // owner → {active, overdue}
    for (var t = 0; t < queue.length; t++) {
      var q = queue[t];
      var owner = toStr(q.rec.承辦人) || "未指派";
      if (!teamMap[owner]) teamMap[owner] = { active: 0, overdue: 0 };
      teamMap[owner].active += 1;
      if (q.level === "overdue" || q.level === "pending") teamMap[owner].overdue += 1; // 待跟進＝待回+逾期
    }
    var ownerNames = Object.keys(teamMap);

    // 過載判斷（overload）：active ≥ max(5, 1.5 × 全體承辦人平均 active)。
    // 平均以「有案在身的承辦人」為母體（未指派也算一組）。
    var meanActive = 0;
    if (ownerNames.length > 0) {
      var sumActive = 0;
      for (var s = 0; s < ownerNames.length; s++) sumActive += teamMap[ownerNames[s]].active;
      meanActive = sumActive / ownerNames.length;
    }
    var overloadThreshold = Math.max(5, 1.5 * meanActive);

    // 平均首覆：對「有首次進線時間＋首次回應時間」者，回應延遲＝首次回應−首次進線（小時），依承辦人平均。
    var respMap = {};
    for (var rp = 0; rp < recs.length; rp++) {
      var rr2 = recs[rp];
      var inq = toDate(rr2.首次進線時間), rsp = toDate(rr2.首次回應時間);
      if (!inq || !rsp || rsp.getTime() < inq.getTime()) continue;
      var ow2 = toStr(rr2.承辦人) || "未指派";
      if (!respMap[ow2]) respMap[ow2] = { sum: 0, n: 0 };
      respMap[ow2].sum += (rsp.getTime() - inq.getTime()) / 3600000;
      respMap[ow2].n += 1;
    }
    var team = ownerNames.map(function (owner) {
      var info = teamMap[owner];
      var flag = (info.active >= overloadThreshold) ? "overload" : "ok";
      var rm = respMap[owner];
      return {
        owner: owner,
        active: info.active,
        overdue: info.overdue,
        avgRespHrs: (rm && rm.n) ? (rm.sum / rm.n) : null,
        load: info.active,
        flag: flag,
      };
    });
    // 案量多者置頂，方便 CEO 一眼看誰最重
    team.sort(function (a, b) { return b.active - a.active; });
    var overloadedOwners = team.filter(function (o) { return o.flag === "overload"; }).length;

    /* ---- kpis ---- */
    // closableToday：今天「可推進結案」的件數 = 待補金額 + 可結案候選。
    var closableToday = closable.length; // 可結案＝人工接管中
    var kpis = {
      pending: pendingCount,                   // 🔴 待回（≥2 小時未回）
      overdueRisk: overdueCount,               // 🟠 逾期（≥1 天未互動/結案）
      awaiting: active.length,                 // 待處理（非已完成）總數
      closableToday: closableToday,            // 今日可結案推進件數
      monthClosed: monthClosedCount,           // 本月結案件數
      overloadedOwners: overloadedOwners,      // 過載承辦人數
    };

    /* ---- actions：本日待辦行動（CTA-first）----
     * 順序：先「補金額 + 結案」（聚焦結案＋補金額），再「逾期追蹤」。
     */
    // 積極跟進優先：先 待回 → 逾期 → 補金額 → 結案
    var actions = [];
    pendingRows.forEach(function (q) {
      actions.push({
        id: q.rec.id, kind: "pending", rec: q.rec, waitLabel: q.waitLabel,
        label: "待回覆：" + (toStr(q.rec.委託人) || "（未具名）") + "（客戶已等 " + q.waitLabel + "）",
      });
    });
    overdueRows.forEach(function (q) {
      actions.push({
        id: q.rec.id, kind: "overdue", rec: q.rec, waitLabel: q.waitLabel,
        label: "逾期跟進：" + (toStr(q.rec.委託人) || "（未具名）") + "（" + q.waitLabel + "未互動）",
      });
    });
    closable.forEach(function (r) {
      actions.push({
        id: r.id, kind: "close", rec: r,
        label: "送件結案：" + (toStr(r.委託人) || "（未具名）"),
      });
    });

    /* ---- slices：去重 + 排序 + 去空 ---- */
    var slices = {
      types: distinctSorted(recs.map(function (r) { return toStr(r.案件類型); })),
      owners: distinctSorted(recs.map(function (r) { return toStr(r.承辦人); })),
      statuses: distinctSorted(recs.map(function (r) { return toStr(r.狀態); })),
    };

    /* ---- summary：單一份每日中文摘要（非早晚兩段）---- */
    var summaryText = buildSummaryText({
      pending: pendingCount,
      overdue: overdueCount,
      closable: closableToday,
      active: active.length,
    });

    /* ---- charts：Agent D 的 charts.js 直接消費 ---- */
    var charts = buildCharts(active, recs, now, monthlyTarget);

    return {
      summary: { text: summaryText, pending: pendingCount, overdue: overdueCount, closable: closableToday },
      kpis: kpis,
      queue: queue,
      team: team,
      deal: {
        monthClosedCount: monthClosedCount,
        byType: byType,
        byOwner: byOwner,
        honestCount: honestCount,
        honestAmount: honestAmount,
        closable: closable,
      },
      actions: actions,
      slices: slices,
      charts: charts,
    };
  }

  /* ---------------------------------------------------------------------------
   * buildSummaryText：單一份每日中文摘要。
   * 提及：逾期件數、可結案件數、待補金額件數、待處理總數。
   * ------------------------------------------------------------------------- */
  function buildSummaryText(c) {
    var parts = [];
    parts.push("今日共 " + c.active + " 件進行中案件");
    if (c.pending > 0) parts.push("🟠 " + c.pending + " 件待回覆（客戶等逾 4 營業時）");
    if (c.overdue > 0) parts.push("🔴 " + c.overdue + " 件逾期（逾 1 天未互動）");
    if ((c.pending || 0) === 0 && (c.overdue || 0) === 0) parts.push("目前無待回/逾期案件");
    if (c.closable > 0) parts.push("有 " + c.closable + " 件可推進結案");
    var head = parts.join("，") + "。";
    if (c.pending > 0 || c.overdue > 0) {
      head += "請積極跟進——回覆客戶，或處理結案。";
    } else if (c.closable > 0) {
      head += "建議推進可結案的案件。";
    } else {
      head += "案況穩定，持續跟進即可。";
    }
    return head;
  }

  /* ---------------------------------------------------------------------------
   * buildCharts：charts-ready 子結構。
   *   types  : 各「案件類型」進行中件數（去空）
   *   owners : 各「承辦人」進行中件數（空 → 未指派）
   *   deals  : 本月「結案日期」逐日累計成交金額序列
   * ------------------------------------------------------------------------- */
  function buildCharts(active, recs, now, monthlyTarget) {
    // ---- types / owners：以「進行中」案件計數 ----
    var typeMap = {};
    var ownerMap = {};
    for (var i = 0; i < active.length; i++) {
      var r = active[i];
      var ty = toStr(r.案件類型);
      if (ty) typeMap[ty] = (typeMap[ty] || 0) + 1;
      // 以「解析後的承辦人名」歸戶：uid→名字，且同一人不同寫法（純 uid / 名字 (uid)）合併為一條
      var ow = (typeof QJ !== "undefined" && QJ.ownerName ? QJ.ownerName(toStr(r.承辦人)) : toStr(r.承辦人)) || "未指派";
      ownerMap[ow] = (ownerMap[ow] || 0) + 1;
    }
    var types = Object.keys(typeMap).sort().map(function (k) { return { label: k, value: typeMap[k] }; });
    var owners = Object.keys(ownerMap).sort().map(function (k) { return { label: k, value: ownerMap[k] }; });

    // 案件類型分布的時間選擇用：每筆 {案型, 建立時間 ms}，由 charts 依所選範圍過濾。
    var typeSeries = [];
    for (var ts = 0; ts < active.length; ts++) {
      var rt = active[ts], tty = toStr(rt.案件類型);
      if (!tty) continue;
      var ct = toDate(rt.首次進線時間) || toDate(rt.建立時間); // CRM 無「建立時間」欄 → 用首次進線時間
      typeSeries.push({ type: tty, created: ct ? ct.getTime() : null });
    }

    // ---- deals：本月逐日累計結案件數 ----
    // 收集本月內、已完成且有結案日期者，依日期排序後累計件數。
    var dayMap = {};   // day(1..31) → 當日結案件數
    for (var d = 0; d < recs.length; d++) {
      var rr = recs[d];
      if (!isDone(rr)) continue;
      var cd = toDate(rr.結案日期);
      if (!cd || !inCurrentMonth(cd, now)) continue;
      var day = cd.getDate();
      dayMap[day] = (dayMap[day] || 0) + 1;
    }
    var labels = [];
    var data = [];
    var cum = 0;
    var sortedDays = Object.keys(dayMap).map(Number).sort(function (a, b) { return a - b; });
    for (var j = 0; j < sortedDays.length; j++) {
      var dy = sortedDays[j];
      cum += dayMap[dy];
      labels.push((now.getMonth() + 1) + "/" + dy);   // 'M/D'
      data.push(cum);
    }

    return {
      types: types,
      typeSeries: typeSeries,
      owners: owners,
      deals: {
        labels: labels,
        data: data,
        target: null,
      },
    };
  }

  /* ---------------------------------------------------------------------------
   * distinctSorted：去重 + 去空白 + 字典序排序。
   * ------------------------------------------------------------------------- */
  function distinctSorted(arr) {
    var seen = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v == null) continue;
      var s = String(v).trim();
      if (!s) continue;
      if (!Object.prototype.hasOwnProperty.call(seen, s)) {
        seen[s] = true;
        out.push(s);
      }
    }
    out.sort();
    return out;
  }

  /* ---- 掛載 ---- */
  QJ.logic = {
    reconcileLastInteraction: reconcileLastInteraction,
    analyze: analyze,
  };

})();
