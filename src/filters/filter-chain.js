/**
 * Filter Chain — Strict signal filter for Bitget trading agent
 * 
 * CRITICAL filters (must pass — reject immediately if fail):
 *   1. volume_ratio — volume > 1.2x average
 *   2. EMA_trend — EMA9/EMA21 aligned with direction
 *   3. MACD_alignment — MACD histogram aligned with direction
 *   4. RSI_guard — not overbought/oversold
 *   5. ADX_minimum — trend strength > 18
 *   6. 4H_alignment — 4H trend aligned
 *
 * SOFT filters (penalty to score, not hard reject):
 *   7. choppiness — market too choppy
 *   8. VWAP_distance — too extended from VWAP
 *   9. funding_check — expensive funding rate
 *  10. near_high_low — too close to 24h extreme
 */

// ─── Pre-scan Exclusions (hard blocks) ───────────────────────────────────────

const prescanExclusions = [
  {
    name: 'existing_position',
    check: (candidate, _indicators, config) => {
      const positions = config?.OPEN_POSITIONS ?? [];
      const has = positions.some(p => p.asset === candidate.symbol);
      return { pass: !has, reason: has ? 'already have open position' : null };
    }
  },
  {
    name: 'cluster_exposure',
    check: (candidate, _indicators, config) => {
      const cluster = candidate.cluster;
      if (!cluster || cluster === 'unknown') return { pass: true, reason: null };
      const positions = config?.OPEN_POSITIONS ?? [];
      const clusterConfig = config?.CLUSTERS?.[cluster];
      if (!clusterConfig) return { pass: true, reason: null };
      const count = positions.filter(p => {
        return clusterConfig.SYMBOLS?.includes(p.asset);
      }).length;
      if (count >= clusterConfig.MAX_POSITIONS) {
        return { pass: false, reason: `cluster ${cluster} at max (${count}/${clusterConfig.MAX_POSITIONS})` };
      }
      return { pass: true, reason: null };
    }
  }
];

// ─── CRITICAL Filters (must all pass) ────────────────────────────────────────

const criticalFilters = [
  {
    name: 'volume_ratio',
    check: (_candidate, indicators, _config) => {
      const ratio = indicators.volumeRatio ?? 0;
      const minRatio = 0.5; // At least 50% of average volume
      if (ratio < minRatio) {
        return { pass: false, reason: `volume ${ratio.toFixed(2)}x < ${minRatio}x, too low` };
      }
      return { pass: true, reason: null };
    }
  },
  {
    name: 'EMA_trend',
    check: (candidate, indicators, _config) => {
      const ema9 = indicators.EMA9 ?? 0;
      const ema21 = indicators.EMA21 ?? 0;
      const diff = Math.abs(ema9 - ema21) / ema21 * 100;
      if (diff < 0.1) {
        return { pass: false, reason: `EMA9/EMA21 too close (${diff.toFixed(2)}%), no trend` };
      }
      if (candidate.side === 'long' && ema9 < ema21) {
        return { pass: false, reason: `EMA9 < EMA21, downtrend` };
      }
      if (candidate.side === 'short' && ema9 > ema21) {
        return { pass: false, reason: `EMA9 > EMA21, uptrend` };
      }
      return { pass: true, reason: null };
    }
  },
  {
    name: 'MACD_alignment',
    check: (candidate, indicators, _config) => {
      const macdHist = indicators.MACD_hist ?? 0;
      if (candidate.side === 'long' && macdHist < 0) {
        return { pass: false, reason: `MACD hist negative, not aligned for long` };
      }
      if (candidate.side === 'short' && macdHist > 0) {
        return { pass: false, reason: `MACD hist positive, not aligned for short` };
      }
      return { pass: true, reason: null };
    }
  },
  {
    name: 'RSI_guard',
    check: (candidate, indicators, _config) => {
      const rsi = indicators.RSI ?? 50;
      if (candidate.side === 'long' && rsi > 70) {
        return { pass: false, reason: `RSI ${rsi.toFixed(1)} > 70, overbought` };
      }
      if (candidate.side === 'short' && rsi < 30) {
        return { pass: false, reason: `RSI ${rsi.toFixed(1)} < 30, oversold` };
      }
      return { pass: true, reason: null };
    }
  },
  {
    name: 'ADX_minimum',
    check: (_candidate, indicators, _config) => {
      const adx = indicators.ADX ?? 0;
      const minADX = 18;
      if (adx < minADX) {
        return { pass: false, reason: `ADX ${adx.toFixed(1)} < ${minADX}, weak trend` };
      }
      return { pass: true, reason: null };
    }
  },
  {
    name: '4H_alignment',
    check: (candidate, indicators, _config) => {
      const trend4h = indicators.trend_4h ?? 'neutral';
      if (candidate.side === 'long' && trend4h === 'bearish') {
        return { pass: false, reason: `4H bearish, not aligned for long` };
      }
      if (candidate.side === 'short' && trend4h === 'bullish') {
        return { pass: false, reason: `4H bullish, not aligned for short` };
      }
      return { pass: true, reason: null };
    }
  }
];

