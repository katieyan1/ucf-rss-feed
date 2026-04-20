"""
For each market in manual_market_data.csv, find the first time the YES price
crossed each of the thresholds: 30, 40, 50, 60, 70, 80, 90, 95 cents.

Ticker mapping was resolved manually from the market_link URLs in the CSV by
querying the Kalshi API for sub-markets within each event.
"""

import csv
import requests
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
THRESHOLDS = [30, 40, 50, 60, 70, 80, 90, 95]
ET = ZoneInfo("America/New_York")

# Mapping: article_id → actual Kalshi market ticker
# article_id "" means no article_id in the CSV (second row for same event)
TICKER_MAP = {
    "cnn-pambundifired":             "KXBONDIOUT-26APR03",
    "wsj-anthropicsecurityrisk":     "KXANTHROPICRISK-26APR01",
    "sfchron-swalwelldropout":       "KXDROPOUTPRIMARY-26-KPAX",
    "guardian-samaltmanreturns":     None,   # OPENAICEO-24-SA — not in current API
    "npr-kristinoemfired":           "KXNOEMOUT-26APR01",
    "guardian-lindayaccarinostepsdown": None, # KXXCEOCHANGE — not in current API
    "nytimes-upennpresidentresigns": None,   # UNIPRESIDENT-24DEC31-PENN — not in current API
    "nytimes-harvardpresidentresigns": None, # UNIPRESIDENT-24DEC31-HARVARD — not in current API
    "guardian-firstnueralink":       None,   # NEURALINK-24JUN30 — not in current API
    "nytimes-powellfire":            "KXTRYFIREPOWELL-26MAY12-JUN01",
    "nytimes-metalayoffs":           "KXMETAHEADCOUNT-26JUL-81000",
    # Second kxdropoutprimary row (Swalwell article, no article_id)
    "_swalwell_cnn":                 "KXDROPOUTPRIMARY-26-ESWA",
}


def fetch_all_trades(ticker):
    """Fetch all trades for a ticker, returning them in chronological order."""
    trades = []
    cursor = None
    while True:
        params = {"ticker": ticker, "limit": 1000}
        if cursor:
            params["cursor"] = cursor
        resp = requests.get(f"{BASE_URL}/markets/trades", params=params)
        resp.raise_for_status()
        data = resp.json()
        batch = data.get("trades", [])
        trades.extend(batch)
        cursor = data.get("cursor")
        if not cursor or not batch:
            break
    # API returns newest-first; reverse for chronological
    trades.sort(key=lambda t: t["created_time"])
    return trades


def find_thresholds(trades, thresholds):
    """For each threshold, find the first trade where yes_price >= threshold/100."""
    results = {}
    remaining = set(thresholds)
    for trade in trades:
        price_cents = round(float(trade["yes_price_dollars"]) * 100)
        for th in list(remaining):
            if price_cents >= th:
                dt = datetime.fromisoformat(
                    trade["created_time"].replace("Z", "+00:00")
                ).astimezone(ET)
                results[th] = {
                    "time": dt.strftime("%Y-%m-%d %H:%M:%S %Z"),
                    "price": price_cents,
                }
                remaining.discard(th)
        if not remaining:
            break
    for th in remaining:
        results[th] = None
    return results


def parse_csv(path):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


def main():
    csv_path = "manual_market_data.csv"
    rows = parse_csv(csv_path)

    # Build the list of (label, article_timestamp, ticker) to process
    markets_to_run = []
    seen_swalwell = False
    for row in rows:
        article_id = row.get("article_id", "").strip()
        article_ts = row.get("timestamp (ET)", "").strip()
        market_title = row.get("market_title", "").strip()

        if not article_id:
            # Second kxdropoutprimary row (Swalwell CNN story)
            if not seen_swalwell and "Ken Paxton" not in market_title:
                ticker = TICKER_MAP["_swalwell_cnn"]
                label = "CNN Swalwell story → KXDROPOUTPRIMARY-26-ESWA"
                markets_to_run.append((label, article_ts, ticker))
                seen_swalwell = True
            continue

        ticker = TICKER_MAP.get(article_id)
        label = f"{article_id} → {ticker or 'N/A'}"
        markets_to_run.append((label, article_ts, ticker))

    print(f"Processing {len(markets_to_run)} markets\n")
    print("=" * 100)

    all_results = []
    for label, article_ts, ticker in markets_to_run:
        print(f"\n{label}")
        print(f"  Article timestamp: {article_ts}")

        if ticker is None:
            print("  SKIPPED — ticker not available in current Kalshi API")
            all_results.append((label, article_ts, ticker, None))
            continue

        print(f"  Fetching trades for {ticker}...")
        try:
            trades = fetch_all_trades(ticker)
        except Exception as e:
            print(f"  ERROR: {e}")
            all_results.append((label, article_ts, ticker, None))
            continue

        print(f"  Total trades: {len(trades)}")

        if not trades:
            print("  No trades found.")
            all_results.append((label, article_ts, ticker, {}))
            continue

        first_trade_time = datetime.fromisoformat(
            trades[0]["created_time"].replace("Z", "+00:00")
        ).astimezone(ET)
        last_trade_time = datetime.fromisoformat(
            trades[-1]["created_time"].replace("Z", "+00:00")
        ).astimezone(ET)
        print(f"  Trade range: {first_trade_time.strftime('%Y-%m-%d %H:%M %Z')} → "
              f"{last_trade_time.strftime('%Y-%m-%d %H:%M %Z')}")

        threshold_hits = find_thresholds(trades, THRESHOLDS)
        all_results.append((label, article_ts, ticker, threshold_hits))

        print(f"  {'Threshold':>10}  {'First crossed at':<28}  {'Price at crossing':>18}")
        print(f"  {'-'*10}  {'-'*28}  {'-'*18}")
        for th in THRESHOLDS:
            hit = threshold_hits.get(th)
            if hit:
                print(f"  {th:>9}¢  {hit['time']:<28}  {hit['price']:>17}¢")
            else:
                print(f"  {th:>9}¢  {'— never reached':<28}")

    # Summary table
    print("\n\n" + "=" * 140)
    print("SUMMARY TABLE — First time each price threshold was crossed (ET)")
    print("=" * 140)

    header = f"{'Market':<50}  {'Article Time':<20}"
    for th in THRESHOLDS:
        header += f"  {th}¢".rjust(22)
    print(header)
    print("-" * 140)

    for label, article_ts, ticker, hits in all_results:
        short_label = (ticker or label.split("→")[-1].strip())[:48]
        row_str = f"{short_label:<50}  {article_ts:<20}"
        if hits is None:
            row_str += "  (not available)"
        else:
            for th in THRESHOLDS:
                hit = hits.get(th)
                val = hit["time"][5:16] if hit else "—"  # MM-DD HH:MM
                row_str += f"  {val:>20}"
        print(row_str)


if __name__ == "__main__":
    main()
