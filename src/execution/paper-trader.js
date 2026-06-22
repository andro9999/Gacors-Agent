/**
 * Paper Trading Engine
 * SQLite-backed simulated trading with $1000 starting balance.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/paper-trades.db');
const STARTING_BALANCE = 1000;
const MAX_POSITIONS = 10;

// ── Database Setup ──────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS balance (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    value REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS positions (
    id          TEXT PRIMARY KEY,
    asset       TEXT NOT NULL,
    direction   TEXT NOT NULL CHECK (direction IN ('LONG','SHORT')),
    entry_price REAL NOT NULL,
    current_price REAL NOT NULL,
    quantity    REAL NOT NULL,
    sl          REAL,
    tp1         REAL,
    tp2         REAL,
    tp3         REAL,
    opened_at   TEXT NOT NULL,
    stage       INTEGER NOT NULL DEFAULT 0,
    atr         REAL,
    pyramid     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS trade_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      TEXT NOT NULL,
    asset          TEXT NOT NULL,
    direction      TEXT NOT NULL,
    price          REAL NOT NULL,
    quantity       REAL NOT NULL,
    balance_change REAL NOT NULL,
    pnl            REAL,
    type           TEXT NOT NULL DEFAULT 'OPEN'
  );
`);

// Seed balance row if it doesn't exist
const balRow = db.prepare('SELECT value FROM balance WHERE id = 1').get();
if (!balRow) {
  db.prepare('INSERT INTO balance (id, value) VALUES (1, ?)').run(STARTING_BALANCE);
}

// ── Prepared Statements ─────────────────────────────────────────────────────

const stmts = {
  getBalance:      db.prepare('SELECT value FROM balance WHERE id = 1'),
  setBalance:      db.prepare('UPDATE balance SET value = ? WHERE id = 1'),
  countPositions:  db.prepare('SELECT COUNT(*) AS cnt FROM positions'),
  insertPosition:  db.prepare(`
    INSERT INTO positions (id, asset, direction, entry_price, current_price, quantity, sl, tp1, tp2, tp3, opened_at, stage, atr, pyramid)
    VALUES (@id, @asset, @direction, @entry_price, @current_price, @quantity, @sl, @tp1, @tp2, @tp3, @opened_at, @stage, @atr, @pyramid)
  `),
  getPosition:     db.prepare('SELECT * FROM positions WHERE id = ?'),
  getAllPositions:  db.prepare('SELECT * FROM positions'),
  deletePosition:  db.prepare('DELETE FROM positions WHERE id = ?'),
  updateCurrentPrice: db.prepare('UPDATE positions SET current_price = ? WHERE id = ?'),
  updatePositionSL:  db.prepare('UPDATE positions SET sl = ? WHERE id = ?'),
  updatePositionStage: db.prepare('UPDATE positions SET stage = ?, sl = ? WHERE id = ?'),
  updatePositionQty:  db.prepare('UPDATE positions SET quantity = ?, pyramid = ? WHERE id = ?'),
  insertLog:       db.prepare(`
    INSERT INTO trade_log (timestamp, asset, direction, price, quantity, balance_change, pnl, type)
    VALUES (@timestamp, @asset, @direction, @price, @quantity, @balance_change, @pnl, @type)
  `),
  getTradeLog:     db.prepare('SELECT * FROM trade_log ORDER BY id DESC LIMIT ?'),
  getTradeLogAll:  db.prepare('SELECT * FROM trade_log ORDER BY id DESC'),
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Open a new paper position.
 * @param {Object} data  { asset, direction, price, quantity, sl?, tp1?, tp2?, tp3?, atr? }
 * @returns {Object}     The created position row.
 */
export function openPosition(data) {
  const { asset, direction, price, quantity, sl = null, tp1 = null, tp2 = null, tp3 = null, atr = null } = data;

  if (!asset || !direction || !price || !quantity) {
    throw new Error('openPosition requires: asset, direction, price, quantity');
  }
  if (!['LONG', 'SHORT'].includes(direction)) {
    throw new Error('direction must be LONG or SHORT');
  }

  const count = stmts.countPositions.get().cnt;
  if (count >= MAX_POSITIONS) {
    throw new Error(`Max ${MAX_POSITIONS} open positions reached`);
  }

  const cost = price * quantity;
  const balance = stmts.getBalance.get().value;
  if (cost > balance) {
    throw new Error(`Insufficient balance: need $${cost.toFixed(2)}, have $${balance.toFixed(2)}`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    stmts.setBalance.run(balance - cost);
    stmts.insertPosition.run({
      id, asset, direction,
      entry_price: price,
      current_price: price,
      quantity,
      sl, tp1, tp2, tp3,
      opened_at: now,
      stage: 0,
      atr,
      pyramid: 0,
    });
    stmts.insertLog.run({
      timestamp: now,
      asset,
      direction,
      price,
      quantity,
      balance_change: -cost,
      pnl: null,
      type: 'OPEN',
    });
  });
  txn();

  return stmts.getPosition.get(id);
}

/**
 * Close a paper position at the given price.
 * @param {string} id     Position UUID
 * @param {number} price  Exit price
 * @returns {Object}      { position, pnl, balanceChange }
 */
export function closePosition(id, price) {
  const pos = stmts.getPosition.get(id);
  if (!pos) throw new Error(`Position ${id} not found`);

  const { asset, direction, entry_price, quantity } = pos;

  let pnl;
  if (direction === 'LONG') {
    pnl = (price - entry_price) * quantity;
  } else {
    pnl = (entry_price - price) * quantity;
  }

  const proceeds = price * quantity;
  const balance = stmts.getBalance.get().value;
  const newBalance = balance + proceeds;

  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    stmts.setBalance.run(newBalance);
    stmts.deletePosition.run(id);
    stmts.insertLog.run({
      timestamp: now,
      asset,
      direction,
      price,
      quantity,
      balance_change: proceeds,
      pnl,
      type: 'CLOSE',
    });
  });
  txn();

  return { position: pos, pnl, balanceChange: proceeds };
}

/**
 * Get all open positions.
 */
export function getPositions() {
  return stmts.getAllPositions.all();
}

/**
 * Get current balance.
 */
export function getBalance() {
  return stmts.getBalance.get().value;
}

/**
 * Get trade log (most recent N entries, or all).
 */
export function getTradeLog(limit = 100) {
  return limit === -1 ? stmts.getTradeLogAll.all() : stmts.getTradeLog.all(limit);
}

// ── Internal helpers for position-manager ───────────────────────────────────

export function _updateCurrentPrice(id, price) {
  stmts.updateCurrentPrice.run(price, id);
}

export function _updateSL(id, sl) {
  stmts.updatePositionSL.run(sl, id);
}

export function _updateStage(id, stage, sl) {
  stmts.updatePositionStage.run(stage, sl, id);
}

export function _updateQuantity(id, quantity, pyramid) {
  stmts.updatePositionQty.run(quantity, pyramid, id);
}

export function _getPosition(id) {
  return stmts.getPosition.get(id);
}

export function _getDB() {
  return db;
}

export { STARTING_BALANCE, MAX_POSITIONS, DB_PATH };
