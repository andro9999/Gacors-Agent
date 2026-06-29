/**
 * LLM Gate — Second opinion via local LLM (9Router)
 *
 * - Builds compact technical snapshot prompt
 * - Calls localhost:20128/v1 (xmtp/mimo-v2.5-pro)
 * - Parses: yes/no + confidence (0-1) + rationale
 * - Cache with TTL 300s
 * - Bypass if score >= 13
 */

import axios from 'axios';

// ─── Cache ─────────────────────────────────────────────────────────────────────

const cache = new Map();
const CACHE_TTL = 300_000; // 300s

function getCached(symbol, side) {
  const key = `${symbol}:${side}`;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(symbol, side, result) {
  const key = `${symbol}:${side}`;
  cache.set(key, {
    result,
    expiresAt: Date.now() + CACHE_TTL,
  });
}

// ─── Prompt Builder ────────────────────────────────────────────────────────────

function buildPrompt(candidate, indicators) {
  const {
    symbol = 'UNKNOWN',
    side = 'long',
    priceChangePct = 0,
    score = 0,
  } = candidate;

  const {
    RSI = 50,
    MACD_hist = 0,
    ADX = 0,
    DI_plus = 0,
    DI_minus = 0,
    EMA9 = 0,
    EMA21 = 0,
    volumeRatio = 0,
    OI_change_pct = 0,
    fundingRate = 0,
    stochRSI_K = 0,
    ATR = 0,
    price = 0,
    bbSqueeze = false,
    choppiness = 0,
    trend_4h = 'neutral',
    takerBuyRatio = 0.5,
    topTraderBias = 'neutral',
  } = indicators;

  const atrPct = price > 0 ? ((ATR / price) * 100).toFixed(2) : 'N/A';

  return `You are a 10x leverage futures trading bot. Reply ONLY in JSON:
{"decision":"yes|no","confidence":0.0-1.0,"rationale":"brief reason"}

RULES:
- Score ≥45 = already filtered by 16 technical layers
- We trade 10x leverage with tight SL (ATR-based)
- We want QUICK MOMENTUM entries, not perfect setups
- A score of 50-65 is NORMAL and ACCEPTABLE
- Only say "no" if there's a CLEAR reason (RSI >80, trend reversal, etc.)
- Do NOT reject for "weak momentum" - momentum is always relative

SETUP: ${symbol} ${side.toUpperCase()}
Score: ${score}/100 | Price Δ: ${priceChangePct.toFixed(2)}%

TECHNICALS (15m):
- RSI: ${RSI.toFixed(1)} | StochRSI: ${stochRSI_K.toFixed(1)}
- MACD hist: ${MACD_hist.toFixed(6)} | ADX: ${ADX.toFixed(1)} (DI+: ${DI_plus.toFixed(1)} / DI-: ${DI_minus.toFixed(1)})
- EMA9: ${EMA9.toFixed(6)} | EMA21: ${EMA21.toFixed(6)} | ${EMA9 > EMA21 ? 'BULL STACK' : 'BEAR STACK'}
- 4H trend: ${trend_4h}

VOLUME/POSITIONING:
- Volume ratio: ${volumeRatio.toFixed(2)}x | Taker buy: ${(takerBuyRatio * 100).toFixed(1)}%
- OI change: ${OI_change_pct.toFixed(2)}% | Funding: ${(fundingRate * 100).toFixed(4)}%
- Top trader bias: ${topTraderBias}
- BB squeeze: ${bbSqueeze ? 'YES' : 'no'} | Choppiness: ${choppiness.toFixed(1)}
- ATR%: ${atrPct}%

Is this a good ${side} entry for a 10x leverage scalp? Only say no if clearly bad.`;
}

// ─── Response Parser ───────────────────────────────────────────────────────────

function parseResponse(text) {
  if (!text) {
    return { decision: 'no', confidence: 0, rationale: 'empty LLM response' };
  }

  // Try JSON parse first
  try {
    // Extract JSON from potential markdown code block
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        decision: parsed.decision === 'yes' ? 'yes' : 'no',
        confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0)),
        rationale: String(parsed.rationale || '').slice(0, 500),
      };
    }
  } catch {
    // Fall through to text parsing
  }

  // Fallback: text parsing
  const lower = text.toLowerCase();
  const hasYes = /\byes\b/.test(lower) || /\bbuy\b/.test(lower) || /\bgo long\b/.test(lower) || /\btake.*trade\b/.test(lower);
  const hasNo = /\bno\b/.test(lower) || /\bavoid\b/.test(lower) || /\bskip\b/.test(lower) || /\bpass\b/.test(lower);

  let decision = 'no';
  if (hasYes && !hasNo) decision = 'yes';
  else if (hasNo && !hasYes) decision = 'no';
  else decision = 'no'; // ambiguous = no

  // Extract confidence if mentioned (e.g., "confidence: 0.7")
  const confMatch = text.match(/confidence[:\s]*(\d+\.?\d*)/i);
  const confidence = confMatch ? Math.min(1, parseFloat(confMatch[1]) || 0.5) : 0.5;

  return {
    decision,
    confidence,
    rationale: text.slice(0, 500),
  };
}

