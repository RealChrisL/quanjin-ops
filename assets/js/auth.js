/* =============================================================================
 * 全謹代書每日營運登記簿 — auth.js
 * 憑證管理 + 朱墨印譜風 Setup Gate（PAT / Base ID / Table ID）
 *
 * 掛在 window.QJ.auth。零後端、純瀏覽器 JS、無模組／無建置步驟。
 * 憑證僅存於本機 localStorage（QJ.LS 鍵名），可隨時清除。
 * ========================================================================== */
(function () {
  "use strict";

  window.QJ = window.QJ || {};
  var LS = QJ.LS;
  var SETTINGS = QJ.SETTINGS;

  /* ---- localStorage 小工具：讀寫容錯（無痕模式／配額不足不應整站崩潰）---- */
  function lsGet(key) {
    try { return window.localStorage.getItem(key); }
    catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); return true; }
    catch (e) { return false; }
  }
  function lsRemove(key) {
    try { window.localStorage.removeItem(key); }
    catch (e) { /* 容錯：清不掉也不拋錯 */ }
  }

  function el(id) { return document.getElementById(id); }

  /* ---- 顯示／隱藏 Setup Gate 與主畫面 ---- */
  function showGate() {
    var gate = el("setup-gate");
    var app = el("app");
    if (gate) { gate.hidden = false; gate.style.display = ""; }
    if (app) { app.hidden = true; app.style.display = "none"; }
  }
  function showApp() {
    var gate = el("setup-gate");
    var app = el("app");
    if (gate) { gate.hidden = true; gate.style.display = "none"; }
    if (app) { app.hidden = false; app.style.display = ""; }
  }

  /* ---- HTML 轉義：value 帶入 input 前防注入（defaultTableId 為內部常數，仍一律轉義）---- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* =========================================================================
   * 公開 API
   * ===================================================================== */

  /* Base/Table/代理網址皆硬編（私有 repo），只需 PAT。無 → 顯示 Setup Gate 並回 false。 */
  function ensure() {
    if (lsGet(LS.pat) && lsGet(LS.proxyToken)) {
      showApp();
      return true;
    }
    showGate();
    renderSetupGate();
    return false;
  }

  /* 取得憑證；Base/Table 硬編，只有 PAT 來自本機。 */
  function getCreds() {
    return {
      pat: lsGet(LS.pat) || "",
      baseId: SETTINGS.defaultBaseId,
      tableId: SETTINGS.defaultTableId
    };
  }

  /* 儲存 PAT（Base/Table 硬編，不存）。 */
  function save(pat) {
    lsSet(LS.pat, (pat || "").trim());
    return getCreds();
  }

  /* 清除全部憑證（含已偵測的 fieldMap）→ 回到 Setup Gate。 */
  function clear() {
    lsRemove(LS.pat);
    lsRemove(LS.baseId);
    lsRemove(LS.tableId);
    lsRemove(LS.fieldMap);
    lsRemove(LS.proxyUrl);
    lsRemove(LS.proxyToken);
    // 清掉記憶體中的 fieldMap，避免清憑證後仍殘留欄位對應
    if (QJ.airtable) { QJ.airtable.fieldMap = null; }
    showGate();
    renderSetupGate();
  }

  /* ---- Setup Gate 卡片內容（朱墨印譜風；class/id 由 Agent C 上樣式）---- */
  function renderSetupGate() {
    var host = el("setup-gate");
    if (!host) { return; }

    var creds = getCreds();
    var patVal = esc(creds.pat || "");
    var proxyTokenPH = "貼上代理密鑰";

    host.innerHTML =
      '<div class="setup-gate-wrap">' +
        '<div class="setup-card">' +
          '<div class="setup-head">' +
            '<div class="seal" aria-label="全謹代書印"><span class="seal-grid"><span>全</span><span>謹</span><span>代</span><span>書</span></span></div>' +
            '<div><h2>營運戰情室</h2></div>' +
          '</div>' +
          '<div class="setup-body">' +
            '<label for="in-pat"><span class="setup-field-label">Airtable 權杖（PAT）</span>' +
              '<input id="in-pat" type="password" autocomplete="off" spellcheck="false" value="' + patVal + '" placeholder="pat..." /></label>' +
            '<label for="in-proxy-token"><span class="setup-field-label">寫入代理密鑰</span>' +
              '<input id="in-proxy-token" type="password" autocomplete="off" spellcheck="false" placeholder="' + proxyTokenPH + '" /></label>' +

            '<div class="setup-error" id="setup-error" hidden></div>' +

            '<button id="btn-save-creds" type="button">啟用戰情室</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    // 綁定「啟用登記簿」
    var btn = el("btn-save-creds");
    if (btn) { btn.addEventListener("click", onSaveClick); }

    // Enter 鍵亦可送出（任一輸入框）
    ["in-pat", "in-proxy-token"].forEach(function (id) {
      var inp = el(id);
      if (inp) {
        inp.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); onSaveClick(); }
        });
      }
    });
  }

  /* ---- 內嵌錯誤訊息（介面語氣，不道歉）---- */
  function showSetupError(msg) {
    var box = el("setup-error");
    if (box) {
      box.textContent = msg;
      box.hidden = false;
    }
  }
  function clearSetupError() {
    var box = el("setup-error");
    if (box) { box.textContent = ""; box.hidden = true; }
  }

  /* ---- 「啟用登記簿」點擊：驗證 → 儲存 → 進主畫面 → 啟動 app ---- */
  function onSaveClick() {
    clearSetupError();
    var patEl = el("in-pat");
    var pat = patEl ? patEl.value.trim() : "";
    var proxyTokEl = el("in-proxy-token");
    var proxyTok = proxyTokEl ? proxyTokEl.value.trim() : "";

    if (!pat) {
      showSetupError("請貼上 Airtable 權杖（PAT）後再啟用。");
      if (patEl) { patEl.focus(); }
      return;
    }
    if (!proxyTok) {
      showSetupError("請貼上寫入代理密鑰後再啟用。");
      if (proxyTokEl) { proxyTokEl.focus(); }
      return;
    }

    save(pat);
    lsSet(LS.proxyToken, proxyTok);
    showApp();

    // 交棒給 orchestrator；app.js 尚未載入時不報錯（防禦式呼叫）
    if (window.QJ.app && typeof QJ.app.boot === "function") {
      QJ.app.boot();
    }
  }

  /* ---- masthead「清除憑證」綁定 ----
   * #clear-creds 由 Agent C 渲染進 masthead，可能晚於 auth.js 載入；
   * 用事件委派（document 層）確保任何時間點都能接到點擊。 */
  function bindClearDelegated() {
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t) { return; }
      // 容許點到 #clear-creds 內部子元素
      var hit = (t.id === "clear-creds") ||
                (typeof t.closest === "function" && t.closest("#clear-creds"));
      if (hit) {
        ev.preventDefault();
        clear();
      }
    });
  }

  // 載入即綁定委派（DOM 尚未就緒也安全：監聽掛在 document 上）
  bindClearDelegated();

  /* ---- 匯出 ---- */
  QJ.auth = {
    ensure: ensure,
    getCreds: getCreds,
    save: save,
    clear: clear,
    renderSetupGate: renderSetupGate
  };

})();
