#!/bin/bash
# Export trade log and push to GitHub
cd /root/bitget-agent

# Export trade log
python3 << 'PYEOF'
import sqlite3, json

db = sqlite3.connect('data/paper-trades.db')
db.row_factory = sqlite3.Row

logs = db.execute('SELECT * FROM trade_log ORDER BY id').fetchall()
bal = db.execute('SELECT value FROM balance WHERE id = 1').fetchone()
positions = db.execute('SELECT * FROM positions ORDER BY opened_at').fetchall()

report = {
    "generated_at": __import__('datetime').datetime.utcnow().isoformat() + "Z",
    "balance": round(bal['value'], 2),
    "open_positions": len(positions),
    "total_trades": len(logs),
    "trades": []
}

for l in logs:
    report["trades"].append({
        "id": l['id'],
        "timestamp": l['timestamp'],
        "asset": l['asset'],
        "direction": l['direction'],
        "price": round(l['price'], 6),
        "quantity": round(l['quantity'], 6),
        "balance_change": round(l['balance_change'], 2),
        "pnl": round(l['pnl'], 2) if l['pnl'] is not None else None,
        "type": l['type']
    })

with open('trade_log.json', 'w') as f:
    json.dump(report, f, indent=2)

print(f"Exported {len(logs)} trades, balance ${bal['value']:.2f}")
db.close()
PYEOF

# Commit and push
git add trade_log.json
git commit -m "Update trade log - $(date +%Y-%m-%d)"
git push 2>&1 | tail -2
