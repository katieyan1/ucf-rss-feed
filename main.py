import RSSPoller
import MarketMapper

def main():
    feed_url = "http://example.com/rss"
    poller = RSSPoller(feed_url)
    poller.poll()

if __name__ == "__main__":    
    main()