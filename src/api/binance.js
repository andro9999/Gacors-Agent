// Binance Futures API Client
// Handles all communication with Binance USDⓈ-M Futures
// Uses axios with rate limiting, caching, and exponential backoff

import axios from 'axios';
import crypto from 'crypto';

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const BINANCE = {
  BASE_URL: 'https://fapi.binance.com',
  API_KEY: process.env.BINANCE_API_KEY || '',
  SECRET_KEY: process.env.BINANCE_SECRET_KEY || '',
  PRODUCT_TYPE: 'USDT',
  RATE_LIMIT: {
    MAX_REQUESTS: 10,
    WINDOW_MS: 1000,
    BACKOFF_BASE_MS: 1000,
    BACKOFF_MAX_MS: 30000,
    MAX_RETRIES: 5
  },
  CACHE_TTL: {
    PAIRS: 300000,      // 5 min
    KLINES: 60000,      // 1 min
    TICKER: 5000,       // 5 sec
    ORDERBOOK: 3000     // 3 sec
  }
};

// ─── CACHE ──────────────────────────────────────────────────────────────────
class Cache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, {
      value,
      expiry: Date.now() + ttlMs
    });
  }

  clear() {
    this.store.clear();
  }
}

const cache = new Cache();

// ─── RATE LIMITER ───────────────────────────────────────────────────────────
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async throttle() {
    const now = Date.now();
    this.requests = this.requests.filter(t => t > now - this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      const oldest = this.requests[0];
      const waitMs = oldest + this.windowMs - now;
      await new Promise(r => setTimeout(r, waitMs));
    }

    this.requests.push(Date.now());
  }
}

const rateLimiter = new RateLimiter(
  BINANCE.RATE_LIMIT.MAX_REQUESTS,
  BINANCE.RATE_LIMIT.WINDOW_MS
);

