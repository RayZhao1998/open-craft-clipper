# Craft 保存目标集成方案（open-craft-clipper）

目标：在 Obsidian Web Clipper 的既有流水线（Defuddle 抽取 → 模板引擎 → 变量/过滤器/highlights/Interpreter）之上，增加第二个「保存目的地」Craft，复用 CraftClipper 已验证的 Craft Space API 调用与文档格式。

参考实现：`/Users/ziyuanzhao/Documents/Develop/CraftClipper`（`src/lib/craft.ts`、`src/lib/markdown.ts`、`src/background.ts`、`DESIGN.md`）。

---

## 1. 现状（fork 上游的关键结构）

| 关注点 | 位置 | 说明 |
| --- | --- | --- |
| 保存行为枚举 | `src/types/types.ts` | `SaveBehavior = 'addToObsidian' \| 'saveFile' \| 'copyToClipboard'`，同时散在 `Settings.stats` / `HistoryEntry.action` |
| 主按钮 & 次级菜单 | `src/core/popup.ts` `determineMainAction()` / `addSecondaryAction()` / `getActionIcon()` | 1412 行大文件，上游改动最频繁 |
| Obsidian 落盘 | `src/utils/obsidian-note-creator.ts` | `generateFrontmatter()` + `saveToObsidian()`（obsidian:// URI + clipboard） |
| 设置存储 | `src/utils/storage-utils.ts` | `storage.sync`，按 `general_settings` / `interpreter_settings` / `property_types` 分组 |
| 设置页 | `src/settings.html` + `src/managers/*.ts` + `src/core/settings.ts` | 静态 HTML + manager 初始化函数，sidebar section 硬编码 |
| 特权操作 | `src/background.ts` | `runtime.sendMessage({ action })`，如 `openObsidianUrl` |
| 统计/历史 | `incrementStat()` + `src/utils/charts.ts` | 图表按 history 的 `action` 聚合（非 `readerMode` 都算 saved） |
| i18n | `src/_locales/*/messages.json`（36 语言） | 缺 key 自动回退英文，`npm run check-strings` 校验 |
| Manifest | `src/manifest.{chrome,firefox,safari}.json` | 三者均已含 `<all_urls>` host_permissions |

结论：**模板引擎产出的就是 `frontmatter + noteContentFormat` 字符串**，Craft 集成只需要替换「最后一公里」，不需要动抽取与模板系统。这是本方案与独立 CraftClipper 的最大差异点——上游的模板/变量/highlights/Interpreter 能力全部可复用。

---

## 2. 设计决策

### 2.1 集成的形态：destination seam（推荐）

不去 popup 里到处 `if (isCraft)`，而是引入一个很窄的「保存出口」接缝：

```
src/utils/save-destination.ts
  resolveSaveDestination(template, settings): 'obsidian' | 'craft'
  saveClip(payload, destination): Promise<SaveResult>
```

- `payload = { noteName, content, frontmatter, properties, vault, path, folderId, behavior }`（popup 现有产物原样传入）
- Obsidian 分支只是把现有 `saveToObsidian()` 调用搬进 adapter，行为不变
- popup 只增加约 30–40 行：主按钮/次级菜单多一项、footer 多一个 Craft folder 选择器

这样上游 `popup.ts` 每次改动，我们只有一个 hunk 需要 rebase。

### 2.2 目的地如何决定（三层优先级）

1. `Template.destination?: 'obsidian' | 'craft'`（模板级覆盖，默认不设 = 跟随全局）
2. `Settings.craft.destinationDefault` / 现有 `Settings.saveBehavior` 新增 `'addToCraft'`（全局默认，出现在设置的下拉与 popup 主按钮）
3. popup 内的临时切换（主按钮 + `more-dropdown` 次级动作，与现有三个行为一致）

> 待确认：是否要模板级 `destination`（见 §6 问题 3）。

### 2.3 Craft 侧的语义映射

