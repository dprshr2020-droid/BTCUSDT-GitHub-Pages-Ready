/*
 * Automatic 5m / 15m interval drawings.
 * Geometry and styling are intentionally based on the supplied standalone HTML:
 * - 5m open ray: #7dd3fc, 1px, [5,3]
 * - 15m open ray: #f5a623, 1px, [5,3]
 * - 15m -> last-5m box: white rgba(255,255,255,0.5), 1.25px, [5,3], no fill
 * - box appears only from +10m into the current 15m bucket
 *
 * The drawings are rendered in a non-interactive canvas over the TradingView
 * chart, rather than as saved TradingView drawing objects. This preserves the
 * exact canvas line width/dash pattern required by the source HTML.
 */
(function (global) {
  "use strict";

  var REST = "https://api.binance.com/api/v3/klines";
  var WS = "wss://stream.binance.com/ws/btcusdt@trade";
  var ONE_MIN = 60000;
  var FIVE_MIN = 5 * ONE_MIN;
  var FIFTEEN_MIN = 15 * ONE_MIN;

  var widget = null;
  var chart = null;
  var timeScale = null;
  var priceScale = null;
  var pane = null;
  var canvas = null;
  var ctx = null;
  var raf = 0;
  var timer = 0;
  var socket = null;
  var reconnectTimer = 0;
  var destroyed = false;

  // 1m candles keyed by exact Binance open timestamp.
  var candles = Object.create(null);
  var lastTradeTs = 0;

  function bucketStart(ts, minutes) {
    var size = minutes * ONE_MIN;
    return Math.floor(ts / size) * size;
  }

  function ensureCanvas() {
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "automatic-interval-drawings";
      canvas.style.cssText = [
        "position:absolute",
        "left:0",
        "top:0",
        "display:block",
        "pointer-events:none",
        "z-index:999999"
      ].join(";");
      var host = document.getElementById("tv_chart_container");
      if (host) {
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        host.appendChild(canvas);
      }
      ctx = canvas.getContext("2d");
    }
  }

  function syncCanvas() {
    ensureCanvas();
    if (!canvas || !chart || !timeScale || !pane) return false;

    var host = document.getElementById("tv_chart_container");
    if (!host) return false;

    var width = Math.max(1, Math.round(timeScale.width()));
    var height = Math.max(1, Math.round(pane.getHeight()));
    var dpr = global.devicePixelRatio || 1;

    // The TradingView time-scale coordinate system starts at the left edge of
    // the main chart pane; the main pane starts at the top of the fullscreen host.
    // Locate the underlying TradingView plot surface so the overlay uses the
    // same left/top origin even when the left drawing toolbar is visible.
    var hostRect = host.getBoundingClientRect();
    var left = 0, top = 0;
    var nodes = host.querySelectorAll("canvas, svg, div");
    var best = null, bestScore = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el === canvas) continue;
      var r = el.getBoundingClientRect();
      if (r.width < width - 4 || r.width > width + 4) continue;
      if (r.height < height - 8) continue;
      var score = Math.abs(r.width - width) + Math.abs(r.height - height) * 0.25 + Math.abs(r.top - hostRect.top) * 0.5;
      if (score < bestScore) { bestScore = score; best = r; }
    }
    if (best) {
      left = best.left - hostRect.left;
      top = best.top - hostRect.top;
    }

    canvas.style.left = Math.round(left) + "px";
    canvas.style.top = Math.round(top) + "px";
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  // Calibrate the time -> pixel mapping from TradingView's public
  // coordinateToTime() API. This avoids assumptions about bar spacing or the
  // current right offset.
  function timeToX(unixMs) {
    var width = timeScale.width();
    if (!(width > 0)) return null;

    var t0 = timeScale.coordinateToTime(0);
    var t1 = timeScale.coordinateToTime(width);
    if (t0 == null || t1 == null || t1 === t0) return null;

    var ts = unixMs / 1000;
    return (ts - t0) / (t1 - t0) * width;
  }

  function priceToY(price) {
    var range = priceScale && priceScale.getVisiblePriceRange();
    if (!range) return null;
    var from = Number(range.from);
    var to = Number(range.to);
    var h = pane.getHeight();
    if (!(h > 0) || !isFinite(from) || !isFinite(to) || from === to) return null;

    // TradingView price scales normally run from high at y=0 to low at y=height.
    return h - ((price - from) / (to - from)) * h;
  }

  function getOpen(ts) {
    var c = candles[String(ts)];
    return c ? c.open : null;
  }

  function currentTargets(now) {
    var b5 = bucketStart(now, 5);
    var b15 = bucketStart(now, 15);
    return {
      b5: b5,
      p5: getOpen(b5),
      b15: b15,
      p15: getOpen(b15)
    };
  }

  function drawRay(price, bucketTs, color) {
    if (price == null) return;
    var y = priceToY(price);
    var xCenter = timeToX(bucketTs);
    if (y == null || xCenter == null) return;

    // The supplied standalone HTML starts each ray at the left edge of the
    // matching candle slot. TradingView's coordinateToTime() maps a candle
    // timestamp to its candle center, so move back by half the bar spacing.
    var barSpacing = timeScale.barSpacing();
    var x = xCenter - barSpacing / 2;

    if (y <= -20 || y >= pane.getHeight() + 20) return;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y + 0.5);
    ctx.lineTo(timeScale.width(), y + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  function drawBox(now, b15, p15) {
    if (p15 == null) return;
    if (now < b15 + 10 * ONE_MIN) return;

    var last5Start = b15 + 10 * ONE_MIN;
    var pLast5 = getOpen(last5Start);
    if (pLast5 == null) return;

    var leftT = b15 - ONE_MIN;
    var rightT = b15 + FIFTEEN_MIN + ONE_MIN;
    var left = timeToX(leftT);
    var right = timeToX(rightT);
    var y1 = priceToY(p15);
    var y2 = priceToY(pLast5);
    var yMid = priceToY((p15 + pLast5) / 2);

    if (left == null || right == null || y1 == null || y2 == null || yMid == null) return;

    var boxLeft = Math.min(left, right);
    var boxRight = Math.max(left, right);
    var top = Math.min(y1, y2);
    var bottom = Math.max(y1, y2);

    // Match the HTML's clip-to-chart behavior.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, timeScale.width(), pane.getHeight());
    ctx.clip();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 3]);

    ctx.strokeRect(boxLeft + 0.5, top + 0.5, boxRight - boxLeft, bottom - top);
    ctx.beginPath();
    ctx.moveTo(boxLeft, Math.round(yMid) + 0.5);
    ctx.lineTo(boxRight, Math.round(yMid) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    raf = 0;
    if (destroyed || !chart) return;
    try {
      timeScale = chart.getTimeScale();
      pane = chart.getPanes()[0];
      priceScale = pane && pane.getMainSourcePriceScale();
    } catch (_) { return; }
    if (!timeScale || !pane || !priceScale || !syncCanvas()) return;

    var w = timeScale.width();
    var h = pane.getHeight();
    ctx.clearRect(0, 0, w, h);

    var now = Date.now();
    var t = currentTargets(now);

    drawRay(t.p15, t.b15, "#f5a623");
    drawRay(t.p5, t.b5, "#7dd3fc");
    drawBox(now, t.b15, t.p15);
  }

  function scheduleDraw() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(draw);
  }

  function seedRows(rows) {
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i];
      candles[String(+k[0])] = {
        time: +k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4]
      };
    }
  }

  function fetchInitial() {
    var now = Date.now();
    var start = now - 24 * 60 * ONE_MIN;
    var url = REST + "?symbol=BTCUSDT&interval=1m&startTime=" + start + "&limit=1000";
    fetch(url, { cache: "no-store", mode: "cors" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (rows) {
        if (Array.isArray(rows)) seedRows(rows);
        scheduleDraw();
      })
      .catch(function (e) { console.warn("[AutomaticDrawings] 1m history:", e); });
  }

  function updateFromTrade(ts, price) {
    var t = Math.floor(ts / ONE_MIN) * ONE_MIN;
    var key = String(t);
    var c = candles[key];
    if (!c) {
      candles[key] = { time:t, open:price, high:price, low:price, close:price };
    } else {
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      c.close = price;
    }
    scheduleDraw();
  }

  function connect() {
    if (destroyed || socket || reconnectTimer) return;
    try { socket = new WebSocket(WS); } catch (e) { socket = null; scheduleReconnect(); return; }

    socket.onmessage = function (ev) {
      var x;
      try { x = JSON.parse(ev.data); } catch (_) { return; }
      if (!x || x.e !== "trade") return;
      var ts = +x.T, price = +x.p;
      if (!(ts > lastTradeTs) || !(price > 0)) return;
      lastTradeTs = ts;
      updateFromTrade(ts, price);
    };

    socket.onerror = function () { try { socket.close(); } catch (_) {} };
    socket.onclose = function () {
      socket = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (destroyed || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = 0;
      connect();
    }, 1000);
  }

  function bindChartEvents() {
    if (!chart) return;
    try { timeScale = chart.getTimeScale(); } catch (_) { timeScale = null; }
    try {
      pane = chart.getPanes()[0];
      priceScale = pane && pane.getMainSourcePriceScale();
    } catch (_) {
      pane = null;
      priceScale = null;
    }

    try { chart.onVisibleRangeChanged().subscribe(null, scheduleDraw); } catch (_) {}
    try { chart.onDataLoaded().subscribe(null, scheduleDraw); } catch (_) {}
    try { timeScale.barSpacingChanged().subscribe(null, scheduleDraw); } catch (_) {}
    try { timeScale.rightOffsetChanged().subscribe(null, scheduleDraw); } catch (_) {}
    try { chart.onIntervalChanged().subscribe(null, function () { scheduleDraw(); }); } catch (_) {}
    try { chart.onSymbolChanged().subscribe(null, function () { scheduleDraw(); }); } catch (_) {}
  }

  function init(w) {
    if (!w || destroyed) return;
    widget = w;
    chart = widget.activeChart();
    ensureCanvas();
    bindChartEvents();
    console.log("[AutomaticDrawings] initialized — persistence disabled");
    fetchInitial();
    connect();

    clearInterval(timer);
    // The source HTML checks the bucket/box state frequently. One-second
    // refresh keeps the +10m activation and bucket transitions exact.
    timer = setInterval(scheduleDraw, 1000);
    scheduleDraw();
  }

  function destroy() {
    destroyed = true;
    clearInterval(timer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (socket) try { socket.close(); } catch (_) {}
    socket = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    ctx = null;
  }

  global.AutoIntervalDrawings = { init: init, destroy: destroy };
})(window);
