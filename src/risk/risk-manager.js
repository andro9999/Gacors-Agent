/**
 * Risk Manager — Position sizing, circuit breakers, and risk limits
 *
 * - Circuit breaker: 3 closed losses in 3h → pause 6h
 * - Daily loss limit: 4% of balance (floor $15, ceiling $60)
 * - Cluster guard: CRYPTO_RISK_ON=2, MEME=1, EQUITY=2
 * - Position sizing: Kelly-inspired based on score
 * - Max same direction: 2
 * - Auto-blacklist: 3 consecutive losses
 */

// ─── Circuit Breaker ───────────────────────────────────────────────────────────

/**
 * Check if circuit breaker is tripped.
 * @param {Array} closedTrades - [{symbol, pnl, closedAt}]
 * @param {Object} config
 * @returns {{ tripped: boolean, reason: string|null, pauseUntil: number|null }}
 */
function checkCircuitBreaker(closedTrades, config) {
  const windowMs = config?.CIRCUIT_BREAKER_WINDOW_MS ?? 3 * 60 * 60 * 1000; // 3h
  const maxLosses = config?.CIRCUIT_BREAKER_MAX_LOSSES ?? 3;
  const pauseMs = config?.CIRCUIT_BREAKER_PAUSE_MS ?? 6 * 60 * 60 * 1000; // 6h

  const now = Date.now();
  const recentLosses = closedTrades.filter(t =>
    t.pnl < 0 && (now - t.closedAt) < windowMs
  );

  if (recentLosses.length >= maxLosses) {
    return {
      tripped: true,
      reason: `${recentLosses.length} losses in last ${(windowMs / 3600000).toFixed(1)}h`,
      pauseUntil: now + pauseMs,
    };
  }

  return { tripped: false, reason: null, pauseUntil: null };
}

// ─── Daily Loss Limit ──────────────────────────────────────────────────────────

/**
 * Check daily PnL against loss limit.
 * @param {Array} closedTrades - today's closed trades
 * @param {number} balance
 * @param {Object} config
 * @returns {{ exceeded: boolean, dailyPnl: number, limit: number, reason: string|null }}
 */
function checkDailyLoss(closedTrades, balance, config) {
  const lossPct = 0.04; // 4% of balance (hardcoded, ignore config bug)
  const floor = config?.DAILY_LOSS_FLOOR ?? 15;
  const ceiling = 200; // $200 max daily loss

  const limit = Math.min(ceiling, Math.max(floor, balance * lossPct));

  // Sum today's PnL from closed trades
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const dailyPnl = closedTrades
    .filter(t => t.closedAt >= todayMs)
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  if (dailyPnl <= -limit) {
    return {
      exceeded: true,
      dailyPnl: Math.round(dailyPnl * 100) / 100,
      limit: Math.round(limit * 100) / 100,
      reason: `daily loss $${Math.abs(dailyPnl).toFixed(2)} exceeds limit $${limit.toFixed(2)}`,
    };
  }

  return {
    exceeded: false,
    dailyPnl: Math.round(dailyPnl * 100) / 100,
    limit: Math.round(limit * 100) / 100,
    reason: null,
  };
}

// ─── Cluster Guard ─────────────────────────────────────────────────────────────

/**
 * Check cluster exposure limits.
 * @param {Object} candidate
 * @param {Array} positions
 * @param {Object} config
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function checkCluster(candidate, positions, config) {
  const cluster = candidate.cluster;
  if (!cluster) return { allowed: true, reason: null };

  const limits = config?.CLUSTER_MAX ?? { CRYPTO_RISK_ON: 2, MEME: 1, EQUITY: 2 };
  const max = limits[cluster] ?? 2;

  const count = positions.filter(p => p.cluster === cluster).length;
  if (count >= max) {
    return {
      allowed: false,
      reason: `cluster ${cluster} at max: ${count}/${max}`,
    };
  }

  return { allowed: true, reason: null };
}

// ─── Direction Limit ───────────────────────────────────────────────────────────

/**
 * Check max same-direction positions.
 * @param {string} side
 * @param {Array} positions
 * @param {Object} config
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function checkDirection(side, positions, config) {
  const maxSame = config?.POSITIONS?.MAX_SAME_DIRECTION ?? config?.MAX_SAME_DIRECTION ?? 7;
  const count = positions.filter(p => p.direction === side || p.side === side).length;

  if (count >= maxSame) {
    return {
      allowed: false,
      reason: `max same direction (${side}): ${count}/${maxSame}`,
    };
  }

  return { allowed: true, reason: null };
}

// ─── Auto-Blacklist ────────────────────────────────────────────────────────────

/**
 * Check if symbol should be auto-blacklisted (3 consecutive losses).
 * @param {string} symbol
 * @param {Array} closedTrades
 * @param {Object} config
 * @returns {{ blacklisted: boolean, reason: string|null }}
 */
