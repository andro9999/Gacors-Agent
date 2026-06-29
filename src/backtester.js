/**
 * Backtester — Event-driven backtest engine for Gacors Agent
 * 
 * Usage: node src/backtester.js [days] [symbol]
 * Example: node src/backtester.js 7 BTCUSDT
 * Default: 14 days, top 10 pairs
 */

import { CONFIG } from './config.js';
import { calculateIndicators } from './api/bitget.js';
import { runFilterChain } from './filters/filter-chain.js';
import { calculateScore } from './scoring/scoring-engine.js';

const CFG = CONFIG;

// ── Backtest Config ─────────────────────────────────────────────────────────
const BACKTEST = {
  INITIAL_BALANCE: 10000,
  LEVERAGE: 10,
  RISK_PER_TRADE: 0.01,      // 1% of balance
  FEE_RATE: 0.0006,           // 0.06% taker fee
  SLIPPAGE_BPS: 5,            // 0.05%
  MAX_POSITIONS: 10,
  SL_ATR_MULT: 2.0,
  TP1_ATR_MULT: 1.0,
  TP1_CLOSE_PCT: 0.5,         // close 50% at TP1
  TRAIL_ATR_MULT: 2.0,
  HARD_STOP_PCT: 4.0,
  MIN_SCORE: 50,
};

// ── Fetch klines from Bitget ────────────────────────────────────────────────
async function fetchKlines(symbol, timeframe, limit = 200) {
  const url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${timeframe}&limit=${limit}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json.code !== '00000') return [];
    return json.data.map(c => ({
      timestamp: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
      quoteVolume: parseFloat(c[6]),
    })).reverse(); // oldest first
  } catch { return []; }
}

// ── Simulate position ───────────────────────────────────────────────────────
function simulateTrade(entry, side, atr, klines, startIdx) {
  const slDist = Math.max(atr * BACKTEST.SL_ATR_MULT, entry * 0.02);
  const tp1Dist = Math.max(atr * BACKTEST.TP1_ATR_MULT, entry * 0.01);
  const trailDist = Math.max(atr * BACKTEST.TRAIL_ATR_MULT, entry * 0.02);

  const sl = side === 'long' ? entry - slDist : entry + slDist;
  const tp1 = side === 'long' ? entry + tp1Dist : entry - tp1Dist;

  let stage = 0; // 0 = full, 1 = TP1 hit (50% closed, trailing rest)
  let trailingSL = sl;
  let closed = false;
  let exitPrice = 0;
  let exitReason = '';
  let holdBars = 0;

  for (let i = startIdx; i < klines.length && !closed; i++) {
    const bar = klines[i];
    holdBars++;

    // Check hard stop
    const pnlPct = side === 'long'
      ? ((bar.low - entry) / entry) * 100
      : ((entry - bar.high) / entry) * 100;

    if (pnlPct <= -BACKTEST.HARD_STOP_PCT) {
      exitPrice = side === 'long' ? entry * (1 - BACKTEST.HARD_STOP_PCT / 100) : entry * (1 + BACKTEST.HARD_STOP_PCT / 100);
      exitReason = 'HARD_STOP';
      closed = true;
      break;
    }

    // Check SL / trailing SL
    if (side === 'long' && bar.low <= trailingSL) {
      exitPrice = trailingSL;
      exitReason = stage === 1 ? 'TRAIL' : 'SL';
      closed = true;
      break;
    }
    if (side === 'short' && bar.high >= trailingSL) {
      exitPrice = trailingSL;
      exitReason = stage === 1 ? 'TRAIL' : 'SL';
      closed = true;
      break;
    }

    // Check TP1
    if (stage === 0) {
      if ((side === 'long' && bar.high >= tp1) || (side === 'short' && bar.low <= tp1)) {
        stage = 1;
        trailingSL = entry; // move to breakeven
      }
    }

    // Update trailing SL
    if (stage === 1) {
      if (side === 'long') {
        const newSL = bar.close - trailDist;
        if (newSL > trailingSL) trailingSL = newSL;
      } else {
        const newSL = bar.close + trailDist;
        if (newSL < trailingSL) trailingSL = newSL;
      }
    }

    // Time exit after 20 bars (5 hours on 15m)
    if (holdBars >= 20) {
      exitPrice = bar.close;
      exitReason = 'TIME';
      closed = true;
      break;
    }
  }

  if (!closed) {
    exitPrice = klines[klines.length - 1]?.close || entry;
    exitReason = 'END';
  }

  // Calculate P&L
  const pnlRaw = side === 'long'
    ? (exitPrice - entry) / entry
    : (entry - exitPrice) / entry;

  // TP1 partial: 50% closed at TP1, rest at exit
  let effectivePnl;
  if (stage === 1) {
    const tp1Pnl = side === 'long' ? (tp1 - entry) / entry : (entry - tp1) / entry;
    effectivePnl = (tp1Pnl * BACKTEST.TP1_CLOSE_PCT) + (pnlRaw * (1 - BACKTEST.TP1_CLOSE_PCT));
  } else {
    effectivePnl = pnlRaw;
  }

  const feePct = BACKTEST.FEE_RATE * 2; // entry + exit
  const slipPct = BACKTEST.SLIPPAGE_BPS / 10000 * 2;
  const netPnlPct = effectivePnl - feePct - slipPct;

  return {
    entry,
    exit: exitPrice,
    side,
    pnlPct: netPnlPct * 100,
    exitReason,
    holdBars,
    stage,
  };
}

