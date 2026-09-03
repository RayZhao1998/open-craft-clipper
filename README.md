# OpenCraftClipper

**OpenCraftClipper** captures the web as clean Markdown — saved into **Craft**, into **Obsidian**, or to your **downloads** — and can translate any Reader article in place with your own AI endpoint.

It is a fork of [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper), renamed so it can be distributed on its own terms. It is **not affiliated with, sponsored, or endorsed by Obsidian**; the Obsidian name and logo remain their owner's trademarks, and the upstream code stays under its MIT license (see [License](#license)). Saving to Obsidian keeps working exactly as it did.

Upstream's general description still applies: anything you save is stored as durable Markdown files you can read offline and preserve for the long term.

- **[Releases — packaged builds for Chrome, Firefox, Safari](https://github.com/RayZhao1998/open-craft-clipper/releases)**
- **[Documentation (upstream)](https://help.obsidian.md/web-clipper)** — templates, variables, filters, highlights and Interpreter are upstream's, and unchanged
- **[Troubleshooting (upstream)](https://help.obsidian.md/web-clipper/troubleshoot)**

Fork version `1.7.1-fork.1` is based on Obsidian Web Clipper `1.7.1`.

## This fork: Craft support

`OpenCraftClipper` adds **Craft** as a save destination next to Obsidian, using the [Craft Space API](https://docs.craft.do/space-api). Templates, variables, filters, highlights and Interpreter are untouched — only the final save step changes.

- Usage and format details: [docs/Craft.md](docs/Craft.md)
- Design, decisions and status: [docs/craft-integration-plan.md](docs/craft-integration-plan.md)

Stay rebaseable: all Craft logic lives in `src/utils/craft/*`, `src/utils/save-destination.ts` and `src/managers/craft-settings.ts`; edits to upstream files are kept to small, guarded hunks.

```bash
# track upstream
 git remote add upstream https://github.com/obsidianmd/obsidian-clipper.git
 git fetch upstream && git merge upstream/main   # then: npm run build && npm test
```

## This fork: AI translation in Reader

Reader mode can translate the page you are reading, bilingually, without sending the whole article to a model:

- Configure any OpenAI-compatible endpoint (base URL + key + model) in **Settings → AI**, with a connection test.
- Only the text within one viewport above and below the screen is queued; nothing is sent while you are scrolling.
- **Remembered, not re-requested**: finished paragraphs are cached in IndexedDB for 90 days, so re-opening an article costs nothing — and the key covers endpoint, model, languages and the whole prompt, so changing any of them translates again instead of serving the old answer.
- Works for YouTube too — the description keeps its lines, and caption lines are translated near the screen without breaking player seeking.
- The translation prompt is editable (tone, glossary, domain context), with the output contract appended for you.
- **Usage** (issue #1): Settings → AI shows requests, input and output tokens, what the cache saved, and an optional reference cost — kept on this device only, never synced.

Usage, cost controls and the prompt format: [docs/AI translation.md](docs/AI%20translation.md)

All AI logic lives in `src/utils/ai/*` plus `src/utils/reader-translate.ts`; requests go through the background page so the key never reaches a content script. Everything else in the page — highlights, selection, the markdown that gets saved — is left alone.

## This fork: Auto Reader

Reader can open pages on its own. List the sites or links you always read cleanly, and Reader opens them the moment they finish loading — no toolbar click per article.

- A rule is a domain (subdomains included), optionally narrowed to a path, a full address prefix, or a `/regex/`. A leading `-` carves an exception out of the rest.
- Turning Reader off in a tab keeps it off there: the page you just left is not pushed back into Reader by the next load.

Configure it in **Settings → Reader → Auto Reader**. Rule format and limits: [docs/Auto Reader.md](docs/Auto%20Reader.md)

Matching and the per-tab opt-out live in `src/utils/auto-reader.ts`; the background script only injects and toggles.

## Get started

Install the extension by downloading it from the official directory for your browser:

- **[Chrome Web Store](https://chromewebstore.google.com/detail/obsidian-web-clipper/cnjifjpddelmedmihgijeibhnjfabmlf)** for Chrome, Brave, Arc, Orion, and other Chromium-based browsers.
- **[Firefox Add-Ons](https://addons.mozilla.org/en-US/firefox/addon/web-clipper-obsidian/)** for Firefox and Firefox Mobile.
- **[Safari Extensions](https://apps.apple.com/us/app/obsidian-web-clipper/id6720708363)** for macOS, iOS, and iPadOS.
- **[Edge Add-Ons](https://microsoftedge.microsoft.com/addons/detail/obsidian-web-clipper/eigdjhmgnaaeaonimdklocfekkaanfme)** for Microsoft Edge.

## Use the extension

Documentation is available on the [Obsidian Help site](https://help.obsidian.md/web-clipper), which covers how to use [highlighting](https://help.obsidian.md/web-clipper/highlight), [templates](https://help.obsidian.md/web-clipper/templates), [variables](https://help.obsidian.md/web-clipper/variables), [filters](https://help.obsidian.md/web-clipper/filters), and more.

## Contribute

### Documentation

User documentation is maintained in the [`en/Obsidian Web Clipper` directory of obsidian-help](https://github.com/obsidianmd/obsidian-help/tree/master/en/Obsidian%20Web%20Clipper).

### Translations

You can help translate Web Clipper into your language. Submit your translation via pull request using the format found in the [/_locales](/src/_locales) folder.

### Features and bug fixes

See the [help wanted](https://github.com/obsidianmd/obsidian-clipper/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) tag for issues where contributions are welcome.

## Roadmap

In no particular order:

- [ ] Annotate highlights
- [ ] Template directory
- [ ] Sync settings across browsers
- [x] A separate icon for Web Clipper (1.6.3)
- [x] Template validation (1.1.0)
- [x] Template logic (if/for)  (1.1.0)
- [x] Save images locally ([Obsidian 1.8.0](https://obsidian.md/changelog/2024-12-18-desktop-v1.8.0/))
- [x] Translate UI into more languages — help is welcomed

## Developers

To build the extension:

```
npm run build
```

This will create three directories:
- `dist/` for the Chromium version
- `dist_firefox/` for the Firefox version
- `dist_safari/` for the Safari version

### Install the extension locally

For Chromium browsers, such as Chrome, Brave, Edge, and Arc:

1. Open your browser and navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist` directory

For Firefox:

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Navigate to the `dist_firefox` directory and select the `manifest.json` file

If you want to run the extension permanently you can do so with the Nightly or Developer versions of Firefox.

1. Type `about:config` in the URL bar
2. In the Search box type `xpinstall.signatures.required`
3. Double-click the preference, or right-click and select "Toggle", to set it to `false`.
4. Go to `about:addons` > gear icon > **Install Add-on From File…**

For iOS Simulator testing on macOS:

1. Run `npm run build` to build the extension
2. Open `xcode/Obsidian Web Clipper/Obsidian Web Clipper.xcodeproj` in Xcode
3. Select the **Obsidian Web Clipper (iOS)** scheme from the scheme selector
4. Choose an iOS Simulator device and click **Run** to build and launch the app
5. Once the app is running on the simulator, open **Safari**
6. Navigate to a webpage and tap the **Extensions** button in Safari to access the Web Clipper extension

### Run tests

```
npm test
```

Or run in watch mode during development:

```
npm run test:watch
```

## Third-party libraries

- [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) for browser compatibility
- [defuddle](https://github.com/kepano/defuddle) for content extraction and Markdown conversion
- [dayjs](https://github.com/iamkun/dayjs) for date parsing and formatting
- [lz-string](https://github.com/pieroxy/lz-string) to compress templates to reduce storage space
- [lucide](https://github.com/lucide-icons/lucide) for icons
- [dompurify](https://github.com/cure53/DOMPurify) for sanitizing HTML

## License

OpenCraftClipper is distributed under the MIT License. The upstream copyright notice is retained unchanged, as that license requires:

> Copyright (c) 2024 Obsidian

Upstream's exclusion applies to this fork verbatim:

> Obsidian Web Clipper source code is open source under the MIT License. All trademarks, icons, marketing copy, and other marketing assets are excluded from that license.

So the **name and logo are not part of what you may reuse here**: `src/icons/` still contains upstream's artwork and must be replaced before publishing this build as its own product.
