/// <reference types="node" />
import * as nFs   from 'node:fs';
import * as nPath from 'node:path';
import { App, Notice, TFile, requestUrl } from 'obsidian';
import type LinkLinkPlugin from './main';

export interface IndexEntry {
  path: string;
  title: string;
  embedding: number[];
  mtime?: number;
}

export class IndexingService {
  private app: App;
  private plugin: LinkLinkPlugin;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pipeline() returns an untyped object from @xenova/transformers which has no public TypeScript types
  private embedder: any = null;

  constructor(app: App, plugin: LinkLinkPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  // ── Model ─────────────────────────────────────────────────────────────────

  private get pluginDir(): string {
    return this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/link-link`;
  }

  private get pluginAbsPath(): string {
    const adapter = this.app.vault.adapter as any;
    const base: string = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : (adapter.basePath ?? '');
    return `${base}/${this.pluginDir}`;
  }

  private get modelsDir(): string {
    return `${this.pluginAbsPath}/models`;
  }

  private async ensureOllama(onProgress: (msg: string, pct: number) => void): Promise<boolean> {
    const models: { id: string; active: boolean; modelName: string; baseUrl: string }[] =
      (this.plugin.settings as any).ollamaModels ?? [];
    const active = models.find(m => m.active);
    if (!active) {
      new Notice('No active Ollama model configured. Go to Settings → Embedding and add one.');
      return false;
    }
    const base = (active.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    onProgress('Connecting to Ollama…', 2);
    try {
      const resp = await requestUrl(`${base}/api/tags`);
      if (resp.status !== 200) throw new Error(`Ollama returned ${resp.status}`);
      const data = resp.json as { models?: { name: string }[] };
      const installed = data.models ?? [];
      const found = installed.some(
        (m: { name: string }) => m.name === active.modelName || m.name.startsWith(active.modelName + ':')
      );
      if (!found) {
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
      // @ts-ignore
      const { pipeline, env } = await import('@xenova/transformers');

      // nFs / nPath are statically imported at the top of this file with the
      // 'node:' prefix, so esbuild emits require('node:fs') / require('node:path')
      // in the CJS bundle — real Electron/Node.js modules, not esbuild stubs.
      // Plain 'fs'/'path' inside @xenova/transformers remain as esbuild stubs
      // (platform:browser), keeping RUNNING_LOCALLY=false and avoiding the
      // url.fileURLToPath(import.meta.url) crash in Electron's renderer.
      const pluginAbs = this.pluginAbsPath;

      // Load WASM files from plugin dir and expose as Blob URLs.
      // onnxruntime-web uses fetch() for WASM (browser mode), and Blob URLs are
      // same-origin in Electron renderer so they load without CORS issues.
      const wasmBlob = (name: string) => {
        const p = nPath.join(pluginAbs, name);
        if (!nFs.existsSync(p)) return undefined;
        return URL.createObjectURL(new Blob([nFs.readFileSync(p)], { type: 'application/wasm' }));
      };
      const simdUrl = wasmBlob('ort-wasm-simd.wasm');
      const baseUrl = wasmBlob('ort-wasm.wasm');
      if (simdUrl || baseUrl) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- env.backends.onnx.wasm type is not publicly typed in onnxruntime-web
        (env.backends.onnx.wasm as any).wasmPaths = {
          ...(simdUrl ? { 'ort-wasm-simd.wasm': simdUrl } : {}),
          ...(baseUrl ? { 'ort-wasm.wasm':      baseUrl } : {}),
        };
      }
      env.backends.onnx.wasm.numThreads = 1;

      // Custom file cache: serves pre-shipped model files via real node:fs and
      // caches any remote downloads for future offline use.
      const isRemote = (s: string) => s.startsWith('http://') || s.startsWith('https://');
      env.localModelPath  = this.modelsDir;
      env.useCustomCache  = true;
      env.customCache = {
        async match(key: string) {
          if (isRemote(key)) return undefined;
          if (nFs.existsSync(key)) return new Response(nFs.readFileSync(key));
          return undefined;
        },
        async put(key: string, response: Response) {
          if (isRemote(key)) return;
          try {
            nFs.mkdirSync(nPath.dirname(key), { recursive: true });
            nFs.writeFileSync(key, new Uint8Array(await response.arrayBuffer()));
          } catch { /* ignore write errors */ }
        },
      };
      env.allowLocalModels = true;

      this.embedder = await pipeline(
        'feature-extraction',
        'Xenova/bge-small-en-v1.5',
        {
          quantized: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- progress_callback parameter type is not exported from @xenova/transformers
          progress_callback: (p: any) => {
            if (p.status === 'downloading') {
              onProgress(`Downloading model: ${p.file} (${Math.round(p.progress ?? 0)}%)`, 2 + (p.progress ?? 0) * 0.06);
            } else if (p.status === 'loading') {
              onProgress('Loading model into memory…', 8);
            }
          },
        }
      );

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
      const models: { id: string; active: boolean; modelName: string; baseUrl: string }[] =
        (this.plugin.settings as any).ollamaModels ?? [];
      const active = models.find(m => m.active);
      if (!active) throw new Error('No active Ollama model configured');
      const base = (active.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
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
    return Array.from(out.data) as number[];
  }

  // ── File filtering ────────────────────────────────────────────────────────

  getFilesToIndex(): TFile[] {
    const { ignoredPaths, indexMode, excludePaths, includePaths } = this.plugin.settings;

    return this.app.vault.getMarkdownFiles().filter(f => {
      if (this.matchesList(f.path, ignoredPaths)) return false;

      if (indexMode === 'exclude') {
        if (this.matchesList(f.path, excludePaths)) return false;
      } else if (indexMode === 'include' && includePaths.length > 0) {
        if (!this.matchesList(f.path, includePaths)) return false;
      }

      return true;
    });
  }

  matchesList(filePath: string, list: string[]): boolean {
    for (const p of list) {
      const norm = p.replace(/\/$/, '');
      if (filePath === norm || filePath === norm + '.md' || filePath.startsWith(norm + '/')) return true;
    }
    return false;
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
    if (this.plugin.settings.embeddingSource === 'local') {
      const models: { id: string; active: boolean }[] = (this.plugin.settings as any).ollamaModels ?? [];
      const active = models.find(m => m.active);
      if (active) return `${this.pluginDir}/link-link-index-${active.id}.json`;
    }
    return `${this.pluginDir}/link-link-index.json`;
  }

  indexPathForModel(modelId: string): string {
    return `${this.pluginDir}/link-link-index-${modelId}.json`;
  }

  get builtinIndexPath(): string {
    return `${this.pluginDir}/link-link-index.json`;
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
    const val   = fm?.[field];

    if (val !== undefined && val !== null) {
      if (typeof val === 'number') return val;
      const parsed = Date.parse(String(val));
      if (!isNaN(parsed)) return parsed;
    }

    // Field absent or unparseable → fall back to OS mtime
    return file.stat.mtime;
  }

  // ── Change preview ────────────────────────────────────────────────────────

  // Returns what a full index run would do, without loading the model.
  // Returns null when no index exists yet (first-time indexing).
  async previewChanges(): Promise<{ toEmbed: number; unchanged: number; toRemove: number } | null> {
    let existing: IndexEntry[] = [];
    try { existing = await this.loadIndex(); } catch { return null; }

    const existingByPath = new Map(existing.map(e => [e.path, e]));
    const allIndexable   = this.getFilesToIndex();
    const currentPaths   = new Set(allIndexable.map(f => f.path));

    let toEmbed = 0, unchanged = 0;
    for (const file of allIndexable) {
      const prev        = existingByPath.get(file.path);
      const fileMtime   = this.getFileMtime(file);
      const isUnchanged = prev?.mtime !== undefined && fileMtime <= prev.mtime;
      if (isUnchanged) unchanged++; else toEmbed++;
    }

    const toRemove = existing.filter(e => !currentPaths.has(e.path)).length;
    return { toEmbed, unchanged, toRemove };
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
    const filesToCheck = targetFiles ?? allIndexable;
    const fullScan     = !targetFiles;
    const currentPaths = fullScan ? new Set(allIndexable.map(f => f.path)) : null;

    // Classify: embed or skip
    const toEmbed: TFile[] = [];
    let skipped = 0;

    for (const file of filesToCheck) {
      const prev      = existingByPath.get(file.path);
      const fileMtime = this.getFileMtime(file);
      const unchanged = prev?.mtime !== undefined && fileMtime <= prev.mtime;
      if (unchanged) skipped++; else toEmbed.push(file);
    }

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
