---
title: Auto Reader
---

Some sites are worth reading in Reader every single time — news sites with comment sections in the middle of the article, blogs that ship three videos autoplaying, documentation pages with a sidebar wider than the text. **Auto Reader** opens those pages in Reader for you, as soon as they finish loading.

> [!note] Availability
> Auto Reader is a feature of this fork, and it applies to pages the extension can inject into: normal `http(s)` pages in the top frame.

## Turn it on

1. Open **Settings → Reader**.
2. Under **Auto Reader**, switch **Open Reader automatically** on.
3. List the addresses under **Sites and links**, one rule per line.

Nothing is fetched or rewritten until the toggle is on and at least one rule exists.

## Rules

| You write | It covers |
| --- | --- |
| `example.com` | that host **and its subdomains**, any path |
| `example.com/blog` | `/blog` and everything under it — but **not** `/bloggers`, paths end at a `/` boundary |
| `youtube.com/watch` | `/watch` **whatever its parameters**: `…/watch?v=…`, `…/watch?v=…&t=42s` — while `/watch_popup` stays outside |
| `x.com/*/status/*` | `*` is one path segment, `**` spans any depth: `x.com/**/status/*` also covers `/i/web/status/…` |
| `https://example.com/long-reads/` | addresses starting exactly like that, no subdomain shortcut |
| `localhost:3000` | that host **and** port — a rule without a port ignores the port |
| `^https://x\.com/[^/]+/status/\d+$` | a regular expression on the whole address; `^…` needs no delimiters, so slashes stay unescaped |
| `/^https:\/\/news\.example\.com\/item\?id=\d+$/` | the same regex between slashes, with the slashes escaped |
| `-example.com/comments` | an **exception**: subtract this from the rules above |

A few things worth knowing:

- Exceptions win wherever they sit in the list, so the order of your rules does not matter. An exception on its own never opens Reader.
- A domain rule matches the host and its subdomains only — `example.com` does not match `notexample.com`.
- `*` stays inside one path segment, so `x.com/*/status/*` covers every account's status page and none of the timelines, bookmarks or search results on the same host.
- Parameters do not get in the way: a path rule is compared against the path, so `youtube.com/watch` covers `…/watch?v=…` — the shape every video page uses. A rule that carries a query of its own (`example.com/item?id=42`) is compared against path **and** query, and stays a prefix.
- A video host is rarely worth opening whole. `youtube.com/watch` plus `youtu.be` covers watch pages (desktop, `m.`, `music.`) and short links, and leaves the homepage, the subscriptions feed and `/shorts/` alone; add `youtube.com/shorts` or `youtube.com/live` if you want those too.
- Blank lines and lines starting with `#` are ignored, and a broken rule is skipped rather than disabling the rest.
- Leading `www.` is not required, and `www.` in front of a domain rule makes no difference. `*.example.com` is allowed and means the same as `example.com`.

```text
# Posts and single tweets, never the timeline
theverge.com/reviews
x.com/*/status/*
-x.com/*/status/*/video
/^https:\/\/\w+\.medium\.com\/.+$/

# Videos, into the transcript rather than the feed
youtube.com/watch
youtube.com/shorts
youtu.be
```

## Getting it out of the way

Turning **Reader off** in a tab means "not in this tab": Reader does not reopen there, even after a reload, until the tab moves on to a page that no rule matches. A new tab starts fresh, and **Settings → Reader → Open Reader** still opens the standalone Reader page exactly as before.

If a page opens in Reader and extraction comes up thin, turn Reader off for it once and adjust the rule — an exclusion, or a narrower path — to keep it out for good. Opening Reader automatically is counted in your statistics the same way as opening it by hand.
