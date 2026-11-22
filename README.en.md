# Qua

A desktop outliner built for notes you'll write once and use again and again.

**[中文 README](README.md)** · The interface comes in Chinese and English; it follows your system language by default and can be switched in Settings.

In Qua, every line you write is an independently actionable unit: tag it, give it properties, reference it from anywhere, drag it into a table or board to rearrange it, or mirror it onto multiple pages. Change it in one place and every place it appears updates in sync—content never gets locked inside the page where you wrote it.

![Qua's default interface: the body is an editable tree of blocks, with toggleable side docks on both edges](shots/readme-hero-en.png)

---

## Join the community

Interested, have questions, or just want to chat? Join the QQ group "qua 双链笔记" (group number: 1044063116)—scan the QR code below to join.

<p align="center"><img src="shots/qq-group-qr.png" alt="qua 双链笔记 QQ 群二维码（群号 1044063116）" width="280"></p>

---

## Quick start

**Try it online**: [qua.leay.net](https://qua.leay.net/) — open it and start writing, no installation needed. Your data stays in your own browser and is never uploaded to any server.

**macOS desktop app** (Apple Silicon): download the latest `.dmg` from [Releases](https://github.com/hqweay/qua/releases) and drag it into Applications. The installer is unsigned, so if macOS blocks it on first launch, right-click → Open.

**Windows desktop app** (x64): download the latest `.exe` installer from [Releases](https://github.com/hqweay/qua/releases) and double-click to install. The installer is unsigned, so if SmartScreen blocks it, click More info → Run anyway.

Both desktop apps use SQLite for storage and full-text search, with a more complete feature set than the browser version.

### About the beta

Qua is still in beta, so there are a few things worth spelling out up front:

- **Old data may not survive a version upgrade.** When the data format changes, we switch straight to the new format rather than writing a migration. Before a format change, the desktop app automatically leaves a `backups/` snapshot in the repo directory; to be extra safe, copy the entire repo directory ("Documents/Qua") before upgrading.
- **No import/export or cloud sync yet**—your data lives only on your own computer (or in your browser).
- **The interface comes in Chinese and English**, follows your system language by default, and can be switched in Settings.
- The app checks for a new version every 5 hours and mentions it in the "Qua" menu; installing it is still up to you.
- If you run into any problems, let us know in [Issues](https://github.com/hqweay/qua/issues).

---

## What makes it different

There are no rigid boundaries between pages, daily notes, tags, and views: a page can be a member of a tag, appear in three query results at once, and be referenced from another page—all of these are different uses of the same content, not three copies. A few concrete properties:

- **One block, many places.** Mirrored onto another page, pinned into a dock window, surfaced by a query—it's the same block everywhere, editable in place, with changes synced across all of them. Deletion is reversible too: deleted blocks go to the trash, and when restored their names, properties, and incoming references all come back exactly as they were.
- **Values are separate from categories.** Which tags a block "belongs to" and which field values are filled in on it are two different things: tags categorize, fields hold values. A tag can declare fields for its members, and each member fills them in and displays them independently.
- **Views are separate from data.** The same content can be seen from different angles—outline, table, board, calendar, mind map, and more. Switching views never rearranges your data, and changing a view never touches your content.
- **Names are separate from the body.** Page and tag names are addresses; the body is a description. Editing the body never changes the name; references always show the target's current name, so renaming a target updates every reference to it.
- **A library is just a folder.** A library is an ordinary directory (`library.json` + `qua.db` + `assets/`). No account, no server; copying the whole folder is a complete backup.

The model behind this design (why pages, daily notes, tags, and views can all be reduced to blocks) is written up in [`docs/模型-一切皆块.md`](docs/模型-一切皆块.md)—read it if you're curious; you don't need it to use Qua.

![Side dock: the right dock is a stack of cards (windows, inspector, mount area, trash, and more); a window card holds the same content and can be edited directly](shots/dock-窗口卡.png)

---

## What you can do

**Write**: the body is an editable tree of blocks. Bold, italic, highlight, inline code, text color, and background color all travel with the text; `[[references]]`, `#tags`, `@names`, external links, and images are self-contained inline units, so adding or deleting them never damages the characters nearby—deleting at the end of a line won't break a reference into stray characters, and deleting text won't turn a tag into a handful of `#` symbols. Pasting a bare URL automatically turns it into a link. Shortcuts step aside during IME composition, so Chinese input is never interrupted. Select a span of text to add a **note** (comments follow the text) or set a color from the selection bubble; cross-block selections under the same parent block can be deleted or edited in place (the first and last fragments merge into one block). With multiple blocks selected, you can drag them as a group, delete or indent them in bulk—`⌘⇧A` upgrades "the words on this line" into "these blocks".

![Slash menu: type / at the start of a line to insert a to-do, query block, reference, date, or image in place](shots/overlay-斜杠菜单.png)

**Capture**: quick notes land in today's daily note; `⌘T` brings you back to today any time, `⌘⇧R` reviews the last three days (`⌘⌥⇧R` the last seven); `@` mentions pages and blocks, creating a page on the spot if no page with that name exists; every daily note and page can be given an **icon and color**, so you can tell at a glance what's what. The daily-note host also carries a few built-in sections: references, created today, notes, and mentions.

**Organize**: a block can belong to several tags at once, and tags themselves can be hierarchical. The **Directory** card in the left panel spreads the library's structural objects across four faces—pages, tags, property definitions, automations. The first two lay out the membership tree: dragging a block in adds a membership relation, it doesn't move the block. The last two are flat lists by identity and read-only. Properties are declared on tags, written on each block itself, and edited in place in the inspector card on the right. There are seven property types: text, number, date, switch, option, reference, and attachment. Text can carry formatting (link / email / phone), and dates can be a date or a date-time; text, number, option, reference, and attachment can all store **multiple values**, displayed as a row of chips. A reference property can narrow its candidate pool (under certain tags, a specified set of blocks, or the results of a query) and display as a chip or an editable inline reference; an attachment value can be an external link or a local image imported into the library. Mark an option field as "task status" and checking it completes the task, using the same interactions and queries as built-in to-dos.

When references point at the wrong target, you don't have to fix them one by one: the header of the backlinks bar and of a tag's members bar both offer "**Retarget…**"—pick a new target once and that whole batch of references moves over, undoable in one step.

Deletion has a single entry point: a block, a day, a page, a tag, a field definition all show the same "Delete" row in the menu. The confirmation only spells out what goes with it; deleted things go to the trash, and restoring brings back names, properties, and relations exactly as they were.

**Automation**: an automation is a block that reads "**if … then …**". Triggers can be manual, a property change, a tag being added or removed, or a new child under a block; the "if" uses the same condition language as queries to circle up targets; the "then" is a small closed set of built-in actions: set/clear a property, add/remove a tag, insert a child, move. A manual run acts on the block you selected; to run over a batch, use the "if" to define the range. Each run is one transaction—a failure rolls the whole batch back, and one undo reverses the run. Disabled/active is part of the definition (it travels with the library), so a rule you got from somewhere else never starts firing on its own.

**View**: the direct children of a page (or of any block) can be presented in seven views: outline, table, outline-table, cards (a gallery when ungrouped, a board when grouped by a property, with a toggle to "use the body's first image as the cover"), calendar, mind map, and tabs; query results can switch among four views: outline, table, cards, and calendar. Switching views never rearranges data, and changing a view never touches your content. Each view has an "Options" button in its header that gathers sorting, filtering, grouping, and display into one panel: tables let you drag column widths, cards let you adjust covers, and a grouped column header is that property's value. To look at a batch of blocks at once, use a query to circle up the members: conditions form a nestable condition tree, with each line reading like a sentence; "unfilled tasks" and "not tasks" are clearly distinguished; you can also ask existence questions like "has children", "has body", "has tag", or write relative dates like "before today" or "last seven days".

![Condition tree: one condition per line, each reading like a sentence; nothing is written until you click Apply](shots/query-条件树.png)

**Find**: full-text search on the desktop runs on a SQLite full-text index (Chinese word segmentation + pinyin); `⌘K` finds blocks by keyword, with hits you can preview and edit in place, and the `⌘P` command palette runs every command—no need to memorize shortcuts. The search surface can live permanently as a dock card or a center tab, and a set of search results can be "promoted into a query block" right where it is, becoming a view that refreshes itself. All keybindings can be changed in Settings.

---

## The shape language in the body

Several kinds of atoms can live inside one block's text. The shape itself carries the relation:

| What you type | What it is | How to read it |
|---|---|---|
| `[[Page name]]` | page reference | bold with double brackets; click to go there, `Shift+click` opens it in a dock window |
| `#Name` | inline tag / inline instance | takes one slot in the text; points at a tag or a record—it does **not** tag the block for you |
| the chip at line end | tag **membership** | decided by the block's own tags; deleting text doesn't remove it—remove it explicitly in the inspector |
| the triangle (left of the chip) | this tag has fields | click to fill values in place; tags without fields don't get a triangle |
| `@Name` | reference to a page or a named block | once an ordinary block has a name, `@` finds it just like a page |
| image / external link | inline atom | images are content-addressed, so pasting twice stores once; a link opens in your system browser |

Tags answer "whose content is this"; field values answer "what does this content carry"—keeping them apart means deleting text, renaming, or moving never damages the other.

---

## Common keyboard shortcuts

| Key | What it does |
|---|---|
| `Enter` / `⇧Enter` | create the next sibling / a child at the insertion point |
| `Tab` / `⇧Tab` | indent / outdent |
| `⌘⏎` | toggle to-do completion |
| `⌘B` / `⌘I` / `⌘E` / `` ⌘` `` | bold / italic / highlight / inline code (select text first) |
| `⌘⇧K` / `@` / `#` | insert an inline reference / reference a page or block / insert an inline tag |
| `⌘.` | fold / unfold the current block |
| `⌘Z` / `⌘⇧Z` | undo / redo (while the editor has focus) |
| `⌘⇧A` | select this line → these blocks |
| `⌘P` | command palette |
| `⌘K` | global search (always available; inserting a link lives in the slash menu and block menu) |
| `⌘T` / `⌘⇧R` | back to today's journal / review the last three days |
| `⌘⌥1` / `⌘⌥2` | toggle the left / right dock |
| `⌘⇧L` / `⌘,` | toggle theme / Settings (the interface language lives here too) |
| `⌘⇧?` | keymap (every command's shortcut and when it applies) |

Mouse: the block handle sits to the left of each row and turns into a drag grip on hover; left-click focuses, right-click opens the menu, drag reorders. `Shift+click` opens a window in the side dock, `⌥+click` shows property details in place. Rows in record views (table / cards / list / calendar) open the same block menu on right-click—the menu opens for the block you clicked, deletion and copying are undoable, and only actions that make sense for a block appear (indent/fold and other editor-dependent ones don't).

---

## Where your data lives

- **Desktop**: each library is a directory under "Documents/Qua" (`repos/<id>/`); content lives in `qua.db` (SQLite), and images are stored by content hash under `assets/`. Every edit writes only what changed, so a big library doesn't get slower. `Qua/app.json` records the library list, and you can open any external directory as a library. Before a data-format change, the app leaves a full-library snapshot in `backups/`.
- **Browser**: text and structure live in the browser's localStorage, and inline images in IndexedDB; think about backups before switching devices or clearing browser data. Search in the web version is a local scan, without word segmentation or pinyin.
- **Deletion**: deletes are soft; the trash restores with one click, and only emptying the trash makes it final.

---

## Current limitations

- No import/export (Markdown and other formats are not supported yet) and no cloud sync.
- The desktop app is unsigned (on macOS, right-click → Open the first time) and does not update itself: it checks for a new version every 5 hours and mentions it in the "Qua" menu; installing it is up to you. Back up the library directory before upgrading.
- Cross-block merging has unfinished edges: a cross-block selection that spans different parents, or whose first block is a section root (the first level of a page or daily note), can't be deleted or replaced yet.
- Inline assets and attachments currently accept images only; an attachment value can also be an external link.
- Automation actions are a small closed set of built-in operations—no scripting. Richer workflows will have to wait for a plugin system.
- The interface is available in Chinese and English (system language by default, switchable in Settings); there is no mobile app, collaboration, or plugin system, and none of those are near-term goals.

---

## Feedback

Bugs, data oddities, or anything that feels off—open an
[Issue](https://github.com/hqweay/qua/issues).
One sentence covering "which screen, what you did, what you expected, what actually happened" is a very useful report; for data problems, describe what you did—no need to attach the library file (it contains your content).

---

## Contributing

```bash
pnpm install
pnpm dev            # vite + electron together
pnpm dev:web        # browser only → http://127.0.0.1:5180/
pnpm gate           # full gate: static checks + unit tests + build + smoke + real Electron
pnpm build:mac      # .app and .dmg (release/ directory)
```

Node 26.x and pnpm 11.x are required. Before touching code, read [`AGENTS.md`](AGENTS.md) (engineering rules),
[`CONTRIBUTING.md`](CONTRIBUTING.md) (workflow), and [`docs/ROADMAP.md`](docs/ROADMAP.md) (what's next).

The architecture has five layers: `core ← view ← ui ← app ← host`. The model layer has zero DOM, commands never touch page elements, and the structural constraints are enforced statically by `pnpm arch:check`. Visualization and more docs:
[`https://qua.leay.net/arch.html`](https://qua.leay.net/arch.html) ·
[`docs/ARCH-断言.md`](docs/ARCH-断言.md) · [`docs/ELECTRON-备忘.md`](docs/ELECTRON-备忘.md).

---

## License

[AGPL-3.0](LICENSE) © 2026 hqweay