// ── Main Backtest ───────────────────────────────────────────────────────────
async function runBacktest(days = 14, targetSymbol = null) {
  console.log(`=== BACKTEST: ${days} days ===\n`);

  const symbols = targetSymbol
    ? [targetSymbol]
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
       'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT'];

  let balance = BACKTEST.INITIAL_BALANCE;
  const trades = [];
  const equityCurve = [{ date: 'start', balance }];

  for (const symbol of symbols) {
    console.log(`Backtesting ${symbol}...`);

    // Fetch 15m klines (limit 200 per request, need multiple)
    const klines15m = await fetchKlines(symbol, '15m', 200);
    const klines1h = await fetchKlines(symbol, '1H', 200);
    const klines4h = await fetchKlines(symbol, '4H', 200);

    if (klines15m.length < 50 || klines1h.length < 50) {
      console.log(`  Skipped ${symbol} — insufficient data`);
      continue;
    }

    let signalCount = 0;
    let tradeCount = 0;

    // Walk through 15m candles
    for (let i = 50; i < klines15m.length - 20; i++) {
      const candle = klines15m[i];

      // Simple indicator calculation (inline for backtest speed)
      const closes = klines15m.slice(Math.max(0, i - 50), i + 1).map(c => c.close);
      const highs = klines15m.slice(Math.max(0, i - 50), i + 1).map(c => c.high);
      const lows = klines15m.slice(Math.max(0, i - 50), i + 1).map(c => c.low);
      const volumes = klines15m.slice(Math.max(0, i - 50), i + 1).map(c => c.volume);

      // EMA
      const ema9 = closes.slice(-9).reduce((a, b) => a + b, 0) / 9;
      const ema21 = closes.slice(-21).reduce((a, b) => a + b, 0) / 21;

      // RSI
      const changes = closes.slice(-15).map((c, j) => j > 0 ? c - closes[j - 14] : 0).slice(1);
      const gains = changes.filter(c => c > 0);
      const losses = changes.filter(c => c < 0).map(Math.abs);
      const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / 14 : 0.001;
      const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / 14 : 0.001;
      const rsi = 100 - (100 / (1 + avgGain / avgLoss));

      // Volume ratio
      const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
      const volumeRatio = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 0;

      // ADX (simplified)
      const adx = 20 + Math.random() * 15; // placeholder

      // Trend
      const trend = ema9 > ema21 ? 'BULLISH' : 'BEARISH';

      // Side
      const side = trend === 'BULLISH' ? 'long' : 'short';

      // Simple filter check
      if (volumeRatio < 0.8) continue;
      if (side === 'long' && rsi > 70) continue;
      if (side === 'short' && rsi < 30) continue;
      if (side === 'long' && rsi < 35) continue;
      if (side === 'short' && rsi > 65) continue;

      signalCount++;

      // ATR
      const atr = highs.slice(-14).reduce((sum, h, j) => {
        const l = lows[j];
        const pc = closes[j - 1] || closes[j];
        return sum + Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }, 0) / 14;

      // Simulate trade
      const result = simulateTrade(candle.close, side, atr, klines15m, i + 1);

      // Apply to balance
      const riskAmount = balance * BACKTEST.RISK_PER_TRADE;
      const positionValue = riskAmount / (BACKTEST.SL_ATR_MULT * atr / candle.close);
      const pnlDollar = positionValue * result.pnlPct / 100;

      balance += pnlDollar;
      trades.push({
        symbol,
        time: new Date(candle.timestamp).toISOString(),
        side,
        entry: result.entry,
        exit: result.exit,
        pnlPct: result.pnlPct,
        pnlDollar,
        exitReason: result.exitReason,
        holdBars: result.holdBars,
        balance,
      });

      tradeCount++;

      // Skip ahead
      i += result.holdBars;
    }

    console.log(`  Signals: ${signalCount}, Trades: ${tradeCount}`);
  }

  // ── Results ─────────────────────────────────────────────────────────────
  console.log('\n=== RESULTS ===\n');

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const totalPnl = balance - BACKTEST.INITIAL_BALANCE;
  const totalPnlPct = (totalPnl / BACKTEST.INITIAL_BALANCE * 100);
  const winRate = trades.length ? (wins.length / trades.length * 100) : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  // Max drawdown
  let peak = BACKTEST.INITIAL_BALANCE;
  let maxDD = 0;
  for (const t of trades) {
    if (t.balance > peak) peak = t.balance;
    const dd = (peak - t.balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Exit reason breakdown
  const exitReasons = {};
  trades.forEach(t => {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  });

  console.log(`Trades:        ${trades.length}`);
  console.log(`Wins:          ${wins.length} (${winRate.toFixed(1)}%)`);
  console.log(`Losses:        ${losses.length}`);
  console.log(`Avg Win:       ${avgWin.toFixed(2)}%`);
  console.log(`Avg Loss:      ${avgLoss.toFixed(2)}%`);
  console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
  console.log(`Total P&L:     $${totalPnl.toFixed(2)} (${totalPnlPct.toFixed(2)}%)`);
  console.log(`Final Balance: $${balance.toFixed(2)}`);
  console.log(`Max Drawdown:  ${maxDD.toFixed(2)}%`);
  console.log(`\nExit Reasons:`);
  Object.entries(exitReasons).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => {
    console.log(`  ${r}: ${c} (${(c / trades.length * 100).toFixed(1)}%)`);
  });

  // Top 5 wins and losses
  const sorted = [...trades].sort((a, b) => b.pnlDollar - a.pnlDollar);
  console.log(`\nTop 5 Wins:`);
  sorted.slice(0, 5).forEach(t => {
    console.log(`  ${t.symbol} ${t.side} ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(2)}% ($${t.pnlDollar.toFixed(2)}) ${t.exitReason}`);
  });
  console.log(`Top 5 Losses:`);
  sorted.slice(-5).forEach(t => {
    console.log(`  ${t.symbol} ${t.side} ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(2)}% ($${t.pnlDollar.toFixed(2)}) ${t.exitReason}`);
  });

  return { trades, balance, winRate, totalPnlPct, maxDD, profitFactor };
}

// ── CLI Entry ───────────────────────────────────────────────────────────────
const days = parseInt(process.argv[2]) || 14;
const symbol = process.argv[3] || null;
runBacktest(days, symbol).catch(console.error);
