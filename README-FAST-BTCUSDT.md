# BTCUSDT Binance + TradingView Charting Library (Performance Build)

## Required architecture

1. Direct Binance WebSocket
2. Trade-level real-time data (`btcusdt@trade`)
3. Local candle aggregation
4. TradingView Charting Library as the renderer/UI
5. Direct Binance REST API (`/api/v3/klines`)
6. No UDF polling
7. One persistent WebSocket

## Run

Use a local HTTP server from this directory. Do not open `index.html` directly with `file://`.

Example with Python:

    python -m http.server 8000

Then open:

    http://localhost:8000/

The supplied `charting_library/` directory is retained from the original TradingView Charting Library package.

## Performance architecture

- Historical candles come directly from Binance REST.
- Live prices come directly from Binance's trade WebSocket.
- There is no TradingView data server, UDF endpoint, application backend, or polling loop.
- The browser maintains one WebSocket for BTCUSDT.
- Only the selected TradingView resolution is aggregated and broadcast.
- The current candle is mutated in place and emitted immediately for each incoming trade.
- A short recent-trade buffer allows a resolution switch to reconstruct the current candle without opening another socket.
- Reconnect uses exponential backoff and prevents duplicate sockets.
- REST results are not periodically refreshed; the live WebSocket owns the current candle.

## Important technical limitation

The TradingView Charting Library itself is a substantial renderer. A direct Binance trade stream removes avoidable network/datafeed latency, but it cannot make TradingView render as cheaply as a custom Canvas renderer. This build therefore targets the lowest practical latency while preserving the actual Charting Library UI and rendering engine.

## Binance source

Spot REST:
`https://api.binance.com/api/v3/klines`

Spot WebSocket:
`wss://stream.binance.com:9443/ws/btcusdt@trade`

## Automatic interval drawings

`automatic-drawings.js` adds the automatic drawings from the supplied standalone HTML directly to the TradingView chart:

- Current 5m candle open: `#7dd3fc`, 1px, dashed `[5,3]`, beginning at the 5m candle position and extending right.
- Current 15m candle open: `#f5a623`, 1px, dashed `[5,3]`, beginning at the 15m candle position and extending right.
- Current 15m → last-5m box: activates at +10 minutes; left = 15m start −1m; right = 15m end +1m; boundaries are the 15m open and +10m 1m open; midline is their average; white `rgba(255,255,255,0.5)`, 1.25px, dashed `[5,3]`, no fill.

The overlay is non-interactive and follows TradingView pan/zoom/timeframe changes. It uses the Binance 1m trade stream for the exact bucket opens needed by the automatic drawings.
