/* Automatic 5m / 15m drawings — native TradingView drawing objects.
   Uses the Charting Library drawing API so drawings live inside the chart
   coordinate system and remain visible while zooming, panning, resizing.
*/
(function (global) {
  "use strict";

  var REST = "https://api.binance.com/api/v3/klines";
  var WS = "wss://stream.binance.com/ws/btcusdt@trade";
  var ONE_MIN = 60000;
  var FIVE = 5 * ONE_MIN;
  var FIFTEEN = 15 * ONE_MIN;

  var widget = null, chart = null, socket = null, timer = 0, reconnect = 0;
  var candles = Object.create(null);
  var destroyed = false;
  var ids = [];
  var lastKey = "";

  function bucket(ts, mins) { return Math.floor(ts / (mins * ONE_MIN)) * (mins * ONE_MIN); }
  function openAt(ts) { var c = candles[String(ts)]; return c ? c.open : null; }

  function removeAutoDrawings() {
    if (!chart) return;
    for (var i = 0; i < ids.length; i++) {
      try { chart.removeEntity(ids[i], { disableUndo: true }); } catch (_) {}
    }
    ids = [];
  }

  function addRay(timeMs, price, color) {
    if (price == null) return;
    try {
      /* Use the documented multipoint `ray` drawing.  `horizontal_ray` is not
         a supported CreateShapeOptions shape in this Charting Library build.
         A two-point horizontal ray gives the exact required start point and
         extends only to the right. */
      var t0 = timeMs / 1000;
      var t1 = (timeMs + ONE_MIN) / 1000;
      var result = chart.createMultipointShape(
        [
          { time: t0, price: price },
          { time: t1, price: price }
        ],
        {
          shape: "horizontal_ray",
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          zOrder: "top",
          overrides: {
            linecolor: color,
            linewidth: 1,
            linestyle: 2,
            showLabel: false,
            showPrice: false,
            
          }
        }
      );
      Promise.resolve(result).then(function(id) {
        if (id) ids.push(id);
      }).catch(function(e) {
        console.warn("[AutomaticDrawings] ray create rejected", e);
      });
    } catch (e) {
      console.warn("[AutomaticDrawings] ray error", e);
    }
  }

  function addBox(start15, p15, pLast5) {
    var left = (start15 - ONE_MIN) / 1000;
    var right = (start15 + FIFTEEN + ONE_MIN) / 1000;
    var top = Math.max(p15, pLast5);
    var bottom = Math.min(p15, pLast5);

    try {
      var result = chart.createMultipointShape(
        [
          { time: left, price: top },
          { time: right, price: bottom }
        ],
        {
          shape: "rectangle",
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          zOrder: "top",
          overrides: {
            "linetoolrectangle.color": "rgba(255,255,255,0.5)",
            "linetoolrectangle.linewidth": 1,
            "linetoolrectangle.lineStyle": 2,
            "linetoolrectangle.backgroundColor": "rgba(255,255,255,0)",
            "linetoolrectangle.fillBackground": false,
            "linetoolrectangle.extendLeft": false,
            "linetoolrectangle.extendRight": false,
            "linetoolrectangle.showLabel": false,
            "linetoolrectangle.middleLine.showLine": true,
            "linetoolrectangle.middleLine.lineColor": "rgba(255,255,255,0.5)",
            "linetoolrectangle.middleLine.lineWidth": 1,
            "linetoolrectangle.middleLine.lineStyle": 2
          }
        }
      );
      Promise.resolve(result).then(function(id) {
        if (id) ids.push(id);
      }).catch(function(e) {
        console.warn("[AutomaticDrawings] box create rejected", e);
      });
    } catch (e) {
      console.warn("[AutomaticDrawings] box error", e);
    }
  }

  function render() {
    if (destroyed || !chart) return;
    var now = Date.now();
    var b5 = bucket(now, 5);
    var b15 = bucket(now, 15);
    var p5 = openAt(b5);
    var p15 = openAt(b15);
    var pLast5 = now >= b15 + 10 * ONE_MIN ? openAt(b15 + 10 * ONE_MIN) : null;
    var key = [b5, p5, b15, p15, pLast5 != null ? pLast5 : "none"].join("|");

    if (key === lastKey) return;
    if (p5 == null || p15 == null) {
      console.log("[AutomaticDrawings] waiting for opens", { b5:b5, p5:p5, b15:b15, p15:p15, candles:Object.keys(candles).length });
      return;
    }

    lastKey = key;
    removeAutoDrawings();
    addRay(b15, p15, "#f5a623");
    addRay(b5, p5, "#7dd3fc");
    if (pLast5 != null) addBox(b15, p15, pLast5);

    console.log("[AutomaticDrawings] rendered EXACT", { fiveMin:{start:new Date(b5).toISOString(),open:p5}, fifteenMin:{start:new Date(b15).toISOString(),open:p15}, box:{last5Start:pLast5 != null ? new Date(b15+10*ONE_MIN).toISOString() : null,last5Open:pLast5} });
  }

  function seed(rows) {
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i];
      candles[String(+k[0])] = { open:+k[1], high:+k[2], low:+k[3], close:+k[4] };
    }
  }

  function fetchInitial() {
    var start = Date.now() - 24 * 60 * ONE_MIN;
    fetch(REST + "?symbol=BTCUSDT&interval=1m&startTime=" + start + "&limit=1000", { cache:"no-store", mode:"cors" })
      .then(function(r){ if (!r.ok) throw Error("HTTP " + r.status); return r.json(); })
      .then(function(rows){ seed(rows); console.log("[AutomaticDrawings] Binance 1m loaded", Object.keys(candles).length); render(); })
      .catch(function(e){ console.warn("[AutomaticDrawings] Binance history failed", e); });
  }

  function trade(ts, price) {
    var t = Math.floor(ts / ONE_MIN) * ONE_MIN;
    var k = String(t), c = candles[k];
    if (!c) candles[k] = c = { open:price, high:price, low:price, close:price };
    else { if (price > c.high) c.high = price; if (price < c.low) c.low = price; c.close = price; }
    render();
  }

  function connect() {
    if (destroyed || socket || reconnect) return;
    try { socket = new WebSocket(WS); } catch (_) { scheduleReconnect(); return; }
    socket.onopen = function(){ console.log("[AutomaticDrawings] Binance trade WS connected"); };
    socket.onmessage = function(ev){
      try {
        var x = JSON.parse(ev.data);
        if (x && x.e === "trade") trade(+x.T, +x.p);
      } catch (_) {}
    };
    socket.onerror = function(){ try{socket.close();}catch(_){} };
    socket.onclose = function(){ socket = null; scheduleReconnect(); };
  }
  function scheduleReconnect(){
    if (destroyed || reconnect) return;
    reconnect = setTimeout(function(){ reconnect = 0; connect(); }, 1000);
  }

  function init(w) {
    if (!w || destroyed) return;
    widget = w;
    chart = widget.activeChart();
    console.log("[AutomaticDrawings] native mode initialized");
    fetchInitial();
    connect();
    clearInterval(timer);
    timer = setInterval(render, 1000);
    render();
  }

  function destroy(){
    destroyed = true;
    clearInterval(timer);
    if (reconnect) clearTimeout(reconnect);
    if (socket) try{socket.close();}catch(_){}
    socket = null;
    removeAutoDrawings();
  }

  global.AutoIntervalDrawings = { init:init, destroy:destroy };
})(window);
