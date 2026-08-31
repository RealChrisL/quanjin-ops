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

  /* 結案來源稽核：哪些結案走系統、哪些是同仁直接在 Airtable 結的（GET /close-review）。
     獨立於 25 秒輪詢；失敗或未回應 → QJ.closeReview 留空，面板降級為無「結案者」欄。 */
  function refreshCloseReview() {
    if (!QJ.airtable.fetchCloseReview) return;
    QJ.airtable.fetchCloseReview().then(function (cr) {
      if (cr && cr.ok) {
        QJ.closeReview = cr;
        if (state.analysis && QJ.render && QJ.render.renderCloseReview) QJ.render.renderCloseReview(state);
      }
    });
  }

  /* 已結案回訊名冊（GET /returned-uids）：後端把「已結案客戶又回訊」的紀錄靜默轉為
     人工接管中，這份名冊讓面板把它們標成「已結案回訊」而不是新進件。95.4% 的目標
     紀錄沒有結案日期，只靠面板自己的日期訊號會誤標。失敗／未授權 → 名冊留空，
     面板降級為只用結案日期訊號（標得少，不會標錯）。 */
  function refreshReturnedUids() {
    if (!QJ.airtable.fetchReturnedUids) return;
    QJ.airtable.fetchReturnedUids().then(function (r) {
      if (r && r.ok && Array.isArray(r.uids)) {
        var m = {};
        r.uids.forEach(function (u) { if (u) m[u] = true; });
        QJ.returnedUids = m;
      }
    });
  }

  /* 寫入代理存活：戰情室的寫入全走 proxy；隧道／服務掛了時，讀取仍正常（瀏覽器直連 Airtable）
     但每筆結案／修正會無聲失敗。獨立探測 /health（免授權），明確標示「可寫入 / 無法寫入」。 */
  function refreshProxyHealth() {
    if (!(QJ.render && QJ.render.setWriteStatus)) return;
    if (!(QJ.proxyConfigured && QJ.proxyConfigured())) {
      QJ.render.setWriteStatus("off", "未設定寫入");
      return;
    }
    if (!QJ.airtable.fetchHealth) return;
    QJ.airtable.fetchHealth().then(function (ok) {
      QJ.render.setWriteStatus(ok ? "true" : "false", ok ? "寫入正常" : "⚠ 無法寫入");
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () {
      if (document.hidden) return;
      refreshProxyHealth(); // 存活探測獨立於資料輪詢——即使正在輸入也要持續顯示寫入是否可達
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
      refreshCloseReview();
    refreshReturnedUids(); // 修正結果會改變「系統內／系統外」歸屬，重抓來源稽核
    }).catch(function (e) {
      replaceRec(id, snapshot);           // 失敗回滾
      analyzeAndRender(true);
      bumpProcessed(-1);
      log(label, false, "寫回失敗（" + (e && e.status || "網路") + "）已回滾");
      toast("寫回失敗（" + (e && e.status || "網路") + "）。已還原這筆，請重試。", "danger");
      refreshProxyHealth(); // 寫入失敗 → 立即重探存活，讓指示燈反映「無法寫入」
    });
  }

  /* =============================================================================
   * 姓名搜尋 + 已結案自動補查（AUTO-FALLBACK）
   *
   * 兩段式：① 輸入即在「已載入的進行中紀錄」本地切片（零網路）；② debounce 後若本地
   * 零命中，才自動打 ONE 支伺服器端已結案查詢。已完成紀錄約 1,200 筆，整批載入會灌爆
   * 佇列／KPI／圖譜，所以永遠隨選、永不預載、永不翻頁。
   * 防洪三道：debounce 500ms／同一字串只查一次（lastClosedQuery）／同時只允許一支在飛。
   * ========================================================================== */
  var search = { q: "", timer: null, inflight: false, lastClosedQuery: null };
  var SEARCH_DEBOUNCE_MS = 500;

  function onSearchInput(v) {
    search.q = String(v == null ? "" : v).trim();
    QJ.render.applyFilters && QJ.render.applyFilters({ q: search.q });
    if (search.timer) { clearTimeout(search.timer); search.timer = null; }
    if (!search.q) {
      // 清空 → 收掉灰卡區，並讓下次同字串可以重查
      search.lastClosedQuery = null;
      QJ.render.hideClosedResults && QJ.render.hideClosedResults();
      return;
    }
    search.timer = setTimeout(maybeSearchClosed, SEARCH_DEBOUNCE_MS);
  }

  function maybeSearchClosed() {
    var q = search.q;
    if (!q) return;
    // 進行中清單找得到 → 不查已結案（灰卡是「找不到」時才該出現的第二段）
    var hits = QJ.render.localMatchCount ? QJ.render.localMatchCount(q) : 0;
    if (hits > 0) { QJ.render.hideClosedResults && QJ.render.hideClosedResults(); return; }
    if (search.lastClosedQuery === q) return;   // 同一字串已查過，別重打
    if (search.inflight) return;
    runClosedSearch(q);
  }

  function runClosedSearch(q) {
    if (!QJ.airtable.searchClosed) return;
    search.inflight = true;
    search.lastClosedQuery = q;
    QJ.render.renderClosedResults && QJ.render.renderClosedResults({ query: q, loading: true });
    QJ.airtable.searchClosed(q).then(function (recs) {
      search.inflight = false;
      if (search.q !== q) return;               // 使用者已改字串 → 丟棄過期結果
      QJ.render.renderClosedResults && QJ.render.renderClosedResults({ query: q, records: recs || [] });
    }).catch(function (e) {
      search.inflight = false;
      search.lastClosedQuery = null;            // 失敗不快取，讓使用者可重試
      if (search.q !== q) return;
      log("查詢已結案", false, "查詢失敗（" + ((e && e.status) || "網路") + "）");
      QJ.render.renderClosedResults && QJ.render.renderClosedResults({
        query: q,
        error: "已結案紀錄查詢失敗，請稍後再試；若持續發生，請告知全謹系統管理人員。"
      });
    });
  }

  /* 開回：已完成 → 人工接管中。刻意「直寫 Airtable 欄位」而非走 proxy 的 restore／takeover
   * ——那兩條都是 bot verb，會推播訊息給客戶（restore 必推「感謝耐心等候」，takeover 非
   * 上班時段推關懷語）。開回是內部找回紀錄的動作，客戶端必須零側效。
   * 失敗只影響這張卡（狀態未變更），不動佇列、不做樂觀更新。 */
  function doReopen(id, btn) {
    if (!id || !QJ.airtable.reopenRecord) return;
    var nm = (btn && btn.getAttribute("data-name")) || "此案";
    if (!window.confirm("重新開啟「" + nm + "」？案件將轉為人工接管中，可重新指派承辦人。系統不會通知客戶。")) return;
    QJ.render.setClosedCardState && QJ.render.setClosedCardState(id, "busy", "開回中…");
    QJ.airtable.reopenRecord(id).then(function () {
      QJ.render.setClosedCardState && QJ.render.setClosedCardState(id, "done", "已開回，可在上方客戶清單指派承辦人。");
      log("開回案件", true, "已改為人工接管中（直寫 Airtable，未通知客戶）");
      toast("✓ 已開回，案件已轉人工接管，可重新指派（客戶未收到通知）。", "ok");
      refresh(true);   // 以伺服器真相重抓 → 該筆即出現在進行中清單
    }).catch(function (e) {
      var code = (e && e.status) || "網路";
      QJ.render.setClosedCardState && QJ.render.setClosedCardState(id, "err",
        "開回失敗（" + code + "）。案件狀態未變更，請重試。");
      log("開回案件", false, "寫回失敗（" + code + "）狀態未變更");
    });
  }

  function onClick(ev) {
    // 預約按鈕先攔（它用 data-bk-action，不是 data-cta —— 預約的鍵是
    // cal.com booking_uid，不是 Airtable recordId）
    var _bk = ev.target.closest ? ev.target.closest("[data-bk-action]") : null;
    if (_bk) { onBookingClick(_bk); return; }
    var btn = ev.target.closest ? ev.target.closest("[data-cta]") : null;
    if (!btn) return;
    var cta = btn.getAttribute("data-cta"), id = btn.getAttribute("data-id");
    if (!id) return;

    if (cta === "reopen") { doReopen(id, btn); return; }

    if (cta === "amount" || cta === "close") {
      var host = (btn.closest && (btn.closest(".queue-cta-cell") || btn.closest(".cta-ctrls") || btn.closest(".dl-row") || btn.closest(".nudge-row") || btn.closest(".review-row"))) || btn.parentNode;
      // 結案 → forced-outcome 選擇器（成交填金額／未成交一鍵）；補金額 → 原數字輸入
      if (cta === "close") { QJ.render.openCloseOutcome && QJ.render.openCloseOutcome(host, id); }
      else { QJ.render.openInlineAmount && QJ.render.openInlineAmount(host, id, cta); }
      return;
    }

    if (cta === "contacted") {
      var rc = findRec(id), pc = { 最後互動時間: nowISO() };
      if (rc && !rc.首次回應時間) pc.首次回應時間 = nowISO(); // 記錄首次團隊回應時刻（Airtable 欄位，儀表板已不據此計分）
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
      // 成交結案：金額必填且 > 0。若未成交，請按「未成交」（記為成交金額 0）。
      var v2 = QJ.render.getInlineAmount ? QJ.render.getInlineAmount(id) : null;
      var n2 = Number(v2);
      if (!(v2 != null && v2 !== "" && n2 > 0)) {
        toast("請輸入成交金額（大於 0）。若此案未成交，請按「未成交」。", "warn");
        return;
      }
      var rcf = findRec(id);
      if (!window.confirm("以成交 NT$ " + n2.toLocaleString() + " 結案「" + ((rcf && rcf.委託人) || "此案") + "」？\n結案後會從清單移除，需逐筆恢復。")) return;
      var patch2 = { 狀態: QJ.STATUS.DONE, 成交金額: n2, 結案日期: QJ.todayISODate() };
      if (rcf && !rcf.首次回應時間) patch2.首次回應時間 = nowISO();
      doPatch(id, patch2, function (r) { r.狀態 = QJ.STATUS.DONE; r.結案日期 = new Date(); r.成交金額 = n2; if (rcf && !rcf.首次回應時間) r.首次回應時間 = new Date(); }, "成交結案", { action: "close", amount: n2 });
      QJ.render.closeInlineAmount && QJ.render.closeInlineAmount(id);
      return;
    }
    if (cta === "close-lost") {
      // 未成交一鍵結案：成交金額記為 0 → 生產 CRM 衍生為「未成交」。
      var rcl = findRec(id);
      if (!window.confirm("以未成交結案「" + ((rcl && rcl.委託人) || "此案") + "」？\n會記為未成交（成交金額 0），並從清單移除。")) return;
      var patchL = { 狀態: QJ.STATUS.DONE, 成交金額: 0, 結案日期: QJ.todayISODate() };
      if (rcl && !rcl.首次回應時間) patchL.首次回應時間 = nowISO();
      doPatch(id, patchL, function (r) { r.狀態 = QJ.STATUS.DONE; r.結案日期 = new Date(); r.成交金額 = 0; if (rcl && !rcl.首次回應時間) r.首次回應時間 = new Date(); }, "未成交結案", { action: "close", amount: 0 });
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
      // 嚴格 forced-outcome：下拉改為「已完成」不再裸結案，改開結果選擇器（成交/未成交），
      // 由選擇器送出實際結案。先把下拉退回原值，避免在尚未確認結果時就顯示已完成。
      t.value = cur;
      var host = (t.closest && (t.closest("td") || t.closest(".queue-cta-cell") || t.closest(".cta-ctrls"))) || t.parentNode;
      QJ.render.openCloseOutcome && QJ.render.openCloseOutcome(host, id);
      return;
    } else { t.value = cur; return; }
    if (confirmMsg && !window.confirm(confirmMsg)) { t.value = cur; return; }
    doPatch(id, { 狀態: next }, function (r) { r.狀態 = next; }, label, { action: action });
  }

  /* ── 預約面板（2026-08-31）─────────────────────────────────────────────
     掛在 120 秒的 proxy 計時器上，不進 25 秒熱迴圈 —— 那條走瀏覽器直連
     Airtable，與預約無關。取數失敗傳 null（不是空陣列），renderBookings
     會顯示說明行而不是靜靜隱藏：「隱藏」與「壞掉」必須分得出來。 */
  function refreshBookings() {
    if (!QJ.airtable || !QJ.airtable.fetchBookings) return;
    var host = document.getElementById("booking-panel");
    return QJ.airtable.fetchBookings().then(function (d) {
      QJ.render.renderBookings(host, d);
    }).catch(function () {
      QJ.render.renderBookings(host, null);
    });
  }

  /* 預約按鈕。刻意**不做樂觀更新** —— 一次確認的「成功」有兩層且可獨立
     失敗（cal.com 回寫、客戶推播），樂觀 UI 會顯示「已確認」而客戶其實
     沒收到。等伺服器真相，然後把 dispatcher 那句話逐字轉達 —— 它把四種
     通知結果說得比任何 UI 文案都準。 */
  function onBookingClick(btn) {
    var act = btn.getAttribute("data-bk-action");
    var uid = btn.getAttribute("data-bk-uid");
    var nm = btn.getAttribute("data-bk-name") || "這位客戶";
    var sl = btn.getAttribute("data-bk-slot") || "";
    if (!act || !uid) return;
    if (act === "decline" &&
        !window.confirm("婉拒「" + nm + "」" + sl + " 的預約？\n系統會取消這筆申請，並通知客戶重新安排時間。")) return;
    if (act === "cancel" &&
        !window.confirm("取消「" + nm + "」" + sl + " 這筆已確認的預約？\n系統會取消這場會議，並通知客戶預約已取消。\n客戶先前已收到確認通知，取消後可能需要另行聯繫說明。")) return;
    if (act === "confirm" &&
        !window.confirm("確認「" + nm + "」" + sl + " 的預約？\n系統會通知客戶預約已成立，並附上時間與地點。")) return;
    btn.disabled = true;
    if (QJ.render.bkInflight) QJ.render.bkInflight[uid] = 1;
    function _done() { if (QJ.render.bkInflight) delete QJ.render.bkInflight[uid]; }
    QJ.airtable.bookingAction(uid, act).then(function (j) {
      _done();
      QJ.render.toast((j.changed ? "✓ " : "") + (j.message || "已送出"),
                      j.changed ? "ok" : "info");
      return refreshBookings();
    }).catch(function (e) {
      _done();
      btn.disabled = false;
      var code = (e && e.status) || 0;
      QJ.render.toast(code
        ? ("預約動作失敗（" + code + "）。這筆狀態未變更，客戶沒有收到任何訊息，請重試。")
        : "預約動作未能完成（網路）。無法確定是否已送出，請重新整理後再看這筆的狀態，避免重複操作。",
        code ? "danger" : "warn");
    });
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
    var qbox = document.getElementById("queue-q");
    if (qbox) {
      qbox.addEventListener("input", function () { onSearchInput(this.value); });
      // type=search 的原生清除鈕在部分瀏覽器只發 search 事件，補綁一次確保清空生效
      qbox.addEventListener("search", function () { onSearchInput(this.value); });
    }
    document.addEventListener("visibilitychange", function () { if (!document.hidden && state.analysis && !document.querySelector(".inline-edit")) refresh(true); });

    setStatus("連線中…", false);
    // 同仁名冊先就位：必須在「首次 fetchRecords→_isStaffOwnRecord」之前 await /staff，
    // 否則首屏正規化會把同仁誤列為客戶。fetchStaff 永不 reject（失敗回 null），
    // applyStaffRoster 失敗即 no-op（沿用硬編後備），所以這一步永遠會往下走。
    var staffStep = QJ.airtable.fetchStaff
      ? QJ.airtable.fetchStaff().then(function (roster) {
          if (roster && QJ.applyStaffRoster) { QJ.applyStaffRoster(roster); }
        })
      : Promise.resolve();
    staffStep.then(function () {
      return QJ.airtable.detectSchema();
    }).then(function () {
      return refresh(false);
    }).then(function () {
      startPolling();
      refreshStats(); refreshCloseReview();
    refreshReturnedUids(); refreshProxyHealth(); refreshBookings();
      if (!state.statsTimer) state.statsTimer = setInterval(function () {
        // 2026-08-31:與 25 秒那條對齊 —— 背景分頁不打 proxy。
        if (document.hidden) return;
        refreshStats(); refreshCloseReview();
        refreshReturnedUids(); refreshBookings(); }, 120000);
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