// ─── API REQUEST ────────────────────────────────────────────────────────────
async function makeRequest(method, endpoint, params = {}, signed = false) {
  const url = `${BINANCE.BASE_URL}${endpoint}`;
  let retries = 0;

  while (retries <= BINANCE.RATE_LIMIT.MAX_RETRIES) {
    await rateLimiter.throttle();

    try {
      const headers = {
        'Content-Type': 'application/json'
      };

      if (signed) {
        const timestamp = Date.now();
        const queryString = new URLSearchParams({ ...params, timestamp }).toString();
        const signature = crypto
          .createHmac('sha256', BINANCE.SECRET_KEY)
          .update(queryString)
          .digest('hex');

        headers['X-MBX-APIKEY'] = BINANCE.API_KEY;
        params.timestamp = timestamp;
        params.signature = signature;
      }

      const config = {
        method,
        url,
        headers,
        timeout: 10000
      };

      if (method === 'GET') {
        config.params = params;
      } else {
        config.data = params;
      }

      const response = await axios(config);

      // Binance returns data directly (no wrapper)
      return response.data;
    } catch (error) {
      retries++;

      if (retries > BINANCE.RATE_LIMIT.MAX_RETRIES) {
        throw new Error(`Binance API failed after ${retries} retries: ${error.message}`);
      }

      // Exponential backoff
      const backoff = Math.min(
        BINANCE.RATE_LIMIT.BACKOFF_BASE_MS * Math.pow(2, retries - 1),
        BINANCE.RATE_LIMIT.BACKOFF_MAX_MS
      );
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

// ─── PUBLIC API FUNCTIONS ───────────────────────────────────────────────────

/**
 * Fetch all USDT perpetual trading pairs
 * @returns {Promise<string[]>} Array of symbol names
 */
export async function fetchPairs() {
  const cacheKey = 'pairs';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await makeRequest('GET', '/fapi/v1/exchangeInfo');

    const symbols = data.symbols
      .filter(p => p.quoteAsset === 'USDT' && p.status === 'TRADING' && p.contractType === 'PERPETUAL')
      .map(p => p.symbol);

    cache.set(cacheKey, symbols, BINANCE.CACHE_TTL.PAIRS);
    return symbols;
  } catch (error) {
    console.error('Failed to fetch pairs:', error.message);
    return [];
  }
}

/**
 * Fetch kline (candlestick) data
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {string} timeframe - Kline interval ('1m','5m','15m','1H','4H','1D')
 * @param {number} limit - Number of candles (default 200)
 * @returns {Promise<object[]>} Array of OHLCV candles
 */
export async function fetchKlines(symbol, timeframe, limit = 200) {
  const cacheKey = `klines:${symbol}:${timeframe}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Map timeframe to Binance interval
  const granularityMap = {
    '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1H': '1h', '4H': '4h', '6H': '6h', '12H': '12h', '1D': '1d', '1W': '1w'
  };

  try {
    const data = await makeRequest('GET', '/fapi/v1/klines', {
      symbol,
      interval: granularityMap[timeframe] || timeframe,
      limit: parseInt(limit)
    });

    // Binance returns arrays: [openTime, open, high, low, close, volume, closeTime, ...]
    const candles = data.map(c => ({
      timestamp: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
      quoteVolume: parseFloat(c[7])
    }));

    cache.set(cacheKey, candles, BINANCE.CACHE_TTL.KLINES);
    return candles;
  } catch (error) {
    console.error(`Failed to fetch klines for ${symbol}:`, error.message);
    return [];
  }
}

/**
 * Fetch ticker data for a symbol
 * @param {string} symbol - Trading pair
 * @returns {Promise<object>} Ticker data { price, volume, change24h, high24h, low24h }
 */
export async function fetchTicker(symbol) {
  const cacheKey = `ticker:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await makeRequest('GET', '/fapi/v1/ticker/24hr', {
      symbol
    });

    const ticker = {
      symbol,
      price: parseFloat(data.lastPrice),
      last: parseFloat(data.lastPrice),
      volume24h: parseFloat(data.volume),
      quoteVolume24h: parseFloat(data.quoteVolume),
      change24h: parseFloat(data.priceChangePercent),
      high24h: parseFloat(data.highPrice),
      low24h: parseFloat(data.lowPrice),
      bid: parseFloat(data.bidPrice),
      ask: parseFloat(data.askPrice),
      timestamp: parseInt(data.closeTime)
    };

    cache.set(cacheKey, ticker, BINANCE.CACHE_TTL.TICKER);
    return ticker;
  } catch (error) {
    console.error(`Failed to fetch ticker for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Fetch orderbook data
 * @param {string} symbol - Trading pair
 * @param {number} limit - Depth limit (default 20)
 * @returns {Promise<object>} Orderbook { bids, asks, spread }
 */
export async function fetchOrderbook(symbol, limit = 20) {
  const cacheKey = `orderbook:${symbol}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await makeRequest('GET', '/fapi/v1/depth', {
      symbol,
      limit: parseInt(limit)
    });

    const orderbook = {
      bids: data.bids.map(b => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })),
      asks: data.asks.map(a => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })),
      timestamp: Date.now()
    };

    if (orderbook.bids.length > 0 && orderbook.asks.length > 0) {
      orderbook.spread = orderbook.asks[0].price - orderbook.bids[0].price;
      orderbook.spreadPercent = (orderbook.spread / orderbook.bids[0].price) * 100;
    }

    cache.set(cacheKey, orderbook, BINANCE.CACHE_TTL.ORDERBOOK);
    return orderbook;
  } catch (error) {
    console.error(`Failed to fetch orderbook for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Fetch funding rate for a symbol
 * @param {string} symbol - Trading pair
 * @returns {Promise<object>} Funding rate data
 */
export async function fetchFundingRate(symbol) {
  try {
    const data = await makeRequest('GET', '/fapi/v1/fundingRate', {
      symbol,
      limit: 1
    });

    if (!data || data.length === 0) return null;

    return {
      symbol,
      fundingRate: parseFloat(data[0].fundingRate),
      nextFundingTime: parseInt(data[0].fundingTime)
    };
  } catch (error) {
    console.error(`Failed to fetch funding rate for ${symbol}:`, error.message);
    return null;
  }
}

// ─── INDICATOR CALCULATIONS ─────────────────────────────────────────────────

/**
 * Calculate all technical indicators for a symbol
 * @param {string} symbol - Trading pair
 * @param {object} config - Indicator configuration (optional)
 * @returns {Promise<object>} All calculated indicators
 */
export async function calculateIndicators(symbol, config = {}) {
  const {
    EMA_FAST = 9, EMA_SLOW = 21, EMA_TREND = 50,
    RSI_PERIOD = 14, MACD_FAST = 12, MACD_SLOW = 26, MACD_SIGNAL = 9,
    STOCHRSI_PERIOD = 14, STOCHRSI_K = 3, STOCHRSI_D = 3,
    FISHER_PERIOD = 10, ADX_PERIOD = 14, ATR_PERIOD = 14,
    BOLLINGER_PERIOD = 20, BOLLINGER_STD = 2, CHOP_PERIOD = 14
  } = config;

  // Fetch klines for multiple timeframes
  const [candles1H, candles4H, candles15m] = await Promise.all([
    fetchKlines(symbol, '1H', 200),
    fetchKlines(symbol, '4H', 200),
    fetchKlines(symbol, '15m', 200)
  ]);

  if (!candles1H || candles1H.length < 50) {
    return null;
  }

  const closes1H = candles1H.map(c => c.close);
  const highs1H = candles1H.map(c => c.high);
  const lows1H = candles1H.map(c => c.low);
  const volumes1H = candles1H.map(c => c.volume);

  // ─── EMA ─────────────────────────────────────────────────────────────
  const ema9 = EMA(EMA_FAST, closes1H);
  const ema21 = EMA(EMA_SLOW, closes1H);
  const ema50 = EMA(EMA_TREND, closes1H);

  // ─── RSI ─────────────────────────────────────────────────────────────
  const rsi = RSI(RSI_PERIOD, closes1H);

  // ─── MACD ────────────────────────────────────────────────────────────
  const macd = MACD(MACD_FAST, MACD_SLOW, MACD_SIGNAL, closes1H);

  // ─── StochRSI ────────────────────────────────────────────────────────
  const stochRsi = StochRSI(STOCHRSI_PERIOD, closes1H, STOCHRSI_K, STOCHRSI_D);

  // ─── Fisher ──────────────────────────────────────────────────────────
  const fisher = Fisher(rsi, FISHER_PERIOD);

  // ─── ADX ─────────────────────────────────────────────────────────────
  const adxData = ADX(ADX_PERIOD, candles1H);

  // ─── ATR ─────────────────────────────────────────────────────────────
  const atr = ATR(ATR_PERIOD, candles1H);

  // ─── VWAP ────────────────────────────────────────────────────────────
  const vwap = VWAP(candles1H);

  // ─── Bollinger ───────────────────────────────────────────────────────
  const bollinger = Bollinger(BOLLINGER_PERIOD, BOLLINGER_STD, closes1H);

  // ─── CHOP ────────────────────────────────────────────────────────────
  const chop = CHOP(CHOP_PERIOD, candles1H);

  // ─── Volume Ratio ────────────────────────────────────────────────────
  const volumeRatio = VolumeRatio(volumes1H, 20);

  // ─── Composite Oscillator ────────────────────────────────────────────
  const composite = CompositeOscillator(rsi, stochRsi.k, fisher);

  // ─── 4H Indicators ──────────────────────────────────────────────────
  let fourHTrend = null;
  if (candles4H && candles4H.length >= 30) {
    const closes4H = candles4H.map(c => c.close);
    const ema9_4H = EMA(9, closes4H);
    const ema21_4H = EMA(21, closes4H);
    const rsi4H = RSI(14, closes4H);

    fourHTrend = {
      ema9: ema9_4H[ema9_4H.length - 1],
      ema21: ema21_4H[ema21_4H.length - 1],
      rsi: rsi4H[rsi4H.length - 1],
      trend: ema9_4H[ema9_4H.length - 1] > ema21_4H[ema21_4H.length - 1] ? 'BULLISH' : 'BEARISH'
    };
  }

  // ─── 15m Indicators ─────────────────────────────────────────────────
  let entry15m = null;
  if (candles15m && candles15m.length >= 30) {
    const closes15m = candles15m.map(c => c.close);
    const ema9_15m = EMA(9, closes15m);
    const rsi15m = RSI(14, closes15m);

    entry15m = {
      ema9: ema9_15m[ema9_15m.length - 1],
      rsi: rsi15m[rsi15m.length - 1]
    };
  }

  // ─── Current Values ─────────────────────────────────────────────────
  const current = {
    price: closes1H[closes1H.length - 1],
    ema9: ema9[ema9.length - 1],
    ema21: ema21[ema21.length - 1],
    ema50: ema50[ema50.length - 1],
    rsi: rsi[rsi.length - 1],
    macd: macd.macd[macd.macd.length - 1],
    macdSignal: macd.signal[macd.signal.length - 1],
    macdHistogram: macd.histogram[macd.histogram.length - 1],
    stochRsiK: stochRsi.k[stochRsi.k.length - 1],
    stochRsiD: stochRsi.d[stochRsi.d.length - 1],
    fisher: fisher[fisher.length - 1],
    adx: adxData.adx[adxData.adx.length - 1],
    plusDI: adxData.plusDI[adxData.plusDI.length - 1],
    minusDI: adxData.minusDI[adxData.minusDI.length - 1],
    atr: atr[atr.length - 1],
    vwap: vwap[vwap.length - 1],
    bollingerUpper: bollinger.upper[bollinger.upper.length - 1],
    bollingerMiddle: bollinger.middle[bollinger.middle.length - 1],
    bollingerLower: bollinger.lower[bollinger.lower.length - 1],
    bollingerPercentB: bollinger.percentB[bollinger.percentB.length - 1],
    chop: chop[chop.length - 1],
    volumeRatio: volumeRatio[volumeRatio.length - 1],
    composite: composite[composite.length - 1]
  };

  // ─── Trend Analysis ─────────────────────────────────────────────────
  const trend = {
    ema: current.ema9 > current.ema21 ? 'BULLISH' : 'BEARISH',
    macd: current.macd > current.macdSignal ? 'BULLISH' : 'BEARISH',
    fourH: fourHTrend?.trend || 'NEUTRAL',
    overall: 'NEUTRAL'
  };

  // Voting system: 2/3 agreement
  const votes = [trend.ema, trend.macd, trend.fourH].filter(t => t === 'BULLISH').length;
  trend.overall = votes >= 2 ? 'BULLISH' : votes <= 1 ? 'BEARISH' : 'NEUTRAL';
  trend.votes = votes;

  return {
    symbol,
    timestamp: Date.now(),
    current,
    trend,
    fourHTrend,
    entry15m,
    arrays: {
      ema9, ema21, ema50, rsi, macd, stochRsi, fisher,
      adx: adxData, atr, vwap, bollinger, chop, volumeRatio, composite
    }
  };
}

// ─── MARKET DATA ────────────────────────────────────────────────────────────

/**
 * Get BTC regime (for overall market direction)
 * @returns {Promise<object>} BTC trend analysis
 */
export async function getBTCRegime() {
  return calculateIndicators('BTCUSDT');
}

/**
 * Fetch multiple tickers in parallel
 * @param {string[]} symbols - Array of trading pairs
 * @returns {Promise<object[]>} Array of ticker data
 */
export async function fetchMultipleTickers(symbols) {
  const promises = symbols.map(s => fetchTicker(s));
  const results = await Promise.allSettled(promises);
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}

// ─── INDICATOR FUNCTIONS ────────────────────────────────────────────────────
// (Same as Bitget — these are pure math functions)

function EMA(period, data) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function RSI(period, data) {
  const rsi = [];
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period && i < data.length; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }

  avgGain /= period;
  avgLoss /= period;

  for (let i = 0; i < period; i++) rsi.push(50);

  for (let i = period; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) rsi.push(100);
    else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - (100 / (1 + rs)));
    }
  }

  return rsi;
}

function MACD(fast, slow, signal, data) {
  const emaFast = EMA(fast, data);
  const emaSlow = EMA(slow, data);

  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = EMA(signal, macdLine);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);

  return { macd: macdLine, signal: signalLine, histogram };
}

function StochRSI(period, data, kPeriod, dPeriod) {
  const rsi = RSI(period, data);
  const stochK = [];
  const stochD = [];

  for (let i = period; i < rsi.length; i++) {
    const slice = rsi.slice(Math.max(0, i - period), i + 1);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    const k = max === min ? 50 : ((rsi[i] - min) / (max - min)) * 100;
    stochK.push(k);
  }

  for (let i = kPeriod - 1; i < stochK.length; i++) {
    const slice = stochK.slice(i - kPeriod + 1, i + 1);
    stochD.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }

  return { k: stochK, d: stochD };
}

function Fisher(rsi, period) {
  const fisher = [];
  for (let i = 0; i < rsi.length; i++) {
    const normalized = (rsi[i] - 50) / 50;
    fisher.push(0.5 * Math.log((1 + normalized) / (1 - normalized)));
  }
  return fisher;
}

function ADX(period, candles) {
  const adx = [], plusDI = [], minusDI = [];

  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(i - period, i);
    let pdm = 0, mdm = 0, tr = 0;

    for (let j = 1; j < slice.length; j++) {
      const high = slice[j].high;
      const low = slice[j].low;
      const prevHigh = slice[j - 1].high;
      const prevLow = slice[j - 1].low;
      const prevClose = slice[j - 1].close;

      const upMove = high - prevHigh;
      const downMove = prevLow - low;

      if (upMove > downMove && upMove > 0) pdm += upMove;
      if (downMove > upMove && downMove > 0) mdm += downMove;

      tr += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    }

    const pdi = tr > 0 ? (pdm / tr) * 100 : 0;
    const mdi = tr > 0 ? (mdm / tr) * 100 : 0;
    const dx = (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;

    plusDI.push(pdi);
    minusDI.push(mdi);
    adx.push(dx);
  }

  return { adx, plusDI, minusDI };
}

function ATR(period, candles) {
  const atr = [];
  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(i - period, i);
    let sum = 0;
    for (let j = 1; j < slice.length; j++) {
      const high = slice[j].high;
      const low = slice[j].low;
      const prevClose = slice[j - 1].close;
      sum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    }
    atr.push(sum / period);
  }
  return atr;
}

function VWAP(candles) {
  const vwap = [];
  let cumVol = 0, cumTP = 0;

  for (const candle of candles) {
    const tp = (candle.high + candle.low + candle.close) / 3;
    cumTP += tp * candle.volume;
    cumVol += candle.volume;
    vwap.push(cumVol > 0 ? cumTP / cumVol : tp);
  }

  return vwap;
}

function Bollinger(period, stdDev, data) {
  const upper = [], middle = [], lower = [], percentB = [];

  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const std = Math.sqrt(variance);

    middle.push(mean);
    upper.push(mean + stdDev * std);
    lower.push(mean - stdDev * std);

    const range = (mean + stdDev * std) - (mean - stdDev * std);
    percentB.push(range > 0 ? (data[i] - (mean - stdDev * std)) / range : 0.5);
  }

  return { upper, middle, lower, percentB };
}

function CHOP(period, candles) {
  const chop = [];
  for (let i = period; i < candles.length; i++) {
    const slice = candles.slice(i - period, i);
    let atrSum = 0, highMax = -Infinity, lowMin = Infinity;

    for (let j = 1; j < slice.length; j++) {
      atrSum += Math.max(
        slice[j].high - slice[j].low,
        Math.abs(slice[j].high - slice[j - 1].close),
        Math.abs(slice[j].low - slice[j - 1].close)
      );
      highMax = Math.max(highMax, slice[j].high);
      lowMin = Math.min(lowMin, slice[j].low);
    }

    const range = highMax - lowMin;
    chop.push(range > 0 ? 100 * Math.log10(atrSum / range) / Math.log10(period) : 50);
  }
  return chop;
}

function VolumeRatio(volumes, period) {
  const ratio = [];
  for (let i = period; i < volumes.length; i++) {
    const avg = volumes.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
    ratio.push(avg > 0 ? volumes[i] / avg : 0);
  }
  return ratio;
}

function CompositeOscillator(rsi, stochK, fisher) {
  const composite = [];
  for (let i = 0; i < rsi.length; i++) {
    const r = (rsi[i] - 50) / 50;
    const s = (stochK[i] - 50) / 50;
    const f = fisher[i] || 0;
    composite.push((r * 0.4 + s * 0.3 + f * 0.3) * 100);
  }
  return composite;
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────
// Re-export with same names as bitget.js for drop-in replacement
export { BINANCE as BITGET };
