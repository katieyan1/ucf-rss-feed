import time
from datetime import datetime, timezone


class TradeDecider:
    def __init__(
        self,
        confidence_threshold: float = 0.70,
        max_dollars_per_market: float = 25.0,
        max_total_exposure: float = 200.0,
        daily_loss_limit: float = 50.0,
        cooldown_seconds: int = 300,  # 5 min cooldown per market
    ):
        self.confidence_threshold = confidence_threshold
        self.max_dollars_per_market = max_dollars_per_market
        self.max_total_exposure = max_total_exposure
        self.daily_loss_limit = daily_loss_limit
        self.cooldown_seconds = cooldown_seconds

        # Internal state
        self.open_positions: dict[str, float] = {}       # market_id -> dollars committed
        self.last_trade_time: dict[str, float] = {}      # market_id -> unix timestamp
        self.daily_pnl: float = 0.0                      # running daily P&L (updated externally)
        self.decisions_log: list[dict] = []              # full audit trail

    def _total_exposure(self) -> float:
        return sum(self.open_positions.values())

    def _is_on_cooldown(self, market_id: str) -> bool:
        if market_id not in self.last_trade_time:
            return False
        elapsed = time.time() - self.last_trade_time[market_id]
        return elapsed < self.cooldown_seconds

    def _position_size(self, confidence: float, current_price: float, signal: str) -> float:
        """
        Scale position size with confidence.
        confidence=0.70 -> ~$0, confidence=1.0 -> max_dollars_per_market
        Current price check: don't buy YES above 90c or NO below 10c (no edge).
        """
        # Price sanity check — no point trading if market already priced in the news
        if signal == "yes" and current_price > 0.90:
            return 0.0
        if signal == "no" and current_price < 0.10:
            return 0.0

        # Linear scale from threshold -> max
        scale = (confidence - self.confidence_threshold) / (1.0 - self.confidence_threshold)
        size = scale * self.max_dollars_per_market
        return round(max(0.0, min(size, self.max_dollars_per_market)), 2)

    def decide(self, signal_output: dict, current_prices: dict[str, float]) -> list[dict]:
        """
        Takes the SignalAnalyzer output and a dict of {market_id: current_price},
        returns a list of trade decisions.

        Each decision looks like:
        {
            "market_id": "RATECUT_2026_Q2",
            "action": "buy" | "skip",
            "side": "yes" | "no",
            "dollars": 12.50,
            "reason": "...",
            "skip_reason": "..." (only if action == "skip")
        }
        """
        article = signal_output.get("article", {})
        signals = signal_output.get("signals", [])
        decisions = []

        # Hard stop: daily loss limit breached
        if self.daily_pnl <= -self.daily_loss_limit:
            print(f"[TradeDecider] Daily loss limit hit (${self.daily_pnl:.2f}). No trades.")
            return []

        # Hard stop: max total exposure already reached
        if self._total_exposure() >= self.max_total_exposure:
            print(f"[TradeDecider] Max exposure reached (${self._total_exposure():.2f}). No trades.")
            return []

        for signal in signals:
            market_id = signal.get("market_id")
            side = signal.get("signal")          # "yes" or "no"
            confidence = signal.get("confidence", 0.0)
            reason = signal.get("reason", "")

            current_price = current_prices.get(market_id, 0.50)  # default 50c if unknown

            decision = {
                "market_id": market_id,
                "article_id": article.get("article_id"),
                "publish_time": article.get("publish_time"),
                "decided_at": datetime.now(timezone.utc).isoformat(),
                "side": side,
                "confidence": confidence,
                "current_price": current_price,
                "action": None,
                "dollars": 0.0,
                "reason": reason,
                "skip_reason": None,
            }

            # --- Filters ---
            if confidence < self.confidence_threshold:
                decision["action"] = "skip"
                decision["skip_reason"] = f"Confidence {confidence:.2f} below threshold {self.confidence_threshold}"

            elif self._is_on_cooldown(market_id):
                decision["action"] = "skip"
                elapsed = time.time() - self.last_trade_time[market_id]
                decision["skip_reason"] = f"Market on cooldown ({elapsed:.0f}s / {self.cooldown_seconds}s elapsed)"

            else:
                size = self._position_size(confidence, current_price, side)

                if size == 0.0:
                    decision["action"] = "skip"
                    decision["skip_reason"] = f"Price {current_price:.2f} leaves no edge for '{side}' trade"

                elif self._total_exposure() + size > self.max_total_exposure:
                    # Partial fill up to remaining budget
                    remaining = self.max_total_exposure - self._total_exposure()
                    if remaining < 1.0:
                        decision["action"] = "skip"
                        decision["skip_reason"] = "Total exposure cap reached"
                    else:
                        decision["action"] = "buy"
                        decision["dollars"] = round(remaining, 2)
                        decision["skip_reason"] = f"Capped at remaining exposure (${remaining:.2f})"

                else:
                    decision["action"] = "buy"
                    decision["dollars"] = size

            # Update internal state if trading
            if decision["action"] == "buy":
                self.open_positions[market_id] = (
                    self.open_positions.get(market_id, 0.0) + decision["dollars"]
                )
                self.last_trade_time[market_id] = time.time()

            decisions.append(decision)
            self.decisions_log.append(decision)

        return decisions

    def update_pnl(self, delta: float):
        """Call this when a position settles to update daily P&L tracking."""
        self.daily_pnl += delta

    def close_position(self, market_id: str):
        """Call when a market settles to free up exposure."""
        if market_id in self.open_positions:
            del self.open_positions[market_id]

    def get_audit_log(self) -> list[dict]:
        return self.decisions_log
