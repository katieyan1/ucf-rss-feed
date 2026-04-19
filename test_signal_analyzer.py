import json
from SignalAnalyzer import SignalAnalyzer  # adjust import name to match your file name

groq_key = '...' # <-- put api key here





# --- Sample Input ---
sample_input = {
  "article": {
    "article_id": "abc123",
    "headline": "Fed signals possible rate cut amid slowing inflation",
    "summary": "Federal Reserve officials hinted at a potential interest rate cut in the coming months as inflation data continues to show signs of cooling. Several Fed members expressed confidence that price pressures are easing, raising expectations for monetary easing in Q2 2026.",
    "publish_time": "2026-04-18T14:32:00Z"
  },
  "markets": [
    {
      "market_id": "RATECUT_2026_Q2",
      "title": "Will the Fed cut rates in Q2 2026?",
      "description": "Resolves YES if the Federal Reserve announces a rate cut before the end of Q2 2026.",
      "event": "US Monetary Policy",
      "settlement_rules": "Resolves YES if an official Fed announcement confirms a rate cut within the specified timeframe; otherwise NO.",
      "expiration_time": "2026-06-30T20:00:00Z",
      "settlement_time": "2026-07-01T20:00:00Z"
    },
    {
      "market_id": "INFLATION_BELOW_3_2026",
      "title": "Will US inflation fall below 3% by end of 2026?",
      "description": "Resolves YES if the official year-over-year CPI reading drops below 3% at any point before December 31, 2026.",
      "event": "US Inflation",
      "settlement_rules": "Resolves YES based on official CPI data releases from the Bureau of Labor Statistics; otherwise NO.",
      "expiration_time": "2026-12-31T23:59:00Z",
      "settlement_time": "2027-01-15T13:30:00Z"
    }
  ]
}

def test_output_structure(result):
    """Validate the output has the expected structure."""
    assert "article" in result, "Missing 'article' key"
    assert "signals" in result, "Missing 'signals' key"
    assert "article_id" in result["article"], "Missing 'article_id' in article"
    assert "publish_time" in result["article"], "Missing 'publish_time' in article"
    assert len(result["signals"]) == len(sample_input["markets"]), "Signal count mismatch"

    for signal in result["signals"]:
        assert "market_id" in signal, "Missing 'market_id' in signal"
        assert "signal" in signal, "Missing 'signal' in signal"
        assert "confidence" in signal, "Missing 'confidence' in signal"
        assert "reason" in signal, "Missing 'reason' in signal"
        assert signal["signal"] in ["yes", "no"], f"Invalid signal value: {signal['signal']}"
        assert 0.0 <= signal["confidence"] <= 1.0, f"Confidence out of range: {signal['confidence']}"

    print(":white_check_mark: All structure checks passed!")

def run_test():
    print("=" * 50)
    print("Running SignalAnalyzer Test")
    print("=" * 50)

    # Initialize analyzer — reads from env var GROQ_API_KEY or pass it directly
    analyzer = SignalAnalyzer(api_key=groq_key)

    # Run analysis
    result = analyzer.analyze(sample_input)
    print(result)

    
    # Pretty print result
    print("\n:bar_chart: Raw Output:")
    print(json.dumps(result, indent=2))

    # Validate structure
    print("\n:mag: Validating output structure...")
    test_output_structure(result)

    # Print summary
    print("\n:chart_with_upwards_trend: Signal Summary:")
    for signal in result.get("signals", []):
        direction = ":large_green_circle: YES" if signal["signal"] == "yes" else ":red_circle: NO"
        print(f"  {signal['market_id']}: {direction} | Confidence: {signal['confidence']} | {signal['reason']}")
    
        
if __name__ == "__main__":
    run_test()