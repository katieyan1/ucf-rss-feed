import requests
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime, timezone

TICKER = "KXTRUMPADMINLEAVE-26DEC31-PBON"  # Pam Bondi
BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"

# April 1st–2nd, 2026 UTC window
start = datetime(2026, 4, 1, 0, 0, 0, tzinfo=timezone.utc)
end = datetime(2026, 4, 2, 23, 59, 59, tzinfo=timezone.utc)

min_ts = int(start.timestamp())
max_ts = int(end.timestamp())

def fetch_candlesticks():
    candles = []
    resp = requests.get(
        f"{BASE_URL}/series/KXTRUMPADMINLEAVE/markets/{TICKER}/candlesticks",
        params={"start_ts": min_ts, "end_ts": max_ts, "period_interval": 1},
    )
    resp.raise_for_status()
    return resp.json().get("candlesticks", [])

def fetch_trades():
    trades = []
    cursor = None

    while True:
        params = {
            "ticker": TICKER,
            "min_ts": min_ts,
            "max_ts": max_ts,
            "limit": 1000,
        }
        if cursor:
            params["cursor"] = cursor

        resp = requests.get(f"{BASE_URL}/markets/trades", params=params)
        resp.raise_for_status()
        data = resp.json()

        batch = data.get("trades", [])
        trades.extend(batch)
        print(f"Fetched {len(batch)} trades (total so far: {len(trades)})")

        cursor = data.get("cursor")
        if not cursor or not batch:
            break

    return trades

if __name__ == "__main__":
    print(f"Fetching trades for {TICKER} on April 1st–2nd, 2026...")
    trades = fetch_trades()
    trades.sort(key=lambda t: t["created_time"])
    print(f"\nTotal trades: {len(trades)}\n")
    print(f"{'Time (ET)':<32} {'Side':<6} {'Contracts':>10} {'Yes Price':>10} {'No Price':>10}")
    print("-" * 72)
    from zoneinfo import ZoneInfo
    eastern = ZoneInfo("America/New_York")
    for t in trades:
        if float(t["yes_price_dollars"]) > 0.95:
            continue
        dt = datetime.fromisoformat(t["created_time"].replace("Z", "+00:00")).astimezone(eastern)
        time = dt.strftime("%Y-%m-%d %H:%M:%S.%f %Z")
        print(f"{time:<32} {t['taker_side']:<6} {float(t['count_fp']):>10.0f} {float(t['yes_price_dollars']):>9.2f}  {float(t['no_price_dollars']):>9.2f}")

    # Graph yes price over time
    from zoneinfo import ZoneInfo
    eastern = ZoneInfo("America/New_York")
    times = [datetime.fromisoformat(t["created_time"].replace("Z", "+00:00")).astimezone(eastern) for t in trades]
    yes_prices = [float(t["yes_price_dollars"]) for t in trades]
    sizes = [float(t["count_fp"]) for t in trades]

    fig, ax = plt.subplots(figsize=(14, 5))
    ax.scatter(times, yes_prices, s=[s * 2 for s in sizes], alpha=0.5, color="steelblue", zorder=3)
    ax.plot(times, yes_prices, color="steelblue", linewidth=0.8, alpha=0.4)

    ax.xaxis.set_major_formatter(mdates.DateFormatter("%-I%p", tz=eastern))
    ax.xaxis.set_major_locator(mdates.HourLocator(interval=2))
    fig.autofmt_xdate()

    ax.set_title("Pam Bondi — Kalshi Yes Price on April 1st–2nd, 2026", fontsize=13)
    ax.set_xlabel("Time (ET)")
    ax.set_ylabel("Yes Price ($)")
    ax.set_ylim(0, 1)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f"${y:.2f}"))
    ax.grid(axis="y", linestyle="--", alpha=0.5)

    plt.tight_layout()
    plt.savefig("pambondi.png", dpi=150)
    print("\nChart saved to pambondi.png")

    # Graph bid/ask over time
    print("Fetching candlesticks...")
    candles = fetch_candlesticks()
    print(f"Fetched {len(candles)} candlesticks")

    candle_times = [datetime.fromtimestamp(c["end_period_ts"], tz=timezone.utc).astimezone(eastern) for c in candles]
    bids = [float(c["yes_bid"]["close_dollars"]) for c in candles]
    asks = [float(c["yes_ask"]["close_dollars"]) for c in candles]

    fig2, ax2 = plt.subplots(figsize=(14, 5))
    ax2.plot(candle_times, bids, color="steelblue", linewidth=1, label="Best Bid")
    ax2.plot(candle_times, asks, color="tomato", linewidth=1, label="Best Ask")
    ax2.fill_between(candle_times, bids, asks, alpha=0.15, color="gray", label="Spread")

    ax2.xaxis.set_major_formatter(mdates.DateFormatter("%-I%p", tz=eastern))
    ax2.xaxis.set_major_locator(mdates.HourLocator(interval=2))
    fig2.autofmt_xdate()

    ax2.set_title("Pam Bondi — Kalshi Resting Bid/Ask on April 1st–2nd, 2026", fontsize=13)
    ax2.set_xlabel("Time (ET)")
    ax2.set_ylabel("Yes Price ($)")
    ax2.set_ylim(0, 1)
    ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda y, _: f"${y:.2f}"))
    ax2.grid(axis="y", linestyle="--", alpha=0.5)
    ax2.legend()

    plt.tight_layout()
    plt.savefig("pambondi_bidask.png", dpi=150)
    print("Chart saved to pambondi_bidask.png")
