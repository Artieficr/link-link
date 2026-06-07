import { App, Modal, TFile } from 'obsidian';
import type LinkLinkPlugin from './main';
import type { IndexEntry } from './indexing';

// ─── Confirmation modal ───────────────────────────────────────────────────────

export class ConfirmModal extends Modal {
  private message: string;
  private detail: string;
  private onConfirm: () => void;
  private confirmText: string;
  private destructive: boolean;

  private cancelText: string;

  constructor(
    app: App,
    message: string,
    detail: string,
    onConfirm: () => void,
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
    const row = contentEl.createEl('div', { cls: 'll-modal-btns' });
    row.createEl('button', { text: this.cancelText }).addEventListener('click', () => this.close());
    const ok = row.createEl('button', {
      text: this.confirmText,
      cls: this.destructive ? 'll-btn-danger' : 'll-btn-accent'
    });
    ok.addEventListener('click', () => { this.close(); this.onConfirm(); });
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
    const { ignoredPaths, indexMode, excludePaths, includePaths } = this.plugin.settings;

    if (this.matchesList(filePath, ignoredPaths)) return true;

    if (indexMode === 'exclude') {
      if (this.matchesList(filePath, excludePaths)) return true;
    } else if (indexMode === 'include' && includePaths.length > 0) {
      if (!this.matchesList(filePath, includePaths)) return true;
    }

    return false;
  }

  isReadOnly(filePath: string): boolean {
    return this.matchesList(filePath, this.plugin.settings.readOnlyPaths);
  }

  private matchesList(filePath: string, list: string[]): boolean {
    for (const p of list) {
      const norm = p.replace(/\/$/, '');
      if (filePath === norm || filePath === norm + '.md' || filePath.startsWith(norm + '/')) return true;
    }
    return false;
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

  // Returns paths of notes that are already naturally connected (outgoing text links + backlinks).
  // These are excluded from the Top N count so frontmatter stays focused on new discoveries.
  private getNaturalConnections(file: TFile): Set<string> {
    const paths = new Set<string>();
    const bodyLinks = this.app.metadataCache.getFileCache(file)?.links ?? [];
    for (const link of bodyLinks) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (dest) paths.add(dest.path);
    }
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const [src, links] of Object.entries(resolved)) {
      if (src !== file.path && links[file.path]) paths.add(src);
    }
    return paths;
  }

  findRelated(entry: IndexEntry, pool: IndexEntry[], naturalPaths?: Set<string>): string[] {
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
    return limited.map(s => s.title);
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
    let updated    = 0;

    for (let i = 0; i < writable.length; i++) {
      const entry = writable[i];
      onProgress(`${entry.title} (${i + 1} / ${writable.length})`, (i / writable.length) * 95);

      const file  = this.app.vault.getFileByPath(entry.path);
      if (!file) continue;
      const naturalPaths = this.getNaturalConnections(file);
      const links = this.findRelated(entry, pool, naturalPaths);

      // Use Obsidian's frontmatter API — handles YAML parsing/writing correctly
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (links.length > 0) fm[field] = links.map(l => `[[${l}]]`);
      });

      if (links.length > 0) updated++;
    }

    onProgress(`Done — updated ${updated} notes.`, 100);
    return { updated, skipped: writable.length - updated };
  }

  async runForFile(file: TFile, index: IndexEntry[]): Promise<number | false> {
    if (this.isIgnored(file.path) || this.isReadOnly(file.path)) return false;
    const field = this.plugin.settings.relatedFieldName || 'related';
    const pool  = index.filter(e => !this.isIgnored(e.path));
    const entry = pool.find(e => e.path === file.path);
    if (!entry) return false;
    const naturalPaths = this.getNaturalConnections(file);
    const links = this.findRelated(entry, pool, naturalPaths);
    await this.app.fileManager.processFrontMatter(file, fm => {
      if (links.length > 0) fm[field] = links.map(l => `[[${l}]]`);
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
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        delete fm[field];
      });
    }

    return targets.length;
  }
}
