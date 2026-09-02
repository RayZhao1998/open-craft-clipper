---
title: AI translation
---

Reader mode can show an article in two languages at once: the original paragraph, with its translation directly underneath. Translation is done paragraph by paragraph, and only around the part of the page you are actually reading, so a 20,000-word article costs the same per scroll as the screen you can see.

> [!note] Availability
> AI translation is only available inside **Reader** — the full-page reader and the Reader tab opened from the extension popup. Translations live in the page and are removed when you turn translation off.

## Set up a model

Translation is off until you give it an endpoint.

1. Open **Settings → AI**.
2. Under **Model endpoint**, enter a **base URL**, an **API key** and a **model ID**. Anything that speaks an OpenAI-compatible `POST {base}/chat/completions` works (OpenAI, OpenRouter, DeepSeek, Groq, Together, an OpenAI-compatible gateway, a corporate proxy). Anthropic and Google AI endpoints, and Ollama's OpenAI-compatible port, are recognised too.
    - OpenAI: `https://api.openai.com/v1`
    - OpenRouter: `https://openrouter.ai/api/v1`
    - Anthropic: `https://api.anthropic.com/v1`
    - Google AI: `https://generativelanguage.googleapis.com/v1beta`
    - Ollama: `http://localhost:11434/v1`
3. Press **Test connection**. The panel answers *Connected* or shows the exact error (bad key, model not found, no network, …).
4. Switch **Enable AI** on.

Requests are sent from the extension's background page, so the key is not exposed to the pages you clip. Local endpoints (localhost, `127.0.0.1`, `.local`, private IP ranges) do not require a key.

Nothing is uploaded except the text of the paragraphs being translated. Your prompt template and the page title are not sent.

Under **Immersive translation** you can choose the target language (**Translate to**), the layout, whether video captions are included, and the prompt.

## Translate an article

Open an article in Reader (the **Read** tab in the extension popup, or the Reader button on a page) and press **Translate** in the Reader toolbar. Translations appear under each paragraph as you scroll; a paragraph whose translation is on its way shows a faint placeholder line in its place.

- **Original + translation** (default) keeps the original and adds the translation below it.
- **Translation only** hides the original once a paragraph has been translated, so the page never blanks out mid-request. Table cells and definition terms stay bilingual, because their translation lives inside them.
- Turn on **Translate automatically** if you want Reader to start translating as soon as it opens.

Because only the region around the viewport is queued, you can fly through an article without spending anything: while the page is scrolling, nothing is sent. Scrolling back up is free — translated paragraphs are cached per model and language.

## Videos

For YouTube pages, Reader translates the same two kinds of text:

- the **video description**, keeping its line breaks (a description is one paragraph with hard breaks, and it is sent as one segment, not one request per line);
- the **transcript**, caption line by caption line, inserted inside each caption line so clicking a line still jumps the player there.

Captions are the most expensive part of a video, so they are optional: **Translate transcripts** is on by default and can be switched off — the description is still translated. Only the captions near the screen are requested, and timestamps and chapter markers are never sent.

## Cost controls

| Control | Default |
| --- | --- |
| Region translated | the screen plus one viewport above and below |
| While scrolling | no requests at all |
| Characters per request | ~1,400 |
| Segments per request | 12 |
| Requests in flight | 2 |
| Output cap per request | none — the endpoint's own limit applies; if an answer is still cut off, the translations that did finish are kept |
| Retries per paragraph | 2, then give up |
| After consecutive failures | 3 — translating stops and the error is shown |
| Code, quotes, numbers | never sent |
| Text already in the target language | never sent |

## Extra request parameters

If the model needs a parameter that has no field of its own, put it in **Settings → AI → Extra request parameters** as a JSON object. It is merged into every request body:

```json
{"thinking_token_budget": 0}
```

Common recipes for models that "think" before answering:

| Endpoint | Parameter |
| --- | --- |
| Qwen on Aliyun-style compatible endpoints | `{"thinking_token_budget": 0}` or `{"enable_thinking": false}` |
| Qwen served by vLLM / SGLang | `{"chat_template_kwargs": {"enable_thinking": false}}` |
| Gemini | `{"generationConfig": {"thinkingConfig": {"thinkingBudget": 0}}}` |
| Ollama | `{"think": false}` |
| OpenAI reasoning models | `{"reasoning_effort": "low"}` (there is no off switch) |

The object can add parameters; it cannot replace `model`, `messages`, `stream` or the prompt we built. If a gateway rejects an unknown parameter with HTTP 400, the request is retried once without it, so a wrong field costs one failed call rather than breaking translation. Nothing here is optional in a cost sense: a thinking model that spends 2,000 tokens reasoning before answering a 40-token paragraph is billed for all of it — turning thinking off is the single largest saving available on these models.

## Custom translation prompt

The **Translation prompt** field is the *user-level* instruction appended to the built-in translation contract (return one JSON string per input, same order, never merge or drop a segment, keep markdown, code, URLs, numbers and whitespace). Use it to fix tone and glossary rather than to change the format:

```
Context: an article about semiconductors. Translate Simplified Chinese 简体中文 into natural, publication-quality Chinese.
Glossary: "fabless" -> 无晶圆厂, "foundry" -> 晶圆代工厂, "yield" -> 良率.
Do not translate product names, model numbers, code, URLs or citation markers.
```

The built-in contract is always appended after your text, so the model still receives the numbered segments and the output requirements. Leave the field empty for the plain default. Press **Reset prompt** to clear it.

Two placeholders are substituted in your text: `{sourceLang}` (detected from the paragraph's script, e.g. `English`) and `{targetLang}` (the label of the chosen language).

## Languages

Choose the target language from the list, or **Custom code…** and type any language or locale (`pt-BR`, `日本語`, `esperanto`). Code-switched paragraphs — a Chinese article with English product names in it — are translated as one unit; only a paragraph that has no prose in it at all is skipped.

## Limitations

- Translation runs in Reader only: it is not applied to the markdown that gets saved, and highlights are unaffected by it.
- A **reasoning ("thinking") model** that answers only in its reasoning field cannot be translated from: the connection test says so, and translation reports it instead of failing silently. Use a model that answers directly, or turn its thinking off at the endpoint.
- If a model returns fewer lines than it was sent, the affected paragraphs stay in the original language rather than showing a shifted translation.
- Very long paragraphs are split into request-sized pieces and re-joined, which can occasionally read slightly less smoothly than a whole-paragraph translation.

## See also

- [Clip web pages](Clip%20web%20pages.md)
- [Highlight web pages](Highlight%20web%20pages.md)
- [Interpret web pages](Interpret%20web%20pages.md) — template-driven AI actions on the whole page
