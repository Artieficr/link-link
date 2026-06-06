# Link Link!

**Semantically related notes — right in your sidebar.**

[Obsidian](https://obsidian.md/) native graph view is an amazing tool to see connections between your notes and find relevant links. But it requires constant manual link embedding. When a vault grows, many notes may become connected by spirit but lost from each other by actual native Obsidian connections — hence the graph view will display them as orphans.

**Link Link!** finds notes similar to the one you're reading and shows them in a live side panel, ranked by how closely they match. Drag and drop from the panel to create a fast link, or use automated commands that embed a list of semantically similar notes into the frontmatter field. You can run a command to populate the currently open note or interconnect the whole vault!

No cloud services, no subscriptions, no data leaving your machine. Private by default.

## Features

- **Live similarity panel** — updates automatically as you switch notes. Similar notes are ranked by a `0.00–1.00` similarity score, where 0 is not similar at all and 1 is an identical note.
- **List view** — notes ranked by similarity score, most relevant on top. Each result has a color coded marker — green for the closest match, grey for the weakest, yellow in between. Spot a note worth linking? Drag it straight into the editor to paste a [[link]], or hit the connection icon to add or remove it from your related: field in one click.
- **Graph view** — everything in list view, visualised as a graph in native Obsidian style. Connected notes cluster around the current one, unconnected but semantically similar notes float at the edges — ready to be pulled in. Drag a floating node onto the central note to connect it, or drag a connected node to central to disconnect it.
- **Multiple embedding backends** — use what you already have:
    - **Built-in (lightweight)** — uses local `bge-small-en-v1.5` via Transformers.js, runs fully offline with no extra setup. Install the plugin and just use it!
    - **Copilot plugin** — reads the existing index from the [Copilot](https://github.com/logancyang/obsidian-copilot) (v2.1.0 or later) plugin instead of creating a new one. Zero extra work if you already use an embedding model with Copilot.
    - **Local model (Ollama)** — connect any locally-running [Ollama](https://ollama.com/) embedding model for full control and more powerful models. Add as many models as you like. Each gets its own index file, so you can compare and pick the one that works best for you.
- **Interlink Current Note** — writes a `related:` frontmatter field to the currently open note only, connecting it to its most semantically similar notes. Available as a panel button and a command palette entry.
- **Interlink Vault** — performs semantic search across the entire index, finds the top N similar notes for each one, and populates a `related:` field with native Obsidian `[[links]]`. That way every note finds its connections with other notes that share similar concepts and ideas, even if they were never connected manually. Available as a panel button and a command palette entry.
- **Commands** — all major actions are available from the command palette:
    - _Open related notes panel_
    - _Index Vault_
    - _Interlink Current Note_
    - _Interlink Vault_
- **Fully configurable**:
    - _Exceptions_ — list folders and files you don't want affected. You can make some notes referenceable but not modifiable. For example, if you have a Wiki folder, other notes can add wiki pages to their `related:` field, but the wiki pages themselves won't be edited.
    - _Similarity threshold_ — a higher threshold filters similarity more aggressively, while a lower one may surface fewer relevant notes. `0.5` is the default and works well.
    - _Top N results_ — if your vault is large, you may want to limit how many related notes are shown.
    - _Auto-index_ — choose when the index updates: manually only, on Obsidian startup, or automatically on every file save.
    - _Changes detection_ — by default the plugin uses the OS file modification timestamp to skip unchanged notes. If your sync tool (Dropbox, iCloud, etc.) overwrites timestamps on transfer, you can point it at a custom frontmatter date field combined with [Linter](https://github.com/platers/obsidian-linter) plugin.
    - _Indexing progress display_ — choose between a floating pop-up window, standard Obsidian notifications, or silent background indexing.

## Requirements

- Obsidian `1.4.0` or later
- Desktop only (Windows, macOS, Linux)
- For the **Copilot backend**: [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) plugin installed and vault indexed
- For the **Local model (Ollama) backend**: [Ollama](https://ollama.com/) installed, running, and the desired embedding model pulled (`ollama pull <model-name>`)

## Installation

### Via BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the Community Plugins browser
2. Open BRAT settings → **Add Beta Plugin**
3. Paste: `https://github.com/Artieficr/link-link`
4. Enable **Link Link!** in Community Plugins

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Artieficr/link-link/releases/latest)
2. Copy them into your vault at `.obsidian/plugins/link-link/`
3. Reload Obsidian
4. Enable **Link Link!** in Settings → Community Plugins

## Quick Start

1. Open the **Link Link!** panel via the ribbon icon or **Command palette → Link Link!: Open related notes panel**
2. Go to **Settings → Link Link! → Embedding → Index vault** and click **Index vault** to build the index for the first time. Indexing runs in the background and may take few minutes for large vaults.
3. Navigate to any note — the panel updates automatically
4. Click any result to open it, or drag and drop a node outside the panel into the editor to paste a `[[link]]`

## How It Works

Link Link! represents each note as a vector — a list of numbers that encodes its meaning. Notes that are semantically similar end up with vectors that point in similar directions. The similarity score is the cosine of the angle between two vectors: `1.0` means identical, `0.0` means unrelated.

The **built-in backend** runs `bge-small-en-v1.5` locally via [Transformers.js](https://huggingface.co/docs/transformers.js) with no server required.

The **Copilot backend** reuses the index already built by the Copilot plugin, so if you already use Copilot you get semantic search at zero extra computational cost.

The **Ollama backend** calls your locally-running Ollama server at `POST /api/embeddings`. Each configured model maintains its own index file, so you can switch between models without losing your existing index.

The index stores one embedding vector per note. On subsequent runs, only notes whose modification timestamp has changed are re-embedded — so incremental indexing is fast even for large vaults.

## Privacy

Everything runs on your machine. No notes, embeddings, or metadata are ever sent anywhere.

## Contributing

I'm not a software engineer. I created this plugin with [Claude](https://claude.ai/) help for myself. Since it worked very well for me, I wanted to share it with people who might need the same tool.

Bug reports and feature suggestions are welcome.

Feel free to initiate issues and pull requests [github.com/Artieficr/link-link](https://github.com/Artieficr/link-link).

## License

MIT © Artie Tsoy
