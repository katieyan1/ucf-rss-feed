import requests
import time
from bs4 import BeautifulSoup
from datetime import datetime, timezone

SITEMAP_URL = "https://www.nytimes.com/sitemap/2026/04/15/"
POLL_INTERVAL = 60  # seconds between checks

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
}

def fetch_articles():
    resp = requests.get(SITEMAP_URL, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    articles = {}
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "/2026/" in href and "nytimes.com" in href:
            title = a.get_text(strip=True)
            articles[href] = title
    return articles

def main():
    print(f"Polling {SITEMAP_URL} every {POLL_INTERVAL}s for new articles...\n")
    seen = {}

    while True:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        try:
            articles = fetch_articles()
            new = {url: title for url, title in articles.items() if url not in seen}
            if new:
                for url, title in new.items():
                    print(f"[{now}] NEW: {title}\n        {url}")
                seen.update(new)
            else:
                print(f"[{now}] No new articles ({len(seen)} total seen)")
        except Exception as e:
            print(f"[{now}] Error: {e}")

        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
