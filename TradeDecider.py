import base64
import importlib
import json
import os
import time
from datetime import datetime, timezone
from urllib import error, parse, request


class TradeDecider:
    def __init__(
        self,
        confidence_threshold: float = 0.70,
        max_dollars_per_market: float = 25.0,
        max_total_exposure: float = 200.0,
        daily_loss_limit: float = 50.0,
        cooldown_seconds: int = 300,  # 5 min cooldown per market
        execution_mode: str | None = None,
        env_file: str = ".env",
        kalshi_base_url: str | None = None,
        order_timeout_seconds: int = 10,
        log_trades: bool = True,
    ):
        self._env_file_directory = os.path.dirname(os.path.abspath(__file__))
        self._load_env_file(env_file)

        self.confidence_threshold = confidence_threshold
        self.max_dollars_per_market = max_dollars_per_market
        self.max_total_exposure = max_total_exposure
        self.daily_loss_limit = daily_loss_limit
        self.cooldown_seconds = cooldown_seconds

        self.kalshi_base_url = (
            kalshi_base_url
            or os.environ.get("KALSHI_BASE_URL")
            or "https://api.elections.kalshi.com/trade-api/v2"
        ).rstrip("/")
        self.kalshi_order_path = os.environ.get("KALSHI_ORDER_PATH", "/portfolio/orders")
        if not self.kalshi_order_path.startswith("/"):
            self.kalshi_order_path = f"/{self.kalshi_order_path}"
        self.order_timeout_seconds = self._safe_int(
            os.environ.get("KALSHI_ORDER_TIMEOUT_SECONDS", str(order_timeout_seconds)),
            default=order_timeout_seconds,
        )

        self.kalshi_api_token = os.environ.get("KALSHI_API_TOKEN", "").strip()
        self.kalshi_key_id = os.environ.get("KALSHI_KEY_ID", "").strip()
        self.kalshi_private_key_path = os.environ.get("KALSHI_PRIVATE_KEY_PATH", "").strip()
        self.kalshi_private_key_passphrase = os.environ.get("KALSHI_PRIVATE_KEY_PASSPHRASE", "")
        self.kalshi_extra_headers = self._parse_extra_headers(
            os.environ.get("KALSHI_EXTRA_HEADERS", "")
        )

        requested_mode = (
            execution_mode
            or os.environ.get("TRADE_DECIDER_MODE")
            or os.environ.get("KALSHI_EXECUTION_MODE")
            or "visualize"
        )
        self.requested_execution_mode = self._normalize_execution_mode(requested_mode)
        self.execution_mode = self.requested_execution_mode
        self.log_trades = self._parse_bool(os.environ.get("TRADE_DECIDER_LOG_TRADES"), default=log_trades)
        if self.execution_mode == "live" and not self._can_submit_live_orders():
            print(
                "[TradeDecider] Live mode requested but Kalshi credentials/signing support are missing. "
                "Falling back to visualize mode."
            )
            self.execution_mode = "visualize"

        # Internal state
        self.open_positions: dict[str, float] = {}       # market_id -> dollars committed
        self.last_trade_time: dict[str, float] = {}      # market_id -> unix timestamp
        self.daily_pnl: float = 0.0                      # running daily P&L (updated externally)
        self.decisions_log: list[dict] = []              # full audit trail

    @staticmethod
    def _safe_int(raw_value: str, default: int) -> int:
        try:
            return int(raw_value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _parse_bool(raw_value: str | None, default: bool) -> bool:
        if raw_value is None:
            return default
        normalized = str(raw_value).strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
        return default

    @staticmethod
    def _normalize_execution_mode(mode: str) -> str:
        mode = (mode or "visualize").strip().lower()
        if mode not in {"visualize", "live"}:
            return "visualize"
        return mode

    def _load_env_file(self, env_file: str) -> None:
        if not env_file:
            return

        env_path = env_file
        if not os.path.isabs(env_path):
            cwd_candidate = os.path.join(os.getcwd(), env_path)
            file_candidate = os.path.join(os.path.dirname(os.path.abspath(__file__)), env_path)
            env_path = cwd_candidate if os.path.isfile(cwd_candidate) else file_candidate

        if not os.path.isfile(env_path):
            return

        self._env_file_directory = os.path.dirname(os.path.abspath(env_path))

        with open(env_path, "r", encoding="utf-8") as handle:
            for line in handle:
                raw = line.strip()
                if not raw or raw.startswith("#"):
                    continue
                if raw.startswith("export "):
                    raw = raw[len("export ") :].strip()
                if "=" not in raw:
                    continue

                key, value = raw.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value

    def _resolve_path(self, maybe_relative_path: str) -> str:
        if os.path.isabs(maybe_relative_path):
            return maybe_relative_path
        cwd_candidate = os.path.join(os.getcwd(), maybe_relative_path)
        if os.path.isfile(cwd_candidate):
            return cwd_candidate
        return os.path.join(self._env_file_directory, maybe_relative_path)

    @staticmethod
    def _parse_extra_headers(raw_headers: str) -> dict[str, str]:
        if not raw_headers:
            return {}
        try:
            parsed = json.loads(raw_headers)
        except json.JSONDecodeError:
            return {}
        if not isinstance(parsed, dict):
            return {}

        headers: dict[str, str] = {}
        for key, value in parsed.items():
            if isinstance(key, str) and isinstance(value, (str, int, float, bool)):
                headers[key] = str(value)
        return headers

    def _can_submit_live_orders(self) -> bool:
        if self.kalshi_api_token:
            return True

        if not self.kalshi_key_id or not self.kalshi_private_key_path:
            return False

        key_path = self._resolve_path(self.kalshi_private_key_path)
        if not os.path.isfile(key_path):
            return False

        hashes_module, serialization_module, padding_module, _ = self._load_crypto_modules()
        return all((hashes_module, serialization_module, padding_module))

    @staticmethod
    def _load_crypto_modules():
        try:
            hashes_module = importlib.import_module("cryptography.hazmat.primitives.hashes")
            serialization_module = importlib.import_module(
                "cryptography.hazmat.primitives.serialization"
            )
            padding_module = importlib.import_module(
                "cryptography.hazmat.primitives.asymmetric.padding"
            )
            return hashes_module, serialization_module, padding_module, None
        except Exception as exc:
            return None, None, None, str(exc)

    @staticmethod
    def _normalize_price(raw_price: float | int) -> float:
        try:
            price = float(raw_price)
        except (TypeError, ValueError):
            return 0.50

        if price < 0:
            return 0.50
        if price > 1.0:
            price = price / 100.0

        return max(0.0, min(price, 1.0))

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
        if self.confidence_threshold >= 1.0:
            return 0.0

        # Price sanity check — no point trading if market already priced in the news
        if signal == "yes" and current_price > 0.90:
            return 0.0
        if signal == "no" and current_price < 0.10:
            return 0.0

        # Linear scale from threshold -> max
        scale = (confidence - self.confidence_threshold) / (1.0 - self.confidence_threshold)
        size = scale * self.max_dollars_per_market
        return round(max(0.0, min(size, self.max_dollars_per_market)), 2)

    def set_execution_mode(self, mode: str) -> str:
        """Toggle between 'visualize' and 'live' order handling."""
        normalized = self._normalize_execution_mode(mode)
        if normalized == "live" and not self._can_submit_live_orders():
            self.execution_mode = "visualize"
            return self.execution_mode

        self.execution_mode = normalized
        return self.execution_mode

    def _build_order_payload(
        self,
        market_id: str,
        side: str,
        dollars: float,
        current_price: float,
    ) -> dict:
        yes_price_cents = int(round(current_price * 100))
        yes_price_cents = max(1, min(99, yes_price_cents))
        no_price_cents = max(1, min(99, 100 - yes_price_cents))
        per_contract_cost_cents = yes_price_cents if side == "yes" else no_price_cents
        count = max(1, int(round((dollars * 100) / max(per_contract_cost_cents, 1))))

        market_token = "".join(ch for ch in str(market_id) if ch.isalnum() or ch in ("-", "_"))
        market_token = market_token[:24] or "market"

        payload = {
            "ticker": market_id,
            "client_order_id": f"rss-{market_token}-{int(time.time() * 1000)}",
            "type": "limit",
            "time_in_force": "immediate_or_cancel",
            "action": "buy",
            "side": side,
            "count": count,
        }
        if side == "yes":
            payload["yes_price"] = yes_price_cents
        else:
            payload["no_price"] = no_price_cents

        return payload

    def _build_auth_headers(self, method: str, request_path: str) -> tuple[dict[str, str], str | None]:
        if self.kalshi_api_token:
            return {"Authorization": f"Bearer {self.kalshi_api_token}"}, None

        if not self.kalshi_key_id or not self.kalshi_private_key_path:
            return {}, "Missing Kalshi credentials (token or key-id/private-key pair)."

        key_path = self._resolve_path(self.kalshi_private_key_path)
        if not os.path.isfile(key_path):
            return {}, f"Private key file not found at '{key_path}'."

        hashes_module, serialization_module, padding_module, load_error = self._load_crypto_modules()
        if load_error or not all((hashes_module, serialization_module, padding_module)):
            return {}, "Install 'cryptography' to sign Kalshi live order requests."
        assert hashes_module is not None
        assert serialization_module is not None
        assert padding_module is not None

        passphrase_bytes = (
            self.kalshi_private_key_passphrase.encode("utf-8")
            if self.kalshi_private_key_passphrase
            else None
        )

        try:
            with open(key_path, "rb") as key_file:
                private_key = serialization_module.load_pem_private_key(
                    key_file.read(),
                    password=passphrase_bytes,
                )
        except Exception as exc:
            return {}, f"Failed to load private key: {exc}"

        timestamp = str(int(time.time() * 1000))
        message = f"{timestamp}{method.upper()}{request_path}"

        try:
            signature_bytes = private_key.sign(
                message.encode("utf-8"),
                padding_module.PSS(
                    mgf=padding_module.MGF1(hashes_module.SHA256()),
                    salt_length=padding_module.PSS.MAX_LENGTH,
                ),
                hashes_module.SHA256(),
            )
        except Exception as exc:
            return {}, f"Failed to sign Kalshi request: {exc}"

        signature = base64.b64encode(signature_bytes).decode("ascii")
        return {
            "KALSHI-ACCESS-KEY": self.kalshi_key_id,
            "KALSHI-ACCESS-SIGNATURE": signature,
            "KALSHI-ACCESS-TIMESTAMP": timestamp,
        }, None

    @staticmethod
    def _extract_order_id(response_payload: dict | str | None) -> str | None:
        if not isinstance(response_payload, dict):
            return None

        for key in ("order_id", "id", "client_order_id"):
            value = response_payload.get(key)
            if value:
                return str(value)

        nested_order = response_payload.get("order")
        if isinstance(nested_order, dict):
            for key in ("order_id", "id", "client_order_id"):
                value = nested_order.get(key)
                if value:
                    return str(value)

        return None

    def _submit_kalshi_order(
        self,
        market_id: str,
        side: str,
        dollars: float,
        current_price: float,
    ) -> tuple[bool, dict | str | None, str | None]:
        endpoint = f"{self.kalshi_base_url}{self.kalshi_order_path}"
        request_path = parse.urlparse(endpoint).path
        auth_headers, auth_error = self._build_auth_headers("POST", request_path)
        if auth_error:
            return False, None, auth_error

        payload = self._build_order_payload(market_id, side, dollars, current_price)
        body = json.dumps(payload).encode("utf-8")

        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        headers.update(auth_headers)
        headers.update(self.kalshi_extra_headers)

        req = request.Request(endpoint, data=body, headers=headers, method="POST")
        try:
            with request.urlopen(req, timeout=self.order_timeout_seconds) as response:
                response_text = response.read().decode("utf-8")
                try:
                    parsed_response = json.loads(response_text) if response_text else {}
                except json.JSONDecodeError:
                    parsed_response = response_text
                return True, parsed_response, None
        except error.HTTPError as exc:
            error_body = exc.read().decode("utf-8")
            try:
                parsed_error = json.loads(error_body) if error_body else {}
            except json.JSONDecodeError:
                parsed_error = error_body
            return False, parsed_error, f"HTTP {exc.code}"
        except error.URLError as exc:
            return False, None, f"Network error: {exc.reason}"
        except Exception as exc:
            return False, None, f"Unexpected submit error: {exc}"

    def _execute_decision(self, decision: dict) -> bool:
        if decision["action"] != "buy":
            decision["execution_status"] = "not_applicable"
            decision["execution_note"] = "No order generated."
            return False

        if self.execution_mode == "visualize":
            decision["execution_status"] = "simulated"
            decision["execution_note"] = "Visualization mode enabled; order not submitted to Kalshi."
            return True

        success, response_payload, submit_error = self._submit_kalshi_order(
            market_id=decision["market_id"],
            side=decision["side"],
            dollars=decision["dollars"],
            current_price=decision["current_price"],
        )

        decision["kalshi_response"] = response_payload

        if success:
            decision["execution_status"] = "submitted"
            decision["execution_note"] = "Order submitted to Kalshi."
            decision["kalshi_order_id"] = self._extract_order_id(response_payload)
            return True

        decision["execution_status"] = "submit_failed"
        decision["execution_note"] = f"Kalshi submit failed: {submit_error}"
        if not decision.get("skip_reason"):
            decision["skip_reason"] = decision["execution_note"]
        return False

    def _log_trade_decision(self, decision: dict) -> None:
        if not self.log_trades:
            return

        market_id = decision.get("market_id")
        side = decision.get("side")
        confidence = decision.get("confidence", 0.0)
        action = decision.get("action")
        execution_status = decision.get("execution_status")

        if action == "buy" and execution_status in {"simulated", "submitted"}:
            print(
                "[TradeDecider] Kalshi trade taken "
                f"market={market_id} side={side} dollars=${decision.get('dollars', 0.0):.2f} "
                f"confidence={confidence:.2f} mode={decision.get('execution_mode')} status={execution_status}"
            )
            return

        if action == "buy" and execution_status == "submit_failed":
            print(
                "[TradeDecider] Kalshi trade failed "
                f"market={market_id} side={side} dollars=${decision.get('dollars', 0.0):.2f} "
                f"reason={decision.get('execution_note') or 'submit failed'}"
            )
            return

        reason = decision.get("skip_reason") or decision.get("execution_note") or "No edge"
        print(
            "[TradeDecider] Kalshi trade ignored "
            f"market={market_id} side={side} confidence={confidence:.2f} reason={reason}"
        )

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

            raw_current_price = current_prices.get(market_id, 0.50)  # default 50c if unknown
            current_price = self._normalize_price(raw_current_price)

            decision = {
                "market_id": market_id,
                "article_id": article.get("article_id"),
                "publish_time": article.get("publish_time"),
                "decided_at": datetime.now(timezone.utc).isoformat(),
                "side": side,
                "confidence": confidence,
                "current_price": current_price,
                "raw_current_price": raw_current_price,
                "action": None,
                "dollars": 0.0,
                "reason": reason,
                "skip_reason": None,
                "execution_mode": self.execution_mode,
                "execution_status": "pending",
                "execution_note": None,
                "kalshi_order_id": None,
                "kalshi_response": None,
            }

            # --- Filters ---
            if not market_id:
                decision["action"] = "skip"
                decision["skip_reason"] = "Signal missing market_id"

            elif side not in {"yes", "no"}:
                decision["action"] = "skip"
                decision["skip_reason"] = f"Unsupported side '{side}'"

            elif confidence < self.confidence_threshold:
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

            # Execute order path (live) or keep as simulated (visualize).
            should_update_state = self._execute_decision(decision)

            # Update internal state only for simulated/live-submitted buys.
            if decision["action"] == "buy" and should_update_state:
                self.open_positions[market_id] = (
                    self.open_positions.get(market_id, 0.0) + decision["dollars"]
                )
                self.last_trade_time[market_id] = time.time()

            self._log_trade_decision(decision)

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
