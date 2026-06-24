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

  /* 有無有效憑證（PAT + Base ID 皆存在）。無 → 顯示 Setup Gate 並回 false。 */
  function ensure() {
    var pat = lsGet(LS.pat);
    var baseId = lsGet(LS.baseId);
    if (pat && baseId) {
      showApp();
      return true;
    }
    showGate();
    renderSetupGate();
    return false;
  }

  /* 取得憑證；tableId 缺省回 SETTINGS.defaultTableId。 */
  function getCreds() {
    return {
      pat: lsGet(LS.pat) || "",
      baseId: lsGet(LS.baseId) || "",
      tableId: lsGet(LS.tableId) || SETTINGS.defaultTableId
    };
  }

  /* 儲存憑證；tableId 留空時用 defaultTableId。 */
  function save(pat, baseId, tableId) {
    pat = (pat || "").trim();
    baseId = (baseId || "").trim();
    tableId = (tableId || "").trim() || SETTINGS.defaultTableId;
    lsSet(LS.pat, pat);
    lsSet(LS.baseId, baseId);
    lsSet(LS.tableId, tableId);
    return getCreds();
  }

  /* 清除全部憑證（含已偵測的 fieldMap）→ 回到 Setup Gate。 */
  function clear() {
    lsRemove(LS.pat);
    lsRemove(LS.baseId);
    lsRemove(LS.tableId);
    lsRemove(LS.fieldMap);
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
    var tableVal = esc(creds.tableId || SETTINGS.defaultTableId);

    host.innerHTML =
      '<div class="setup-gate-wrap">' +
        '<div class="setup-card">' +
          '<div class="setup-head">' +
            '<div class="seal" aria-label="全謹代書印"><span class="seal-grid"><span>全</span><span>謹</span><span>代</span><span>書</span></span></div>' +
            '<div><h2>每日營運登記簿</h2><p>連線設定 · 朱墨印譜</p></div>' +
          '</div>' +
          '<div class="setup-body">' +
            '<label for="in-pat"><span class="setup-field-label">Airtable Personal Access Token</span>' +
              '<input id="in-pat" type="password" autocomplete="off" spellcheck="false" placeholder="pat..." /></label>' +
            '<label for="in-base"><span class="setup-field-label">Base ID</span>' +
              '<input id="in-base" type="text" autocomplete="off" spellcheck="false" placeholder="app..." /></label>' +
            '<label for="in-table"><span class="setup-field-label">Table ID</span>' +
              '<input id="in-table" type="text" autocomplete="off" spellcheck="false" value="' + tableVal + '" placeholder="tbl..." /></label>' +

            '<div class="setup-error" id="setup-error" hidden></div>' +

            '<button id="btn-save-creds" type="button">啟用登記簿</button>' +

            '<p class="setup-note">資料只在 Airtable 與本機之間直連，不經第三方。憑證僅存於這台瀏覽器，可隨時清除。公開網址不存放任何客戶資料——沒有權杖什麼都看不到。</p>' +

            '<div class="setup-perm">' +
              '<div class="setup-perm-title">權杖（PAT）權限指引</div>' +
              '<ul>' +
                '<li>在 Airtable 建立 scoped Personal Access Token（不要用舊版 API key）。</li>' +
                '<li>僅授權這一個 Base，不要全帳號授權。</li>' +
                '<li>僅勾三個 scope：data.records:read、data.records:write、schema.bases:read。</li>' +
                '<li>建議僅於 CEO 自有裝置使用；公開網址請勿外流，權杖等同帳號鑰匙。</li>' +
              '</ul>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // 綁定「啟用登記簿」
    var btn = el("btn-save-creds");
    if (btn) { btn.addEventListener("click", onSaveClick); }

    // Enter 鍵亦可送出（任一輸入框）
    ["in-pat", "in-base", "in-table"].forEach(function (id) {
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
    var baseEl = el("in-base");
    var tableEl = el("in-table");

    var pat = patEl ? patEl.value.trim() : "";
    var baseId = baseEl ? baseEl.value.trim() : "";
    var tableId = tableEl ? tableEl.value.trim() : "";

    if (!pat) {
      showSetupError("請貼上 Airtable 權杖（PAT）後再啟用。");
      if (patEl) { patEl.focus(); }
      return;
    }
    if (!baseId) {
      showSetupError("請填入 Base ID（以 app 開頭）後再啟用。");
      if (baseEl) { baseEl.focus(); }
      return;
    }

    save(pat, baseId, tableId);
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
