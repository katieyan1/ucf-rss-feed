"""
For each article in manual_market_data.csv, find the YES price of the
corresponding Kalshi market at the article's publication timestamp (ET).

Method: fetch all trades for the ticker, find the last trade at or before
the article timestamp. If no trade exists before the timestamp, report the
first trade's price and flag it.
"""

import csv
import re
import requests
from datetime import datetime
from zoneinfo import ZoneInfo

BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
API_KEY  = "75d926ae-dfa2-45a7-965e-267335570aab"
ET       = ZoneInfo("America/New_York")

CSV_PATH = "../../manual_market_data.csv"

# Resolved from market_link URLs in the CSV
TICKER_MAP = {
    "cnn-pambundifired":                "KXBONDIOUT-26APR03",
    "wsj-anthropicsecurityrisk":        "KXANTHROPICRISK-26APR01",
    "sfchron-swalwelldropout":          "KXDROPOUTPRIMARY-26-KPAX",
    "guardian-samaltmanreturns":        None,   # OPENAICEO-24-SA — not in current API
    "npr-kristinoemfired":              "KXNOEMOUT-26APR01",
    "guardian-lindayaccarinostepsdown": None,   # KXXCEOCHANGE — not in current API
    "nytimes-upennpresidentresigns":    None,   # UNIPRESIDENT-24DEC31-PENN — not in current API
    "nytimes-harvardpresidentresigns":  None,   # UNIPRESIDENT-24DEC31-HARVARD — not in current API
    "guardian-firstnueralink":          None,   # NEURALINK-24JUN30 — not in current API
    "nytimes-powellfire":               "KXTRYFIREPOWELL-26MAY12-JUN01",
    "nytimes-metalayoffs":              "KXMETAHEADCOUNT-26JUL-81000",
    "_swalwell_cnn":                    "KXDROPOUTPRIMARY-26-ESWA",
}


def parse_timestamp(ts_str):
    """
    Parse the varied timestamp formats used in the CSV.

    Formats seen:
      - ISO with offset:  2026-04-01T18:24:29-04:00
      - Readable ET:      Apr 10, 2026, 9:25 PM ET
      - Concatenated:     M/D/YYHHMM  e.g. 4/1/261919 = Apr 1 2026 19:19 ET
                          (3-digit time treated as HMM with leading zero)
    """
    ts_str = ts_str.strip()
    if not ts_str:
        return None

    # ISO format
    if "T" in ts_str and ts_str[0].isdigit():
        try:
            return datetime.fromisoformat(ts_str).astimezone(ET)
        except ValueError:
            pass

    # Readable: "Apr 10, 2026, 9:25 PM ET"
    if ts_str.endswith(" ET"):
        try:
            return datetime.strptime(ts_str[:-3].strip(), "%b %d, %Y, %I:%M %p").replace(tzinfo=ET)
        except ValueError:
            pass

    # Concatenated M/D/YYHHMM
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2})(\d{3,4})$", ts_str)
    if m:
        mo, dy, yr2, time_part = m.groups()
        year = 2000 + int(yr2)
        time_part = time_part.zfill(4)
        hour, minute = int(time_part[:2]), int(time_part[2:])
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return datetime(year, int(mo), int(dy), hour, minute, tzinfo=ET)
        else:
            print(f"  [WARN] Parsed date {mo}/{dy}/{year} but time '{time_part}' is invalid — skipping")
            return None

    print(f"  [WARN] Could not parse timestamp: '{ts_str}'")
    return None


def fetch_all_trades(ticker):
    """Fetch all trades for a ticker in chronological order."""
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


def price_at_timestamp(trades, target_dt):
    """
    Return (price_cents, trade_time, flag) where:
      - price_cents is the YES price at the last trade <= target_dt
      - flag is 'before_open' if all trades are after target_dt
    """
    if not trades:
        return None, None, "no_trades"

    last_before = None
    for trade in trades:
        trade_dt = datetime.fromisoformat(
            trade["created_time"].replace("Z", "+00:00")
        ).astimezone(ET)
        if trade_dt <= target_dt:
            last_before = trade
        else:
            break  # trades are sorted chronologically

    if last_before is None:
        # Article published before market opened — use first trade price
        first = trades[0]
        first_dt = datetime.fromisoformat(
            first["created_time"].replace("Z", "+00:00")
        ).astimezone(ET)
        price = round(float(first["yes_price_dollars"]) * 100)
        return price, first_dt, "before_open"

    trade_dt = datetime.fromisoformat(
        last_before["created_time"].replace("Z", "+00:00")
    ).astimezone(ET)
    price = round(float(last_before["yes_price_dollars"]) * 100)
    return price, trade_dt, "ok"


