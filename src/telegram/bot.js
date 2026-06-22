/**
 * Telegram Bot for Bitget Paper Trading Agent
 * Commands, notifications, and real-time position display.
 */

import TelegramBot from 'node-telegram-bot-api';
import {
  getPositions,
  getBalance,
  getTradeLog,
  closePosition,
} from '../execution/paper-trader.js';
import { CONFIG as PM_CONFIG } from '../execution/position-manager.js';

// ── Config ──────────────────────────────────────────────────────────────────

const TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID  || '';

let bot = null;
let isRunning = false;
let isPaused  = false;
let dailyStats = { date: new Date().toISOString().slice(0, 10), pnl: 0, trades: 0, wins: 0 };

// ── Bot Initialization ──────────────────────────────────────────────────────

export function startBot() {
  if (bot) return bot;

  bot = new TelegramBot(TOKEN, { polling: true });

  // Register commands
  bot.onText(/\/start/,    cmdStart);
  bot.onText(/\/status/,   cmdStatus);
  bot.onText(/\/positions/, cmdPositions);
  bot.onText(/\/pnl/,      cmdPnl);
  bot.onText(/\/risk/,     cmdRisk);
  bot.onText(/\/config/,   cmdConfig);
  bot.onText(/\/backtest/, cmdBacktest);
  bot.onText(/\/stop/,     cmdStop);
  bot.onText(/\/pause/,    cmdPause);
  bot.onText(/\/resume/,   cmdResume);

  bot.on('polling_error', (err) => {
    console.error('[TelegramBot] Polling error:', err.message);
  });

  console.log('[TelegramBot] Bot started');
  isRunning = true;

  // Send startup message
  sendMessage('Bot Paper Trading Bitget aktif.\n\nKetik /status untuk dashboard.\nKetik /positions untuk posisi terbuka.');

  return bot;
}

/**
 * Stop the bot.
 */
export function stopBot() {
  if (bot) {
    bot.stopPolling();
    bot = null;
    isRunning = false;
  }
}

// ── Command Handlers ────────────────────────────────────────────────────────

function cmdStart(msg) {
  const text = [
    '=== Bitget Paper Trading Bot ===',
    '',
    'Perintah yang tersedia:',
    '  /status    - Dashboard utama',
    '  /positions - Posisi terbuka',
    '  /pnl       - Ringkasan P&L',
    '  /risk      - Info risiko',
    '  /config    - Konfigurasi saat ini',
    '  /backtest  - Jalankan backtest',
    '  /stop      - Hentikan bot',
    '  /pause     - Jeda trading',
    '  /resume    - Lanjutkan trading',
    '',
    'Starting Balance: $1000',
    'Max Positions: 10',
  ].join('\n');
  sendMessage(text);
}

function cmdStatus(msg) {
  const balance = getBalance();
  const positions = getPositions();
  const logs = getTradeLog(1000);

  // Calculate stats
  const closedTrades = logs.filter(l => l.type === 'CLOSE' || l.type.startsWith('CLOSE_'));
  const wins = closedTrades.filter(l => l.pnl > 0).length;
  const winRate = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : '0.0';

  const totalPnl = closedTrades.reduce((sum, l) => sum + (l.pnl || 0), 0);
  const unrealizedPnl = positions.reduce((sum, p) => {
    const pnl = p.direction === 'LONG'
      ? (p.current_price - p.entry_price) * p.quantity
      : (p.entry_price - p.current_price) * p.quantity;
    return sum + pnl;
  }, 0);

  const exposure = positions.reduce((sum, p) => sum + p.current_price * p.quantity, 0);

  const text = [
    '=== DASHBOARD ===',
    '',
    `Balance:       $${balance.toFixed(2)}`,
    `Total P&L:     $${totalPnl.toFixed(2)}`,
    `Unrealized:    $${unrealizedPnl.toFixed(2)}`,
    `Exposure:      $${exposure.toFixed(2)}`,
    `Positions:     ${positions.length}/10`,
    `Trades Today:  ${dailyStats.trades}`,
    `Daily P&L:     $${dailyStats.pnl.toFixed(2)}`,
    `Win Rate:      ${winRate}%`,
    `Status:        ${isPaused ? 'PAUSED' : 'ACTIVE'}`,
  ].join('\n');
  sendMessage(text);
}

