/* =============================================================================
 * 全謹代書每日營運登記簿 — orchestrator (app.js)
 * boot → ensure 憑證 → detectSchema → fetch → analyze → render + charts → 輪詢
 * CTA：樂觀更新 → PATCH →（成功）以伺服器值 reconcile /（失敗）回滾；逐筆同步紀錄
 * ========================================================================== */
(function () {
  "use strict";
  var QJ = window.QJ; if (!QJ) return;
  var S = QJ.SETTINGS;
  var state = { records: [], analysis: null, pollTimer: null, booting: false };
  var processed = 0;

  function nowISO() { return new Date().toISOString(); }
  function hhmm() {
    var d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (x) { return String(x).padStart(2, "0"); }).join(":");
  }
  function findRec(id) { for (var i = 0; i < state.records.length; i++) if (state.records[i].id === id) return state.records[i]; return null; }
  function replaceRec(id, rec) { for (var i = 0; i < state.records.length; i++) if (state.records[i].id === id) { state.records[i] = rec; return; } }
  function val(id) { var el = document.getElementById(id); return el ? el.value : ""; }
  function setStatus(t, on) { QJ.render && QJ.render.setStatus && QJ.render.setStatus(t, on); }
  function toast(m, k) { QJ.render && QJ.render.toast && QJ.render.toast(m, k); }
  function log(action, ok, msg) { QJ.render && QJ.render.pushSyncLog && QJ.render.pushSyncLog({ time: hhmm(), action: action, ok: ok, msg: msg }); }
  function bumpProcessed(d) { processed = Math.max(0, processed + d); QJ.render && QJ.render.setProcessedCount && QJ.render.setProcessedCount(processed); }

  function showApp() {
    var g = document.getElementById("setup-gate"), a = document.getElementById("app");
    if (g) g.style.display = "none";
    if (a) a.style.display = "";
  }

  function analyzeAndRender(diff) {
    var prev = state.analysis;
    state.analysis = QJ.logic.analyze(state.records, S);
    if (diff && prev && QJ.render.diffUpdate) QJ.render.diffUpdate(prev, state.analysis);
    else QJ.render.renderApp(state.analysis);
    if (QJ.charts && QJ.charts.renderCharts) { try { QJ.charts.renderCharts(state.analysis); } catch (e) { /* charts fail-soft */ } }
  }

  function refresh(diff) {
    setStatus("更新中…", true);
    return QJ.airtable.fetchRecords().then(function (recs) {
      state.records = recs;
      analyzeAndRender(diff);
      setStatus("資料同步中", true);
    }).catch(function (e) {
      setStatus("連線中斷——將自動重試", false);
      toast("讀取失敗（" + (e && e.status || "網路") + "）。已保留目前畫面，下次輪詢會自動重試。", "danger");
    });
  }

  /* 24/7 代理戰績橫幅：獨立於 25 秒紀錄輪詢（這些數字不會分秒變動）。失敗 → 橫幅隱藏。 */
  function refreshStats() {
    if (!QJ.airtable.fetchStats) return;
    QJ.airtable.fetchStats().then(function (s) {
      if (QJ.render && QJ.render.renderAgentBanner) QJ.render.renderAgentBanner(s);
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () {
      if (document.hidden) return;
      if (document.querySelector(".inline-edit")) return; // 正在輸入成交金額／結案，勿讓輪詢重繪洗掉未送出的輸入
      refresh(true);
    }, (S.pollSeconds || 25) * 1000);
  }

  /* ---- CTA：一律走後端寫回代理（樂觀更新 → cta → reconcile / rollback）。
   *      proxy 為必要條件（登入已強制兩把鑰匙）；未設定或未帶 action → 拒絕，
   *      不做直連寫入，避免「有時通知、有時不通知」的不一致行為。 */
  function doPatch(id, semanticPatch, optimistic, label, proxyAction) {
    var rec = findRec(id); if (!rec) return;
    if (!proxyAction || !(QJ.proxyConfigured && QJ.proxyConfigured())) {
      toast("尚未設定寫入代理，無法寫入。請重新整理並輸入正確的代理密鑰。", "danger");
      return;
    }
    var snapshot = Object.assign({}, rec); // 淺拷貝，保留原始基本值供回滾（fields 為唯讀參照）
    if (optimistic) optimistic(rec);
    analyzeAndRender(true);
    bumpProcessed(+1);
    QJ.airtable.cta(id, proxyAction).then(function () {
      log(label, true, "已透過後端安全寫入（含鎖／通知／稽核）");
      toast("✓ 已安全寫入", "ok");
      refresh(true); // 以伺服器真相重抓校正
    }).catch(function (e) {
      replaceRec(id, snapshot);           // 失敗回滾
      analyzeAndRender(true);
      bumpProcessed(-1);
      log(label, false, "寫回失敗（" + (e && e.status || "網路") + "）已回滾");
      toast("寫回失敗（" + (e && e.status || "網路") + "）。已還原這筆，請重試。", "danger");
    });
  }

  function onClick(ev) {
    var btn = ev.target.closest ? ev.target.closest("[data-cta]") : null;
    if (!btn) return;
    var cta = btn.getAttribute("data-cta"), id = btn.getAttribute("data-id");
    if (!id) return;

    if (cta === "amount" || cta === "close") {
      var host = (btn.closest && (btn.closest(".queue-cta-cell") || btn.closest(".cta-ctrls") || btn.closest(".dl-row"))) || btn.parentNode;
      QJ.render.openInlineAmount && QJ.render.openInlineAmount(host, id, cta);
      return;
    }

    if (cta === "contacted") {
      var rc = findRec(id), pc = { 最後互動時間: nowISO() };
      if (rc && !rc.首次回應時間) pc.首次回應時間 = nowISO(); // 首次團隊回應 → 解鎖回應延遲/平均首覆
      doPatch(id, pc, function (r) { r.lastInteraction = new Date(); if (rc && !rc.首次回應時間) r.首次回應時間 = new Date(); }, "標記已聯繫", { action: "contacted" });
      return;
    }
    if (cta === "amount-confirm") {
      var v = QJ.render.getInlineAmount ? QJ.render.getInlineAmount(id) : null;
      var n = Number(v);
      // 須 > 0：成交金額=0 會被生產 CRM 衍生為「未成交」。若未成交請改用「送件結案」不填金額（留待補記）。
      if (!(n > 0)) { toast("請輸入大於 0 的成交金額。若此案未成交，請改用「送件結案」不填金額（保留待補記）。", "warn"); return; }
      var r0 = findRec(id), patch = { 成交金額: n };
      if (r0 && !r0.結案日期) patch.結案日期 = QJ.todayISODate();
      doPatch(id, patch, function (r) { r.成交金額 = n; if (!r.結案日期) r.結案日期 = new Date(); }, "補登成交金額", { action: "amount", amount: n });
      QJ.render.closeInlineAmount && QJ.render.closeInlineAmount(id);
      return;
    }
    if (cta === "close-confirm") {
      var rcf = findRec(id);
      if (!window.confirm("確定結案「" + ((rcf && rcf.委託人) || "此案") + "」？\n結案後會從清單移除，需逐筆恢復。")) return;
      var v2 = QJ.render.getInlineAmount ? QJ.render.getInlineAmount(id) : null;
      var patch2 = { 狀態: QJ.STATUS.DONE, 結案日期: QJ.todayISODate() };
      var n2 = Number(v2);
      // 只在金額 > 0 時寫入；0/空白 → 留待補記，避免把結案誤標為「未成交」
      var hasAmt = (v2 != null && v2 !== "" && n2 > 0);
      if (hasAmt) patch2.成交金額 = n2;
      if (rcf && !rcf.首次回應時間) patch2.首次回應時間 = nowISO();
      doPatch(id, patch2, function (r) { r.狀態 = QJ.STATUS.DONE; r.結案日期 = new Date(); if (hasAmt) r.成交金額 = n2; if (rcf && !rcf.首次回應時間) r.首次回應時間 = new Date(); }, "送件結案", { action: "close", amount: hasAmt ? n2 : undefined });
      QJ.render.closeInlineAmount && QJ.render.closeInlineAmount(id);
      return;
    }
    // reassign（改派）v1 停用：按鈕為 disabled，不會走到這
  }

  function onSliceChange() {
    QJ.render.applyFilters && QJ.render.applyFilters({ type: val("slice-type"), owner: val("slice-owner"), status: val("slice-status") });
  }

  /* 客戶佇列「狀態」下拉變更 → 經 proxy 走 bot：人工接管中=接管、跟進中=恢復、已完成=結案 */
  function onStatusChange(t) {
    var id = t.getAttribute("data-id"), cur = t.getAttribute("data-current"), next = t.value;
    if (!id || !next || next === cur) return;
    var rec = findRec(id), nm = (rec && rec.委託人) || "此案";
    var S = QJ.STATUS, action, label, confirmMsg;
    if (next === S.HUMAN) { action = "takeover"; label = "接管"; }
    else if (next === S.OPEN) {
      action = "restore"; label = "交回智能助手";
      confirmMsg = "交回智能助手（恢復跟進）「" + nm + "」？" +
        ((QJ.proxyConfigured && QJ.proxyConfigured()) ? "\n系統會通知客戶已恢復服務。" : "");
    } else if (next === S.DONE) {
      action = "close"; label = "結案";
      confirmMsg = "確定結案「" + nm + "」？\n結案後會從清單移除，需逐筆恢復。";
    } else { t.value = cur; return; }
    if (confirmMsg && !window.confirm(confirmMsg)) { t.value = cur; return; }
    doPatch(id, { 狀態: next }, function (r) { r.狀態 = next; }, label, { action: action });
  }

  function boot() {
    if (state.booting) return;
    state.booting = true;
    if (!QJ.auth.ensure()) { state.booting = false; return; } // 無憑證 → Setup Gate
    showApp();

    document.addEventListener("click", onClick);
    document.addEventListener("change", function (ev) {
      var t = ev.target;
      if (t && t.classList && t.classList.contains("reassign-select")) {
        var rid = t.getAttribute("data-id"), val = t.value;
        if (rid && val) {
          var rr = findRec(rid), wasOpen = !!(rr && rr.狀態 === QJ.STATUS.OPEN);
          var patchR = { 承辦人: val };
          if (wasOpen) patchR.狀態 = QJ.STATUS.HUMAN; // 鏡像 bot：改派即接管，避免 bot 仍自動回覆
          if (rr && !rr.首次回應時間) patchR.首次回應時間 = nowISO();
          doPatch(rid, patchR, function (r) { r.承辦人 = val; if (wasOpen) r.狀態 = QJ.STATUS.HUMAN; if (rr && !rr.首次回應時間) r.首次回應時間 = new Date(); }, "改派承辦人", { action: "reassign", owner: val });
          toast("已改派並已通知該同仁。", "info");
        }
        t.value = "";
      } else if (t && t.classList && t.classList.contains("cta-slice")) {
        QJ.render.applyCtaFilter && QJ.render.applyCtaFilter(t.getAttribute("data-facet"), t.value);
      } else if (t && t.classList && t.classList.contains("status-select")) {
        onStatusChange(t);
      }
    });
    ["slice-type", "slice-owner", "slice-status"].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.addEventListener("change", onSliceChange);
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && state.analysis && !document.querySelector(".inline-edit")) refresh(true); });

    setStatus("連線中…", false);
    QJ.airtable.detectSchema().then(function () {
      return refresh(false);
    }).then(function () {
      startPolling();
      refreshStats();
      if (!state.statsTimer) state.statsTimer = setInterval(refreshStats, 120000);
      state.booting = false;
    }).catch(function (e) {
      state.booting = false;
      setStatus("初始化失敗", false);
      toast("初始化失敗（" + (e && e.status || "網路 / 權限") + "）。請確認 PAT 權限與 Base ID，或在右上角清除憑證重新設定。", "danger");
    });
  }

  QJ.app = { boot: boot, refresh: refresh };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
