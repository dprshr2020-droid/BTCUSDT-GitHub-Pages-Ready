# Limited Pine-Compatible System

This project adds a small Pine-style runtime on top of the existing fast Binance BTCUSDT + TradingView Charting Library project.

## Included
- Binance 1m historical OHLCV seed and live trade updates.
- Pine-style variables and a limited expression evaluator.
- Common `ta.*` functions: SMA, EMA, RMA, WMA, RSI, ATR, highest, lowest, crossover, crossunder.
- `plot()` and `hline()` rendering.
- Exact automatic 5m/15m lines + 15m→last-5m box through the same runtime using `exactDrawings()`.
- 5m line: #7dd3fc, 1px, [5,3].
- 15m line: #f5a623, 1px, [5,3].
- Box starts 1m before the 15m bucket and ends 1m after it; it activates after the 10-minute point and includes the midpoint line.

## Script
`pine-indicator.pine` is the default indicator definition. The runtime is deliberately limited and is not TradingView's Pine runtime.
