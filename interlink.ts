import { App, Modal, TFile } from 'obsidian';
import type LinkLinkPlugin from './main';
import { isPathInScope, matchesList, type IndexEntry } from './indexing';

// Why runForFile() didn't produce a related-notes update, distinct enough
// for callers to show the right message instead of always suggesting a
// re-index.
export type InterlinkSkipReason = 'ignored' | 'read-only' | 'not-indexed';

// ─── Confirmation modal ───────────────────────────────────────────────────────

export class ConfirmModal extends Modal {
  private message: string;
  private detail: string;
  private onConfirm: () => void | Promise<void>;
  private confirmText: string;
  private destructive: boolean;

  private cancelText: string;

  constructor(
    app: App,
    message: string,
    detail: string,
    onConfirm: () => void | Promise<void>,
    confirmText = 'Continue',
    destructive = false,
    cancelText = 'Cancel'
  ) {
    super(app);
    this.message     = message;
    this.detail      = detail;
    this.onConfirm   = onConfirm;
    this.confirmText = confirmText;
    this.destructive = destructive;
    this.cancelText  = cancelText;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.message });
    contentEl.createEl('p',  { text: this.detail, cls: 'll-modal-detail' });
    const row = contentEl.createDiv({ cls: 'll-modal-btns' });
    row.createEl('button', { text: this.cancelText }).addEventListener('click', () => this.close());
    const ok = row.createEl('button', {
      text: this.confirmText,
      cls: this.destructive ? 'll-btn-danger' : 'll-btn-accent'
    });
    ok.addEventListener('click', () => { this.close(); void this.onConfirm(); });
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Interlink service ────────────────────────────────────────────────────────

export class InterlinkService {
  private app: App;
  private plugin: LinkLinkPlugin;

  constructor(app: App, plugin: LinkLinkPlugin) {
    this.app    = app;
    this.plugin = plugin;
  }

  // ── Path helpers ────────────────────────────────────────────────────────

  isIgnored(filePath: string): boolean {
    return !isPathInScope(filePath, this.plugin.settings);
  }

  isReadOnly(filePath: string): boolean {
    return matchesList(filePath, this.plugin.settings.readOnlyPaths);
  }

  // ── Similarity ───────────────────────────────────────────────────────────

