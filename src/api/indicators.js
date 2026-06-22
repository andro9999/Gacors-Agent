// Technical Indicator Calculations
// All pure functions, no side effects
// Compatible with ES modules, Node.js 22+

/**
 * Exponential Moving Average
 * @param {number} period - EMA period
 * @param {number[]} data - Price data array
 * @returns {number[]} EMA values
 */
export function EMA(period, data) {
  if (!data || data.length < period) return [];
  
  const multiplier = 2 / (period + 1);
  const ema = [];
  
  // Calculate SMA for first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
  }
  ema.push(sum / period);
  
  // Calculate EMA for remaining values
  for (let i = period; i < data.length; i++) {
    const value = (data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1];
    ema.push(value);
  }
  
  return ema;
}

/**
 * Relative Strength Index
 * @param {number} period - RSI period (default 14)
 * @param {number[]} data - Price data array
 * @returns {number[]} RSI values
 */
export function RSI(period, data) {
  if (!data || data.length < period + 1) return [];
  
  const rsi = [];
  const gains = [];
  const losses = [];
  
  // Calculate price changes
  for (let i = 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }
  
  // Calculate first average gain/loss
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  
  // Calculate RSI
  for (let i = period; i < gains.length; i++) {
    if (i === period) {
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi.push(100 - (100 / (1 + rs)));
    } else {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi.push(100 - (100 / (1 + rs)));
    }
  }
  
  return rsi;
}

/**
 * MACD (Moving Average Convergence Divergence)
 * @param {number} fast - Fast EMA period (default 12)
 * @param {number} slow - Slow EMA period (default 26)
 * @param {number} signal - Signal line period (default 9)
 * @param {number[]} data - Price data array
 * @returns {object} { macd, signal, histogram }
 */
export function MACD(fast, slow, signal, data) {
  if (!data || data.length < slow + signal) {
    return { macd: [], signal: [], histogram: [] };
  }
  
  const emaFast = EMA(fast, data);
  const emaSlow = EMA(slow, data);
  
  // Align arrays (EMA(slow) starts later)
  const offset = slow - fast;
  const macdLine = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset] - emaSlow[i]);
  }
  
  const signalLine = EMA(signal, macdLine);
  
  // Align MACD and Signal
  const signalOffset = signal - 1;
  const histogram = [];
  const alignedMacd = [];
  const alignedSignal = [];
  
  for (let i = 0; i < signalLine.length; i++) {
    alignedMacd.push(macdLine[i + signalOffset]);
    alignedSignal.push(signalLine[i]);
    histogram.push(macdLine[i + signalOffset] - signalLine[i]);
  }
  
  return {
    macd: alignedMacd,
    signal: alignedSignal,
    histogram
  };
}

/**
 * Stochastic RSI
 * @param {number} period - RSI period (default 14)
 * @param {number[]} data - Price data array
 * @param {number} k - K smoothing (default 3)
 * @param {number} d - D smoothing (default 3)
 * @returns {object} { k, d }
 */
export function StochRSI(period, data, k = 3, d = 3) {
  const rsiValues = RSI(period, data);
  if (rsiValues.length < period) {
    return { k: [], d: [] };
  }
  
  const stochRsi = [];
  
  // Calculate Stochastic of RSI
  for (let i = period - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - period + 1, i + 1);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    const value = max - min === 0 ? 50 : ((rsiValues[i] - min) / (max - min)) * 100;
    stochRsi.push(value);
  }
  
  // Apply K smoothing (SMA)
  const kValues = SMA(k, stochRsi);
  
  // Apply D smoothing (SMA of K)
  const dValues = SMA(d, kValues);
  
  return { k: kValues, d: dValues };
}

/**
 * Simple Moving Average (helper function)
 * @param {number} period - SMA period
 * @param {number[]} data - Price data array
 * @returns {number[]} SMA values
 */
function SMA(period, data) {
  if (!data || data.length < period) return [];
  
  const sma = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j];
    }
    sma.push(sum / period);
  }
  return sma;
}

/**
 * Fisher Transform
 * @param {number[]} data - Price data (typically RSI or StochRSI values)
 * @param {number} period - Lookback period (default 10)
 * @returns {number[]} Fisher transform values
 */
