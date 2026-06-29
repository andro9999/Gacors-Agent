/**
 * Scoring Engine — 0-100 scale signal scoring
 *
 * Components:
 *  1. Trend score (0-25): EMA spread strength, ADX strength, DI gap, 4H trend
 *  2. Momentum score (0-25): RSI zone, MACD direction, StochRSI
 *  3. Volume score (0-20): volume ratio, taker bias
 *  4. Structure score (0-15): Bollinger position, Fisher, candle
 *  5. Bonus (0-15): multi-TF confluence, breakout, squeeze, volume momentum
 *  6. Penalty: from soft filters
 *
 * Min score to trade: 55/100
 */

// ─── Trend Score (0-25) ─────────────────────────────────────────────────────
//
// Measures trend STRENGTH (continuous), not just presence:
//   - EMA spread (|EMA9-EMA21| as % of price): 0-8 points
//   - ADX strength (adx/50 * 10, capped):      0-10 points
//   - DI gap (|DI+ - DI-|, direction-aware):   0-4 points
//   - 4H trend bonus:                          0-3 points

function computeTrendScore(indicators, side) {
  let score = 0;

  const ema9 = indicators.EMA9 ?? 0;
  const ema21 = indicators.EMA21 ?? 0;
  const price = indicators.price ?? ema21 ?? 0;

  // EMA spread strength (0-8) — only when EMAs are aligned with the side.
  // Spread of ~2% of price maps to full 8 points.
  const emaAligned =
    (side === 'long' && ema9 > ema21) ||
    (side === 'short' && ema9 < ema21);
  if (emaAligned && price > 0) {
    const spreadPct = (Math.abs(ema9 - ema21) / price) * 100;
    score += Math.min(8, spreadPct * 4); // 2% spread => 8 pts
  }

  // ADX strength (0-10) — continuous: adx/50 * 10, capped at 10.
  const adx = indicators.ADX ?? 0;
  score += Math.min(10, (adx / 50) * 10);

  // DI gap (0-4) — continuous on |DI+ - DI-|, only when DI favors the side.
  // Gap of ~20 maps to full 4 points.
  const diPlus = indicators.DI_plus ?? 0;
  const diMinus = indicators.DI_minus ?? 0;
  const diAligned =
    (side === 'long' && diPlus > diMinus) ||
    (side === 'short' && diMinus > diPlus);
  if (diAligned) {
    const diGap = Math.abs(diPlus - diMinus);
    score += Math.min(4, diGap * 0.2); // gap 20 => 4 pts
  }

  // 4H trend bonus (0-3) — keep as-is.
  const trend4h = indicators.trend_4h ?? 'neutral';
  if ((side === 'long' && trend4h === 'bullish') || (side === 'short' && trend4h === 'bearish')) {
    score += 3;
  }

  return Math.min(25, score);
}

// ─── Momentum Score (0-25) ──────────────────────────────────────────────────

function computeMomentumScore(indicators, side) {
  let score = 0;
  const rsi = indicators.RSI ?? 50;
  const macdHist = indicators.MACD_hist ?? 0;
  const stochRSI = indicators.stochRSI_K ?? 50;
  const fisher = indicators.fisher ?? 0;

  // RSI zone (0-10)
  if (side === 'long') {
    if (rsi >= 45 && rsi <= 65) score += 10;      // sweet spot
    else if (rsi >= 35 && rsi <= 70) score += 7;   // good
    else if (rsi >= 30 && rsi <= 75) score += 4;   // acceptable
  } else {
    if (rsi >= 35 && rsi <= 55) score += 10;
    else if (rsi >= 30 && rsi <= 65) score += 7;
    else if (rsi >= 25 && rsi <= 70) score += 4;
  }

  // MACD histogram (0-8)
  const absHist = Math.abs(macdHist);
  if ((side === 'long' && macdHist > 0) || (side === 'short' && macdHist < 0)) {
    if (absHist > 5) score += 8;
    else if (absHist > 2) score += 6;
    else if (absHist > 0.5) score += 4;
    else score += 2;
  }

  // StochRSI momentum (0-4)
  if (side === 'long' && stochRSI >= 20 && stochRSI <= 70) score += 4;
  if (side === 'short' && stochRSI >= 30 && stochRSI <= 80) score += 4;

  // Fisher direction (0-3)
  if ((side === 'long' && fisher > 0) || (side === 'short' && fisher < 0)) {
    score += 3;
  }

  return Math.min(25, score);
}

// ─── Volume Score (0-20) ────────────────────────────────────────────────────
// Kept as-is — the filter change to 1.5x min volume fixes the distribution.

function computeVolumeScore(indicators, _side) {
  let score = 0;
  const volRatio = indicators.volumeRatio ?? 0;

  // Volume ratio (0-12)
  if (volRatio >= 3.0) score += 12;
  else if (volRatio >= 2.0) score += 9;
  else if (volRatio >= 1.5) score += 6;
  else if (volRatio >= 1.0) score += 4;
  else if (volRatio >= 0.5) score += 2;

  // Taker buy ratio (0-8)
  const taker = indicators.takerBuyRatio ?? 0.5;
  if (taker > 0.6) score += 8;
  else if (taker > 0.55) score += 5;
  else if (taker > 0.5) score += 2;

  return Math.min(20, score);
}

