class Story:
    def __init__(self, headline, summary, source, timestamp):
        self.headline = headline
        self.summary = summary
        self.source = source
        self.timestamp = timestamp

class Market:
    def __init__(self, name, kalshi_id, buy_words, sell_words):
        self.name = name
        self.kalshi_id = kalshi_id
        self.buy_words = buy_words # buy if this word is in the headline
        self.sell_words = sell_words

    def is_relevant(self, headline: Story) -> bool:
        pass