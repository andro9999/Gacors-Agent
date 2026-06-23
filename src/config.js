// Bitget Trading Agent Configuration
// All parameters from the strategy spec

export const CONFIG = {
  // ─── BITGET API ──────────────────────────────────────────────────────
  BITGET: {
    BASE_URL: 'https://api.bitget.com',
    WS_URL: 'wss://ws.bitget.com/mix/v1/stream',
    API_KEY: process.env.BITGET_API_KEY || '',
    SECRET_KEY: process.env.BITGET_SECRET_KEY || '',
    PASSPHRASE: process.env.BITGET_PASSPHRASE || '',
    PRODUCT_TYPE: 'USDT-FUTURES',
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
  },

  // ─── TELEGRAM ────────────────────────────────────────────────────────
  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    ENABLED: true
  },

  // ─── LLM GATE ────────────────────────────────────────────────────────
  LLM: {
    ENDPOINT: 'http://localhost:20128/v1',
    MODEL: 'deepseek-v3.2',
    CONFIDENCE_THRESHOLD: 0.3,
    CONFIDENCE_LONG: 0.35,
    BYPASS_SCORE: 80,
    MAX_TOKENS: 512,
    TEMPERATURE: 0.1,
    TIMEOUT_MS: 15000
  },

  // ─── BTC REGIME ──────────────────────────────────────────────────────
  BTC_REGIME: {
    SYMBOL: 'BTCUSDT',
    EMA_FAST: 9,
    EMA_SLOW: 21,
    VOTING_THRESHOLD: 2,    // 2/3 votes needed
    VOTING_TOTAL: 3,
    TIMEFRAMES: ['1H', '4H', '1D']
  },

  // ─── FILTER CHAIN ────────────────────────────────────────────────────
  FILTERS: {
    CHASE_LIMIT_PCT: 3.5,           // Max chase from current price
    VOLUME_RATIO_MIN: 1.5,          // Min volume vs 20-period avg
    RSI_OVERBOUGHT: 75,             // RSI upper guard
    RSI_OVERSOLD: 25,               // RSI lower guard
    RSI_LONG_MIN: 40,               // Min RSI for long entries
    RSI_SHORT_MAX: 60,              // Max RSI for short entries
    MACD_CONFIRM: true,             // Require MACD direction match
    EMA_TREND_CONFIRM: true,        // Require EMA trend alignment
    FOUR_H_ALIGNMENT: true,         // Require 4H timeframe alignment
    VWAP_FILTER: true,              // Price vs VWAP filter
    ADX_MIN: 20,                    // Minimum ADX for trend strength
    CHOP_MAX: 60,                   // Maximum Choppiness Index
    BOLLINGER_FILTER: true          // Bollinger Band position filter
  },

  // ─── SCORING ─────────────────────────────────────────────────────────
  SCORING: {
    MIN_SCORE_NORMAL: 50,
    MIN_SCORE_LONG: 55,
    MIN_SCORE_SHORT_BEAR: 45,
    BONUS_GATE: 5,
    WEIGHTS: {
      RSI: 1,
      MACD: 1,
      EMA_TREND: 1,
      FOUR_H: 1,
      VWAP: 1,
      ADX: 1,
      CHOP: 1,
      VOLUME: 1,
      BOLLINGER: 1,
      LLM: 2,
      BTC_REGIME: 2
    }
  },

  // ─── COMPOSITE OSCILLATOR ────────────────────────────────────────────
  OSCILLATOR: {
    RSI_WEIGHT: 0.40,
    STOCHRSI_WEIGHT: 0.30,
    FISHER_WEIGHT: 0.30,
    RSI_PERIOD: 14,
    STOCHRSI_PERIOD: 14,
    STOCHRSI_K: 3,
    STOCHRSI_D: 3,
    FISHER_PERIOD: 10
  },

  // ─── VOLUME TAKER ────────────────────────────────────────────────────
  VOLUME_TAKER: {
    BUY_RATIO_THRESHOLD: 1.3,       // Taker buy/sell ratio for long
    SELL_RATIO_THRESHOLD: 0.7,      // Taker buy/sell ratio for short
    MIN_VOLUME_USDT: 500000,        // Min 24h volume in USDT
    VOLUME_SPIKE_MULT: 2.0,         // Volume spike detection
    LOOKBACK_PERIODS: 20            // Periods for volume average
  },

  // ─── INDICATOR PERIODS ───────────────────────────────────────────────
  INDICATORS: {
    EMA_FAST: 9,
    EMA_SLOW: 21,
    EMA_TREND: 50,
    RSI_PERIOD: 14,
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,
    STOCHRSI_PERIOD: 14,
    STOCHRSI_K: 3,
    STOCHRSI_D: 3,
    FISHER_PERIOD: 10,
    ADX_PERIOD: 14,
    ATR_PERIOD: 14,
    BOLLINGER_PERIOD: 20,
    BOLLINGER_STD: 2,
    CHOP_PERIOD: 14,
    VWAP_PERIOD: 1
  },

  // ─── ATR SL/TP ──────────────────────────────────────────────────────
  RISK: {
    SL_ATR_MULT: 1.5,
    SL_ATR_MULT_LONG: 1.8,
    TP_ATR_MULT: 3.0,
    HARD_STOP_PCT: 6.0,             // Absolute max loss per trade
    DAILY_LOSS_PCT: 4.0,            // Max daily portfolio loss
    TRAILING_STOP_ENABLED: true,
    TRAILING_STOP_ATR: 1.0,
    BREAKEVEN_ATR: 1.0              // Move SL to breakeven after 1 ATR
  },

  // ─── POSITION MANAGEMENT ─────────────────────────────────────────────
  POSITIONS: {
    MAX_OPEN: 10,
    MAX_SAME_DIRECTION: 7,
    MAX_CORRELATED: 3,
    LEVERAGE: 10,
    POSITION_SIZE_PCT: 10.0,        // % of balance per trade ($1000 of $10000)
    MAX_POSITION_SIZE_PCT: 10.0,    // Max single position size
    SCALP_SIZE_PCT: 1.0,            // Smaller size for scalps
    COOLDOWN_MS: 600000             // 10 min between trades same pair
  },

  // ─── CLUSTER LIMITS ──────────────────────────────────────────────────
  CLUSTERS: {
    CRYPTO_RISK_ON: {
      MAX_POSITIONS: 2,
      SYMBOLS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'LINKUSDT']
    },
    MEME: {
      MAX_POSITIONS: 1,
      SYMBOLS: ['DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'WIFUSDT', 'BONKUSDT']
    },
    EQUITY: {
      MAX_POSITIONS: 2,
      SYMBOLS: ['NVDAUSDT', 'TSLAUSDT', 'AAPLUSDT', 'MSFTUSDT', 'GOOGUSDT']
    },
    DEFI: {
      MAX_POSITIONS: 2,
      SYMBOLS: ['UNIUSDT', 'AAVEUSDT', 'MKRUSDT', 'COMPUSDT', 'SNXUSDT']
    },
    L1: {
      MAX_POSITIONS: 2,
      SYMBOLS: ['ADAUSDT', 'DOTUSDT', 'ATOMUSDT', 'NEARUSDT', 'APTUSDT']
    }
  },

  // ─── PAPER TRADING ───────────────────────────────────────────────────
  PAPER: {
    INITIAL_BALANCE: 10000,
    ENABLED: true,
    SLIPPAGE_BPS: 5,                // 0.05% simulated slippage
    FEE_RATE: 0.0006,               // 0.06% taker fee
    DB_PATH: './data/paper_trades.db'
  },

  // ─── TIMEFRAMES ──────────────────────────────────────────────────────
  TIMEFRAMES: {
    PRIMARY: '1H',
    SECONDARY: '4H',
    ENTRY: '15m',
    REGIME: '1D',
    KLINES_LIMIT: 200               // Number of candles to fetch
  },

  // ─── STRATEGY MODES ──────────────────────────────────────────────────
  MODES: {
    SCALP: {
      ENABLED: true,
      MIN_SCORE: 7,
      TP_ATR_MULT: 1.5,
      SL_ATR_MULT: 1.0,
      MAX_HOLD_MINUTES: 60
    },
    SWING: {
      ENABLED: true,
      MIN_SCORE: 8,
      TP_ATR_MULT: 3.0,
      SL_ATR_MULT: 1.5,
      MAX_HOLD_HOURS: 48
    },
    POSITION: {
      ENABLED: false,
      MIN_SCORE: 10,
      TP_ATR_MULT: 5.0,
      SL_ATR_MULT: 2.0,
      MAX_HOLD_DAYS: 14
    }
  },

  // ─── MARKET HOURS ────────────────────────────────────────────────────
  MARKET: {
    CRYPTO_24_7: true,
    EQUITY_HOURS: {
      START: '09:30',
      END: '16:00',
      TIMEZONE: 'America/New_York'
    },
    LOW_LIQUIDITY_HOURS: [0, 1, 2, 3, 4, 5] // UTC hours to avoid
  },

  // ─── LOGGING ─────────────────────────────────────────────────────────
  LOGGING: {
    LEVEL: 'info',
    FILE: './logs/trading.log',
    MAX_SIZE_MB: 50,
    MAX_FILES: 5,
    CONSOLE: true
  }
};

// Export individual sections for convenience
export const {
  BITGET,
  TELEGRAM,
  LLM,
  BTC_REGIME,
  FILTERS,
  SCORING,
  OSCILLATOR,
  VOLUME_TAKER,
  INDICATORS,
  RISK,
  POSITIONS,
  CLUSTERS,
  PAPER,
  TIMEFRAMES,
  MODES,
  MARKET,
  LOGGING
} = CONFIG;
