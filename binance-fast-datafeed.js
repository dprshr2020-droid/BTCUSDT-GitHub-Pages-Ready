/* BinanceFastDatafeed v3
   FIXED REALTIME ARCHITECTURE

   Binance trade stream is shared by every TradingView subscription.
   Each subscriber owns its own resolution-specific candle state.
   Historical bars seed that state, so realtime never starts a second
   candle stream or jumps backwards.

   TradingView is the actual renderer.
*/
(function (global) {
  "use strict";

  var REST = "https://api.binance.com";
  var WS_URL = "wss://stream.binance.com/ws/btcusdt@trade";
  var SYMBOL = "BTCUSDT";
  var TV_SYMBOL = "BINANCE:BTCUSDT";

  var RES = ["1","3","5","15","30","60","120","240","360","480","720","1D","3D","1W","1M"];

  var INTERVALS = {
    "1":"1m","3":"3m","5":"5m","15":"15m","30":"30m",
    "60":"1h","120":"2h","240":"4h","360":"6h","480":"8h",
    "720":"12h","1D":"1d","3D":"3d","1W":"1w","1M":"1M"
  };

  var MS = {
    "1":60000,"3":180000,"5":300000,"15":900000,"30":1800000,
    "60":3600000,"120":7200000,"240":14400000,"360":21600000,
    "480":28800000,"720":43200000,"1D":86400000,"3D":259200000,
    "1W":604800000
  };

  function BinanceFastDatafeed() {
    this.subs = Object.create(null);
    this.lastBars = Object.create(null);

    this.ws = null;
    this.wsOpen = false;
    this.connecting = false;
    this.reconnectTimer = 0;
    this.reconnectDelay = 250;
    this.lastTradeTs = 0;

    // Small ring-like recent trade buffer. It is used only when a new
    // resolution subscription appears while the single socket is already live.
    this.recentTrades = [];
    this.recentWindowMs = 60 * 60 * 1000;
  }

  BinanceFastDatafeed.prototype.onReady = function (cb) {
    cb({
      supported_resolutions: RES,
      supports_marks: false,
      supports_timescale_marks: false,
      supports_time: true,
      supports_search: false,
      exchanges: [{ value:"BINANCE", name:"Binance", desc:"Binance Spot" }]
    });
    this.connect();
  };

  BinanceFastDatafeed.prototype.searchSymbols = function (_i, _e, _t, cb) {
    cb([]);
  };

  BinanceFastDatafeed.prototype.resolveSymbol = function (_name, cb, _err) {
    cb({
      ticker: TV_SYMBOL,
      name: SYMBOL,
      full_name: TV_SYMBOL,
      description: "Bitcoin / TetherUS",
      type: "crypto",
      session: "24x7",
      exchange: "BINANCE",
      listed_exchange: "BINANCE",
      timezone: "Etc/UTC",
      format: "price",
      minmov: 1,
      pricescale: 100,
      has_intraday: true,
      has_daily: true,
      has_weekly_and_monthly: true,
      has_empty_bars: false,
      volume_precision: 3,
      intraday_multipliers: ["1","3","5","15","30","60","120","240","360","480","720"],
      daily_multipliers: ["1","3"],
      weekly_multipliers: ["1"],
      monthly_multipliers: ["1"],
      data_status: "streaming",
      supported_resolutions: RES
    });
  };

  BinanceFastDatafeed.prototype.getServerTime = function (cb) {
    cb(Math.floor(Date.now() / 1000));
  };

  BinanceFastDatafeed.prototype.getBars = function (symbolInfo, resolution, pp, onResult, onError) {
    var interval = INTERVALS[resolution];
    if (!interval) {
      onError("Unsupported resolution: " + resolution);
      return;
    }

    var toMs = Math.floor(pp.to * 1000);
    var fromMs = Math.floor(pp.from * 1000);
    var countBack = Math.max(100, pp.countBack || 500);
    var step = MS[resolution];

    // TradingView explicitly says countBack is more important than the
    // from/to range. Ensure the first request can actually return enough bars.
    if (step) {
      var countStart = toMs - (countBack + 5) * step;
      if (countStart < fromMs) fromMs = countStart;
    }

    // Binance max is 1000 klines/request. One request covers the normal
    // chart startup case; page only if TradingView asks for >1000 bars.
    var need = Math.min(countBack + 5, 2500);
    var cursor = fromMs;
    var all = [];
    var requests = 0;
    var self = this;

    function fetchPage() {
      if (requests++ >= 3 || all.length >= need) {
        finish();
        return;
      }

      var limit = Math.min(1000, need - all.length);
      var url = REST + "/api/v3/klines?symbol=" + SYMBOL +
        "&interval=" + encodeURIComponent(interval) +
        "&startTime=" + cursor +
        "&endTime=" + toMs +
        "&limit=" + limit;

      fetch(url, { cache:"no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("Binance REST HTTP " + r.status);
          return r.json();
        })
        .then(function (rows) {
          if (!rows.length) {
            finish();
            return;
          }

          for (var i = 0; i < rows.length; i++) {
            var k = rows[i];
            all.push({
              time:+k[0],
              open:+k[1],
              high:+k[2],
              low:+k[3],
              close:+k[4],
              volume:+k[5]
            });
          }

          var lastTime = +rows[rows.length - 1][0];
          if (lastTime >= toMs - (step || 0) || rows.length < limit) {
            finish();
            return;
          }

          cursor = lastTime + 1;
          fetchPage();
        })
        .catch(function (e) {
          console.error("[BinanceFastDatafeed] REST:", e);
          onError(String(e));
        });
    }

    function finish() {
      if (!all.length) {
        onResult([], { noData:true });
        return;
      }

      // De-duplicate and sort defensively. TradingView requires strictly
      // ascending chronological data.
      all.sort(function(a,b){ return a.time - b.time; });

      var unique = [];
      var prev = -1;
      for (var i = 0; i < all.length; i++) {
        if (all[i].time !== prev) {
          unique.push(all[i]);
          prev = all[i].time;
        }
      }

      // Keep only TradingView's requested range, while retaining countBack.
      var filtered = unique.filter(function(b){
        return b.time >= fromMs && b.time < toMs;
      });

      if (!filtered.length) {
        filtered = unique.slice(-Math.min(unique.length, countBack));
      }

      var last = filtered[filtered.length - 1];
      if (!self.lastBars[resolution] || last.time >= self.lastBars[resolution].time) {
        self.lastBars[resolution] = self.clone(last);
      }

      // Seed every currently active subscriber of this resolution with the
      // same authoritative historical last bar.
      for (var id in self.subs) {
        var s = self.subs[id];
        if (s.resolution === resolution) {
          s.bar = self.clone(last);
        }
      }

      onResult(filtered, { noData:false });
    }

    fetchPage();
  };

  BinanceFastDatafeed.prototype.subscribeBars = function (
    symbolInfo, resolution, onTick, listenerGuid, onResetCacheNeededCallback
  ) {
    // TradingView may temporarily keep old subscriptions alive during a
    // timeframe switch. They must remain independent.
    this.subs[listenerGuid] = {
      symbol:symbolInfo.ticker || TV_SYMBOL,
      resolution:resolution,
      onTick:onTick,
      onReset:onResetCacheNeededCallback,
      bar:this.clone(this.lastBars[resolution])
    };

    if (!this.subs[listenerGuid].bar) {
      this.subs[listenerGuid].bar = this.rebuildCurrentBar(resolution);
    }

    this.connect();

    if (this.subs[listenerGuid].bar) {
      onTick(this.clone(this.subs[listenerGuid].bar));
    }
  };

  BinanceFastDatafeed.prototype.unsubscribeBars = function (listenerGuid) {
    delete this.subs[listenerGuid];
  };

  BinanceFastDatafeed.prototype.connect = function () {
    if (this.wsOpen || this.connecting) return;

    this.connecting = true;

    var ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.onopen = function () {
      this.connecting = false;
      this.wsOpen = true;
      this.reconnectDelay = 250;
      console.info("[BinanceFastDatafeed] Binance trade stream connected");
    }.bind(this);

    ws.onmessage = function (ev) {
      var x;
      try { x = JSON.parse(ev.data); } catch (_) { return; }

      var ts = +x.T;
      var price = +x.p;
      var qty = +x.q;

      if (!(ts > this.lastTradeTs) || !(price > 0)) return;
      this.lastTradeTs = ts;

      this.recentTrades.push([ts, price, qty]);

      var cutoff = ts - this.recentWindowMs;
      var a = this.recentTrades;
      var cut = 0;
      while (cut < a.length && a[cut][0] < cutoff) cut++;
      if (cut) this.recentTrades = a.slice(cut);

      this.updateSubscribers(ts, price, qty);
    }.bind(this);

    ws.onerror = function () {
      try { ws.close(); } catch (_) {}
    };

    ws.onclose = function () {
      if (this.ws === ws) {
        this.ws = null;
        this.wsOpen = false;
        this.connecting = false;
        this.scheduleReconnect();
      }
    }.bind(this);
  };

  BinanceFastDatafeed.prototype.scheduleReconnect = function () {
    if (this.reconnectTimer) return;

    var delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(10000, this.reconnectDelay * 2);

    this.reconnectTimer = setTimeout(function(){
      this.reconnectTimer = 0;
      this.connect();
    }.bind(this), delay);
  };

  BinanceFastDatafeed.prototype.updateSubscribers = function (ts, price, qty) {
    for (var id in this.subs) {
      var s = this.subs[id];
      var bucket = this.bucket(ts, s.resolution);
      var b = s.bar;

      if (!b) {
        b = {
          time:bucket,
          open:price,
          high:price,
          low:price,
          close:price,
          volume:qty
        };
        s.bar = b;
        this.lastBars[s.resolution] = this.clone(b);
        s.onTick(this.clone(b));
        continue;
      }

      if (bucket < b.time) continue;

      if (bucket > b.time) {
        b = {
          time:bucket,
          open:price,
          high:price,
          low:price,
          close:price,
          volume:qty
        };
        s.bar = b;
        this.lastBars[s.resolution] = this.clone(b);
        s.onTick(this.clone(b));
        continue;
      }

      // Same candle: update only OHLCV fields that changed.
      if (price > b.high) b.high = price;
      if (price < b.low) b.low = price;
      b.close = price;
      b.volume += qty;

      this.lastBars[s.resolution] = this.clone(b);
      s.onTick(this.clone(b));
    }
  };

  BinanceFastDatafeed.prototype.rebuildCurrentBar = function (resolution) {
    var seed = this.lastBars[resolution];
    if (seed) return this.clone(seed);

    var a = this.recentTrades;
    if (!a.length) return null;

    var last = a[a.length - 1];
    var bucket = this.bucket(last[0], resolution);
    var b = null;

    for (var i = a.length - 1; i >= 0; i--) {
      var t = a[i];
      if (t[0] < bucket) break;

      if (!b) {
        b = {
          time:bucket,
          open:t[1],
          high:t[1],
          low:t[1],
          close:t[1],
          volume:t[2]
        };
      } else {
        b.open = t[1];
        if (t[1] > b.high) b.high = t[1];
        if (t[1] < b.low) b.low = t[1];
        b.volume += t[2];
      }
    }

    return b;
  };

  BinanceFastDatafeed.prototype.bucket = function (ms, resolution) {
    if (resolution === "1M") {
      var d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }

    var step = MS[resolution];
    return step ? Math.floor(ms / step) * step : ms;
  };

  BinanceFastDatafeed.prototype.clone = function (b) {
    if (!b) return null;
    return {
      time:b.time,
      open:b.open,
      high:b.high,
      low:b.low,
      close:b.close,
      volume:b.volume
    };
  };

  global.BinanceFastDatafeed = BinanceFastDatafeed;
})(window);
