import json
import os
# To install: pip install groq
from groq import Groq

class SignalAnalyzer:
    def __init__(self, api_key=None):
        # You can pass the API key or set it as an environment variable GROQ_API_KEY
        self.client = Groq(
            api_key=api_key or os.environ.get("GROQ_API_KEY"),
        )
        # Using Llama 3.3 70B for high-quality reasoning;
        # Alternatively use 'llama-3.1-8b-instant' for extreme speed.
        self.model = "llama-3.3-70b-versatile"

    def analyze(self, input_data):
        article = input_data.get("article", {})
        headline = article.get("headline", "Unknown Headline")

        print(f"Analyzing article: {headline}")

        # System prompt ensures the model acts as a financial analyst and outputs strict JSON
        system_prompt = (
            "You are a specialized financial news analyst for prediction markets. "
            "Your task is to analyze an article and determine its impact on specific "
            "Kalshi markets. You must output valid, minified JSON only."
        )

        user_prompt = f"""
Analyze the following article and markets. Determine if the article makes the market outcome
more likely (yes) or less likely (no), and provide a confidence level and reason.

INPUT DATA:
{json.dumps(input_data, indent=2)}

OUTPUT FORMAT (STRICT JSON):
{{
  "article": {{
    "article_id": "{article.get('article_id')}",
    "publish_time": "{article.get('publish_time')}"
  }},
  "signals": [
    {{
      "market_id": "...",
      "signal": "yes/no",
      "confidence": 0.00,
      "reason": "..."
    }}
  ]
}}
"""

        try:
            chat_completion = self.client.chat.completions.create(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                model=self.model,
                # Setting response_format to json_object helps ensure valid JSON output
                response_format={"type": "json_object"},
                temperature=0.1,  # Low temperature for deterministic/factual output
            )

            response_content = chat_completion.choices[0].message.content
            return json.loads(response_content)

        except Exception as e:
            print(f"Error during analysis: {e}")
            # Fallback structure if the API call fails
            return {
                "article": {"article_id": article.get("article_id")},
                "signals": [],
                "error": str(e)
            }

# Example Usage:
# analyzer = SignalAnalyzer(api_key="...") # <-- put api key here
# result = analyzer.analyze(example_input_format)
# print(json.dumps(result, indent=2))