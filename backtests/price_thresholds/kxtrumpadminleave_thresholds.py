"""
For each threshold, find the last individual trade in the band just below it
(i.e. the last trade before the price crossed each threshold) for
selected candidates in the KXTRUMPADMINLEAVE-26DEC31 Kalshi market.

Candidates requested: Dan Bongino, Kristi Noem, Pam Bondi, David Sacks, Greg Bovino
Note: Dan Bongino and Greg Bovino are not listed as candidates in this market.
"""

import requests
from datetime import datetime
from zoneinfo import ZoneInfo

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
API_KEY  = "75d926ae-dfa2-45a7-965e-267335570aab"
ET       = ZoneInfo("America/New_York")

THRESHOLDS = [30, 40, 50, 60, 70, 80, 90, 95]

CANDIDATES = {
    "Pam Bondi":   "KXTRUMPADMINLEAVE-26DEC31-PBON",
    "Kristi Noem": "KXTRUMPADMINLEAVE-26DEC31-KNOE",
    "David Sacks": "KXTRUMPADMINLEAVE-26DEC31-DSAC",
    "Dan Bongino": None,   # not in this market
    "Greg Bovino": None,   # not in this market
}


def fetch_all_trades(ticker):
    """Fetch all trades for a ticker, returned in chronological order."""
    trades = []
    cursor = None
    headers = {"Authorization": API_KEY}
    while True:
        params = {"ticker": ticker, "limit": 1000}
        if cursor:
            params["cursor"] = cursor
        resp = requests.get(f"{BASE_URL}/markets/trades", params=params, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        batch = data.get("trades", [])
        trades.extend(batch)
        cursor = data.get("cursor")
        if not cursor or not batch:
            break
    trades.sort(key=lambda t: t["created_time"])
    return trades


def find_thresholds(trades):
    """For each threshold T, return the last trade with price < T before the
    price first crossed T. This is the final moment the market was below each
    level, even if the price jumped over multiple thresholds at once.
    """
    results = {}
    for th in THRESHOLDS:
        # Find where this threshold is first crossed
        first_cross_idx = None
        for j, trade in enumerate(trades):
            if round(float(trade["yes_price_dollars"]) * 100) >= th:
                first_cross_idx = j
                break

        if first_cross_idx is None:
            results[th] = None
            continue

        # Last trade with price < th before the crossing
        last_below = None
        for trade in trades[:first_cross_idx]:
            if round(float(trade["yes_price_dollars"]) * 100) < th:
                last_below = trade

        if last_below is None:
            results[th] = None
            continue

        dt = datetime.fromisoformat(
            last_below["created_time"].replace("Z", "+00:00")
        ).astimezone(ET)
        results[th] = {"time": dt, "price": round(float(last_below["yes_price_dollars"]) * 100)}
    return results


def fmt_time(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S %Z") if dt else "—"


def main():
    all_results = {}

    for name, ticker in CANDIDATES.items():
        print(f"\n{'='*60}")
        print(f"{name} → {ticker or 'not in market'}")
        print(f"{'='*60}")

        if ticker is None:
            print("  SKIPPED — not listed as a candidate in KXTRUMPADMINLEAVE-26DEC31")
            all_results[name] = None
            continue

        print(f"  Fetching trades for {ticker}...")
        trades = fetch_all_trades(ticker)
        print(f"  Total trades: {len(trades)}")

        if not trades:
            print("  No trades found.")
            all_results[name] = {}
            continue

        first_t = datetime.fromisoformat(trades[0]["created_time"].replace("Z", "+00:00")).astimezone(ET)
        last_t  = datetime.fromisoformat(trades[-1]["created_time"].replace("Z", "+00:00")).astimezone(ET)
        print(f"  Trade range: {fmt_time(first_t)} → {fmt_time(last_t)}")

        hits = find_thresholds(trades)
        all_results[name] = hits

        print(f"\n  {'Threshold':>10}  {'First trade at':<30}  {'Price':>7}")
        print(f"  {'-'*10}  {'-'*30}  {'-'*7}")
        for th in THRESHOLDS:
            hit = hits[th]
            if hit:
                print(f"  {th:>9}¢  {fmt_time(hit['time']):<30}  {hit['price']:>6}¢")
            else:
                print(f"  {th:>9}¢  {'— never reached':<30}")

    # Summary table
    print("\n\n" + "=" * 130)
    print("SUMMARY TABLE — First trade crossing each threshold (ET)")
    print("=" * 130)
    header = f"{'Candidate':<16}" + "".join(f"  {''+str(th)+'¢':>22}" for th in THRESHOLDS)
    print(header)
    print("-" * 130)
    for name, hits in all_results.items():
        row = f"{name:<16}"
        if hits is None:
            row += "  (not in market)"
        else:
            for th in THRESHOLDS:
                hit = hits.get(th)
                val = hit["time"].strftime("%m-%d %H:%M:%S") if hit else "—"
                row += f"  {val:>22}"
        print(row)


if __name__ == "__main__":
    main()
