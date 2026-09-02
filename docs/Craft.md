# Save to Craft

This fork of Obsidian Web Clipper adds a second save destination: [Craft](https://craft.do), via the [Craft Space API](https://docs.craft.do/space-api). Everything else — extraction, templates, variables, filters, highlights, Interpreter — works exactly as upstream; only the last step changes.

## Setup

1. Open **Settings → Craft**.
2. Turn on **Save to Craft**.
3. Paste your Space API link (Craft → Space settings → Space API). Full link, share link or bare id all work; it is normalized to `https://connect.craft.do/links/<id>/api/v1`.
4. **Test connection** — the space name appears on success, and the folder tree is loaded.
5. Pick a **default folder** (Unsorted, or any folder — the picker shows the tree flattened as `Parent / Child`).

> The Space API link *is* the credential for your space. Anyone who has it can read and write that space. It is stored with your other clipper settings (synced), so a settings export contains it.

## Choosing the destination

- **Global default:** Settings → General → *Save behavior* → *Add to Craft* (only listed when Craft is enabled).
- **Per template:** Template → *Save to* → `Craft`. A template pinned to Craft hides Vault/Note-location fields and locks *Behavior* to "create new note", because the Craft API only creates documents.
- **Per clip:** the main button plus the `⌄` menu always offer the other app.

When the clip is going to Craft, the footer's vault/path row is replaced by a Craft folder picker. Your last choice is remembered.

## Document format

Craft has no YAML frontmatter, so template **properties become header callouts**:

```
<callout>**source**: [Example](https://example.com)</callout>

<callout>#clippings</callout>

<callout><caption>Saved [Tue, 7 Jul](date://2026-07-07) at 14:32</caption></callout>

***

…note content…
```

- **Properties:** *callouts* (default) or *drop them*.
- **Header tags:** inserted above the caption, template variables allowed (`{{tags}}`).
- **Custom header:** replaces the whole built-in header; uses the same template syntax as note content.
- **Wiki links:** `[[link]]` → plain text (default) or an `obsidian://search` link.
- **Body conversions:** `> [!tip] Title` → `<callout>`, `![[image.png]]` / relative `<img>` → absolute remote URL, `==text==` → **bold**, `%%comments%%` removed. Code blocks and inline code are never rewritten.

Images are **kept as remote URLs** (Craft fetches them); nothing is uploaded to the space, so hotlink-protected or short-lived image URLs can break later.

## Notes and limits

- Appending to an existing document, daily notes and overwriting are Obsidian-only — the Space API creates documents and appends markdown at the end of one.
- Long clips are written with several sequential `POST /blocks` calls (chunked at blank-line boundaries, ~100 KB each, never inside a code fence).
- Requests run in the background service worker, so page CSP/CORS never interferes; if you revoke the link in Craft, paste a new one in settings.