  private cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  }

  // Inverts metadataCache.resolvedLinks (source path -> {target path: count})
  // into target path -> source paths, once, so getNaturalConnections() below
  // doesn't re-scan the whole vault's link graph for every note in run()'s loop.
  private buildBacklinkMap(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const [src, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      for (const dest of Object.keys(links)) {
        let backlinkers = map.get(dest);
        if (!backlinkers) { backlinkers = new Set(); map.set(dest, backlinkers); }
        backlinkers.add(src);
      }
    }
    return map;
  }

  // Returns paths of notes that are already naturally connected (outgoing text links + backlinks).
  // These are excluded from the Top N count so frontmatter stays focused on new discoveries.
  private getNaturalConnections(file: TFile, backlinksByTarget: Map<string, Set<string>>): Set<string> {
    const paths = new Set<string>();
    const bodyLinks = this.app.metadataCache.getFileCache(file)?.links ?? [];
    for (const link of bodyLinks) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (dest) paths.add(dest.path);
    }
    for (const src of backlinksByTarget.get(file.path) ?? []) paths.add(src);
    return paths;
  }

  findRelated(entry: IndexEntry, pool: IndexEntry[], naturalPaths?: Set<string>): { path: string; title: string }[] {
    const { topN, threshold } = this.plugin.settings;
    const scores: { path: string; title: string; score: number }[] = [];

    for (const other of pool) {
      if (other.path === entry.path) continue;
      const score = this.cosine(entry.embedding, other.embedding);
      if (score >= threshold) scores.push({ path: other.path, title: other.title, score });
    }

    const sorted = scores.sort((a, b) => b.score - a.score);
    // Natural connections (outgoing links + backlinks) don't consume Top N slots
    const semantic = sorted.filter(s => !naturalPaths?.has(s.path));
    const limited  = topN === 0 ? semantic : semantic.slice(0, topN);
    return limited.map(s => ({ path: s.path, title: s.title }));
  }

  // Resolves related-note references (from findRelated, keyed by path) into
  // Obsidian-generated wikilinks, sourced from the actual TFile rather than a
  // raw title string — titles containing "]]" or "|" would otherwise produce
  // malformed, unescaped links and corrupt the frontmatter list around them.
  private toWikilinks(links: { path: string; title: string }[], sourcePath: string): string[] {
    return links
      .map(l => this.app.vault.getFileByPath(l.path))
      .filter((f): f is TFile => f !== null)
      .map(target => this.app.fileManager.generateMarkdownLink(target, sourcePath));
  }

  // ── Scan for existing field ───────────────────────────────────────────────

  async findNotesWithRelated(): Promise<TFile[]> {
    const field  = this.plugin.settings.relatedFieldName || 'related';
    const result: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isIgnored(file.path) || this.isReadOnly(file.path)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.[field] !== undefined) result.push(file);
    }
    return result;
  }

  // ── Interlink vault ───────────────────────────────────────────────────────

  async run(
    index: IndexEntry[],
    onProgress: (msg: string, pct: number) => void
  ): Promise<{ updated: number; skipped: number }> {
    const field    = this.plugin.settings.relatedFieldName || 'related';
    const pool     = index.filter(e => !this.isIgnored(e.path));
    const writable = pool.filter(e => !this.isReadOnly(e.path));
    const backlinksByTarget = this.buildBacklinkMap();
    let updated    = 0;

    for (let i = 0; i < writable.length; i++) {
      const entry = writable[i];
      onProgress(`${entry.title} (${i + 1} / ${writable.length})`, (i / writable.length) * 95);

      const file  = this.app.vault.getFileByPath(entry.path);
      if (!file) continue;
      const naturalPaths = this.getNaturalConnections(file, backlinksByTarget);
      const links = this.findRelated(entry, pool, naturalPaths);

      // Use Obsidian's frontmatter API — handles YAML parsing/writing correctly
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (links.length > 0) fm[field] = this.toWikilinks(links, file.path);
      });

      if (links.length > 0) updated++;
    }

    onProgress(`Done — updated ${updated} notes.`, 100);
    return { updated, skipped: writable.length - updated };
  }

  async runForFile(file: TFile, index: IndexEntry[]): Promise<number | InterlinkSkipReason> {
    if (this.isIgnored(file.path)) return 'ignored';
    if (this.isReadOnly(file.path)) return 'read-only';
    const field = this.plugin.settings.relatedFieldName || 'related';
    const pool  = index.filter(e => !this.isIgnored(e.path));
    const entry = pool.find(e => e.path === file.path);
    if (!entry) return 'not-indexed';
    const naturalPaths = this.getNaturalConnections(file, this.buildBacklinkMap());
    const links = this.findRelated(entry, pool, naturalPaths);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (links.length > 0) fm[field] = this.toWikilinks(links, file.path);
      else delete fm[field];
    });
    return links.length;
  }

  // ── Clear related field ───────────────────────────────────────────────────

  async clearRelated(
    onProgress: (msg: string, pct: number) => void
  ): Promise<number> {
    const field = this.plugin.settings.relatedFieldName || 'related';
    const targets = this.app.vault.getMarkdownFiles().filter(f => {
      if (this.isIgnored(f.path) || this.isReadOnly(f.path)) return false;
      const cache = this.app.metadataCache.getFileCache(f);
      return cache?.frontmatter?.[field] !== undefined;
    });

    for (let i = 0; i < targets.length; i++) {
      const file = targets[i];
      onProgress(`${file.basename}`, (i / targets.length) * 100);
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        delete fm[field];
      });
    }

    return targets.length;
  }
}