// ─── SOFT Filters (return penalty score, not pass/fail) ──────────────────────

const softFilters = [
  {
    name: 'choppiness',
    penalty: 5,
    check: (_candidate, indicators, _config) => {
      const chop = indicators.choppiness ?? 50;
      return chop > 61.8;
    }
  },
  {
    name: 'VWAP_distance',
    penalty: 3,
    check: (candidate, indicators, _config) => {
      const dist = Math.abs(indicators.VWAP_distance ?? 0);
      return dist > 2.0;
    }
  },
  {
    name: 'funding_check',
    penalty: 3,
    check: (candidate, indicators, _config) => {
      const funding = Math.abs(indicators.fundingRate ?? 0);
      return funding > 0.01;
    }
  },
  {
    name: 'near_high_low',
    penalty: 4,
    check: (candidate, indicators, _config) => {
      const distToHigh = indicators.distToHigh ?? 50;
      const distToLow = indicators.distToLow ?? 50;
      if (candidate.side === 'long' && distToHigh < 0.5) return true;
      if (candidate.side === 'short' && distToLow < 0.5) return true;
      return false;
    }
  }
];

// ─── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Run the filter chain on a candidate signal.
 * @param {Object} candidate - { symbol, side, priceChangePct, cluster }
 * @param {Object} indicators - full indicator set
 * @param {Object} config - config object
 * @returns {{ pass: boolean, failures: Array, penalty: number, passedCritical: number, totalCritical: number }}
 */
export function runFilterChain(candidate, indicators, config) {
  const failures = [];
  let penalty = 0;

  // Pre-scan exclusions — hard blocks
  for (const rule of prescanExclusions) {
    const result = rule.check(candidate, indicators, config);
    if (!result.pass) {
      failures.push({ layer: `pre:${rule.name}`, reason: result.reason, critical: true });
      return { pass: false, failures, penalty: 100, passedCritical: 0, totalCritical: criticalFilters.length, prescanBlocked: true };
    }
  }

  // Critical filters — ALL must pass
  let passedCritical = 0;
  for (const filter of criticalFilters) {
    const result = filter.check(candidate, indicators, config);
    if (result.pass) {
      passedCritical++;
    } else {
      failures.push({ layer: filter.name, reason: result.reason, critical: true });
    }
  }

  // If any critical filter fails, reject immediately
  if (passedCritical < criticalFilters.length) {
    return { pass: false, failures, penalty: 100, passedCritical, totalCritical: criticalFilters.length, prescanBlocked: false };
  }

  // Soft filters — accumulate penalty
  for (const filter of softFilters) {
    if (filter.check(candidate, indicators, config)) {
      penalty += filter.penalty;
      failures.push({ layer: filter.name, reason: `soft penalty -${filter.penalty}`, critical: false });
    }
  }

  return { pass: true, failures, penalty, passedCritical, totalCritical: criticalFilters.length, prescanBlocked: false };
}