| Obsidian 概念 | Craft 对应 | 处理 |
| --- | --- | --- |
| vault | Space（API link 决定） | 只读显示 space name |
| folder path | `folderId`（`GET /folders` 树） | popup 里 folder `<select>`，扁平化标签 `Projects / Work`，默认 `unsorted`，记住上次用 |
| 新笔记 | `POST /documents` → `POST /blocks` | 一致 |
| append/prepend/overwrite、daily note | 无对应 | v1 不支持，模板选 Craft 目的地时这些 behavior 灰掉/提示「将按新建文档保存」（`POST /blocks` 支持 `pageId` 追加，v2 可做「按标题追加到已有文档」） |
| YAML frontmatter | 不支持 | 转成文档头部 callout（见 2.4）或丢弃 |

### 2.4 内容格式适配（唯一有真实工作量的部分）

新模块 `src/utils/craft/markdown.ts`（纯函数、vitest 覆盖）：

1. **头部（properties → callouts）**，默认对齐官方 clipper 结构（CraftClipper `buildClipMarkdown` 已验证）：

```
<callout>[{title}]({url})</callout>

<callout>Site: **{site}**</callout>
<callout>Author: **{author}**</callout>      ← 仅当属性存在
<callout>source: {source}</callout>           ← 其余 property 逐条渲染

<callout>#clippings</callout>                 ← 可配置 tag 行
<callout><caption>Saved [Tue, 7 Jul](date://2026-07-07) at 14:32</caption></callout>

***

{body}
```

   - 提供 `craft.headerFormat`（可选、用现有模板引擎渲染，支持 `{{title}}`、`{{properties}}` 等变量）；留空则用「properties 逐条 callout」的内置默认。
   - `craft.propertiesAs: 'callouts' | 'strip'`（默认 callouts）。

2. **正文语法转换**（Obsidian → Craft，逐条纯函数）：
   - `> [!note] 标题` / `> [!quote]` 等 callout → `<callout>`（保留 emoji 时用 `<callout emoji="💡">`）
   - `![[image.png]]` → 可解析为绝对 URL 时转 `![image](https://…)`，否则丢弃
   - `[[页面]]` / `[[页面|别名]]` / `[[#标题]]` → `[别名](obsidian://…)` 或纯文本（可设置）
   - `%% 注释 %%` → 删除
   - 表格、脚注、`$math$`、代码块：原样透传（Craft markdown 支持）
   - 相对 `<img src>` / `![alt](/foo.png)` → 按页面 URL 解析为绝对地址（Craft 抓取远端 URL）
3. **图片**：v1 保留远程 URL（与 CraftClipper 的 non-goal 一致）；`POST /upload` 逐文件上传放 v2。
4. **分块写入**：直接移植 `splitIntoBlocks` / `splitMarkdownIntoChunks`（100KB 上限、fence 内不切分）+ 其测试。

### 2.5 API 客户端与调用位置

- 移植 `CraftClipper/src/lib/craft.ts` → `src/utils/craft/api.ts`，几乎逐行照搬：`normalizeApiUrl`、`CraftApiError`、`getConnection`、`getFolders`、`createDocument`、`appendMarkdown`。仅一处改动：base URL 由存储值解析，不再硬编码 `connect.craft.do`（便于将来代理/自建）。
- 所有网络调用放在 **background service worker**（避开页面 CSP/CORS，secret 只在一处使用），`src/background.ts` 新增 3 个 action：
  - `craftTestConnection { apiUrl }` → `{ space }`
  - `craftGetFolders { force? }` → `{ folders }`（顺带在 background 侧做 10 分钟 TTL 缓存，popup 和设置页共用）
  - `craftSave { title, markdown, folderId }` → `{ documentId, clickableLink }`
- popup 只做 UI 与消息编排；`clickableLink`（`craftdocs://`）用于「在 Craft 中打开」，是否自动打开跟随现有 `silentOpen` 语义。

### 2.6 存储与安全

- 新增 `storage.sync` 分组 `craft_settings`（与 `interpreter_settings` 同构，`storage-utils.ts` 的 defaults + sanitize 各加一小段）：

```ts
craft: {
  enabled: boolean;
  apiUrl: string;              // 规范化后的 .../api/v1
  defaultFolderId: string;     // 'unsorted'
  propertiesAs: 'callouts' | 'strip';
  headerFormat: string;        // 可空
  tags: string;                // 默认 "#clippings"
  wikilinkMode: 'link' | 'plain';
}
```

