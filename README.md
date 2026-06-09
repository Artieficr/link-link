# Link Link!

**Semantically related notes — right in your sidebar.**

[Obsidian](https://obsidian.md/) native graph view is an amazing tool to see connections between your notes and find relevant links. But it requires constant manual link embedding. When a vault grows, many notes may become connected by spirit but lost from each other by actual native Obsidian connections — hence the graph view will display them as orphans.

**Link Link!** finds semantically similar notes and shows them in a live side panel — ranked, color coded, and ready to link. Click to open, drag into the editor to paste a [[link]], or batch-connect your entire vault in one command!

No cloud services, no subscriptions, no data leaving your machine. Private by default.

Same amount of notes on examples below. More semantic connections between related notes on the right!

<img width="100%" alt="image" src="https://github.com/Artieficr/link-link/blob/main/.github/assets/interlink-vault.png" />


## Features overview

- **Live similarity panel** — updates automatically as you switch notes. Similar notes are ranked by a `0.00–1.00` similarity score, where 0 is not similar at all and 1 is an identical note.
- **List view** — notes ranked by similarity score, most relevant on top. Each result has a color coded marker — green for the closest match, grey for the weakest, yellow in between. Spot a note worth linking? Drag it straight into the editor to paste a [[link]], or hit the connection icon to add or remove it from your related: field in one click.
- **Graph view** — everything in list view, visualised as a graph in native Obsidian style. Connected notes cluster around the current one, unconnected but semantically similar notes float at the edges — ready to be pulled in. Drag a floating node onto the central note to connect it, or drag a connected node to central to disconnect it.
- **Multiple embedding backends** — use what you already have:
    - **Built-in (lightweight)** — uses `bge-small-en-v1.5` via Transformers.js. Downloads automatically the first time you index your vault (~25 MB), then runs fully offline, with no additional setup required.
    - **Local model (Ollama)** — connect any locally-running [Ollama](https://ollama.com/) embedding model for full control and more powerful models. Add as many models as you like. Each gets its own index file, so you can compare and pick the one that works best for you.
    - **Existing index file** — it reads the existing index file if you have one and have set its path in the settings. Zero extra work if you already use an embedding model any where in your vault.
- **Interlink Current Note** — writes a `related:` frontmatter field to the currently open note only, connecting it to its most semantically similar notes. Available as a panel button and a command palette entry.
- **Interlink Vault** — performs semantic search across the entire index, finds the top N similar notes for each one, and populates a `related:` field with native Obsidian `[[links]]`. That way every note finds its connections with other notes that share similar concepts and ideas, even if they were never connected manually. Available as a command palette entry.
- **Selection Mode** — run a semantic search on any selected text passage: select 5 or more words in any note, click the button, and the panel switches to showing notes semantically related only to that passage.
- **Commands** — all major actions are available from the command palette:
    - _Open related notes panel_
    - _Index Vault_
    - _Interlink Current Note_
    - _Interlink Vault_
- **Fully configurable**:
    - _Exceptions_ — list folders and files you don't want affected. You can make some notes referenceable but not modifiable. For example, if you have a Wiki folder, other notes can add wiki pages to their `related:` field, but the wiki pages themselves won't be edited.
    - _Similarity threshold_ — a higher threshold filters similarity more aggressively, while a lower one may surface fewer relevant notes. `0.5` is the default and a good starting point. Experiment to find your own sweet value.
    - _Top N results_ — if your vault is large, you may want to limit how many related notes are shown.
    - _Auto-index_ — choose when the index updates: manually only, on Obsidian startup, or automatically on every file save.
    - _Changes detection_ — by default the plugin uses the OS file modification timestamp to skip unchanged notes. If your sync tool (Dropbox, iCloud, OneDrive etc.) overwrites timestamps on transfer, you can point it at a custom frontmatter date field combined with [Linter](https://github.com/platers/obsidian-linter) plugin.
    - _Graph view_ — adjust node colors for similarity groups, their size, link thickness, and forces applied.
    - _`related:` frontmatter_ — if you already use that field name in your vault you can configure to use a new custom field name. `related:` is default and will be used as a reference in this README file.

## Requirements

- Obsidian `1.7.2` or later
- Desktop only (Windows, macOS, Linux)
- For the **Local model (Ollama) backend**: [Ollama](https://ollama.com/) installed, running, and the desired embedding model pulled (`ollama pull <model-name>`)
- For the **Existing index backend**: an embeddings index file must be present in the vault directory. The plugin will attempt to read and normalize it. Full compatibility is not guaranteed.

## Installation

### Community Plugins (recommended)

1. Open Obsidian Settings → Community Plugins
2. Click **Browse** and search for **Link Link**
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Artieficr/link-link/releases/latest)
2. Copy them into your vault at `.obsidian/plugins/link-link/`
3. Reload Obsidian
4. Enable **Link Link** in Settings → Community Plugins

## Quick Start

1. **`Link Link!: Run setup Wizard`** via command palette and go through the brief guided course.
2. Navigate to any note — the panel updates automatically.
3. Click any result to open it, or drag and drop a node outside the panel into the editor to paste a `[[link]]`

## Related notes side panel presentation
### List view
All features on the list view have a tooltip with a description of what this is, and what it does. Just hover your mouse over an element.

<img width="70%" alt="image" src="https://github.com/Artieficr/link-link/blob/main/.github/assets/list-view-features.png" />

1. **Interlink current note** — updates your frontmatter `related:` field with semantically similar notes from the index file.
2. **Selection mode** — runs a semantic search on any selected text passage: select 5 or more words in any note, click the button, and the panel switches to showing notes semantically related only to that passage.
3. **Update panel** — side panel should update in a real time, but in case it would not pick up your recent action, you can force update it right now.
4. **Switch display mode** — hop from list view to graph back and forth with this toggle.
5. **Similarity score** — the closer the value is to 1, the more similar this note is to your current note.
6. **`B` badge** — B stands for Backlink. Notes in the list with this badge have current note referenced in them.
7. **`O` badge** — O stands for Outgoing links. Notes in the list with this badge are referenced in the current note's text.
8. **Remove from `related:`** — removes this note from current note's `related:` frontmatter field. Basically removes a connection. Keep in mind that a note can still be connected if it has `B` or `O` badges.
9. **Add to `related:`** — add this note to current note's `related:` frontmatter field. Basically creates a connection.

Notes with `B` or `O` badges are already connected to current note in their way. That's why their `Add` button is transparent — so unconnected notes stand out.

`Remove` button only appears when you hover over a note in the list.

### Graph view
A non-obvious feature: drag and drop nodes onto the central node in the Graph view to link or unlink the grabbed note:

<img width="100%" alt="image" src="https://github.com/Artieficr/link-link/blob/main/.github/assets/graph-view-drag-n-drop.gif" />

Link Link! graph view replicates Obsidian's native Graph. It was intended to replace `Local Graph View` by showing more info and expanding linking functionality.

## How It Works

Link Link! represents each note as a vector — a list of numbers that encodes its meaning. Notes that are semantically similar end up with vectors that point in similar directions. The similarity score is the cosine of the angle between two vectors: `1.0` means identical, `0.0` means unrelated.

The index stores one embedding vector per note. The notes themselves are not modified by indexation process. On subsequent runs, only notes whose modification timestamp has changed are re-embedded — so incremental indexing is fast even for large vaults.

Interlink command:
- reads the index
- compares its entry with each note (or only the current one)
- finds semantically similar notes based on similarity score
- modifies notes' `related:` frontmatter field by adding [[wiki-links]] list of similar notes.
ONLY `related:` FIELD IS MODIFIED. Other notes' content stays untouched.

## Privacy

Everything runs on your machine. No notes, embeddings, or metadata are ever sent anywhere.
The built-in model downloads once on first index (~25 MB) and is cached locally — after that, no network connection is ever required, plugin runs fully offline.

## Contributing
I'm not a software engineer — I created this plugin for myself with the help of [Claude Code](https://claude.com/product/claude-code).
Since it worked very well for me, I wanted to share it with people who might need the same tool.

Bug reports and feature suggestions are welcome.

Feel free to initiate issues and pull requests [github.com/Artieficr/link-link](https://github.com/Artieficr/link-link).

## Plugin pricing

`Link Link!` will stay free forever, no matter what features are added in the future.

If my plugin helped you, consider tipping me on [Ko-fi](https://ko-fi.com/artieficr) as a sign of your gratitude.
**Tips are unnecessary** but much appreciated.

## License

[MIT © Artyom Tsoy](https://github.com/Artieficr/link-link/blob/main/LICENSE.txt)