export function Fisher(data, period = 10) {
  if (!data || data.length < period) return [];
  
  const fisher = [];
  
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    
    // Normalize to -1 to 1 range
    let x = 0;
    if (max - min !== 0) {
      x = 2 * ((data[i] - min) / (max - min)) - 1;
    }
    
    // Clamp x to avoid infinity
    x = Math.max(-0.999, Math.min(0.999, x));
    
    // Fisher Transform
    const fisherValue = 0.5 * Math.log((1 + x) / (1 - x));
    fisher.push(fisherValue);
  }
  
  return fisher;
}

/**
 * Average Directional Index
 * @param {number} period - ADX period (default 14)
 * @param {object[]} data - OHLC data array [{high, low, close}]
 * @returns {object} { adx, plusDI, minusDI }
 */
export function ADX(period, data) {
  if (!data || data.length < period * 2) {
    return { adx: [], plusDI: [], minusDI: [] };
  }
  
  const trueRanges = [];
  const plusDMs = [];
  const minusDMs = [];
  
  // Calculate True Range, +DM, -DM
  for (let i = 1; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevHigh = data[i - 1].high;
    const prevLow = data[i - 1].low;
    const prevClose = data[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
    
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  
  // Smooth using Wilder's method
  const smoothedTR = [];
  const smoothedPlusDM = [];
  const smoothedMinusDM = [];
  
  // Initial sum
  let sumTR = 0;
  let sumPlusDM = 0;
  let sumMinusDM = 0;
  
  for (let i = 0; i < period; i++) {
    sumTR += trueRanges[i];
    sumPlusDM += plusDMs[i];
    sumMinusDM += minusDMs[i];
  }
  
  smoothedTR.push(sumTR);
  smoothedPlusDM.push(sumPlusDM);
  smoothedMinusDM.push(sumMinusDM);
  
  for (let i = period; i < trueRanges.length; i++) {
    smoothedTR.push(smoothedTR[smoothedTR.length - 1] - smoothedTR[smoothedTR.length - 1] / period + trueRanges[i]);
    smoothedPlusDM.push(smoothedPlusDM[smoothedPlusDM.length - 1] - smoothedPlusDM[smoothedPlusDM.length - 1] / period + plusDMs[i]);
    smoothedMinusDM.push(smoothedMinusDM[smoothedMinusDM.length - 1] - smoothedMinusDM[smoothedMinusDM.length - 1] / period + minusDMs[i]);
  }
  
  // Calculate +DI and -DI
  const plusDI = [];
  const minusDI = [];
  const dx = [];
  
  for (let i = 0; i < smoothedTR.length; i++) {
    const pdi = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
    const mdi = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
    plusDI.push(pdi);
    minusDI.push(mdi);
    dx.push(Math.abs(pdi - mdi) / (pdi + mdi) * 100);
  }
  
  // Calculate ADX
  const adx = [];
  let sumDX = 0;
  for (let i = 0; i < period; i++) {
    sumDX += dx[i];
  }
  adx.push(sumDX / period);
  
  for (let i = period; i < dx.length; i++) {
    adx.push((adx[adx.length - 1] * (period - 1) + dx[i]) / period);
  }
  
  return { adx, plusDI, minusDI };
}

/**
 * Average True Range
 * @param {number} period - ATR period (default 14)
 * @param {object[]} data - OHLC data array [{high, low, close}]
 * @returns {number[]} ATR values
 */
export function ATR(period, data) {
  if (!data || data.length < period + 1) return [];
  
  const trueRanges = [];
  
  for (let i = 1; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }
  
  // Wilder's smoothing
  const atr = [];
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += trueRanges[i];
  }
  atr.push(sum / period);
  
  for (let i = period; i < trueRanges.length; i++) {
    atr.push((atr[atr.length - 1] * (period - 1) + trueRanges[i]) / period);
  }
  
  return atr;
}

/**
 * Volume Weighted Average Price
 * @param {object[]} data - OHLCV data [{high, low, close, volume}]
 * @returns {number[]} VWAP values
 */
export function VWAP(data) {
  if (!data || data.length === 0) return [];
  
  const vwap = [];
  let cumulativeTPV = 0;  // Typical Price * Volume
  let cumulativeVolume = 0;
  
  for (let i = 0; i < data.length; i++) {
    const typicalPrice = (data[i].high + data[i].low + data[i].close) / 3;
    cumulativeTPV += typicalPrice * data[i].volume;
    cumulativeVolume += data[i].volume;
    
    vwap.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
  }
  
  return vwap;
}

/**
 * Bollinger Bands
 * @param {number} period - Period (default 20)
 * @param {number} std - Standard deviation multiplier (default 2)
 * @param {number[]} data - Price data array
 * @returns {object} { upper, middle, lower, bandwidth, percentB }
 */
export function Bollinger(period, std, data) {
  if (!data || data.length < period) {
    return { upper: [], middle: [], lower: [], bandwidth: [], percentB: [] };
  }
  
  const upper = [];
  const middle = [];
  const lower = [];
  const bandwidth = [];
  const percentB = [];
  
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j];
    }
    const sma = sum / period;
    
    let sumSquares = 0;
    for (let j = 0; j < period; j++) {
      sumSquares += Math.pow(data[i - j] - sma, 2);
    }
    const stdDev = Math.sqrt(sumSquares / period);
    
    const upperBand = sma + std * stdDev;
    const lowerBand = sma - std * stdDev;
    
    middle.push(sma);
    upper.push(upperBand);
    lower.push(lowerBand);
    bandwidth.push(sma > 0 ? (upperBand - lowerBand) / sma * 100 : 0);
    percentB.push(upperBand - lowerBand > 0 ? (data[i] - lowerBand) / (upperBand - lowerBand) : 0.5);
  }
  
  return { upper, middle, lower, bandwidth, percentB };
}

