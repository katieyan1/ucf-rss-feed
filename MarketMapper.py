from helper_classes import Story, Market

class MarketMapper:
    def __init__(self):
        self.markets : list[Market] = [] # markets to track

    def get_markets(self, headline: Story) -> list[Market]:
        pass