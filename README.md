# Inline Translator

A lean inline web page translator for Chrome / Edge / Firefox (MV3).

## Features

- **Adaptive engine**: Block/inline decided by computed display; unknown sites work out of the box.
- **Layout-safe placement**: Labels translate inline right of the original; prose gets its own line.
- **Style inheritance**: Translations match the original typography, with 17 optional themes (underlines, borders, highlight, quote, blur, transparency, …) and a live popup preview.
- **Rich text**: Placeholder round-trip, restored and sanitized.
- **Dynamic content**: Debounced rescans, SPA restarts, Shadow DOM & same-origin iframe piercing.
- **Efficient**: Viewport-lazy translation, batching, LRU cache.
- **Services**: Google / Edge built-in endpoints or any OpenAI-compatible API.
- **Controls**: Curated + custom site rules, floating button, Alt+A, context menu, popup, per-site auto-translate memory.

## AI Disclosure

This project is developed entirely with LLM assistance, and no human code review has been performed.

## License

Licensed under [Apache License, Version 2.0](LICENSE).
