/**
 * Position Manager
 * Monitors open positions, manages SL/TP, trailing stops, hard stops, pyramiding.
 */

import {
  getPositions,
  closePosition,
  openPosition,
  _updateCurrentPrice,
  _updateSL,
  _updateStage,
  _updateQuantity,
  _getPosition,
  _getDB,
  getBalance,
} from './paper-trader.js';
import { fetchTicker } from '../api/bitget.js';

// ── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  MONITOR_INTERVAL:       15_000,   // 15s normal
  MONITOR_INTERVAL_FAST:   5_000,   // 5s when profit > 3%
  BREAKEVEN_PCT:           1.5,     // move SL to entry at +1.5%
  TRAILING_PCT:            3.0,     // trailing SL distance %
  TRAILING_ATR_MULT:       2.0,     // trail at 2x ATR distance (runner model)
  TRAILING_LOCK_PCT:       2.0,     // lock profit at 2%
  HARD_STOP_PCT:           6.0,     // hard stop at -4% unrealized (Opus recommendation)
  PYRAMID_TRIGGER_PCT:   -999,     // DISABLED — pyramid too risky without actual score tracking
  PYRAMID_SCORE_MIN:       999,    // DISABLED
  PYRAMID_SIZE_PCT:        50,      // add 50% of original size
  TP1_PCT:                 50,      // TP1 takes 50% of position, rest runs/trails
};

// ── State ───────────────────────────────────────────────────────────────────

let monitorTimer = null;
let botRef = null; // telegram bot reference for notifications

/**
 * Attach telegram bot for notifications.
 */
export function setTelegramBot(bot) {
  botRef = bot;
}

/**
 * ATR-adaptive SL/TP calculation.
 * @param {number} entry  Entry price
 * @param {string} side   'LONG' or 'SHORT'
 * @param {number} atr    ATR value (optional, defaults to 2% of entry)
 * @returns {{ sl, tp1, tp2, tp3 }}
 */
export function calculateSLTP(entry, side, atr = null) {
  if (!atr) atr = entry * 0.02; // default ATR = 2% of price

  const slDist  = Math.max(atr * 2,   entry * 0.02);  // SL: 2x ATR or 2%
  const tp1Dist = Math.max(atr * 1.0, entry * 0.01);  // TP1: 1.0x ATR or 1%

  if (side === 'LONG') {
    return {
      sl:  +(entry - slDist).toFixed(8),
      tp1: +(entry + tp1Dist).toFixed(8),
    };
  } else {
    return {
      sl:  +(entry + slDist).toFixed(8),
      tp1: +(entry - tp1Dist).toFixed(8),
    };
  }
}

/**
 * Check if a position should be exited.
 * @param {Object} position  Position row from DB
 * @param {number} price     Current market price
 * @returns {{ action: string, reason: string } | null}
 */
export function checkExit(position, price) {
  const { direction, entry_price, sl, tp1, stage } = position;
  const isLong = direction === 'LONG';

  // Calculate unrealized P&L %
  const pnlPct = isLong
    ? ((price - entry_price) / entry_price) * 100
    : ((entry_price - price) / entry_price) * 100;

  // ── Hard Stop: -6% ──
  if (pnlPct <= -CONFIG.HARD_STOP_PCT) {
    return { action: 'HARD_STOP', reason: `Unrealized ${pnlPct.toFixed(2)}% hit hard stop at -${CONFIG.HARD_STOP_PCT}%` };
  }

  // ── Stop Loss ──
  if (sl !== null) {
    if ((isLong && price <= sl) || (!isLong && price >= sl)) {
      return { action: 'SL', reason: `Price ${price} hit SL ${sl}` };
    }
  }

  // ── TP1: take 50% off, move SL to breakeven, let the rest run/trail ──
  if (stage < 1 && tp1 !== null) {
    if ((isLong && price >= tp1) || (!isLong && price <= tp1)) {
      return { action: 'TP1', reason: `Price ${price} hit TP1 ${tp1}` };
    }
  }

  return null;
}

// ── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Process a single position — update trailing SL, breakeven, pyramiding, exits.
 */
function processPosition(position, price) {
  const { id, direction, entry_price, sl, quantity, atr, stage } = position;
  const isLong = direction === 'LONG';

  // Update current price in DB
  _updateCurrentPrice(id, price);

  const pnlPct = isLong
    ? ((price - entry_price) / entry_price) * 100
    : ((entry_price - price) / entry_price) * 100;

  // ── Breakeven: move SL to entry at +1.5% ──
  if (pnlPct >= CONFIG.BREAKEVEN_PCT) {
    const currentSL = _getPosition(id).sl;
    if (currentSL === null || (isLong && currentSL < entry_price) || (!isLong && currentSL > entry_price)) {
      _updateSL(id, entry_price);
      notify('BREAKEVEN', { ...position, current_price: price, pnlPct });
    }
  }

  // ── Trailing SL ──
  if (pnlPct >= CONFIG.TRAILING_LOCK_PCT) {
    const atrVal = atr || entry_price * 0.02;
    const trailDist = Math.max(
      price * (CONFIG.TRAILING_PCT / 100),
      atrVal * CONFIG.TRAILING_ATR_MULT
    );

    const currentPos = _getPosition(id);
    const currentSL = currentPos ? currentPos.sl : null;

    let newSL;
    if (isLong) {
      newSL = +(price - trailDist).toFixed(8);
      if (currentSL === null || newSL > currentSL) {
        _updateSL(id, newSL);
      }
    } else {
      newSL = +(price + trailDist).toFixed(8);
      if (currentSL === null || newSL < currentSL) {
        _updateSL(id, newSL);
      }
    }
  }

  // ── Pyramid: add 50% at -1.5% if score >= 12 ──
  if (pnlPct <= CONFIG.PYRAMID_TRIGGER_PCT) {
    const currentPos = _getPosition(id);
    if (currentPos && currentPos.pyramid === 0) {
      const score = Math.abs(pnlPct) * 8; // rough proxy
      if (score >= CONFIG.PYRAMID_SCORE_MIN) {
        const addQty = quantity * (CONFIG.PYRAMID_SIZE_PCT / 100);
        try {
          openPosition({
            asset: position.asset,
            direction: position.direction,
            price,
            quantity: addQty,
            sl: position.sl,
            tp1: position.tp1,
            atr: position.atr,
          });
          _updateQuantity(id, quantity + addQty, 1);
          notify('PYRAMID', { ...position, current_price: price, addedQty: addQty, pnlPct });
        } catch (e) {
          // insufficient balance or max positions — skip silently
        }
      }
    }
  }

  // ── Check TP/SL/Hard Stop exits ──
  const freshPos = _getPosition(id);
  if (!freshPos) return; // position already closed
  const exit = checkExit(freshPos, price);
  if (exit) {
    handleExit(id, exit.action, exit.reason, price);
  }
}

/**
 * Handle partial/full exits at TP stages.
 */
function handleExit(id, action, reason, price) {
  const pos = _getPosition(id);
  if (!pos) return;

  if (action === 'TP1') {
    const qtyToClose = pos.quantity * (CONFIG.TP1_PCT / 100);
    const newSL = pos.entry_price; // move remaining runner to breakeven
    _updateStage(id, 1, newSL);
    closePartial(id, qtyToClose, price, action, reason);
    notify('TP1', { ...pos, current_price: price, closedQty: qtyToClose, remainingQty: pos.quantity - qtyToClose });
    return;
  }

  // SL, HARD_STOP — close everything
  const result = closePosition(id, price);
  notify(action, { ...pos, current_price: price, pnl: result.pnl, reason });
}

/**
 * Close a partial quantity — adjust position quantity instead of full close.
 */
