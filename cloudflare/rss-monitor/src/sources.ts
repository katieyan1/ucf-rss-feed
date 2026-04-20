export interface SourceConfig {
  name: string;
  description: string;
  feeds: Record<string, string>;
}

export const SOURCES: SourceConfig[] = [
  {
    name: "nyt",
    description: "New York Times",
    feeds: {
      HomePage: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
      World: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
      US: "https://rss.nytimes.com/services/xml/rss/nyt/US.xml",
      Politics: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",
      Business: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",
      Technology: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
      Science: "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml",
      Health: "https://rss.nytimes.com/services/xml/rss/nyt/Health.xml",
      Arts: "https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml",
    },
  },
  {
    name: "bbc",
    description: "BBC News",
    feeds: {
      TopStories: "https://feeds.bbci.co.uk/news/rss.xml",
      World: "https://feeds.bbci.co.uk/news/world/rss.xml",
      US_Canada: "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml",
      UK: "https://feeds.bbci.co.uk/news/uk/rss.xml",
      Business: "https://feeds.bbci.co.uk/news/business/rss.xml",
      Technology: "https://feeds.bbci.co.uk/news/technology/rss.xml",
      Science: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
      Health: "https://feeds.bbci.co.uk/news/health/rss.xml",
    },
  },
  {
    name: "wsj",
    description: "Wall Street Journal",
    feeds: {
      World: "https://feeds.a.dj.com/rss/RSSWorldNews.xml",
      US: "https://feeds.a.dj.com/rss/RSSWSJD.xml",
      Business: "https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml",
      Markets: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
      Technology: "https://feeds.a.dj.com/rss/RSSWSJD.xml",
    },
  },
  {
    name: "guardian",
    description: "The Guardian",
    feeds: {
      World: "https://www.theguardian.com/world/rss",
      US: "https://www.theguardian.com/us-news/rss",
      UK: "https://www.theguardian.com/uk-news/rss",
      Business: "https://www.theguardian.com/business/rss",
      Technology: "https://www.theguardian.com/technology/rss",
      Science: "https://www.theguardian.com/science/rss",
      Politics: "https://www.theguardian.com/politics/rss",
    },
  },
  {
    name: "npr",
    description: "NPR News",
    feeds: {
      TopStories: "https://feeds.npr.org/1001/rss.xml",
      US: "https://feeds.npr.org/1003/rss.xml",
      World: "https://feeds.npr.org/1004/rss.xml",
      Politics: "https://feeds.npr.org/1014/rss.xml",
      Business: "https://feeds.npr.org/1006/rss.xml",
      Technology: "https://feeds.npr.org/1019/rss.xml",
      Health: "https://feeds.npr.org/1128/rss.xml",
      Science: "https://feeds.npr.org/1007/rss.xml",
    },
  },
  {
    name: "aljazeera",
    description: "Al Jazeera",
    feeds: {
      TopStories: "https://www.aljazeera.com/xml/rss/all.xml",
    },
  }
];