- **待定（§6 问题 7）**：`apiUrl` 即凭证。放 `sync` = 跨设备同步（CraftClipper 的选择，但会进浏览器账号、单值 8KB 限制）；放 `local` = 不同步但不泄漏。个人建议 **`apiUrl` 存 `local`，其余偏好存 `sync`**，并明确它不参与 export/import（或导出时脱敏）。
- 日志脱敏：`debugLog` / `console.log` 里对 `connect.craft.do/links/<id>` 做 mask，Obsidian 路径里现在会 `console.log` URL，别照抄这个习惯。
- Manifest：三个 manifest 的 `host_permissions` 显式加 `https://connect.craft.do/*`（当前已有 `<all_urls>`，加它是为了将来收紧权限）。

### 2.7 统计 / 历史 / i18n

- `SaveBehavior`、`Settings['stats']`、`HistoryEntry['action']` 加 `'addToCraft'`；`incrementStat('addToCraft', spaceName, folderPath, url, title)`（复用 vault/path 两字段承载 space/folder，避免动 history 结构）。
- 图表无需改（非 `readerMode` 即计入 saved）；如要区分，v2 给 metric 下拉加 Craft 维度。
- `getActionIcon('addToCraft')` → `book-open`（或自定义 Craft 图标）；新增 i18n key 只加 `en`（+ `zh_CN`），其他 34 个 locale 自动回退英文，之后可另开 PR 补翻译。

---

## 3. 文件级改动清单

**新增（上游合并时零冲突）**

| 文件 | 内容 |
| --- | --- |
| `src/utils/craft/api.ts` | Space API 客户端（移植） |
| `src/utils/craft/markdown.ts` | 头部 callout 构造 + 语法转换 + 分块（移植 + 扩展） |
| `src/utils/craft/markdown.test.ts` | vitest |
| `src/utils/craft/storage.ts` | folder 缓存、lastFolderId（如不走 background 缓存） |
| `src/utils/save-destination.ts` | destination 解析 + `saveClip()` 出口 |
| `src/managers/craft-settings.ts` | 设置页 Craft section（API link、测试连接、folder 选择、格式选项） |
| `docs/craft-clipper.md` | 使用说明（含如何拿 Space API link、安全提示） |

**最小化改动（每处 ≤ 数行，便于 rebase）**

| 文件 | 改动 |
| --- | --- |
| `src/types/types.ts` | `SaveBehavior`、`Settings.craft`、`stats.addToCraft`、`HistoryEntry.action`、`Template.destination?` |
| `src/utils/storage-utils.ts` | defaults + sanitize + `StorageData.craft_settings` |
| `src/core/popup.ts` | 主按钮/次级菜单分支、footer folder select、成功态 |
| `src/background.ts` | 3 个 craft action handler + 缓存 |
| `src/popup.html` | `#craft-folder-select`（`vault-path-container` 内，默认 hidden） |
| `src/settings.html` + `src/core/settings.ts` | sidebar 新增 `data-section="craft"` + section 容器 + 初始化调用 + section 白名单 |
| `src/managers/general-settings.ts` | save behavior 下拉可选值加 `addToCraft`（仅当 craft.enabled） |
| `src/utils/import-export.ts` | craft 设置的导出/导入（可选脱敏） |
| `src/manifest.*.json` | host_permissions |
| `src/_locales/en/messages.json`（`zh_CN`） | 新文案 |
| `src/style.scss` / `src/styles/*.scss` | folder select 与「Open in Craft」成功态样式 |

---

## 4. 分阶段落地

| 阶段 | 内容 | 验收 | 工作量 |
| --- | --- | --- | --- |
| P0 骨架 | api.ts 移植 + 类型 + `craft_settings` 存储 + 设置页 section + background 三个 handler | 设置页填 link → 测试连接显示 space name → folder 树能加载 | 0.5–1 天 |
| P1 主流程 | `save-destination.ts` + popup「Add to Craft」+ folder 选择器 + 新建文档并写入 + 统计/历史 + i18n | 默认模板一键存进 Craft 指定 folder，popup 成功态给出 Open in Craft | 1 天 |
| P2 格式适配 | frontmatter→callouts、`headerFormat`、wikilink/embed/callout 转换、相对图片绝对化 + 测试 | 用现有默认模板+highlight+Interpreter 生成的内容在 Craft 里渲染正确 | 1 天 |
| P3 打磨 | 模板级 destination、quick clip 命令、reader 视图按钮、失败重试/错误文案、folder 缓存刷新、可选 `POST /upload` 图片 | — | 0.5–1 天 |

