/**
 * Scoring Engine — 0-100 scale signal scoring
 *
 * Components:
 *  1. Trend score (0-25): EMA alignment, ADX strength, 4H trend
 *  2. Momentum score (0-25): RSI zone, MACD direction, StochRSI
 *  3. Volume score (0-20): volume ratio, taker bias
 *  4. Structure score (0-15): Bollinger position, Fisher, candle
 *  5. Bonus (0-15): multi-TF confluence, breakout, squeeze
 *  6. Penalty: from soft filters
 *
 * Min score to trade: 55/100
 */

// ─── Trend Score (0-25) ─────────────────────────────────────────────────────

function computeTrendScore(indicators, side) {
  let score = 0;

  // EMA alignment (0-10)
  const ema9 = indicators.EMA9 ?? 0;
  const ema21 = indicators.EMA21 ?? 0;
  const ema50 = indicators.EMA50 ?? 0;
  if (side === 'long') {
    if (ema9 > ema21) score += 5;
    if (ema21 > ema50) score += 3;
    if (ema9 > ema50) score += 2;
  } else {
    if (ema9 < ema21) score += 5;
    if (ema21 < ema50) score += 3;
    if (ema9 < ema50) score += 2;
  }

  // ADX strength (0-8)
  const adx = indicators.ADX ?? 0;
  if (adx >= 30) score += 8;
  else if (adx >= 25) score += 6;
  else if (adx >= 20) score += 4;
  else if (adx >= 18) score += 2;

  // DI alignment (0-4)
  const diPlus = indicators.DI_plus ?? 0;
  const diMinus = indicators.DI_minus ?? 0;
  if (side === 'long' && diPlus > diMinus) score += 4;
  if (side === 'short' && diMinus > diPlus) score += 4;

  // 4H trend bonus (0-3)
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
