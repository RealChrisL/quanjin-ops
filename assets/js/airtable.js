/* =============================================================================
 * 全謹代書每日營運登記簿 — airtable.js
 * 瀏覽器直連 Airtable REST API（方案甲）：schema 偵測 / 讀取 / 寫回
 *
 * 掛在 window.QJ.airtable。純瀏覽器 JS、無模組／無建置步驟。
 * 所有請求帶 Authorization: Bearer <pat>，並經內部節流（maxReqPerSec）。
 * 輸出一律為 config.js 合約定義的 NormRecord。
 * ========================================================================== */
(function () {
  "use strict";

  window.QJ = window.QJ || {};
  var SETTINGS = QJ.SETTINGS;
  var LS = QJ.LS;
  var DEFAULTS = QJ.FIELD_MAP_DEFAULTS;

  /* =========================================================================
   * 節流：簡易佇列 + 間隔，遵守 maxReqPerSec（Airtable ~5 req/s/base）
   * 每次發送前確保與「上一次發送」至少間隔 minGap 毫秒。
   * ===================================================================== */
  var minGap = Math.ceil(1000 / Math.max(1, SETTINGS.maxReqPerSec || 4));
  var _queue = [];
  var _lastSent = 0;
  var _draining = false;

  function _drain() {
    if (_draining) { return; }
    _draining = true;
    (function step() {
      if (!_queue.length) { _draining = false; return; }
      var now = Date.now();
      var wait = Math.max(0, _lastSent + minGap - now);
      setTimeout(function () {
        var job = _queue.shift();
        _lastSent = Date.now();
        // 發送（job.run 回傳 Promise）；完成與否都繼續排空佇列
        job.run().then(job.resolve, job.reject).then(step, step);
      }, wait);
    })();
  }

  /* 將一個「執行函式」排入節流佇列，回傳 Promise。 */
  function throttle(run) {
    return new Promise(function (resolve, reject) {
      _queue.push({ run: run, resolve: resolve, reject: reject });
      _drain();
    });
  }

  /* =========================================================================
   * 低階 HTTP：帶憑證 + 錯誤正規化
   * 非 2xx → throw Error（含 .status 與 .body）。429 由呼叫端重試。
   * ===================================================================== */
  function authHeaders(pat, withJson) {
    var h = { "Authorization": "Bearer " + pat };
    if (withJson) { h["Content-Type"] = "application/json"; }
    return h;
  }

  /* 將 HTTP 狀態碼轉成「介面語氣」訊息（不道歉，說發生什麼 + 怎麼處理）。 */
  function statusMessage(status, body) {
    if (status === 401) {
      return "權杖未通過驗證（401）。請回設定區重新貼上有效的 Airtable 權杖（PAT）。";
    }
    if (status === 403) {
      return "權限不足（403）。請確認權杖已授權這個 Base，且勾選 data.records 與 schema.bases:read 三個 scope。";
    }
    if (status === 404) {
      return "找不到對應的 Base 或資料表（404）。請回設定區核對 Base ID 與 Table ID。";
    }
    if (status === 422) {
      var detail = "";
      if (body && body.error && body.error.message) { detail = "：" + body.error.message; }
      return "欄位或數值不被接受（422）" + detail + "。請確認欄位對應與寫入值格式。";
    }
    if (status === 429) {
      return "Airtable 請求過於頻繁（429）。系統稍候自動重試。";
    }
    if (status >= 500) {
      return "Airtable 服務暫時無回應（" + status + "）。稍候會自動重試。";
    }
    return "連線回應異常（" + status + "）。";
  }

  /* 解析 Airtable 錯誤回應（可能是 json，也可能是純文字）。 */
  function parseErrBody(res) {
    return res.text().then(function (txt) {
      if (!txt) { return null; }
      try { return JSON.parse(txt); }
      catch (e) { return { raw: txt }; }
    });
  }

  function makeHttpError(status, body) {
    var err = new Error(statusMessage(status, body));
    err.status = status;
    err.body = body;
    return err;
  }

  /* 單次 fetch（已節流外層包好）。429 在此就地退避重試（最多 retries 次）。 */
  function rawFetch(url, opts, retries) {
    if (retries == null) { retries = 2; }
    return fetch(url, opts).then(function (res) {
      if (res.ok) {
        // 204（少見）→ 回 null；其餘解析 json
        if (res.status === 204) { return null; }
        return res.json();
      }
      return parseErrBody(res).then(function (body) {
        if (res.status === 429 && retries > 0) {
          // 退避後重試：等待時間隨剩餘重試次數遞減而拉長
          var backoff = (3 - retries) * 500 + 700; // 700ms, 1200ms...
          return new Promise(function (r) { setTimeout(r, backoff); })
            .then(function () { return rawFetch(url, opts, retries - 1); });
        }
        throw makeHttpError(res.status, body);
      });
    }, function (netErr) {
      // 網路層失敗（離線／CORS／DNS）：包成可顯示錯誤
      var err = new Error("無法連上 Airtable，請確認網路後重試。");
      err.status = 0;
      err.body = { cause: String(netErr && netErr.message || netErr) };
      throw err;
    });
  }

  /* 節流版 GET / PATCH 包裝。 */
  function get(url, pat) {
    return throttle(function () {
      return rawFetch(url, { method: "GET", headers: authHeaders(pat, false) });
    });
  }
  function patch(url, pat, bodyObj) {
    return throttle(function () {
      return rawFetch(url, {
        method: "PATCH",
        headers: authHeaders(pat, true),
        body: JSON.stringify(bodyObj)
      });
    });
  }

  /* =========================================================================
   * 欄位對應（FIELD_MAP）：記憶體 + localStorage
   * ===================================================================== */
  // 開機時若 localStorage 已有先前偵測結果，先載入記憶體（detectSchema 會覆寫）。
  function loadFieldMapFromLS() {
    try {
      var raw = window.localStorage.getItem(LS.fieldMap);
      if (raw) { return JSON.parse(raw); }
    } catch (e) { /* 容錯 */ }
    return null;
  }

  /* 依 schema 欄位名集合解析語意對應。 */
  function resolveFieldMap(fieldNames) {
    var present = {};
    fieldNames.forEach(function (n) { present[n] = true; });

    var map = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      if (key === "lastInteractionCandidates") {
        // 特例：保留所有存在的候選（順序不變）
        map[key] = DEFAULTS[key].filter(function (cand) { return present[cand]; });
        return;
      }
      // 一般鍵：取第一個存在的候選；都不存在 → null（UI 後續讓使用者確認）
      var hit = null;
      var cands = DEFAULTS[key];
      for (var i = 0; i < cands.length; i++) {
        if (present[cands[i]]) { hit = cands[i]; break; }
      }
      map[key] = hit;
    });
    return map;
  }

  /* =========================================================================
   * detectSchema：Meta API 取表結構 → 建欄位對應
   * ===================================================================== */
  function detectSchema() {
    var creds = QJ.auth.getCreds();
    var url = SETTINGS.metaBase + "/" + encodeURIComponent(creds.baseId) + "/tables";

    return get(url, creds.pat).then(function (data) {
      var tables = (data && data.tables) || [];
      // 找 id === tableId 的表；找不到 → 退回第一張表
      var table = null;
      for (var i = 0; i < tables.length; i++) {
        if (tables[i] && tables[i].id === creds.tableId) { table = tables[i]; break; }
      }
      if (!table && tables.length) { table = tables[0]; }
      if (!table) {
        var err = new Error("這個 Base 裡找不到任何資料表（404）。請核對 Base ID。");
        err.status = 404;
        err.body = null;
        throw err;
      }

      var rawFields = table.fields || [];
      var fields = rawFields.map(function (f) {
        return { name: f.name, type: f.type };
      });
      var names = fields.map(function (f) { return f.name; });
      var fieldMap = resolveFieldMap(names);

      // 持久化 + 記憶體曝露
      try { window.localStorage.setItem(LS.fieldMap, JSON.stringify(fieldMap)); }
      catch (e) { /* 容錯：存不進去仍以記憶體為準 */ }
      QJ.airtable.fieldMap = fieldMap;

      return { fields: fields, fieldMap: fieldMap };
    });
  }

  /* =========================================================================
   * 正規化：raw record → NormRecord（嚴格對齊 config.js 合約）
   * ===================================================================== */
  function toStr(v) {
    if (v == null) { return ""; }
    if (Array.isArray(v)) { return v.join("、"); } // 多選／連結欄位攤平成字串
    if (typeof v === "object") {
      // Airtable 連結／協作者物件等：盡量取可讀名稱
      if (v.name) { return String(v.name); }
      if (v.text) { return String(v.text); }
      return "";
    }
    return String(v);
  }

  function toDate(v) {
    if (!v) { return null; }
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function toNumber(v) {
    if (v == null || v === "") { return null; }
    if (typeof v === "number") { return isNaN(v) ? null : v; }
    // 字串金額：去除非數字（保留負號與小數點）
    var cleaned = String(v).replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === ".") { return null; }
    var n = Number(cleaned);
    return isNaN(n) ? null : n;
  }

  /* 取某語意鍵對應的原始值（fieldMap 未解析 → undefined）。 */
  function mapped(rawFields, fieldMap, key) {
    var realName = fieldMap ? fieldMap[key] : null;
    if (!realName) { return undefined; }
    return rawFields[realName];
  }

  /* 上次互動時間：多候選取「最新有效 Date」，並記錄取自哪個欄位。 */
  function reconcileLastInteraction(rawFields, fieldMap) {
    var cands = (fieldMap && fieldMap.lastInteractionCandidates) || [];
    // 優先序 coalesce（非取最新）：依候選順序取「第一個有值」的欄位即停。
    // 「最後互動時間」是客戶互動權威欄位；音檔/修改時間已移出候選（對齊 bot Guardrail 6），
    // 避免團隊端動作把「客戶靜默」訊號洗掉。
    for (var i = 0; i < cands.length; i++) {
      var fname = cands[i];
      var d = toDate(rawFields[fname]);
      if (d) { return { date: d, field: fname }; }
    }
    return { date: null, field: "" };
  }

  /* 委託人顯示名：跨多個姓名欄位依序取「第一個有值的值」（備註 > 姓名 > … > 顯示名稱），
   * 對齊 bot 的 display_name.for_admin 後備邏輯；單一欄位為空時不會顯示「未具名」。 */
  function coalesceName(rawFields) {
    var cands = (DEFAULTS && DEFAULTS["委託人"]) || [];
    for (var i = 0; i < cands.length; i++) {
      var v = toStr(rawFields[cands[i]]);
      if (v) { return v; }
    }
    // 後備：沒有姓名時，只用「客戶身分」欄位（LINE用戶ID）的 uid 顯示——不掃所有欄位，
    // 避免誤抓承辦人（委派團隊成員）的 uid 當成委託人。
    var cuid = toStr(rawFields["LINE用戶ID"]).trim();
    if (/^U[0-9a-f]{16,}$/i.test(cuid)) { return cuid; }
    return "";
  }

  function _normalize(raw, fieldMap) {
    var f = (raw && raw.fields) || {};
    var li = reconcileLastInteraction(f, fieldMap);

    return {
      id: raw && raw.id ? raw.id : "",
      委託人:   coalesceName(f) || toStr(mapped(f, fieldMap, "委託人")),
      電話:     toStr(mapped(f, fieldMap, "電話")),
      案件類型: toStr(mapped(f, fieldMap, "案件類型")),
      承辦人:   toStr(mapped(f, fieldMap, "承辦人")),
      狀態:     toStr(mapped(f, fieldMap, "狀態")),
      成交金額: toNumber(mapped(f, fieldMap, "成交金額")),
      結案日期: toDate(mapped(f, fieldMap, "結案日期")),
      案號:     toStr(mapped(f, fieldMap, "案號")),
      asanaGid: toStr(mapped(f, fieldMap, "asanaGid")),
      asanaUrl: toStr(mapped(f, fieldMap, "asanaUrl")),
      oaChatId: toStr(mapped(f, fieldMap, "oaChatId")),
      案件說明: toStr(mapped(f, fieldMap, "案件說明")),
      待辦事項: toStr(mapped(f, fieldMap, "待辦事項")),
      首次進線時間: toDate(mapped(f, fieldMap, "首次進線時間")),
      首次回應時間: toDate(mapped(f, fieldMap, "首次回應時間")),
      建立時間: toDate(mapped(f, fieldMap, "建立時間")) || toDate(raw && raw.createdTime),
      lastInteraction: li.date,
      lastInteractionField: li.field,
      fields: f // 原始 fields 唯讀備援
    };
  }

  /* =========================================================================
   * fetchRecords：分頁讀取進行中/待處理紀錄 → NormRecord[]
   * ===================================================================== */
  function buildFilterFormula(fieldMap) {
    var statusField = fieldMap ? fieldMap["狀態"] : null;
    if (!statusField) { return null; } // 狀態未解析 → 不過濾，全抓

    var open = QJ.STATUS.OPEN, human = QJ.STATUS.HUMAN, doneVal = QJ.STATUS.DONE;
    var closedField = fieldMap ? fieldMap["結案日期"] : null;

    // 允許清單：只取三態中的兩個「進行態」（跟進中／人工接管中）。空白／未知／舊狀態值
    // 不視為進行中（對齊 bot 三態模型），避免灌水佇列與 KPI。有結案日期欄位時，近 30 天
    // 的「已完成」也保留，供本月結案統計。
    var active = "OR({" + statusField + "}='" + open + "',{" + statusField + "}='" + human + "')";
    if (closedField) {
      var recent = "AND({" + statusField + "}='" + doneVal + "',IS_AFTER({" + closedField + "}, DATEADD(TODAY(),-30,'days')))";
      return "OR(" + active + "," + recent + ")";
    }
    return active;
  }

  /* 排除「同仁＝委託人」的紀錄：客戶身分欄位（LINE用戶ID）為內部同仁 uid 時，
   * 這是同仁自己與 OA 互動產生的紀錄，不該當成待辦客戶顯示。
   * 只看客戶身分（LINE用戶ID），不看承辦人——委派團隊成員＝同仁 uid 是正常的。 */
  function _isStaffOwnRecord(raw) {
    var f = (raw && raw.fields) || {};
    var byUid = QJ.TEAM_BY_UID || {};
    var byOa = QJ.STAFF_OA_IDS || {};
    function pick(val) {
      if (typeof val === "string") { return val.trim(); }
      if (Array.isArray(val) && val.length) { return String(val[0]).trim(); }
      return "";
    }
    var uid = pick(f["LINE用戶ID"]);
    if (uid && byUid[uid]) { return true; }   // 客戶身分＝同仁 webhook uid
    var oaid = pick(f["OA聊天ID"]);
    if (oaid && byOa[oaid]) { return true; }   // OA 對話建立的同仁本人紀錄（無 LINE用戶ID）
    // 後備（防漏）：無客戶 uid 的紀錄，姓名/顯示名恰為同仁名 → 視為同仁本人（OA 對話建立、
    // 其 OA聊天ID 尚未登錄）。僅在「無 LINE用戶ID」時生效——真實客戶必由 LINE 進線帶 uid。
    if (!uid) {
      var names = QJ.STAFF_NAMES || {};
      var nm = pick(f["姓名"]) || pick(f["LINE顯示名稱"]);
      if (nm && names[nm]) { return true; }
    }
    return false;
  }

  /* 排除「加好友後從未傳訊」的追蹤者殘根：record_follow 預建的紀錄，客戶一句話
   * 都沒說過 → OA Manager 根本沒有對話串，謝代書找不到人、也無事可辦（2026-08-13
   * Chris:「待辦清單很多客人在OA找不到」）。判定式逐條移植 bot 端
   * notifier.is_untouched_follow_stub（同一組條款，勿各自演化）：案件類型空/其他
   * ＋對話摘要/場景空＋需求摘要為 follow 哨兵＋首次進線==最後互動（從未 upsert）
   * ＋無人工接手痕跡（OA聊天ID/備註/委派）。任何一條不符 → 照常顯示（fail-open
   * 寧多列一筆殘根，不藏一位真客戶）。隱藏筆數計入 hiddenStubCount 由佇列尾揭露。 */
  var FOLLOW_STUB_SENTINEL = "客戶 follow 後尚未傳送訊息";
  function _isSilentFollowStub(raw) {
    var f = (raw && raw.fields) || {};
    function s(key) {
      var v = f[key];
      if (Array.isArray(v)) { v = v.length ? v[0] : ""; }
      return (typeof v === "string" ? v : (v == null ? "" : String(v))).trim();
    }
    var caseType = s("案件類型");
    if (caseType && caseType !== "其他") { return false; }
    if (s("對話摘要")) { return false; }
    if (s("客戶場景描述")) { return false; }
    var need = s("需求摘要");
    if (need && need.indexOf(FOLLOW_STUB_SENTINEL) !== 0) { return false; }
    var first = s("首次進線時間"), last = s("最後互動時間");
    if (!first || first !== last) { return false; }
    if (s("OA聊天ID") || s("Line 備註名稱") || s("委派團隊成員")) { return false; }
    return true;
  }

  function fetchRecords() {
    var creds = QJ.auth.getCreds();
    var fieldMap = QJ.airtable.fieldMap || loadFieldMapFromLS();
    // 若無 fieldMap，至少嘗試偵測一次（容錯：app 通常會先呼叫 detectSchema）
    var ensureMap = fieldMap
      ? Promise.resolve(fieldMap)
      : detectSchema().then(function (r) { return r.fieldMap; });

    return ensureMap.then(function (fmap) {
      var base = SETTINGS.apiBase + "/" + encodeURIComponent(creds.baseId) +
                 "/" + encodeURIComponent(creds.tableId);
      var formula = buildFilterFormula(fmap);

      var all = [];
      var hiddenStubs = 0;

      function pageOnce(offset) {
        var params = [];
        params.push("pageSize=" + encodeURIComponent(SETTINGS.pageSize));
        if (formula) {
          params.push("filterByFormula=" + encodeURIComponent(formula));
        }
        if (offset) {
          params.push("offset=" + encodeURIComponent(offset));
        }
        var url = base + "?" + params.join("&");

        return get(url, creds.pat).then(function (data) {
          var recs = (data && data.records) || [];
          for (var i = 0; i < recs.length; i++) {
            if (_isStaffOwnRecord(recs[i])) { continue; } // 同仁自身紀錄不列入客戶清單
            if (_isSilentFollowStub(recs[i])) { hiddenStubs++; continue; } // 未開口追蹤者：OA 無對話、無事可辦
            all.push(_normalize(recs[i], fmap));
          }
          if (data && data.offset) {
            return pageOnce(data.offset); // 續抓下一頁
          }
          QJ.airtable.hiddenStubCount = hiddenStubs; // 佇列尾揭露用（絕不默默少東西）
          return all;
        });
      }

      return pageOnce(null);
    });
  }

  /* =========================================================================
   * patchRecord：語意鍵 → 實欄位 → PATCH → 回 NormRecord
   * ===================================================================== */
  // CTA 寫回會用到的語意鍵；「最後互動時間」解析為第一個存在的候選欄位。
  function resolveWriteField(fieldMap, semanticKey) {
    if (semanticKey === "最後互動時間") {
      var cands = (fieldMap && fieldMap.lastInteractionCandidates) || [];
      return cands.length ? cands[0] : null;
    }
    return fieldMap ? (fieldMap[semanticKey] || null) : null;
  }

  function patchRecord(id, semanticPatch) {
    var creds = QJ.auth.getCreds();
    var fieldMap = QJ.airtable.fieldMap || loadFieldMapFromLS();

    return Promise.resolve()
      .then(function () {
        if (!fieldMap) {
          // 無對應表無法翻欄位名 → 先偵測
          return detectSchema().then(function (r) { fieldMap = r.fieldMap; });
        }
      })
      .then(function () {
        if (!id) {
          var e = new Error("缺少紀錄識別碼，無法寫回。");
          e.status = 0; e.body = null;
          throw e;
        }

        // 語意鍵 → 實欄位；對應不到的鍵略過（避免 422），並蒐集供回報
        var realFields = {};
        var unresolved = [];
        Object.keys(semanticPatch || {}).forEach(function (key) {
          var realName = resolveWriteField(fieldMap, key);
          if (realName) {
            realFields[realName] = semanticPatch[key];
          } else {
            unresolved.push(key);
          }
        });

        if (!Object.keys(realFields).length) {
          var e2 = new Error(
            "這些欄位在資料表中找不到對應，無法寫回：" + unresolved.join("、") +
            "。請於設定區確認欄位對應。"
          );
          e2.status = 422;
          e2.body = { unresolved: unresolved };
          throw e2;
        }

        var url = SETTINGS.apiBase + "/" + encodeURIComponent(creds.baseId) +
                  "/" + encodeURIComponent(creds.tableId) +
                  "/" + encodeURIComponent(id);

        return patch(url, creds.pat, { fields: realFields }).then(function (resRec) {
          return _normalize(resRec, fieldMap);
        });
      });
  }

  /* =========================================================================
   * searchClosed：已結案客戶「隨選」單次查詢（找回被 fetchRecords 濾掉的紀錄）
   *
   * fetchRecords 刻意只抓進行態（狀態≠已完成 或 近 30 天結案）——庫內約 1,200 筆
   * 已完成紀錄若整批載入，佇列／KPI／圖譜會被灌爆。所以「已結案的客戶查不到」這件事
   * 用隨選查詢解：使用者真的要找某個人時才打 ONE 支 filterByFormula，maxRecords 設上限，
   * 不預載、不翻頁、不進 state.queue、不進任何統計或徽章。
   *
   * 條件：AND({狀態}='已完成', OR(SEARCH(查詢, {姓名/LINE顯示名稱/Line 備註名稱})))
   * 兩側 LOWER → 大小寫不敏感（對齊 bot find_record_by_name 慣例）。
   * 回傳 NormRecord[]（與 fetchRecords 同一條 _normalize 正規化路徑）；查無 → []。
   * ===================================================================== */
  var CLOSED_SEARCH_MAX = 10;   // 單次隨選查詢回傳上限（刻意小；要更準就打更完整的姓名）

  /* Airtable 公式字串常值跳脫：公式以雙引號包字串，故只需處理反斜線與雙引號。 */
  function _escFormulaStr(s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  /* 組已結案搜尋公式。nameFields 單一真實來源＝FIELD_MAP_DEFAULTS.委託人（同一組姓名候選，
   * 本地比對與伺服器端比對才會一致）；statusField 未解析時只比對姓名，呼叫端另行把關。 */
  function buildClosedSearchFormula(query, statusField, nameFields) {
    var q = String(query == null ? "" : query).trim();
    if (!q) { return null; }
    var fields = (nameFields && nameFields.length)
      ? nameFields
      : ["Line 備註名稱", "姓名", "LINE顯示名稱"];
    var needle = "\"" + _escFormulaStr(q.toLowerCase()) + "\"";
    var ors = fields.map(function (f) {
      // &"" 把空值強制轉字串，避免 LOWER() 吃到空值時整條公式評估失敗
      return "SEARCH(" + needle + ",LOWER({" + f + "}&\"\"))";
    });
    var nameMatch = (ors.length > 1) ? ("OR(" + ors.join(",") + ")") : ors[0];
    if (!statusField) { return nameMatch; }
    return "AND({" + statusField + "}=\"" + QJ.STATUS.DONE + "\"," + nameMatch + ")";
  }

  function searchClosed(query) {
    var q = String(query == null ? "" : query).trim();
    if (!q) { return Promise.resolve([]); }

    var creds = QJ.auth.getCreds();
    var fieldMap = QJ.airtable.fieldMap || loadFieldMapFromLS();
    var ensureMap = fieldMap
      ? Promise.resolve(fieldMap)
      : detectSchema().then(function (r) { return r.fieldMap; });

    return ensureMap.then(function (fmap) {
      var statusField = (fmap && fmap["狀態"]) || "進度狀態";
      var formula = buildClosedSearchFormula(
        q, statusField, (DEFAULTS && DEFAULTS["委託人"]) || null);
      if (!formula) { return []; }

      var url = SETTINGS.apiBase + "/" + encodeURIComponent(creds.baseId) +
                "/" + encodeURIComponent(creds.tableId) +
                "?maxRecords=" + CLOSED_SEARCH_MAX +
                "&filterByFormula=" + encodeURIComponent(formula);

      // 走與輪詢同一條節流佇列（get），不會擠掉正常讀取
      return get(url, creds.pat).then(function (data) {
        var recs = (data && data.records) || [];
        var out = [];
        for (var i = 0; i < recs.length; i++) {
          if (_isStaffOwnRecord(recs[i])) { continue; } // 同仁本人紀錄不是客戶
          out.push(_normalize(recs[i], fmap));
        }
        return out;
      });
    });
  }

  /* =========================================================================
   * reopenRecord（🔁開回）：已完成 → 人工接管中，且「零客戶端側效」。
   *
   * 為什麼直連 PATCH、而不是走寫入代理 /cta：代理只有 takeover／restore 兩條狀態動作，
   * 兩條都會碰到客戶——
   *   restore  → bot 的「恢復」verb，必定推播「感謝耐心等候🙏」給客戶；
   *   takeover → bot 的「接管」verb，manual_takeover_ack 已上線，非上班時段會推播
   *              一則關懷語給客戶（上班時段才靜默）。
   * 「開回」是內部把誤結／需續辦的紀錄找回來的動作，客戶不該收到任何訊息，所以這裡
   * 刻意用 PAT 直接寫欄位（語意等同人工在 Airtable 改狀態）。
   *
   * 只改 進度狀態 一個欄位；不動 結案日期（保留結案歷史，且狀態已非已完成，佇列本來
   * 就會收錄這筆）。成功後由呼叫端重跑 refresh，該筆即以可指派的狀態出現在客戶清單。
   * ===================================================================== */
  function reopenRecord(id) {
    return patchRecord(id, { 狀態: QJ.STATUS.HUMAN });
  }

  /* ---- CTA 走後端寫回代理（bot-proxy）：POST /cta，回 {ok, fields}；非2xx/解析失敗 → throw ---- */
  function cta(id, pa) {
    var url = (QJ.proxyUrl ? QJ.proxyUrl() : "") + "/cta";
    var body = { action: pa.action, recordId: id };
    if (pa.amount != null) body.amount = pa.amount;
    if (pa.owner != null) body.owner = pa.owner;
    return fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + (QJ.proxyToken ? QJ.proxyToken() : ""), "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j || j.ok !== true) { var e = new Error((j && j.error) || ("後端寫入失敗 HTTP " + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  /* 唯讀資料端點共用 GET：帶 Bearer 代理密鑰（這些端點現在需授權，內含內部訊號）。
     401／網路失敗 → 回 null，各呼叫端自行降級。 */
  function _proxyGet(pathSeg) {
    var url = (QJ.proxyUrl ? QJ.proxyUrl() : "") + pathSeg;
    if (!url || url === pathSeg) { return Promise.resolve(null); }
    return fetch(url, { headers: {
      "Authorization": "Bearer " + (QJ.proxyToken ? QJ.proxyToken() : ""),
      "ngrok-skip-browser-warning": "1"
    } }).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
  }

  /* ---- 24/7 代理戰績：GET /stats（唯讀彙總，需授權）。失敗回 null ---- */
  function fetchStats() { return _proxyGet("/stats"); }

  /* ---- 同仁名冊：GET /staff（唯讀，內部同仁 id，需授權）。
   *      單一真實來源＝bot config.json；失敗回 null → app.js 沿用硬編後備名冊。 ---- */
  function fetchStaff() { return _proxyGet("/staff"); }

  /* ---- 結案來源稽核：GET /close-review（唯讀，每筆結案標記系統內／系統外＋結案者；
   *      內部同仁名，無客戶 PII，需授權）。失敗回 null → 面板降級為無「結案者」欄。 ---- */
  function fetchCloseReview() { return _proxyGet("/close-review"); }

  /* ---- 已結案回訊 uid 名單：GET /returned-uids（唯讀，需授權）。
   *      為什麼需要它：面板自己的訊號是「結案日期存在且最後互動時間晚於它」，
   *      但 95.4% 的目標紀錄（891/934，實測）根本沒有結案日期——它們是上線初期
   *      匯入時就帶已完成狀態、從未被人按過結案。少了這個第二訊號，那些列會落回
   *      「可結案」並被朱色「新進件」高亮誤標成新客戶。失敗／未授權 → 回 null，
   *      面板降級為只用結案日期訊號（標得少，不會標錯）。 ---- */
  function fetchReturnedUids() { return _proxyGet("/returned-uids"); }

  /* ---- Asana 進度（Phase 1.5，唯讀）：GET /asana/progress?recordId=rec…（需授權，
   *      個人 token 級）。回 {ok:true, done, total, pct, url?} 或 {ok:false, reason}；
   *      非2xx／網路失敗／解析失敗 → 回 null，呼叫端一律降級為「不顯示」。 ---- */
  function asanaProgress(recordId) {
    var rid = String(recordId == null ? "" : recordId).trim();
    if (!rid) { return Promise.resolve(null); }
    var base = (QJ.proxyUrl ? QJ.proxyUrl() : "");
    if (!base) { return Promise.resolve(null); }
    var url = base + "/asana/progress?recordId=" + encodeURIComponent(rid);
    return fetch(url, { headers: {
      "Authorization": "Bearer " + (QJ.proxyToken ? QJ.proxyToken() : ""),
      "ngrok-skip-browser-warning": "1"
    } }).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
  }

  /* ---- 寫入代理存活：GET /health（免授權，純存活探測）。回 true=可寫入 / false=不可達。 ---- */
  function fetchHealth() {
    var url = (QJ.proxyUrl ? QJ.proxyUrl() : "") + "/health";
    if (!url || url === "/health") { return Promise.resolve(false); }
    return fetch(url, { headers: { "ngrok-skip-browser-warning": "1" } })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  /* ---- 開機時把先前的 fieldMap 載入記憶體（detectSchema 會覆寫）---- */
  QJ.airtable = {
    // 記憶體欄位對應（detectSchema 後填入；clear() 會清空）
    fieldMap: loadFieldMapFromLS(),

    detectSchema: detectSchema,
    fetchRecords: fetchRecords,
    patchRecord: patchRecord,
    searchClosed: searchClosed,
    reopenRecord: reopenRecord,
    CLOSED_SEARCH_MAX: CLOSED_SEARCH_MAX,
    cta: cta,
    fetchStats: fetchStats,
    fetchStaff: fetchStaff,
    fetchCloseReview: fetchCloseReview,
    fetchReturnedUids: fetchReturnedUids,
    fetchHealth: fetchHealth,
    asanaProgress: asanaProgress,
    _normalize: _normalize,
    // 對外曝露 reconcile（logic.js 合約也定義同名，但 raw→date 取最新邏輯落在此）
    reconcileLastInteraction: reconcileLastInteraction
  };

  // 測試專用匯出（純函式；零行為變更）。standalone node harness 由此取得私有純函式。
  QJ.airtable._test = { buildFilterFormula: buildFilterFormula, _isStaffOwnRecord: _isStaffOwnRecord, _normalize: _normalize, coalesceName: coalesceName, toNumber: toNumber, toDate: toDate, buildClosedSearchFormula: buildClosedSearchFormula, _escFormulaStr: _escFormulaStr };

})();