// ─── LLM Call ──────────────────────────────────────────────────────────────────

async function callLLM(prompt, config) {
  const endpoint = config?.LLM?.ENDPOINT 
    ? `${config.LLM.ENDPOINT}/chat/completions`
    : 'http://localhost:20128/v1/chat/completions';
  const model = config?.LLM?.MODEL ?? 'deepseek-v3.2';
  const timeout = config?.LLM?.TIMEOUT_MS ?? 15000;

  const apiKey = config?.LLM?.API_KEY ?? '';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await axios.post(endpoint, {
    model,
    messages: [
      { role: 'system', content: 'You are a quantitative trading analyst. Be concise. Reply only in the requested JSON format.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 300,
  }, {
    timeout,
    headers,
  });

  const content = response?.data?.choices?.[0]?.message?.content ?? '';
  return parseResponse(content);
}

// ─── Main Entry ────────────────────────────────────────────────────────────────

/**
 * LLM second opinion gate.
 * Bypassed if score >= 13. Results cached for 300s.
 * @param {Object} candidate - { symbol, side, score, priceChangePct, ... }
 * @param {Object} indicators - full indicator set
 * @param {Object} config - { LLM_ENDPOINT, LLM_MODEL, LLM_TIMEOUT_MS, ... }
 * @returns {Promise<{ approved: boolean, confidence: number, rationale: string, bypassed: boolean, cached: boolean }>}
 */
export async function llmGate(candidate, indicators, config) {
  // Bypass for high-confidence signals
  const bypassThreshold = config?.LLM?.BYPASS_SCORE ?? 13;
  if ((candidate.score ?? 0) >= bypassThreshold) {
    return {
      approved: true,
      confidence: 1.0,
      rationale: `score ${candidate.score} >= ${bypassThreshold}, LLM bypassed`,
      bypassed: true,
      cached: false,
    };
  }

  // Check cache
  const cached = getCached(candidate.symbol, candidate.side);
  if (cached) {
    return { ...cached, cached: true };
  }

  // Build prompt and call LLM
  const prompt = buildPrompt(candidate, indicators);

  let result;
  try {
    result = await callLLM(prompt, config);
  } catch (err) {
    // On failure, REJECT — fail-closed is safer for live trading
    const fallback = {
      approved: false,
      confidence: 0,
      rationale: `LLM call failed (${err.message}), rejecting (fail-closed)`,
      bypassed: false,
      cached: false,
    };
    return fallback;
  }

  const output = {
    approved: result.decision === 'yes',
    confidence: result.confidence,
    rationale: result.rationale,
    bypassed: false,
    cached: false,
  };

  setCache(candidate.symbol, candidate.side, output);

  return output;
}

/**
 * Clear the LLM cache (useful for testing).
 */
export function clearLLMCache() {
  cache.clear();
}