function cmdPositions(msg) {
  const positions = getPositions();

  if (positions.length === 0) {
    sendMessage('Tidak ada posisi terbuka.');
    return;
  }

  const lines = ['=== POSISI TERBUKA ===', ''];

  for (const p of positions) {
    const pnlPct = p.direction === 'LONG'
      ? ((p.current_price - p.entry_price) / p.entry_price * 100)
      : ((p.entry_price - p.current_price) / p.entry_price * 100);
    const pnlDollar = p.direction === 'LONG'
      ? (p.current_price - p.entry_price) * p.quantity
      : (p.entry_price - p.current_price) * p.quantity;

    lines.push(`[${p.asset}] ${p.direction}`);
    lines.push(`  Entry:    $${p.entry_price.toFixed(4)}`);
    lines.push(`  Current:  $${p.current_price.toFixed(4)}`);
    lines.push(`  Qty:      ${p.quantity.toFixed(6)}`);
    lines.push(`  P&L:      ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlDollar.toFixed(2)})`);
    lines.push(`  SL:       ${p.sl ? '$' + p.sl.toFixed(4) : 'N/A'}`);
    lines.push(`  Stage:    TP${p.stage}/3`);
    lines.push(`  Opened:   ${p.opened_at}`);
    lines.push('');
  }

  sendMessage(lines.join('\n'));
}

function cmdPnl(msg) {
  const logs = getTradeLog(100);
  const closed = logs.filter(l => l.type === 'CLOSE' || l.type.startsWith('CLOSE_'));

  const totalPnl = closed.reduce((s, l) => s + (l.pnl || 0), 0);
  const wins   = closed.filter(l => l.pnl > 0).length;
  const losses = closed.filter(l => l.pnl <= 0).length;
  const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0.0';

  const avgWin  = wins > 0 ? (closed.filter(l => l.pnl > 0).reduce((s, l) => s + l.pnl, 0) / wins) : 0;
  const avgLoss = losses > 0 ? (closed.filter(l => l.pnl <= 0).reduce((s, l) => s + l.pnl, 0) / losses) : 0;

  const positions = getPositions();
  const unrealized = positions.reduce((s, p) => {
    const pnl = p.direction === 'LONG'
      ? (p.current_price - p.entry_price) * p.quantity
      : (p.entry_price - p.current_price) * p.quantity;
    return s + pnl;
  }, 0);

  const text = [
    '=== P&L SUMMARY ===',
    '',
    `Realized P&L:    $${totalPnl.toFixed(2)}`,
    `Unrealized P&L:  $${unrealized.toFixed(2)}`,
    `Total Trades:    ${closed.length}`,
    `Wins / Losses:   ${wins} / ${losses}`,
    `Win Rate:        ${winRate}%`,
    `Avg Win:         $${avgWin.toFixed(2)}`,
    `Avg Loss:        $${avgLoss.toFixed(2)}`,
    `Profit Factor:   ${avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : 'N/A'}`,
  ].join('\n');
  sendMessage(text);
}

function cmdRisk(msg) {
  const balance = getBalance();
  const positions = getPositions();
  const exposure = positions.reduce((s, p) => s + p.current_price * p.quantity, 0);
  const exposurePct = balance > 0 ? ((exposure / balance) * 100).toFixed(1) : '0.0';

  const maxLoss = positions.reduce((s, p) => {
    if (!p.sl) return s;
    const slLoss = p.direction === 'LONG'
      ? (p.entry_price - p.sl) * p.quantity
      : (p.sl - p.entry_price) * p.quantity;
    return s + Math.max(slLoss, 0);
  }, 0);

  const text = [
    '=== RISK STATUS ===',
    '',
    `Balance:          $${balance.toFixed(2)}`,
    `Total Exposure:   $${exposure.toFixed(2)} (${exposurePct}%)`,
    `Open Positions:   ${positions.length}/10`,
    `Max SL Loss:      $${maxLoss.toFixed(2)}`,
    `Hard Stop:        ${PM_CONFIG.HARD_STOP_PCT}%`,
    `Breakeven At:     +${PM_CONFIG.BREAKEVEN_PCT}%`,
    `Trailing Start:   +${PM_CONFIG.TRAILING_LOCK_PCT}%`,
    `Trailing Dist:    ${PM_CONFIG.TRAILING_PCT}%`,
  ].join('\n');
  sendMessage(text);
}