/**
 * Choppiness Index
 * @param {number} period - CHOP period (default 14)
 * @param {object[]} data - OHLC data [{high, low, close}]
 * @returns {number[]} CHOP values (0-100, higher = choppier)
 */
export function CHOP(period, data) {
  if (!data || data.length < period + 1) return [];
  
  const chop = [];
  
  for (let i = period; i < data.length; i++) {
    let sumTR = 0;
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    
    for (let j = 0; j < period; j++) {
      const idx = i - j;
      const high = data[idx].high;
      const low = data[idx].low;
      const prevClose = data[idx - 1].close;
      
      sumTR += Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      
      highestHigh = Math.max(highestHigh, high);
      lowestLow = Math.min(lowestLow, low);
    }
    
    const range = highestHigh - lowestLow;
    if (range > 0 && sumTR > 0) {
      chop.push(100 * Math.log10(sumTR / range) / Math.log10(period));
    } else {
      chop.push(50);
    }
  }
  
  return chop;
}

/**
 * Volume Ratio (current volume vs average)
 * @param {number[]} volumes - Volume data array
 * @param {number} period - Lookback period (default 20)
 * @returns {number[]} Volume ratio values
 */
export function VolumeRatio(volumes, period = 20) {
  if (!volumes || volumes.length < period) return [];
  
  const ratio = [];
  
  for (let i = period; i < volumes.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += volumes[i - j];
    }
    const avg = sum / period;
    ratio.push(avg > 0 ? volumes[i] / avg : 1);
  }
  
  return ratio;
}

/**
 * Composite Oscillator Score
 * Combines RSI, StochRSI, and Fisher with weights
 * @param {number[]} rsi - RSI values
 * @param {number[]} stochRsiK - StochRSI K values
 * @param {number[]} fisherValues - Fisher values
 * @param {object} weights - { rsi, stochRsi, fisher }
 * @returns {number[]} Composite oscillator values (0-100)
 */
export function CompositeOscillator(rsi, stochRsiK, fisherValues, weights = { rsi: 0.4, stochRsi: 0.3, fisher: 0.3 }) {
  // Align arrays to shortest
  const minLen = Math.min(rsi.length, stochRsiK.length, fisherValues.length);
  if (minLen === 0) return [];
  
  const alignedRSI = rsi.slice(-minLen);
  const alignedStochRSI = stochRsiK.slice(-minLen);
  const alignedFisher = fisherValues.slice(-minLen);
  
  const composite = [];
  
  for (let i = 0; i < minLen; i++) {
    // Normalize Fisher to 0-100 range (approximate)
    const fisherNorm = Math.max(0, Math.min(100, (alignedFisher[i] + 3) * (100 / 6)));
    
    const score = (
      alignedRSI[i] * weights.rsi +
      alignedStochRSI[i] * weights.stochRsi +
      fisherNorm * weights.fisher
    );
    
    composite.push(Math.max(0, Math.min(100, score)));
  }
  
  return composite;
}
