import { App, Notice, TFile, requestUrl } from 'obsidian';
import type LinkLinkPlugin from './main';
import type { OllamaModel } from './main';

// @xenova/transformers has no public TypeScript types; these minimal interfaces
// cover the subset we actually call.
type EmbedderFn = (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>;
interface ModelLoadProgress { status: string; file?: string; progress?: number; }

export interface IndexEntry {
  path: string;
  title: string;
  embedding: number[];
  mtime?: number;
}

export function matchesList(filePath: string, list: string[]): boolean {
  for (const p of list) {
    const norm = p.replace(/\/$/, '');
    if (filePath === norm || filePath === norm + '.md' || filePath.startsWith(norm + '/')) return true;
  }
  return false;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export function ollamaBase(baseUrl?: string): string {
  return (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
}

// Throws when the server is unreachable or answers non-200.
export async function ollamaHasModel(base: string, modelName: string): Promise<boolean> {
  const resp = await requestUrl(`${base}/api/tags`);
  if (resp.status !== 200) throw new Error(`Ollama returned ${resp.status}`);
  const data = resp.json as { models?: { name: string }[] };
  return (data.models ?? []).some(m => m.name === modelName || m.name.startsWith(modelName + ':'));
}

export function activeOllama(settings: { ollamaModels: OllamaModel[] }): OllamaModel | undefined {
  return settings.ollamaModels.find(m => m.active);
}

interface PathScopeSettings {
  ignoredPaths: string[];
  indexMode: 'exclude' | 'include';
  excludePaths: string[];
  includePaths: string[];
}

// Shared by IndexingService.getFilesToIndex() and InterlinkService.isIgnored()
// so both services agree on what "in scope" means.
export function isPathInScope(filePath: string, settings: PathScopeSettings): boolean {
  if (matchesList(filePath, settings.ignoredPaths)) return false;

  if (settings.indexMode === 'exclude') {
    if (matchesList(filePath, settings.excludePaths)) return false;
  } else if (settings.indexMode === 'include' && settings.includePaths.length > 0) {
    if (!matchesList(filePath, settings.includePaths)) return false;
  }

  return true;
}

export class IndexingService {
  private app: App;
  private plugin: LinkLinkPlugin;
  private embedder: EmbedderFn | null = null;

  constructor(app: App, plugin: LinkLinkPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  // ── Model ─────────────────────────────────────────────────────────────────

  private get pluginDir(): string {
    return this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/link-link`;
  }

  private async ensureOllama(onProgress: (msg: string, pct: number) => void): Promise<boolean> {
    const active = activeOllama(this.plugin.settings);
    if (!active) {
      new Notice('No active Ollama model configured. Go to Settings → Embedding and add one.');
      return false;
    }
    const base = ollamaBase(active.baseUrl);
    onProgress('Connecting to Ollama…', 2);
    try {
      if (!await ollamaHasModel(base, active.modelName)) {
        new Notice(`Ollama model "${active.modelName}" is not installed. Run: ollama pull ${active.modelName}`);
        return false;
      }
      onProgress('Ollama ready.', 10);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Cannot reach Ollama at ${base}: ${msg}`);
      return false;
    }
  }

  async ensureModel(onProgress: (msg: string, pct: number) => void): Promise<boolean> {
    if (this.plugin.settings.embeddingSource === 'local') return this.ensureOllama(onProgress);

    if (this.embedder) { onProgress('Model ready.', 10); return true; }

    onProgress('Loading embedding model…', 2);

    try {
      const { pipeline, env } = await import('@xenova/transformers');

      // Load WASM runtime from CDN — the browser caches it after the first
      // download, so subsequent Obsidian boots are fast.
      env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/';
      env.backends.onnx.wasm.numThreads = 1;
      env.allowLocalModels = false;

      this.embedder = await pipeline(
        'feature-extraction',
        'Xenova/bge-small-en-v1.5',
        {
          quantized: true,
          progress_callback: (p: ModelLoadProgress) => {
            if (p.status === 'downloading') {
              onProgress(`Downloading model: ${p.file ?? ''} (${Math.round(p.progress ?? 0)}%)`, 2 + (p.progress ?? 0) * 0.06);
            } else if (p.status === 'loading') {
              onProgress('Loading model into memory…', 8);
            }
          },
        }
      ) as EmbedderFn;

      onProgress('Model ready.', 10);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Failed to load embedding model: ${msg}`);
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    if (this.plugin.settings.embeddingSource === 'local') {
      const active = activeOllama(this.plugin.settings);
      if (!active) throw new Error('No active Ollama model configured');
      const base = ollamaBase(active.baseUrl);
      const resp = await requestUrl({
        url: `${base}/api/embeddings`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: active.modelName, prompt: text }),
      });
      if (resp.status !== 200) {
        throw new Error(`Ollama error ${resp.status}: ${resp.text}`);
      }
      const data = resp.json as { embedding: number[] };
      if (!Array.isArray(data.embedding)) throw new Error('Ollama returned no embedding');
      return data.embedding;
    }
    if (!this.embedder) throw new Error('Model not loaded');
    const out = await this.embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }

  // ── File filtering ────────────────────────────────────────────────────────

  getFilesToIndex(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter(f => isPathInScope(f.path, this.plugin.settings));
  }

  // ── Text extraction ───────────────────────────────────────────────────────

  extractText(content: string, title: string): string {
    // Strip frontmatter
    const body = content.replace(/^---[\s\S]*?---\n?/, '');
    // Strip markdown noise
    const plain = body
      .replace(/#+\s/g, '')
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`~>]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 2000);

    return `${title}\n\n${plain}`;
  }

  // ── Index I/O ─────────────────────────────────────────────────────────────

  private get indexPath(): string {
    const active = this.plugin.settings.embeddingSource === 'local' ? activeOllama(this.plugin.settings) : undefined;
    return this.indexPathForModel(active?.id);
  }

  indexPathForModel(modelId?: string): string {
    return `${this.pluginDir}/link-link-index${modelId ? `-${modelId}` : ''}.json`;
  }

  get builtinIndexPath(): string {
    return this.indexPathForModel();
  }

  async loadIndex(): Promise<IndexEntry[]> {
    try {
      const raw = await this.app.vault.adapter.read(this.indexPath);
      return JSON.parse(raw) as IndexEntry[];
    } catch {
      throw new Error('No index found. Click "Index vault" to build one.');
    }
  }

  private async saveIndex(index: IndexEntry[]): Promise<void> {
    await this.app.vault.adapter.write(this.indexPath, JSON.stringify(index));
  }

  async indexExists(): Promise<boolean> {
    return this.app.vault.adapter.exists(this.indexPath);
  }

  async deleteIndex(): Promise<void> {
    if (await this.indexExists()) {
      await this.app.vault.adapter.remove(this.indexPath);
    }
  }

  // ── mtime source ─────────────────────────────────────────────────────────

  // Returns the modification timestamp used for change detection.
  // In frontmatter mode, falls back to OS mtime when the field is absent or unparseable.
  private getFileMtime(file: TFile): number {
    const { mtimeSource, mtimeField } = this.plugin.settings;

    if (mtimeSource !== 'frontmatter') return file.stat.mtime;

    const field = (mtimeField ?? '').trim() || 'updated';
    const fm    = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const val: unknown = fm?.[field];

    if (val !== undefined && val !== null) {
      if (typeof val === 'number') return val;
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- frontmatter value is unknown-shaped user data; a non-date-like stringification simply fails Date.parse below and falls through to the OS mtime fallback
      const parsed = Date.parse(String(val));
      if (!isNaN(parsed)) return parsed;
    }

    // Field absent or unparseable → fall back to OS mtime
    return file.stat.mtime;
  }

  // Splits files into those needing (re)embedding and those unchanged since the index entry.
  private classify(files: TFile[], existingByPath: Map<string, IndexEntry>): { toEmbed: TFile[]; skipped: number } {
    const toEmbed: TFile[] = [];
    for (const file of files) {
      const prev = existingByPath.get(file.path);
      if (!(prev?.mtime !== undefined && this.getFileMtime(file) <= prev.mtime)) toEmbed.push(file);
    }
    return { toEmbed, skipped: files.length - toEmbed.length };
  }

  // ── Change preview ────────────────────────────────────────────────────────

  // Returns what a full index run would do, without loading the model.
  // Returns null when no index exists yet (first-time indexing).
  async previewChanges(): Promise<{ toEmbed: number; unchanged: number; toRemove: number } | null> {
    let existing: IndexEntry[] = [];
    try { existing = await this.loadIndex(); } catch { return null; }

    const allIndexable = this.getFilesToIndex();
    const currentPaths = new Set(allIndexable.map(f => f.path));
    const { toEmbed, skipped: unchanged } = this.classify(allIndexable, new Map(existing.map(e => [e.path, e])));

    const toRemove = existing.filter(e => !currentPaths.has(e.path)).length;
    return { toEmbed: toEmbed.length, unchanged, toRemove };
  }

  // ── Unified index ─────────────────────────────────────────────────────────

  // Smart incremental index. When targetFiles is provided only those files are
  // checked (used by the file-save auto-index); otherwise the full vault is
  // scanned and deleted-file entries are pruned.
  async index(
    onProgress: (msg: string, pct: number) => void,
    targetFiles?: TFile[],
    signal?: AbortSignal
  ): Promise<{ added: number; updated: number; removed: number; skipped: number }> {
    // Load existing index (empty on first run)
    let existing: IndexEntry[] = [];
    try { existing = await this.loadIndex(); } catch { /* no index yet */ }

    const existingByPath = new Map(existing.map(e => [e.path, e]));

    const allIndexable = this.getFilesToIndex();
    const filesToCheck = targetFiles
      ? targetFiles.filter(f => isPathInScope(f.path, this.plugin.settings))
      : allIndexable;
    const fullScan     = !targetFiles;
    const currentPaths = fullScan ? new Set(allIndexable.map(f => f.path)) : null;

    const { toEmbed, skipped: unchangedCount } = this.classify(filesToCheck, existingByPath);
    let skipped = unchangedCount;

    const deletedCount = fullScan
      ? existing.filter(e => !currentPaths!.has(e.path)).length
      : 0;

    // Early exit: nothing to do
    if (toEmbed.length === 0 && deletedCount === 0) {
      onProgress('Index is up to date.', 100);
      return { added: 0, updated: 0, removed: 0, skipped };
    }

    // Load model only when there are files to embed
    if (toEmbed.length > 0) {
      const ready = await this.ensureModel(onProgress);
      if (!ready) throw new Error('Could not load embedding model — check the error notification above.');
    }

    // Embed
    let added = 0, updated = 0;
    for (let i = 0; i < toEmbed.length; i++) {
      if (signal?.aborted) throw new DOMException('Indexing cancelled', 'AbortError');
      const file = toEmbed[i];
      const pct  = 10 + (i / toEmbed.length) * 85;
      onProgress(`(${i + 1}/${toEmbed.length}) ${file.basename}`, pct);
      try {
        const content   = await this.app.vault.read(file);
        const text      = this.extractText(content, file.basename);
        const embedding = await this.embed(text);
        const mtime     = this.getFileMtime(file);
        const isNew     = !existingByPath.has(file.path);
        existingByPath.set(file.path, { path: file.path, title: file.basename, embedding, mtime });
        if (isNew) added++; else updated++;
      } catch (e) {
        console.warn(`link-link: failed to embed ${file.path}`, e);
        skipped++;
      }
    }

    // Prune deleted entries (full scan only)
    let newIndex = [...existingByPath.values()];
    let removed  = 0;
    if (fullScan) {
      const before = newIndex.length;
      newIndex     = newIndex.filter(e => currentPaths!.has(e.path));
      removed      = before - newIndex.length;
    }

    onProgress('Saving index…', 96);
    await this.saveIndex(newIndex);

    return { added, updated, removed, skipped };
  }
}
