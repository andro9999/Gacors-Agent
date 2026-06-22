# Gacors Agent

AI-powered autonomous trading agent for Bitget USDT perpetual futures.

## Architecture

```mermaid
flowchart TD
    A["SCAN - Every 5 Minutes"] --> B["INDICATORS"]
    B --> C["FILTER CHAIN"]
    C --> D["SCORING"]
    D --> E["RANKING"]
    E --> F["LLM GATE"]
    F --> G["EXECUTE"]
    G --> H["MONITOR"]
    H --> I["TELEGRAM"]

    A -->|"Bitget API"| A1["649 USDT Pairs"]
    A -->|"EMA9/21 3TF"| A2["BTC Regime Detection"]

    B -->|"15m + 1H + 4H"| B1["RSI, MACD, EMA, ADX, ATR, VWAP, Bollinger, StochRSI"]

    C --> C1["6 Critical Filters"]
    C --> C2["4 Soft Filters"]
    C1 --> C1a["Volume >= 0.3x"]
    C1 --> C1b["EMA Aligned"]
    C1 --> C1c["MACD Aligned"]
    C1 --> C1d["RSI Guard"]
    C1 --> C1e["ADX >= 18"]
    C1 --> C1f["4H Aligned"]

    D --> D1["Trend 0-25"]
    D --> D2["Momentum 0-25"]
    D --> D3["Volume 0-20"]
    D --> D4["Structure 0-15"]
    D --> D5["Bonus 0-15"]
    D --> D6["Min Score 45/100"]

    E --> E1["Sort by Score - Highest First"]

    F --> F1["DeepSeek V3.2"]
    F --> F2["Score >= 55 = Auto Approve"]

    G --> G1["Size = Balance / Max Positions"]
    G --> G2["SL = ATR x 1.8"]
    G --> G3["TP1 = ATR x 1.5 - 25%"]
    G --> G4["TP2 = ATR x 2.5 - 25%"]
    G --> G5["TP3 = ATR x 4.0 - 50% Trailing"]

    H --> H1["Breakeven at +1.5%"]
    H --> H2["Trailing at +2.0%"]
    H --> H3["Hard Stop at -6%"]

    I --> I1["Commands: status, positions, pnl, risk"]
    I --> I2["Auto Alerts: Entry, TP, SL, Breakeven"]

    style A fill:#e1f5fe
    style B fill:#e8f5e9
    style C fill:#fff3e0
    style D fill:#fce4ec
    style E fill:#f3e5f5
    style F fill:#e8eaf6
    style G fill:#e0f2f1
    style H fill:#fff8e1
    style I fill:#fbe9e7
```

## Quick Start

```bash
git clone https://github.com/andro9999/Gacors-Agent.git
cd Gacors-Agent
npm install
cp .env.example .env
TRADING_MODE=paper node index.js
```

## Configuration

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TRADING_MODE=paper
```

## Features

| Component | Description |
|-----------|-------------|
| Filter Chain | 16 layers: 6 critical + 4 soft |
| Scoring | 0-100: Trend + Momentum + Volume + Structure + Bonus |
| LLM Gate | DeepSeek V3.2, bypass at score 55+ |
| SL/TP | ATR-adaptive: SL 1.8x, TP1 1.5x, TP2 2.5x, TP3 4.0x |
| Monitor | Breakeven +1.5%, trailing +2%, hard stop -6% |
| Telegram | Commands + auto notifications |
| Paper Trading | SQLite, dynamic position sizing |

## Scoring

| Component | Max | Measures |
|-----------|-----|----------|
| Trend | 25 | EMA, ADX, DI, 4H |
| Momentum | 25 | RSI, MACD, StochRSI, Fisher |
| Volume | 20 | Volume ratio, taker bias |
| Structure | 15 | Bollinger, VWAP, choppiness |
| Bonus | 15 | Confluence, squeeze, funding |

## Tech Stack

- Node.js 22+ / SQLite / Bitget API v2 / DeepSeek V3.2 / Telegram Bot

## License

MIT