def load_csv(path):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


def main():
    rows = load_csv(CSV_PATH)

    # Build list of (label, article_id, timestamp_str, ticker) to process
    markets = []
    seen_swalwell = False
    for row in rows:
        article_id = row.get("article_id", "").strip()
        ts_str     = row.get("timestamp (ET)", "").strip()
        headline   = row.get("headline", "").strip()

        if not article_id:
            # Second kxdropoutprimary row (Swalwell CNN story)
            if not seen_swalwell:
                markets.append(("_swalwell_cnn", ts_str, headline or "(Swalwell CNN)"))
                seen_swalwell = True
            continue

        ticker = TICKER_MAP.get(article_id)
        markets.append((article_id, ts_str, headline))

    print(f"Processing {len(markets)} markets\n")
    print("=" * 100)

    results = []

    # Cache trades per ticker so we don't re-fetch for duplicate tickers
    trade_cache: dict[str, list] = {}

    for article_id, ts_str, headline in markets:
        ticker = TICKER_MAP.get(article_id)
        label  = f"{article_id} → {ticker or 'N/A'}"
        print(f"\n{label}")
        print(f"  Headline:  {headline[:80]}")
        print(f"  Timestamp: {ts_str}")

        if ticker is None:
            print("  SKIPPED — ticker not available in current Kalshi API")
            results.append((article_id, ts_str, ticker, None, None, "unavailable"))
            continue

        target_dt = parse_timestamp(ts_str)
        if target_dt is None:
            print("  SKIPPED — could not parse timestamp")
            results.append((article_id, ts_str, ticker, None, None, "bad_timestamp"))
            continue

        print(f"  Parsed:    {target_dt.strftime('%Y-%m-%d %H:%M %Z')}")

        if ticker not in trade_cache:
            print(f"  Fetching trades for {ticker}...")
            try:
                trade_cache[ticker] = fetch_all_trades(ticker)
            except Exception as e:
                print(f"  ERROR fetching trades: {e}")
                results.append((article_id, ts_str, ticker, None, None, f"fetch_error: {e}"))
                continue
            print(f"  Total trades: {len(trade_cache[ticker])}")

        trades = trade_cache[ticker]
        price, trade_dt, flag = price_at_timestamp(trades, target_dt)

        if flag == "no_trades":
            print("  No trades found.")
            results.append((article_id, ts_str, ticker, None, None, "no_trades"))
        elif flag == "before_open":
            print(f"  Article published BEFORE market opened.")
            print(f"  First trade: {trade_dt.strftime('%Y-%m-%d %H:%M:%S %Z')} → {price}¢  [before_open]")
            results.append((article_id, ts_str, ticker, price, trade_dt, "before_open"))
        else:
            print(f"  Price at article time: {price}¢  (last trade: {trade_dt.strftime('%Y-%m-%d %H:%M:%S %Z')})")
            results.append((article_id, ts_str, ticker, price, trade_dt, "ok"))

    # Summary
    print("\n\n" + "=" * 120)
    print("SUMMARY — YES price at article publication time")
    print("=" * 120)
    print(f"{'Article ID':<40} {'Timestamp (ET)':<26} {'Ticker':<36} {'Price':>6}  {'Note'}")
    print("-" * 120)
    for article_id, ts_str, ticker, price, trade_dt, flag in results:
        price_str = f"{price}¢" if price is not None else "—"
        note = flag if flag != "ok" else ""
        ts_display = ts_str[:25]
        print(f"{article_id:<40} {ts_display:<26} {(ticker or 'N/A'):<36} {price_str:>6}  {note}")


if __name__ == "__main__":
    main()
