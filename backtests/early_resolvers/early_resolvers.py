"""
Find Kalshi markets that resolved (closed) before their scheduled expiration date.

Compares close_time vs expiration_time for all determined/closed markets.
Markets are flagged if they closed more than MIN_HOURS_EARLY before their
scheduled expiration_time.
"""

import requests
from datetime import datetime, timezone, timedelta

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"

# Only report markets that closed at least this many hours before schedule
MIN_HOURS_EARLY = 24

def fetch_resolved_markets(status="closed", max_pages=200):
    """Page through all resolved markets and return them."""
    markets = []
    cursor = None
    page = 0

    while page < max_pages:
        params = {"status": status, "limit": 1000}
        if cursor:
            params["cursor"] = cursor

        resp = requests.get(f"{BASE_URL}/markets", params=params)
        resp.raise_for_status()
        data = resp.json()

        batch = data.get("markets", [])
        markets.extend(batch)
        print(f"  Page {page + 1}: fetched {len(batch)} markets (total: {len(markets)})")

        cursor = data.get("cursor")
        if not cursor or not batch:
            break
        page += 1

    return markets


def parse_dt(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def main():
    print("Fetching resolved markets from Kalshi...")
    print("(This may take a while — paging through all results)\n")

    markets = fetch_resolved_markets(status="closed")
    print(f"\nTotal resolved markets fetched: {len(markets)}\n")

    early = []
    for m in markets:
        close_time = parse_dt(m.get("close_time"))
        expiration_time = parse_dt(m.get("expiration_time"))
        expected_expiration_time = parse_dt(m.get("expected_expiration_time"))

        if not close_time or not expiration_time:
            continue

        hours_early = (expiration_time - close_time).total_seconds() / 3600

        if "MENTION" in m.get("ticker", "").upper():
            continue

        if hours_early >= MIN_HOURS_EARLY:
            # Also compute how early vs expected_expiration_time
            hours_vs_expected = None
            if expected_expiration_time:
                hours_vs_expected = (expected_expiration_time - close_time).total_seconds() / 3600

            early.append({
                "ticker": m.get("ticker", ""),
                "title": m.get("title", ""),
                "result": m.get("result", ""),
                "close_time": close_time,
                "expiration_time": expiration_time,
                "expected_expiration_time": expected_expiration_time,
                "hours_early": hours_early,
                "hours_vs_expected": hours_vs_expected,
                "can_close_early": m.get("can_close_early", False),
            })

    # Sort by most early first
    early.sort(key=lambda x: x["hours_early"], reverse=True)

    print(f"Markets that resolved >= {MIN_HOURS_EARLY}h before scheduled expiration: {len(early)}\n")
    print(f"{'Ticker':<55} {'Result':<8} {'Closed':<22} {'Scheduled Expiry':<22} {'Days Early':>10}")
    print("-" * 125)

    for m in early:
        close_str = m["close_time"].strftime("%Y-%m-%d %H:%M UTC")
        exp_str = m["expiration_time"].strftime("%Y-%m-%d %H:%M UTC")
        days_early = m["hours_early"] / 24
        ticker = m["ticker"][:54]
        print(f"{ticker:<55} {m['result']:<8} {close_str:<22} {exp_str:<22} {days_early:>9.1f}d")

    if early:
        print(f"\n--- Top 20 most interesting (largest gap) ---")
        for m in early[:20]:
            days_early = m["hours_early"] / 24
            print(f"\nTicker:    {m['ticker']}")
            print(f"Title:     {m['title']}")
            print(f"Result:    {m['result']}")
            print(f"Closed:    {m['close_time'].strftime('%Y-%m-%d %H:%M UTC')}")
            print(f"Scheduled: {m['expiration_time'].strftime('%Y-%m-%d %H:%M UTC')}")
            if m["expected_expiration_time"]:
                print(f"Expected:  {m['expected_expiration_time'].strftime('%Y-%m-%d %H:%M UTC')}")
            print(f"Days early: {days_early:.1f}")


if __name__ == "__main__":
    main()