function cmdConfig(msg) {
  const text = [
    '=== CONFIGURATION ===',
    '',
    `Starting Balance:   $1000`,
    `Max Positions:      10`,
    `Monitor Interval:   ${PM_CONFIG.MONITOR_INTERVAL / 1000}s`,
    `Fast Interval:      ${PM_CONFIG.MONITOR_INTERVAL_FAST / 1000}s`,
    `Breakeven:          +${PM_CONFIG.BREAKEVEN_PCT}%`,
    `Trailing Start:     +${PM_CONFIG.TRAILING_LOCK_PCT}%`,
    `Trailing Dist:      ${PM_CONFIG.TRAILING_PCT}% / ATR*${PM_CONFIG.TRAILING_ATR_MULT}`,
    `Hard Stop:          -${PM_CONFIG.HARD_STOP_PCT}%`,
    `TP1 / TP2 / TP3:    ${PM_CONFIG.TP1_PCT}% / ${PM_CONFIG.TP2_PCT}% / ${PM_CONFIG.TP3_PCT}%`,
    `Pyramid Trigger:    ${PM_CONFIG.PYRAMID_TRIGGER_PCT}% (score >= ${PM_CONFIG.PYRAMID_SCORE_MIN})`,
    `Pyramid Size:       +${PM_CONFIG.PYRAMID_SIZE_PCT}%`,
  ].join('\n');
  sendMessage(text);
}

function cmdBacktest(msg) {
  sendMessage('Fitur backtest belum tersedia. Gunakan /status untuk kondisi saat ini.');
}

function cmdStop(msg) {
  sendMessage('Bot dihentikan. Jalankan ulang untuk memulai kembali.');
  setTimeout(() => {
    if (bot) {
      bot.stopPolling();
      bot = null;
      isRunning = false;
    }
    process.exit(0);
  }, 1000);
}

function cmdPause(msg) {
  isPaused = true;
  sendMessage('Trading DIPAUSED. Posisi tetap dipantau.\nGunakan /resume untuk melanjutkan.');
}

function cmdResume(msg) {
  isPaused = false;
  sendMessage('Trading DILANJUTKAN.');
}

// ── Notification System ─────────────────────────────────────────────────────

/**
 * Send a typed notification to the configured chat.
 * @param {string} type  Notification type
 * @param {Object} data  Notification data
 */
