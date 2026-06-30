// index.js — Main Orchestrator for Bitget Trading Agent

import 'dotenv/config';
import { CONFIG } from './src/config.js';
import { fetchPairs, fetchKlines, fetchTicker, fetchFundingRate, calculateIndicators, getBTCRegime } from './src/api/binance.js';
import { runFilterChain } from './src/filters/filter-chain.js';
import { calculateScore } from './src/scoring/scoring-engine.js';
import { checkRisk, calculatePositionSize } from './src/risk/risk-manager.js';
import { llmGate } from './src/risk/llm-gate.js';
import { openPosition, getPositions, getBalance, getTradeLog } from './src/execution/paper-trader.js';
import { calculateSLTP, startMonitoring, setTelegramBot } from './src/execution/position-manager.js';
import { startBot, sendNotification, isPausedState } from './src/telegram/bot.js';

const CFG = CONFIG;
let scanCount = 0;

// ── Cooldown Tracker ────────────────────────────────────────────────────────
const lastTradeTime = new Map(); // symbol -> timestamp

function isOnCooldown(symbol) {
  const last = lastTradeTime.get(symbol);
  if (!last) return false;
  return (Date.now() - last) < CFG.POSITIONS.COOLDOWN_MS;
}

function recordTrade(symbol) {
  lastTradeTime.set(symbol, Date.now());
}


// ── Indicator Adapter ────────────────────────────────────────────────────────

function adaptIndicators(result, extra = {}) {
  if (!result || !result.current) return null;
  const c = result.current;
  const t = result.trend || {};

  return {
    price:           c.price,
    RSI:             c.rsi,
    EMA9:            c.ema9,
    EMA21:           c.ema21,
    EMA50:           c.ema50,
    MACD:            c.macd,
    MACD_signal:     c.macdSignal,
    MACD_hist:       c.macdHistogram,
    stochRSI_K:      c.stochRsiK,
    stochRSI_D:      c.stochRsiD,
    fisher:          c.fisher,
    ADX:             c.adx,
    DI_plus:         c.plusDI,
    DI_minus:        c.minusDI,
    ATR:             c.atr,
    VWAP:            c.vwap,
    VWAP_distance:   c.price && c.vwap ? (c.price - c.vwap) / c.vwap * 100 : 0,
    bollingerUpper:  c.bollingerUpper,
    bollingerMiddle: c.bollingerMiddle,
    bollingerLower:  c.bollingerLower,
    bollingerPercentB: c.bollingerPercentB,
    bbSqueeze:       c.bollingerPercentB !== undefined && Math.abs(c.bollingerPercentB - 0.5) < 0.1,
    chop:            c.chop,
    choppiness:      c.chop,
    volumeRatio:     c.volumeRatio,
    composite:       c.composite,
    trend_4h:        result.fourHTrend?.trend?.toLowerCase() || 'neutral',
    trend_overall:   t.overall || 'NEUTRAL',
    fundingRate:     extra.fundingRate ?? 0,
    OI_change_pct:   extra.oiChange ?? 0,
    takerBuyRatio:   extra.takerBuyRatio ?? 0.5,
    topTraderBias:   extra.topTraderBias ?? 'neutral',
    entry15m:        result.entry15m,
    arrays:          result.arrays,
  };
}

// ── Cluster Helper ──────────────────────────────────────────────────────────

function getCluster(symbol) {
  for (const [name, cluster] of Object.entries(CFG.CLUSTERS || {})) {
    if (cluster.SYMBOLS?.includes(symbol)) return name;
  }
  return 'unknown';
}

// ── BTC Regime Helper ─────────────────────────────────────────────────────────

/**
 * Decide whether a side is allowed under the current BTC regime.
 *   BEARISH → only shorts (skip longs)
 *   BULLISH → only longs (skip shorts)
 *   NEUTRAL → both allowed
 */
function regimeAllowsSide(btcRegime, side) {
  if (btcRegime === 'BEARISH') return side === 'short';
  if (btcRegime === 'BULLISH') return side === 'long';
  return true;
}

// ── Scan Cycle ──────────────────────────────────────────────────────────────