function checkAutoBlacklist(symbol, closedTrades, config) {
  const maxConsecutive = config?.AUTO_BLACKLIST_CONSECUTIVE ?? 3;
  const cooldownMs = config?.AUTO_BLACKLIST_COOLDOWN_MS ?? 24 * 60 * 60 * 1000; // 24h

  // Get last N trades for this symbol, sorted by close time desc
  const symbolTrades = closedTrades
    .filter(t => t.symbol === symbol)
    .sort((a, b) => b.closedAt - a.closedAt)
    .slice(0, maxConsecutive);

  if (symbolTrades.length >= maxConsecutive && symbolTrades.every(t => t.pnl < 0)) {
    return {
      blacklisted: true,
      reason: `${maxConsecutive} consecutive losses on ${symbol}`,
      cooldownUntil: Date.now() + cooldownMs,
    };
  }

  return { blacklisted: false, reason: null, cooldownUntil: null };
}

// ─── Position Sizing ───────────────────────────────────────────────────────────

/**
 * Kelly-inspired position sizing based on score.
 * @param {number} score
 * @param {number} balance
 * @param {Object} config
 * @returns {{ sizePct: number, sizeUsd: number, tier: string }}
 */
export function calculatePositionSize(score, balance, config) {
  // Volatility-based 1% risk sizing
  // risk_per_trade = 1% of balance
  // sizeUsd = risk_per_trade / (stop_distance_pct * leverage)
  // This ensures every trade risks ~1% regardless of coin volatility
  const riskPct = 0.01; // 1% of balance
  const riskAmount = balance * riskPct;
  const leverage = config?.POSITIONS?.LEVERAGE ?? 10;
  // Default stop distance: 2% (will be overridden by ATR in execution)
  const defaultStopPct = 0.02;
  const sizeUsd = riskAmount / (defaultStopPct * leverage);

  return {
    sizePct: Math.round((sizeUsd / balance) * 10000) / 100,
    sizeUsd: Math.round(sizeUsd * 100) / 100,
    tier: 'A',
  };
}

// ─── Main Risk Check ───────────────────────────────────────────────────────────

/**
 * Full risk check for a candidate trade.
 * @param {Object} candidate - { symbol, side, cluster, score, ... }
 * @param {Array} positions - open positions
 * @param {Object} config - { closedTrades, balance, DAILY_LOSS_PCT, CLUSTER_MAX, ... }
 * @returns {{ allowed: boolean, blockers: string[], positionSize: Object|null, blacklistUpdate: Object|null }}
 */
export function checkRisk(candidate, positions, config) {
  const blockers = [];
  const closedTrades = config?.closedTrades ?? [];
  const balance = config?.balance ?? 1000;

  // 1. Circuit breaker — always active
  const circuit = checkCircuitBreaker(closedTrades, config);
  if (circuit.tripped) {
    blockers.push(`CIRCUIT BREAKER: ${circuit.reason}`);
  }

  // 2. Daily loss limit
  const dailyLoss = checkDailyLoss(closedTrades, balance, config);
  if (dailyLoss.exceeded) {
    blockers.push(`DAILY LOSS: ${dailyLoss.reason}`);
  }

  // 3. Cluster guard
  const cluster = checkCluster(candidate, positions, config);
  if (!cluster.allowed) {
    blockers.push(cluster.reason);
  }

  // 4. Direction limit
  const direction = checkDirection(candidate.side, positions, config);
  if (!direction.allowed) {
    blockers.push(direction.reason);
  }

  // 5. Auto-blacklist check
  const blacklist = checkAutoBlacklist(candidate.symbol, closedTrades, config);

  // 6. Max open positions
  const maxPositions = config?.MAX_OPEN_POSITIONS ?? 10;
  if (positions.length >= maxPositions) {
    blockers.push(`max positions: ${positions.length}/${maxPositions}`);
  }

  const allowed = blockers.length === 0;

  // Calculate position size only if allowed
  let positionSize = null;
  if (allowed && candidate.score != null) {
    positionSize = calculatePositionSize(candidate.score, balance, config);
  }

  return {
    allowed,
    blockers,
    positionSize,
    blacklistUpdate: blacklist.blacklisted ? {
      symbol: candidate.symbol,
      reason: blacklist.reason,
      cooldownUntil: blacklist.cooldownUntil,
    } : null,
    dailyLossStatus: {
      pnl: dailyLoss.dailyPnl,
      limit: dailyLoss.limit,
      remaining: dailyLoss.limit + dailyLoss.dailyPnl,
    },
    circuitBreaker: circuit,
  };
}