export async function sendNotification(type, data) {
  let text = '';

  switch (type) {
    case 'ENTRY':
      text = [
        `[ENTRY APPROVED] ${data.asset}`,
        `Direction:  ${data.direction}`,
        `Price:      $${data.price}`,
        `Quantity:   ${data.quantity}`,
        `SL:         ${data.sl ? '$' + data.sl : 'N/A'}`,
        `TP1/TP2/TP3: ${data.tp1 || '-'} / ${data.tp2 || '-'} / ${data.tp3 || '-'}`,
      ].join('\n');
      break;

    case 'TP1':
    case 'TP2':
    case 'TP3':
      text = [
        `[${type}] ${data.asset} ${data.direction}`,
        `Price:      $${data.current_price}`,
        `P&L:        ${data.pnlPct ? data.pnlPct.toFixed(2) + '%' : 'N/A'}`,
        `Closed Qty: ${data.closedQty || data.quantity}`,
        `Remaining:  ${data.remainingQty || 0}`,
      ].join('\n');
      break;

    case 'SL':
      text = [
        `[STOP LOSS] ${data.asset} ${data.direction}`,
        `Entry:      $${data.entry_price}`,
        `Exit:       $${data.current_price}`,
        `P&L:        $${data.pnl ? data.pnl.toFixed(2) : 'N/A'}`,
        `Reason:     ${data.reason}`,
      ].join('\n');
      break;

    case 'HARD_STOP':
      text = [
        `[HARD STOP] ${data.asset} ${data.direction}`,
        `Entry:      $${data.entry_price}`,
        `Exit:       $${data.current_price}`,
        `P&L:        $${data.pnl ? data.pnl.toFixed(2) : 'N/A'}`,
        `Reason:     ${data.reason}`,
      ].join('\n');
      break;

    case 'BREAKEVEN':
      text = `[BREAKEVEN] ${data.asset} SL dipindah ke entry $${data.entry_price}`;
      break;

    case 'PYRAMID':
      text = [
        `[PYRAMID] ${data.asset} ${data.direction}`,
        `Added Qty:  ${data.addedQty}`,
        `New Total:  ${data.quantity + (data.addedQty || 0)}`,
      ].join('\n');
      break;

    case 'CIRCUIT_BREAKER':
      text = [
        '[CIRCUIT BREAKER AKTIF]',
        `Reason: ${data.reason}`,
        'Trading dihentikan sementara.',
      ].join('\n');
      break;

    case 'DAILY_SUMMARY':
      text = [
        '=== DAILY SUMMARY ===',
        `Date:         ${data.date}`,
        `Trades:       ${data.trades}`,
        `P&L:          $${data.pnl.toFixed(2)}`,
        `Win Rate:     ${data.winRate}%`,
        `Balance:      $${data.balance.toFixed(2)}`,
      ].join('\n');
      break;

    default:
      text = `[${type}] ${JSON.stringify(data)}`;
  }

  return sendMessage(text);
}

/**
 * Send real-time position update.
 * @param {Array} positions  Array of position objects
 */
export async function sendPositionUpdate(positions) {
  if (!positions || positions.length === 0) return;

  const lines = ['=== POSITION UPDATE ===', ''];

  for (const p of positions) {
    const pnlPct = p.direction === 'LONG'
      ? ((p.current_price - p.entry_price) / p.entry_price * 100)
      : ((p.entry_price - p.current_price) / p.entry_price * 100);
    const pnlDollar = p.direction === 'LONG'
      ? (p.current_price - p.entry_price) * p.quantity
      : (p.entry_price - p.current_price) * p.quantity;

    const marker = pnlPct >= 0 ? '+' : '';
    lines.push(`${p.asset} ${p.direction} | Entry: $${p.entry_price.toFixed(4)} | Now: $${p.current_price.toFixed(4)} | ${marker}${pnlPct.toFixed(2)}% ($${pnlDollar.toFixed(2)})`);
  }

  return sendMessage(lines.join('\n'));
}

// ── Daily Summary ───────────────────────────────────────────────────────────

export function sendDailySummary() {
  const balance = getBalance();
  const logs = getTradeLog(1000);
  const today = new Date().toISOString().slice(0, 10);
  const todayLogs = logs.filter(l => l.timestamp.startsWith(today));
  const closed = todayLogs.filter(l => l.type === 'CLOSE' || l.type.startsWith('CLOSE_'));
  const wins = closed.filter(l => l.pnl > 0).length;
  const pnl = closed.reduce((s, l) => s + (l.pnl || 0), 0);
  const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0.0';

  sendNotification('DAILY_SUMMARY', {
    date: today,
    trades: closed.length,
    pnl,
    winRate,
    balance,
  });
}

// ── Utility ─────────────────────────────────────────────────────────────────

async function sendMessage(text) {
  if (!bot) return;
  try {
    return await bot.sendMessage(CHAT_ID, text);
  } catch (err) {
    console.error('[TelegramBot] Send error:', err.message);
  }
}

/**
 * Check if bot is paused.
 */
export function isPausedState() {
  return isPaused;
}

/**
 * Check if bot is running.
 */
export function isRunningState() {
  return isRunning;
}

export { bot, CHAT_ID };