async function runScan() {
  if (isPausedState()) return;

  const startTime = Date.now();
  scanCount++;
  console.log(`[${new Date().toISOString()}] Scan #${scanCount} starting...`);

  try {
    const pairs = await fetchPairs();
    console.log(`  ${pairs.length} pairs fetched`);

    const btcResult = await getBTCRegime();
    const btcRegime = btcResult?.trend?.overall || 'NEUTRAL';

    const regimeMode = btcRegime === 'BEARISH' ? 'SHORTS ONLY'
                     : btcRegime === 'BULLISH' ? 'LONGS ONLY'
                     : 'BOTH';
    console.log(`  BTC Regime: ${btcRegime} → ${regimeMode}`);

    const positions = getPositions();
    const openCount = positions.length;
    const maxPositions = CFG.POSITIONS.MAX_OPEN;
    const slotsAvailable = maxPositions - openCount;
    console.log(`  Open: ${openCount}/${maxPositions}, slots: ${slotsAvailable}`);

    if (slotsAvailable <= 0) {
      console.log('  Max positions reached, skipping scan');
      return;
    }

    const openSymbols = new Set(positions.map(p => p.asset));

    // ── Phase 1: Collect all candidates with scores ──
    const candidates = [];
    let scanned = 0;
    let filterPassed = 0;
    let filterFailed = 0;
    let scorePassed = 0;
    let scoreFailed = 0;
    let regimeVetoed = 0;

    for (const symbol of pairs.slice(0, 500)) {
      try {
        if (openSymbols.has(symbol)) continue;
        scanned++;

        // Calculate all indicators
        const rawIndicators = await calculateIndicators(symbol, CFG.INDICATORS);
        if (!rawIndicators) continue;

        // Fetch funding rate
        let extra = {};
        try {
          const funding = await fetchFundingRate(symbol);
          extra.fundingRate = funding?.fundingRate ?? 0;
        } catch { /* optional */ }

        // Adapt to flat format
        const indicators = adaptIndicators(rawIndicators, extra);
        if (!indicators) continue;

        // Calculate priceChangePct from 24h change
        const ticker = await fetchTicker(symbol);
        const priceChangePct = ticker?.change24h ?? 0;

        // Determine side from trend
        const side = indicators.trend_overall === 'BULLISH' ? 'long' :
                     indicators.trend_overall === 'BEARISH' ? 'short' :
                     btcRegime === 'BULLISH' ? 'long' :
                     btcRegime === 'BEARISH' ? 'short' :
                     indicators.EMA9 > indicators.EMA21 ? 'long' : 'short';

        // BTC Regime Veto: hard gate
        if (!regimeAllowsSide(btcRegime, side)) {
          regimeVetoed++;
          continue;
        }

        // Build candidate
        const candidate = {
          symbol,
          side,
          priceChangePct,
          cluster: getCluster(symbol),
        };

        // Run filter chain (critical + soft)
        const filter = runFilterChain(candidate, indicators, {
          ...CFG,
          OPEN_POSITIONS: positions,
        });

        if (!filter.pass) {
          filterFailed++;
          if (filterFailed <= 5) { // Log first 5 rejections for debugging
            const reasons = filter.failures?.map(f => f.reason).join('; ') || 'unknown';
            console.log(`    REJECT ${symbol}: ${reasons.slice(0, 100)}`);
          }
          continue;
        }
        filterPassed++;

        // Calculate score with filter penalty
        candidate.filterPenalty = filter.penalty;
        const scoreResult = calculateScore(candidate, indicators, CFG);

        if (!scoreResult.passed) {
          scoreFailed++;
          continue;
        }
        scorePassed++;

        // Add to candidates list
        candidates.push({
          symbol,
          side,
          score: scoreResult.score,
          breakdown: scoreResult.breakdown,
          indicators,
          priceChangePct,
          filterPenalty: filter.penalty,
          ticker,
        });

      } catch (e) {
        // Skip individual pair errors
      }
    }

    console.log(`  Scanned: ${scanned} | RegimeVeto: ${regimeVetoed} | Filter: ${filterPassed}/${filterFailed} | Score: ${scorePassed}/${scoreFailed}`);
    console.log(`  Candidates: ${candidates.length} (regime: ${btcRegime} → ${regimeMode})`);

    if (candidates.length === 0) {
      console.log('  No candidates found');
      return;
    }

    // ── Phase 2: Rank by score (highest first) ──
    candidates.sort((a, b) => b.score - a.score);

    // Show top 5
    console.log('  Top candidates:');
    for (const c of candidates.slice(0, 5)) {
      console.log(`    ${c.symbol.padEnd(12)} ${c.side.padEnd(6)} Score: ${c.score.toFixed(1)} | Trend:${c.breakdown.trend} Mom:${c.breakdown.momentum} Vol:${c.breakdown.volume} Str:${c.breakdown.structure} Bon:${c.breakdown.bonus}`);
    }

    // ── Phase 3: Execute top N trades (max 3 per scan to avoid correlation) ──
    let tradesExecuted = 0;
    const maxTradesPerScan = 3;
    const maxTrades = Math.min(slotsAvailable, candidates.length, maxTradesPerScan);

    for (let i = 0; i < maxTrades; i++) {
      const c = candidates[i];

      try {
        // Cooldown check — skip if recently traded this symbol
        if (isOnCooldown(c.symbol)) {
          continue;
        }

        // Risk check — pass closedTrades and balance for circuit breaker + daily loss
        const allLogs = getTradeLog(-1);
        const closedTrades = allLogs
          .filter(l => l.type === 'CLOSE' || l.type?.startsWith('CLOSE_'))
          .map(l => ({ symbol: l.asset, pnl: l.pnl || 0, closedAt: new Date(l.timestamp).getTime() }));
        const currentBalance = getBalance();
        const risk = checkRisk({ symbol: c.symbol, side: c.side.toUpperCase(), score: c.score }, getPositions(), {
          ...CFG,
          closedTrades,
          balance: currentBalance,
        });
        if (!risk.allowed) {
          console.log(`    ${c.symbol} BLOCKED by risk: ${risk.blockers.join(', ')}`);
          continue;
        }

        // LLM gate (bypass if score >= 80)
        // LLM gate: ADVISORY ONLY — log but don't block (Opus recommendation)
        const llm = await llmGate({ symbol: c.symbol, side: c.side, score: c.score, priceChangePct: c.priceChangePct }, c.indicators, CFG);
        if (!llm.approved) {
          console.log(`    ${c.symbol} LLM ADVISORY SKIP (conf: ${llm.confidence}): ${llm.rationale?.slice(0, 80)}`);
        } else {
          console.log(`    ${c.symbol} LLM OK (conf: ${llm.confidence}): ${llm.rationale?.slice(0, 60)}`);
        }

        // Calculate SL/TP
        const entryPrice = c.ticker?.price || c.indicators.price;
        if (!entryPrice || entryPrice <= 0) continue;

        const atr = c.indicators.ATR || entryPrice * 0.02;
        const sltp = calculateSLTP(entryPrice, c.side.toUpperCase(), atr);

        // Calculate position size (dynamic: balance / max_positions)
        const balance = getBalance();
        const posSize = calculatePositionSize(c.score, balance, CFG);
        const leverage = CFG.POSITIONS.LEVERAGE || 10;
        const notional = posSize.sizeUsd * leverage; // margin x leverage
        const quantity = notional / entryPrice;

        if (quantity <= 0 || posSize.sizeUsd < 1) continue;

        // Open position
        openPosition({
          asset: c.symbol,
          direction: c.side.toUpperCase(),
          price: entryPrice,
          quantity,
          sl: sltp.sl,
          tp1: sltp.tp1,
          atr,
        });

        tradesExecuted++;
        console.log(`  OPENED: ${c.symbol} ${c.side.toUpperCase()} @ $${entryPrice} | Margin: $${posSize.sizeUsd.toFixed(2)} | Notional: $${notional.toFixed(2)} | Score: ${c.score.toFixed(1)} | SL: $${sltp.sl}`);

        // Telegram notification
        await sendNotification('ENTRY', {
          asset: c.symbol,
          direction: c.side.toUpperCase(),
          price: entryPrice,
          quantity: quantity.toFixed(6),
          notional: notional.toFixed(2),
          margin: posSize.sizeUsd.toFixed(2),
          sl: sltp.sl,
          tp1: sltp.tp1,
          score: c.score,
          llmConfidence: llm.confidence,
          btcRegime,
        });

      } catch (e) {
        console.log(`    ${c.symbol} ERROR: ${e.message?.slice(0, 80)}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Scan #${scanCount} done in ${elapsed}s | Trades: ${tradesExecuted}/${maxTrades}`);

  } catch (e) {
    console.error(`Scan error: ${e.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== BITGET TRADING AGENT ===');
  console.log(`Mode: ${process.env.TRADING_MODE || 'paper'}`);
  console.log(`Balance: $${getBalance()}`);
  console.log(`Max positions: ${CFG.POSITIONS.MAX_OPEN}`);
  console.log(`Leverage: ${CFG.POSITIONS.LEVERAGE}x`);
  console.log(`LLM: ${CFG.LLM.MODEL} @ ${CFG.LLM.ENDPOINT}`);
  console.log(`Min score: ${CFG.SCORING?.MIN_SCORE_NORMAL ?? 55}`);
  console.log('');

  // Start Telegram bot
  startBot();
  setTelegramBot({ sendNotification });

  // Start position monitoring
  startMonitoring();

  // Run initial scan
  await runScan();

  // Schedule recurring scans every 5 minutes
  setInterval(runScan, 5 * 60 * 1000);

  console.log('');
  console.log('Agent ready. Scanning every 5 minutes.');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