---

## 5. 上游同步策略（fork 维护）

1. `git remote add upstream https://github.com/obsidianmd/obsidian-clipper.git`，本地分支：`main`（跟随 upstream）、`feat/craft-destination`（我们的改动）。
2. 所有 Craft 逻辑放新文件；共享文件改动控制在「可一眼 review 的 hunk」，并用 `craft.enabled` 守卫，保证 Craft 关闭时行为与上游逐字节一致。
3. 每次 upstream merge 后必跑：`npm run build && npm test`，再手工过一遍 4 条路径：Obsidian 保存 / Craft 保存 / 存文件 / 复制到剪贴板。
4. `npm run check-strings` 保证新 i18n key 无未使用/缺失。
5. 版本号与 upstream changelog 分离，`package.json` name 改为 `open-craft-clipper`、manifest `name` 加自己的标识（避免与商店版冲突，也便于两个扩展并存）。

---

## 6. 需要你拍板的问题（已答复，见 §8）

1. **追加语义**：Craft 只支持「新建文档 + 末尾追加」。是否需要 v2 的「按标题追加到已有文档」（能近似实现 daily note）？
2. **frontmatter**：默认把 properties 渲染成头部 callouts，还是整段丢弃？是否需要可编辑的 `headerFormat`（我倾向要，成本很低但很值）。
3. **目的地来源**：只要全局 saveBehavior 加一项，还是同时支持模板级 `destination`（我推荐后者，长期更顺手，代价是 `template-ui` 多一个下拉）。
4. **Obsidian 语法**：`[[wikilink]]` 转成 `[文本](obsidian://…)` 还是纯文本？`![[embed]]` 是丢弃还是尽量转成远程图片？
5. **图片**：v1 保留远程 URL 是否可接受（Craft 需要联网渲染，原站防盗链/过期会裂）？
6. **构建目标**：Chrome 优先，还是三个 build（Chrome/Firefox/Safari）一开始就都要绿？工作量主要在 i18n 与样式回归。
7. **API link 存哪**：`storage.sync`（跨设备同步，凭证进浏览器账号）vs `storage.local`（不同步）——我建议 local，导出时默认脱敏。

---

## 7. 风险清单

- `src/core/popup.ts` 是上游高频改动文件，任何直接改它的实现都会成为 rebase 痛点 → 已通过 `save-destination.ts` 收敛，务必保持 popup 改动量。
- Craft `POST /blocks` 的 markdown 方言与上游模板用户习惯不一致（用户写的模板里会有 Obsidian 语法）→ P2 的转换层是价值核心，要写测试锁住。
- 大页面（长 transcript）分块写入是串行 N 次请求，需要进度/超时与失败重试（当前 CraftClipper 是「失败就中断，前面的块已写入」，可改进为记录已写块数并支持续写）。
- 401/404 与撤销 Space link 的用户提示要清晰（secret link 一旦在 Craft 端 revoke，只能让用户重新粘贴）。
- `clipboardWrite` 等既有权限不变；新增网络域名权限会触发已安装用户的权限变更提示（发布说明里提一句）。

---

## 8. 决策记录与实施进度

### 决策（已确认）

1. **目的地来源**：全局 saveBehavior + 模板级 `Template.destination`（双层，模板优先）。
2. **frontmatter**：默认把 properties 渲染成头部 callouts；提供可编辑 `craft.headerFormat`（用模板引擎渲染）。
3. **图片**：v1 只保留远程 URL，不做 `POST /upload`。
4. **存储**：与 Obsidian clipper 其它设置一致 —— `storage.sync` 的 `craft_settings` 分组（因此会随浏览器账号同步，也会被「导出全部设置」包含；UI 里有醒目提示）。
5. **wikilinks** 默认转纯文本（可切 `obsidian://search` 链接），`![[embed]]` 可解析时转远程图片、否则丢弃。
6. 三个 build（Chrome/Firefox/Safari）一起保持可构建。

### 已完成（P0 + P1 + P2）

**新增文件（上游合并零冲突）**

