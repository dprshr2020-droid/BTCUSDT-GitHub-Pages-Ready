# Limited Pine-Compatible System — Exact 5m/15m Levels

The included `pine-indicator.pine` is the active indicator for the automatic level system.

## Exact behavior
- Current 5m bucket open: `#7dd3fc`, 1px, dashed `[5,3]`. Starts at the 5m candle position and extends to the right edge.
- Current 15m bucket open: `#f5a623`, 1px, dashed `[5,3]`. Starts at the 15m candle position and extends to the right edge.
- At +10 minutes into the current 15m bucket, a box is drawn between the 15m open and the +10m (last 5m) open.
- Box left boundary: 15m start - 1 minute.
- Box right boundary: 15m start + 16 minutes.
- Box midpoint line is included.
- Box and midpoint: white 50% (`rgba(255,255,255,0.5)`), 1.25px, dashed `[5,3]`, no fill.

The runtime uses Binance 1m candles for exact bucket-open values, so the drawings remain correct when the TradingView chart is switched between 1m and 5m.
