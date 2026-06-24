/* =============================================================================
 * 全謹代書每日營運登記簿 — charts.js
 * 朱墨印譜風圖表層（甜甜圈／長條／折線），掛在 window.QJ.charts。
 *
 * 純瀏覽器原生 JS，無建置／無 import；使用 index.html 由 CDN 載入的全域 Chart。
 * 消費 logic.js 產出的 state.charts：
 *   { types:[{label,value}], owners:[{label,value}],
 *     deals:{labels:[], data:[], target:Number|null} }
 * 渲染進 canvas：#chart-types #chart-owners #chart-deals
 *
 * ⚠️ 本檔不得含任何真實客戶資料；顏色全部取自朱墨印譜主題色。
 * ========================================================================== */
(function () {
  "use strict";

  window.QJ = window.QJ || {};

  /* =========================================================================
   * 朱墨印譜主題色（與 CSS 變數對齊；CSS 尚未就緒時用此處字面值備援）
   * cinnabar 朱  / ink 墨 / gold 金 / green 綠 / ochre 赭 / 米紙底
   * ===================================================================== */
  var THEME = {
    cinnabar: "#C0392B", // --accent 朱
    ink:      "#181410", // --ink 墨
    gold:     "#9A7B3F", // --gold 金
    green:    "#3D6B52", // 綠
    ochre:    "#A87C1F", // 赭
    paper:    "#ECE6D8", // --paper 米紙
    muted:    "#5A5142"  // 文字／座標籤
  };

  /* 讀取 CSS 變數（有就用、沒有就退回主題字面值）。供承辦人長條「強調最高者」用。 */
  function cssVar(name, fallback) {
    try {
      var root = document.documentElement;
      var v = window.getComputedStyle(root).getPropertyValue(name);
      v = (v || "").trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /* 甜甜圈調色盤：主色 + 淺色調（tint），絕不霓虹/光暈。依需要循環。 */
  function buildPalette(n) {
    var base = [
      THEME.cinnabar, THEME.ink, THEME.gold, THEME.green, THEME.ochre,
      tint(THEME.cinnabar, 0.32), tint(THEME.green, 0.30), tint(THEME.gold, 0.34),
      tint(THEME.ink, 0.42), tint(THEME.ochre, 0.30)
    ];
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(base[i % base.length]);
    }
    return out;
  }

  /* 將 hex 往米紙底「提亮」amount（0~1）：朱墨譜的淡墨/淡朱質感，非加白。 */
  function tint(hex, amount) {
    var c = hexToRgb(hex);
    var p = hexToRgb(THEME.paper);
    if (!c || !p) { return hex; }
    var r = Math.round(c.r + (p.r - c.r) * amount);
    var g = Math.round(c.g + (p.g - c.g) * amount);
    var b = Math.round(c.b + (p.b - c.b) * amount);
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function hexToRgb(hex) {
    if (typeof hex !== "string") { return null; }
    var m = hex.replace("#", "");
    if (m.length === 3) { m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2]; }
    if (m.length !== 6) { return null; }
    var num = parseInt(m, 16);
    if (isNaN(num)) { return null; }
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  /* rgba 形式的淡墨格線 */
  function inkRgba(alpha) {
    var c = hexToRgb(THEME.ink) || { r: 24, g: 20, b: 16 };
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha + ")";
  }

  /* =========================================================================
   * 公用：環境檢查
   * ===================================================================== */
  function chartLib() {
    return (typeof window !== "undefined" && window.Chart) ? window.Chart : null;
  }

  function reducedMotion() {
    try {
      return !!(window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) {
      return false;
    }
  }

  /* 取得 canvas；不存在回 null（呼叫端負責跳過該圖）。 */
  function getCanvas(id) {
    var el = document.getElementById(id);
    if (!el || el.tagName !== "CANVAS") { return null; }
    return el;
  }

  /* dataset 是否「有東西可畫」：陣列非空且至少一個正值。 */
  function hasData(arr) {
    if (!Array.isArray(arr) || arr.length === 0) { return false; }
    for (var i = 0; i < arr.length; i++) {
      var v = Number(arr[i]);
      if (isFinite(v) && v > 0) { return true; }
    }
    return false;
  }

  /* 將 [{label,value}] 拆成 {labels, values}，過濾無效列。 */
  function splitPairs(pairs) {
    var labels = [], values = [];
    if (Array.isArray(pairs)) {
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i] || {};
        var v = Number(p.value);
        if (!isFinite(v)) { v = 0; }
        labels.push(p.label == null ? "—" : String(p.label));
        values.push(v);
      }
    }
    return { labels: labels, values: values };
  }

  /* 找最大值索引（並列時取第一個）；空陣列回 -1。 */
  function argMax(values) {
    var idx = -1, best = -Infinity;
    for (var i = 0; i < values.length; i++) {
      if (values[i] > best) { best = values[i]; idx = i; }
    }
    return idx;
  }

  /* =========================================================================
   * 空狀態（不丟錯、雅緻留白）：在 canvas 上以淡墨寫一行字。
   * ===================================================================== */
  function renderEmpty(canvas, msg) {
    if (!canvas) { return; }
    try {
      var ctx = canvas.getContext && canvas.getContext("2d");
      if (!ctx) { return; }
      var w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.fillStyle = inkRgba(0.38);
      ctx.font = '14px "IBM Plex Mono", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(msg || "尚無資料", w / 2, h / 2);
      ctx.restore();
    } catch (e) {
      /* 容錯：連空狀態都畫不出來也絕不拋錯 */
    }
  }

  /* =========================================================================
   * 圖表實例管理（idempotent：重畫前 destroy，輪詢更新不漏實例）
   * ===================================================================== */
  var _instances = {}; // { canvasId: ChartInstance }

  function destroyInstance(id) {
    var inst = _instances[id];
    if (inst && typeof inst.destroy === "function") {
      try { inst.destroy(); } catch (e) { /* 容錯 */ }
    }
    delete _instances[id];
  }

  function destroyAll() {
    Object.keys(_instances).forEach(destroyInstance);
  }

  /* =========================================================================
   * Chart.js 全域預設（字體 IBM Plex Mono、文字色、淡墨格線）
   * 只設一次；reduced-motion 由各圖 options 控制（避免全域副作用殘留）。
   * ===================================================================== */
  var _defaultsApplied = false;
  function applyDefaults(Chart) {
    if (_defaultsApplied || !Chart || !Chart.defaults) { return; }
    try {
      Chart.defaults.font = Chart.defaults.font || {};
      Chart.defaults.font.family = '"IBM Plex Mono", monospace';
      Chart.defaults.color = THEME.muted; // #5A5142
      // 格線預設（個別 scale 仍可覆寫）
      if (Chart.defaults.scale && Chart.defaults.scale.grid) {
        Chart.defaults.scale.grid.color = inkRgba(0.08);
      }
      Chart.defaults.borderColor = inkRgba(0.08);
      _defaultsApplied = true;
    } catch (e) {
      /* 預設設不上也不擋圖表渲染 */
    }
  }

  /* 共用座標軸樣式（淡墨格線 + 文字色） */
  function axisStyle(opts) {
    opts = opts || {};
    return {
      grid: {
        color: inkRgba(0.08),
        drawBorder: false
      },
      ticks: {
        color: THEME.muted,
        font: { family: '"IBM Plex Mono", monospace', size: 11 }
      },
      beginAtZero: opts.beginAtZero === true
    };
  }

  /* =========================================================================
   * 圖一：#chart-types — 案件類型分布（甜甜圈，保留精簡圖例）
   * ===================================================================== */
  function renderTypes(Chart, state, anim) {
    var id = "chart-types";
    var canvas = getCanvas(id);
    if (!canvas) { return; } // canvas 缺失 → 跳過

    destroyInstance(id);

    var pairs = (state.charts && state.charts.types) || [];
    var sp = splitPairs(pairs);
    if (!hasData(sp.values)) {
      renderEmpty(canvas, "尚無案件類型資料");
      return;
    }

    var palette = buildPalette(sp.values.length);

    _instances[id] = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: sp.labels,
        datasets: [{
          data: sp.values,
          backgroundColor: palette,
          borderColor: THEME.paper,   // 米紙底分隔，無光暈
          borderWidth: 2,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: anim,
        cutout: "58%",
        plugins: {
          legend: {
            display: true,           // 甜甜圈保留精簡圖例
            position: "bottom",
            labels: {
              color: THEME.muted,
              boxWidth: 12,
              boxHeight: 12,
              padding: 12,
              font: { family: '"IBM Plex Mono", monospace', size: 11 }
            }
          },
          tooltip: {
            backgroundColor: THEME.ink,
            titleColor: THEME.paper,
            bodyColor: THEME.paper,
            borderColor: THEME.gold,
            borderWidth: 1
          }
        }
      }
    });
  }

  /* =========================================================================
   * 圖二：#chart-owners — 各承辦人案量（長條；最高/超載者以朱色強調）
   * ===================================================================== */
  function renderOwners(Chart, state, anim) {
    var id = "chart-owners";
    var canvas = getCanvas(id);
    if (!canvas) { return; }

    destroyInstance(id);

    var pairs = (state.charts && state.charts.owners) || [];
    var sp = splitPairs(pairs);
    if (!hasData(sp.values)) {
      renderEmpty(canvas, "尚無承辦人案量資料");
      return;
    }

    var inkColor = cssVar("--ink", THEME.ink);
    var accentColor = cssVar("--accent", THEME.cinnabar);
    var topIdx = argMax(sp.values); // 案量最高（或超載）者 → 朱色強調

    var colors = sp.values.map(function (_, i) {
      return i === topIdx ? accentColor : inkColor;
    });

    _instances[id] = new Chart(canvas, {
      type: "bar",
      data: {
        labels: sp.labels,
        datasets: [{
          label: "案量",
          data: sp.values,
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 0,
          borderRadius: 2,
          maxBarThickness: 36
        }]
      },
      options: {
        indexAxis: "y",             // 水平長條：承辦人名稱較好讀
        responsive: true,
        maintainAspectRatio: false,
        animation: anim,
        plugins: {
          legend: { display: false }, // 單一序列 → 不顯示圖例
          tooltip: {
            backgroundColor: THEME.ink,
            titleColor: THEME.paper,
            bodyColor: THEME.paper,
            borderColor: THEME.gold,
            borderWidth: 1
          }
        },
        scales: {
          x: axisStyle({ beginAtZero: true }),
          y: axisStyle({ beginAtZero: false })
        }
      }
    });
  }

  /* =========================================================================
   * 圖三：#chart-deals — 本月累計成交金額（折線）＋ 月目標虛線（金色）
   * target 為 null → 乾淨省略參考線。
   * ===================================================================== */
  function renderDeals(Chart, state, anim) {
    var id = "chart-deals";
    var canvas = getCanvas(id);
    if (!canvas) { return; }

    destroyInstance(id);

    var deals = (state.charts && state.charts.deals) || {};
    var labels = Array.isArray(deals.labels) ? deals.labels : [];
    var data = Array.isArray(deals.data) ? deals.data.map(Number) : [];

    if (labels.length === 0 || !hasData(data)) {
      renderEmpty(canvas, "本月尚無成交資料");
      return;
    }

    var accentColor = cssVar("--accent", THEME.cinnabar);
    var goldColor = cssVar("--gold", THEME.gold);

    var datasets = [{
      label: "累計成交金額",
      data: data,
      borderColor: accentColor,           // 朱色主線
      backgroundColor: tint(THEME.cinnabar, 0.78), // 極淡朱填色，無光暈
      fill: true,
      tension: 0.25,
      pointRadius: 2,
      pointBackgroundColor: accentColor,
      pointBorderColor: THEME.paper,
      pointBorderWidth: 1,
      borderWidth: 2
    }];

    // 月目標：有設定才畫 → 金色水平虛線（第二 dataset 的常數線，免外掛）
    var target = (deals.target == null) ? null : Number(deals.target);
    var hasTarget = (target != null && isFinite(target) && target > 0);
    if (hasTarget) {
      var line = [];
      for (var i = 0; i < labels.length; i++) { line.push(target); }
      datasets.push({
        label: "本月目標",
        data: line,
        borderColor: goldColor,           // 金色
        borderDash: [6, 4],               // 虛線
        borderWidth: 1.5,
        pointRadius: 0,
        pointHitRadius: 0,
        fill: false,
        tension: 0
      });
    }

    _instances[id] = new Chart(canvas, {
      type: "line",
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: anim,
        interaction: { mode: "index", intersect: false },
        plugins: {
          // 有目標線（兩序列）→ 顯示圖例；單序列 → 隱藏
          legend: {
            display: hasTarget,
            position: "bottom",
            labels: {
              color: THEME.muted,
              boxWidth: 18,
              padding: 12,
              font: { family: '"IBM Plex Mono", monospace', size: 11 }
            }
          },
          tooltip: {
            backgroundColor: THEME.ink,
            titleColor: THEME.paper,
            bodyColor: THEME.paper,
            borderColor: THEME.gold,
            borderWidth: 1
          }
        },
        scales: {
          x: axisStyle({ beginAtZero: false }),
          y: axisStyle({ beginAtZero: true })
        }
      }
    });
  }

  /* =========================================================================
   * 對外主入口：renderCharts(state)
   * - Chart 未載入 / state.charts 缺失 → 不畫、不拋錯
   * - 各圖獨立 try：單圖失敗不連累其它兩圖
   * ===================================================================== */
  function renderCharts(state) {
    var Chart = chartLib();
    if (!Chart) {
      // Chart.js 未載入：清掉殘存實例，安靜返回
      destroyAll();
      return;
    }
    if (!state || typeof state !== "object" || !state.charts) {
      // 無資料：保險清空既有圖表，避免顯示陳舊資料
      destroyAll();
      return;
    }

    applyDefaults(Chart);
    var anim = reducedMotion() ? false : undefined; // 尊重減少動態偏好

    try { renderTypes(Chart, state, anim); }   catch (e) { /* 單圖容錯 */ }
    try { renderOwners(Chart, state, anim); }  catch (e) { /* 單圖容錯 */ }
    try { renderDeals(Chart, state, anim); }   catch (e) { /* 單圖容錯 */ }
  }

  /* ---- 匯出 ---- */
  QJ.charts = {
    renderCharts: renderCharts,
    destroyAll: destroyAll,
    _instances: _instances // 測試/除錯可視
  };

})();