| 文件 | 作用 |
| --- | --- |
| `src/utils/craft/api.ts` | Space API 客户端（normalize / connection / folders / documents / blocks + fence-safe 分块）+ `maskSecretLink` 日志脱敏 |
| `src/utils/craft/client.ts` | UI ↔ background 消息协议（`craftTestConnection` / `craftGetFolders` / `craftSave`） |
| `src/utils/craft/folders.ts` | folder 树缓存（10min TTL）、扁平化选项、last-used folder |
| `src/utils/craft/markdown.ts` | properties → callouts 头部、tags、caption、`***`、frontmatter 兜底剥离 |
| `src/utils/craft/syntax.ts` | Obsidian → Craft 语法（callout / wikilink / embed / `==hl==` / `%%comment%%` / 相对图片绝对化），代码区保护 |
| `src/utils/craft/note-creator.ts` | 对应 `obsidian-note-creator.ts` 的 Craft 落点 |
| `src/utils/save-destination.ts` | `resolveSaveDestination()` 决策接缝 |
| `src/managers/craft-settings.ts` | 设置页 Craft section |
| `src/utils/craft/*.test.ts` | 40 个用例（api / markdown / syntax） |
| `docs/Craft.md` | 使用说明 |

**改动到的上游文件**（每处均为小 hunk）：`types/types.ts`、`utils/storage-utils.ts`、`utils/cli-stubs.ts`、`core/popup.ts`、`core/settings.ts`、`background.ts`、`managers/settings-section-ui.ts`、`managers/general-settings.ts`、`managers/template-ui.ts`、`settings.html`、`popup.html`、`icons/icons.ts`、`styles/settings.scss`、`styles/popup.scss`、`manifest.*.json`、`_locales/{en,zh_CN}/messages.json`。

Popup 侧的唯一「重构」是把 `handleClipObsidian` 里的 interpreter 等待逻辑抽成 `runInterpreterIfNeeded()` 供两条路径共用。

### 待办（P3）

- Reader 视图 / 快捷命令（quick clip）走 Craft 目的地。
- 分块写入失败续写（当前失败即中断，前面块已写入）。
- 空间名缓存展示、folder 刷新按钮的 loading 态。
- Craft 文档「按标题追加到已有文档」（近似 daily note）。

### 验证情况

- `npx tsc --noEmit` 干净（仅剩上游 `cli.ts` 的 TS1323 既存错误）。
- `npm test`：新增 40 个 Craft 用例全绿；唯一失败 `template-integration.test.ts > 'youtube'` 在上游干净树上同样失败（既存）。
- `npm run build`（chrome/firefox/safari）全部成功。
- `npm run check-strings` 在上游是坏的（读 `src/locales` 而非 `src/_locales`），已用脚本静态核对 `data-i18n` key 与 DOM id。
- **无法自动冒烟**：Chrome 151 正式版忽略 `--load-extension`/`--disable-extensions-except`（`extension_service.cc` 直接 ignore），需人工 `Load unpacked` 验证。

### 人工验收清单

1. `npm run build:chrome` → `chrome://extensions` → Load unpacked → 选 `dist/`。
2. 设置 → Craft：开关、粘贴 API link（试 id-only / share link / 完整链接三种）、Test connection 应显示空间名；错误 link 应显示红字且**不回显完整 secret link**。
3. Default folder 下拉出现空间目录树；刷新按钮能重取。
4. General → Save behavior 出现「Add to Craft」（未启用 Craft 时该选项应隐藏）。
5. 模板 → Save to = Craft：Behavior 锁为 create、Vault/Note location 隐藏；popup 主按钮变「Add to Craft」，底部变 folder 选择器，vault/path 行消失。
6. 剪一个普通网页 → Craft 内确认：标题、头部 callout、tag、caption、`***`、正文渲染正常，代码块未被改写。
7. 剪一个含 `[[wikilink]]`、`> [!tip]`、`![[img]]`、相对图片、`==高亮==`、`%%注释%%` 的页面（或自定义模板塞这些语法）逐条核对。
8. 长文（> 100KB，如 YouTube transcript）能保存且顺序正确。
9. 切回 Obsidian 目的地：vault/path 恢复、Add to Obsidian 行为与上游一致（含 clipboard 回退）。
10. 中文/英文语言下 Craft section 文案完整（其余 34 个 locale 回退英文）。
