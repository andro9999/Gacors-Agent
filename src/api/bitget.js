// Bitget API Client
// Handles all communication with Bitget exchange
// Uses axios with rate limiting, caching, and exponential backoff

import axios from 'axios';
import crypto from 'crypto';
import { BITGET } from '../config.js';
import {
  EMA, RSI, MACD, StochRSI, Fisher, ADX, ATR, VWAP,
  Bollinger, CHOP, VolumeRatio, CompositeOscillator
} from './indicators.js';

// ─── CACHE ────────────────────────────────────────────────────────────
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

// ─── RATE LIMITER ─────────────────────────────────────────────────────
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
  BITGET.RATE_LIMIT.MAX_REQUESTS,
  BITGET.RATE_LIMIT.WINDOW_MS
);

// ─── API REQUEST ──────────────────────────────────────────────────────
async function makeRequest(method, endpoint, params = {}, signed = false) {
  const url = `${BITGET.BASE_URL}${endpoint}`;
  let retries = 0;

  while (retries <= BITGET.RATE_LIMIT.MAX_RETRIES) {
    await rateLimiter.throttle();

    try {
      const headers = {
        'Content-Type': 'application/json'
      };

      if (signed) {
        const timestamp = Date.now().toString();
        const queryString = new URLSearchParams(params).toString();
        const prehash = timestamp + method.toUpperCase() + endpoint + (queryString ? '?' + queryString : '');
        const signature = crypto
          .createHmac('sha256', BITGET.SECRET_KEY)
          .update(prehash)
          .digest('base64');

        headers['ACCESS-KEY'] = BITGET.API_KEY;
        headers['ACCESS-SIGN'] = signature;
        headers['ACCESS-TIMESTAMP'] = timestamp;
        headers['ACCESS-PASSPHRASE'] = BITGET.PASSPHRASE;
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

      if (response.data.code === '00000') {
        return response.data.data;
      }

      throw new Error(response.data.msg || 'API error');
    } catch (error) {
      retries++;

      if (retries > BITGET.RATE_LIMIT.MAX_RETRIES) {
        throw new Error(`Bitget API failed after ${retries} retries: ${error.message}`);
      }

      // Exponential backoff
      const backoff = Math.min(
        BITGET.RATE_LIMIT.BACKOFF_BASE_MS * Math.pow(2, retries - 1),
        BITGET.RATE_LIMIT.BACKOFF_MAX_MS
      );
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

// ─── PUBLIC API FUNCTIONS ─────────────────────────────────────────────

/**
 * Fetch all USDT perpetual trading pairs
 * @returns {Promise<string[]>} Array of symbol names
 */
export async function fetchPairs() {
  const cacheKey = 'pairs';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await makeRequest('GET', '/api/v2/mix/market/contracts', {
      productType: BITGET.PRODUCT_TYPE
    });

    const symbols = data
      .filter(p => p.symbol.endsWith('USDT'))
      .map(p => p.symbol);

    cache.set(cacheKey, symbols, BITGET.CACHE_TTL.PAIRS);
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

  // Map timeframe to Bitget granularity
  const granularityMap = {
    '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1H': '1H', '4H': '4H', '6H': '6H', '12H': '12H', '1D': '1D', '1W': '1W'
  };

  try {
    const data = await makeRequest('GET', '/api/v2/mix/market/candles', {
      symbol,
      productType: BITGET.PRODUCT_TYPE,
      granularity: granularityMap[timeframe] || timeframe,
      limit: parseInt(limit)
    }, true);

    const candles = data.map(c => ({
      timestamp: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
      quoteVolume: parseFloat(c[6])
    }));

    cache.set(cacheKey, candles, BITGET.CACHE_TTL.KLINES);
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
    const data = await makeRequest('GET', '/api/v2/mix/market/ticker', {
      symbol,
      productType: BITGET.PRODUCT_TYPE
    });

    // API returns array, get first item
    const item = Array.isArray(data) ? data[0] : data;
    if (!item) return null;

    const ticker = {
      symbol,
      last: parseFloat(item.lastPr),
      price: parseFloat(item.lastPr),
      volume24h: parseFloat(item.baseVolume),
      quoteVolume24h: parseFloat(item.quoteVolume),
      change24h: parseFloat(item.change24h),
      high24h: parseFloat(item.high24h),
      low24h: parseFloat(item.low24h),
      bid: parseFloat(item.bidPr),
      ask: parseFloat(item.askPr),
      timestamp: parseInt(item.ts)
    };

    cache.set(cacheKey, ticker, BITGET.CACHE_TTL.TICKER);
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
    const data = await makeRequest('GET', '/api/v2/mix/market/merge-depth', {
      symbol,
      productType: BITGET.PRODUCT_TYPE,
      limit: parseInt(limit),
      precision: 'scale0'
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

    cache.set(cacheKey, orderbook, BITGET.CACHE_TTL.ORDERBOOK);
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
    const data = await makeRequest('GET', '/api/v2/mix/market/current-fund-rate', {
      symbol,
      productType: BITGET.PRODUCT_TYPE
    });

    // API returns array, get first item
    const item = Array.isArray(data) ? data[0] : data;
    if (!item) return null;

    return {
      symbol,
      fundingRate: parseFloat(item.fundingRate),
      nextFundingTime: parseInt(item.nextUpdate)
    };
  } catch (error) {
    console.error(`Failed to fetch funding rate for ${symbol}:`, error.message);
    return null;
  }
}

// ─── INDICATOR CALCULATIONS ───────────────────────────────────────────

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

// ─── MARKET DATA ──────────────────────────────────────────────────────

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

/**
 * Calculate position size based on risk parameters
 * @param {number} balance - Account balance
 * @param {number} entryPrice - Entry price
 * @param {number} stopLoss - Stop loss price
 * @param {number} leverage - Leverage multiplier
 * @returns {object} Position sizing info
 */
export function calculatePositionSize(balance, entryPrice, stopLoss, leverage = 10) {
  const riskAmount = balance * 0.02; // 2% risk per trade
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const stopPercent = stopDistance / entryPrice;
  
  const sizeUSDT = riskAmount / stopPercent;
  const sizeUnits = sizeUSDT / entryPrice;
  const marginRequired = sizeUSDT / leverage;

  return {
    sizeUSDT: Math.min(sizeUSDT, balance * 0.05), // Max 5% of balance
    sizeUnits,
    marginRequired,
    riskAmount,
    stopDistance,
    stopPercent: stopPercent * 100
  };
}

// Export cache and rate limiter for testing
export { cache, rateLimiter };