// ─── Volume Momentum Helper (0-4) ────────────────────────────────────────────
//
// True volume momentum: is current volume rising vs the previous 3 bars?
// Uses the per-bar volumeRatio series (volume normalized by its 20-bar average,
// so comparing recent ratios is a valid proxy for comparing raw volume).
// Falls back to the scalar volumeRatio vs a 1.0 baseline when no series exists.
// Returns 0-4 continuous points scaled by how much current exceeds the average.

function computeVolumeMomentum(indicators) {
  const series = indicators.arrays?.volumeRatio;

  if (Array.isArray(series) && series.length >= 4) {
    const current = series[series.length - 1];
    const prev3 = series.slice(-4, -1);
    const avg = prev3.reduce((a, b) => a + b, 0) / prev3.length;
    if (avg > 0 && current > avg) {
      const ratio = current / avg; // >1 means accelerating volume
      return Math.min(4, (ratio - 1) * 8); // +50% over avg => full 4 pts
    }
    return 0;
  }

  // Fallback: no per-bar series available, use scalar volumeRatio.
  const vr = indicators.volumeRatio ?? 0;
  if (vr > 1.0) {
    return Math.min(4, (vr - 1.0) * 4); // 2.0x => full 4 pts
  }
  return 0;
}

// ─── Structure Score (0-15) ─────────────────────────────────────────────────

function computeStructureScore(indicators, side) {
  let score = 0;

  // Bollinger position (0-5)
  const bbPB = indicators.bollingerPercentB ?? 0.5;
  if (side === 'long' && bbPB >= 0.3 && bbPB <= 0.7) score += 5;
  if (side === 'short' && bbPB >= 0.3 && bbPB <= 0.7) score += 5;

  // VWAP position (0-5)
  const vwapDist = indicators.VWAP_distance ?? 0;
  if (side === 'long' && vwapDist > -1 && vwapDist < 1) score += 5;
  if (side === 'short' && vwapDist > -1 && vwapDist < 1) score += 5;

  // Choppiness (0-5)
  const chop = indicators.choppiness ?? 50;
  if (chop < 50) score += 5;
  else if (chop < 61.8) score += 3;

  return Math.min(15, score);
}

// ─── Bonus Score (0-15) ─────────────────────────────────────────────────────
//
// Components: multi-TF confluence (0-5), Bollinger squeeze (0-5),
// favorable funding (0-5), and volume momentum (0-4). Capped at 15.

function computeBonusScore(indicators, side) {
  let score = 0;

  // Multi-TF confluence (0-5)
  const trend4h = indicators.trend_4h ?? 'neutral';
  const ema9 = indicators.EMA9 ?? 0;
  const ema21 = indicators.EMA21 ?? 0;
  const macdHist = indicators.MACD_hist ?? 0;
  
  let confluence = 0;
  if ((side === 'long' && ema9 > ema21) || (side === 'short' && ema9 < ema21)) confluence++;
  if ((side === 'long' && macdHist > 0) || (side === 'short' && macdHist < 0)) confluence++;
  if ((side === 'long' && trend4h === 'bullish') || (side === 'short' && trend4h === 'bearish')) confluence++;
  if (confluence >= 3) score += 5;
  else if (confluence >= 2) score += 3;

  // Bollinger squeeze (0-5)
  if (indicators.bbSqueeze) score += 5;

  // Funding rate favorable (0-5)
  const funding = indicators.fundingRate ?? 0;
  if ((side === 'long' && funding < 0) || (side === 'short' && funding > 0)) {
    score += 5; // getting paid to hold
  }

  // Volume momentum (0-4) — current volume rising vs previous 3 bars
  score += computeVolumeMomentum(indicators);

  return Math.min(15, score);
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Calculate composite score (0-100) for a candidate signal.
 * @param {Object} candidate - { symbol, side, priceChangePct }
 * @param {Object} indicators - full indicator set
 * @param {Object} config - { MIN_SCORE_NORMAL, ... }
 * @returns {{ score: number, passed: boolean, minRequired: number, breakdown: Object }}
 */
export function calculateScore(candidate, indicators, config) {
  const side = candidate.side;

  const trendScore = computeTrendScore(indicators, side);
  const momentumScore = computeMomentumScore(indicators, side);
  const volumeScore = computeVolumeScore(indicators, side);
  const structureScore = computeStructureScore(indicators, side);
  const bonusScore = computeBonusScore(indicators, side);

  let rawScore = trendScore + momentumScore + volumeScore + structureScore + bonusScore;

  // Apply penalty from filter chain (if passed)
  const penalty = candidate.filterPenalty ?? 0;
  rawScore = Math.max(0, rawScore - penalty);

  const finalScore = Math.round(rawScore * 10) / 10;

  // Minimum score threshold
  const minRequired = config?.SCORING?.MIN_SCORE_NORMAL ?? 55;
  const passed = finalScore >= minRequired;

  return {
    score: finalScore,
    passed,
    minRequired,
    breakdown: {
      trend: trendScore,
      momentum: momentumScore,
      volume: volumeScore,
      structure: structureScore,
      bonus: bonusScore,
      penalty,
      maxPossible: 100,
    }
  };
}