function closePartial(id, qty, price, action, reason) {
  const pos = _getPosition(id);
  if (!pos) return;

  const isLong = pos.direction === 'LONG';

  // Apply exit slippage
  const SLIPPAGE_BPS = 5;
  const FEE_RATE = 0.0006;
  const exitSlippage = price * (SLIPPAGE_BPS / 10000);
  const exitPrice = isLong ? price - exitSlippage : price + exitSlippage;

  const pnl = isLong
    ? (exitPrice - pos.entry_price) * qty
    : (pos.entry_price - exitPrice) * qty;

  const exitFee = exitPrice * qty * FEE_RATE;
  const marginReturn = (pos.entry_price * qty) / 10; // entry-based margin for closed portion

  const newQty = +(pos.quantity - qty).toFixed(8);
  if (newQty <= 0.0000001) {
    closePosition(id, price);
  } else {
    _updateQuantity(id, newQty, pos.pyramid);
    // Return margin + pnl - fee for partial close
    const db = _getDB();
    const balance = db.prepare('SELECT value FROM balance WHERE id = 1').get().value;
    db.prepare('UPDATE balance SET value = ? WHERE id = 1').run(balance + marginReturn + pnl - exitFee);
  }

  // Log partial close
  const db = _getDB();
  db.prepare(`
    INSERT INTO trade_log (timestamp, asset, direction, price, quantity, balance_change, pnl, type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), pos.asset, pos.direction, exitPrice, qty, marginReturn + pnl - exitFee, pnl, `CLOSE_${action}`);
}

// ── Notification Helper ─────────────────────────────────────────────────────

function notify(type, data) {
  if (botRef && botRef.sendNotification) {
    botRef.sendNotification(type, data).catch(() => {});
  }
}

// ── Main Monitor Loop ───────────────────────────────────────────────────────

let isRunning = false;

export async function monitorPositions() {
  if (isRunning) return;
  isRunning = true;

  try {
    const positions = getPositions();
    if (positions.length === 0) {
      isRunning = false;
      scheduleNext(CONFIG.MONITOR_INTERVAL);
      return;
    }

    let hasHighProfit = false;

    for (const pos of positions) {
      try {
        // Fetch LIVE price from Bitget (not stale DB price)
        const ticker = await fetchTicker(pos.asset);
        const livePrice = ticker?.price || ticker?.last;

        if (!livePrice || livePrice <= 0) {
          console.warn(`[PositionManager] No live price for ${pos.asset}, skipping`);
          continue;
        }

        // Update DB with live price
        _updateCurrentPrice(pos.id, livePrice);

        const pnlPct = pos.direction === 'LONG'
          ? ((livePrice - pos.entry_price) / pos.entry_price) * 100
          : ((pos.entry_price - livePrice) / pos.entry_price) * 100;

        if (pnlPct > 3) hasHighProfit = true;

        // Process position with live price
        processPosition({ ...pos, current_price: livePrice }, livePrice);
      } catch (e) {
        console.error(`[PositionManager] Error processing ${pos.asset}:`, e.message);
      }
    }

    const interval = hasHighProfit ? CONFIG.MONITOR_INTERVAL_FAST : CONFIG.MONITOR_INTERVAL;
    scheduleNext(interval);

  } catch (err) {
    console.error('[PositionManager] Monitor error:', err.message);
    scheduleNext(CONFIG.MONITOR_INTERVAL);
  } finally {
    isRunning = false;
  }
}

function scheduleNext(interval) {
  clearTimeout(monitorTimer);
  monitorTimer = setTimeout(() => monitorPositions(), interval);
}

/**
 * Start the position monitoring loop.
 */
export function startMonitoring() {
  monitorPositions().catch(e => console.error('[PositionManager] Initial monitor error:', e.message));
  console.log('[PositionManager] Monitoring started');
}

/**
 * Stop the position monitoring loop.
 */
export function stopMonitoring() {
  clearTimeout(monitorTimer);
  monitorTimer = null;
  console.log('[PositionManager] Monitoring stopped');
}

export { CONFIG };
