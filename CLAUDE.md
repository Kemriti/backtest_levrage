# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single self-contained HTML file (`upro_backtest_v9_yahoo.html`, ~6300 lines) implementing a browser-based backtest engine for a "Buy The Dip" leveraged-ETF trading strategy (UPRO, S&P 500 ×3), plus one small Cloudflare Pages Function (`functions/api/yahoo.js`) that proxies Yahoo Finance for the auto-fetch feature. There is no build system, no package manager, and no test suite for the HTML — it's a static page with CDN-loaded libraries and an inline Python engine executed client-side via Pyodide. See `README.md` for the full strategy/feature description.

The project is deployed on **Cloudflare Pages**, connected to this GitHub repo: every `git push` to the connected branch auto-redeploys. `_redirects` maps `/` → `/upro_backtest_v9_yahoo.html` so the deployed root URL serves the app directly.

## Commands

There is no build, lint, or test tooling — there is nothing to compile or transpile. Cloudflare Pages deploys the repo as-is (static file + Functions directory), no build command configured.

- **Run the app locally**: open `upro_backtest_v9_yahoo.html` directly in a browser. The Yahoo Finance auto-fetch will fall back to public CORS proxies (`corsproxy.io`, `allorigins`) since `/api/yahoo` (the Cloudflare Function) only exists once deployed — or use manual CSV upload, or the built-in GBM-simulated dataset. `lancer_backtest.bat` (Windows) is a legacy fully-offline option: it spins up a tiny inline Node CORS proxy on `localhost:8080` before opening the page, but is no longer needed once the site is deployed.
- **Iterate on the HTML**: edit the file and reload the page in the browser (Ctrl+R). No dev server is required. To verify a change, actually run a backtest in the browser (load CSVs or use Yahoo auto-fetch, click "▶ LANCER LE BACKTEST") and check the relevant output tab and/or the browser console for Python tracebacks (Pyodide surfaces them there).
- **Iterate on the proxy Function**: test via `npx wrangler pages dev .` (Cloudflare's local emulator for Pages + Functions) if you need to validate `/api/yahoo` before pushing; otherwise just push and check the deployed preview URL.
- **Node requirement**: only `lancer_backtest.bat`'s local proxy and `wrangler` (if used) need Node installed; the app itself needs nothing beyond a browser with WebAssembly support (for Pyodide).

## Architecture

The repo has two parts: the monolith HTML app, and a one-file Cloudflare Pages Function (`functions/api/yahoo.js`) that exists purely to give the browser-side `fetch()` a same-origin, CORS-safe endpoint for Yahoo Finance — it does nothing except forward `?ticker=&period1=&period2=` to `query1.finance.yahoo.com/v8/finance/chart/...` server-side and re-emit the JSON with `Access-Control-Allow-Origin: *`. If you change the query params `fetchYahooData()` sends, update both sides together.

Everything else lives in one file, organized top-to-bottom as: `<style>` → HTML markup (upload/config UI + tab shells) → one big `<script>` with all JS, which dynamically generates and runs a Python program. Rough line map (will drift as the file is edited, but useful for orientation):

- `~1–580`: CSS only.
- `~582–1204`: upload zone (CSV inputs + Yahoo auto-fetch controls) and the strategy config panel (all `<input>`/`<select>` controls — capital, dates, DCA, entry/scale/exit/stop thresholds, trend MA, adaptive timeout/TP-by-tranche, satellite, volatility regime filter, costs panel, hedge-put panel).
- `~1206–1898`: the 13 result tabs' HTML shells (`tab-performance`, `tab-trades`, `tab-drawdown`, `tab-distribution`, `tab-compare`, `tab-journal`, `tab-dca`, `tab-costs`, `tab-cash`, `tab-timeout`, `tab-hedge`, `tab-v5insights`, `tab-analysis`). `tab-analysis` is static content (known biases/risks of the strategy) — not generated from backtest output.
- `~1900` onward: JS. Key entry points:
  - `handleCSV()` / `parsePutsCSV()` — parse uploaded Yahoo-Finance-format CSVs into `window._csvData` (`upro`, `upro_high`, `spy`, `vix`, `puts`).
  - `fetchAllYahoo()` (~6221) / `fetchYahooData()` (~6111) — auto-fetches UPRO/SPY/VIX from Yahoo's `v8/finance/chart` API. Tries proxies in order: own `/api/yahoo` (relative path → only resolves when served from Cloudflare Pages), then `corsproxy.io`, then `allorigins`. Each is a same-shape JSON passthrough of Yahoo's response, so parsing logic doesn't need to branch per-proxy.
  - `runBacktest()` (~2828) — collects all config-panel values into a `params` object, calls `buildPythonCode(params)`, runs it via `pyodide.runPythonAsync(...)`, and dispatches the JSON result to `renderResults()`.
  - **`buildPythonCode(p)` (~2929–4265) is the actual trading engine** — it returns a Python source string (template literal) that Pyodide executes. This is where all strategy logic lives: GBM fallback simulation, real-CSV loading and date filtering, Black-Scholes put pricing, the day-by-day event-driven backtest loop (entry/scaling/exit/timeout/DCA/hedge/satellite), benchmark curves (SPY B&H, UPRO B&H, risk-free cash), and the metrics/journal computation. It ends with `json.dumps(result)` — the `result` dict (built at the end of the Python string) is the single contract between the Python engine and the JS rendering layer; every key consumed by a `render*()` function must exist there.
  - `renderResults(d, params)` (~4269) fans out the result dict to one `render*()` function per tab (`renderMetrics`, `renderPerfChart`, `renderTradesTable`, `renderDDChart`, `renderDistCharts`, `renderCompareTable`, `renderYearlyChart`, `renderJournal`, `renderCash`, `renderCosts`, `renderDCA`, `renderHedge`, `renderV5Insights`, `renderTimeout`).
  - `exportToExcel()` (~2168) builds the downloadable `.xlsx` via SheetJS from the same result data.
  - `applyCostPreset()`, `applyTimeoutPreset()`, `applyTPPreset()`, `applyVolPreset()` — preset buttons that just set slider/select values in the config panel; no separate logic path.

### Data flow into Python (important gotcha)

JS values are interpolated directly into the Python template string (`${p.xxx}`), so **every param must be coerced to a JS-stringifiable literal that is also valid Python** (numbers, or quoted strings for Python string params like `'${p.hedge_mode}'`). CSV datasets are the exception: they're passed as **double-JSON-encoded strings** (`JSON.stringify(JSON.stringify(x))`) specifically so Python always receives a quoted string (`'"null"'` or `'"{...}"'`) and never a bare `null`/`true` that would raise a Python `NameError`; `_decode_csv()` on the Python side reverses this with two `json.loads()` calls. Follow this same double-encoding pattern if you add new CSV-sourced data.

### Strategy engine invariants worth knowing before editing

- The rolling-max used for entry/scaling signals is `.shift(1)` to avoid look-ahead bias — don't remove the shift.
- `MAX_HOLD_BY_SCALE` / `effective_timeout` implement a **ratchet**: once a deeper tranche activates a shorter timeout, the effective timeout only tightens, never loosens, for the lifetime of that trade.
- Take-profit checks use the day's **High** (`upro_high`) against the target price, but fills are simulated at the exact target price (not the High), modeling a limit order; all other exits fill at Close.
- `upro_beta` (UPRO/SPY rolling 60-day beta, clamped to [1.5, 5]) replaces a previously hardcoded 2.5× factor for translating SPY vol into UPRO vol for Black-Scholes hedge pricing — keep using the rolling value rather than reintroducing a fixed constant.
- Benchmarks (SPY B&H, UPRO B&H, risk-free cash curve) all receive the same DCA injections as the main strategy at the same dates, so comparisons in the "Comparaison" tab stay apples-to-apples.

## Working language

UI strings, comments in the config panel, and the `README.md` are in French; keep new user-facing strings consistent with that.
