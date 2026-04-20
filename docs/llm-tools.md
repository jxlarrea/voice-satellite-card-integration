# Experimental: LLM Tools

Voice Satellite supports displaying rich visual results from LLM tool calls inline during voice interactions. These features require the **[Voice Satellite - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools)** integration, which provides the tools to your conversation agent.

> **Requirements:**
> - Install the **[Voice Satellite - LLM Tools](https://github.com/jxlarrea/voice-satellite-card-llm-tools)** integration, which provides the search tools to your conversation agent.
> - Your Assist pipeline must use a **conversational AI agent** (e.g., OpenAI, Google Generative AI, Anthropic, Ollama, etc.). The built-in Home Assistant conversation agent does not support tool calling and cannot use these features.

## Contents

- [Image Search](#image-search)
- [Video Search](#video-search)
- [Web Search](#web-search)
- [Wikipedia Search](#wikipedia-search)
- [Weather Forecast](#weather-forecast)
- [Financial Data](#financial-data)

## Image Search

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/cats.jpg" alt="Image Search" width="650"/>
</p>

Ask your assistant to search for images:

- *"Show me images of golden retrievers"*
- *"Search for pictures of the Eiffel Tower"*

Results appear as a thumbnail grid in the media panel. Tap any image to view it fullscreen in a lightbox. The panel stays visible for 30 seconds after TTS completes, and can be dismissed at any time with a double-tap, double-click, or the Escape key.

## Video Search

<p align="center">
   <img src="https://github.com/jxlarrea/voice-satellite-card-integration/blob/main/assets/screenshots/mrbeast.jpg" alt="Video Search" width="650"/>
</p>

Ask your assistant to search for videos:

- *"Search for cooking videos"*
- *"Find YouTube videos about woodworking"*

Results appear as video cards showing the thumbnail, duration, title, and channel name. Tap any video to play it in the lightbox via YouTube embed. When a video is playing, TTS audio is automatically suppressed.

## Web Search

Ask your assistant to search the web:

- *"Search the web for Home Assistant 2025 new features"*
- *"Look up the latest SpaceX launch"*

The assistant responds with a summary of the search results. If the search returns a relevant featured image, it is displayed alongside the response.

## Wikipedia Search

Ask your assistant to look up topics on Wikipedia:

- *"Tell me about the James Webb Space Telescope"*
- *"Look up the history of the Roman Empire"*

The assistant responds with a summary from the Wikipedia article. If the article includes a main image, it is displayed alongside the response.

## Weather Forecast

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/weather2.jpg" alt="Weather" width="650"/>
</p>

Ask your assistant about the weather:

- *"What's the weather today?"*
- *"What's the forecast for this week?"*

The assistant responds with a spoken summary while displaying a weather card in the media panel showing the current temperature, condition, humidity, and a scrollable forecast (hourly, daily, or twice-daily depending on the range requested). The weather icon is sourced from Google Weather SVGs via Home Assistant. The weather card uses the same featured panel layout as web search and Wikipedia - it appears alongside the chat response and dismisses immediately after TTS completes (no 30-second linger).

## Financial Data

<p align="center">
   <img src="https://raw.githubusercontent.com/jxlarrea/voice-satellite-card-integration/refs/heads/main/assets/screenshots/currency2.jpg" alt="Stocks" width="650"/>
</p>

Ask your assistant about stocks, crypto, or currency conversions:

- *"What's Apple's stock price?"*
- *"How much is Bitcoin right now?"*
- *"Convert 100 USD to EUR"*

**Stocks and crypto** display a financial card showing the company or coin name, exchange badge, current price, color-coded change indicator (green with up arrow for gains, red with down arrow for losses), and key details like open/high/low prices or market cap. If available, a logo is displayed alongside the name.

**Currency conversions** display the converted amount prominently with the exchange rate below.

The financial card uses the same featured panel layout as weather - it appears alongside the chat response and dismisses immediately after TTS completes.
