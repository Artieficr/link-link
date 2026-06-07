import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from 'obsidian';
import { IndexingService, type IndexEntry } from './indexing';
import { InterlinkService, ConfirmModal } from './interlink';

const VIEW_TYPE = 'link-link-view';

interface OllamaModel {
  id: string;
  modelName: string;
  displayName: string;
  baseUrl: string;
  active: boolean;
}

interface LinkLinkSettings {
  topN: number;
  threshold: number;
  embeddingSource: 'builtin' | 'existing' | 'local';
  existingIndexPath: string;
  detectedIndexFiles: { path: string; format: string }[];
  ollamaModels: OllamaModel[];
  // Indexing filters
  indexMode: 'exclude' | 'include';
  excludePaths: string[];
  includePaths: string[];
  ignoredPaths: string[];
  readOnlyPaths: string[];
  autoIndexMode: 'manual' | 'startup' | 'file-save';
  mtimeSource: 'os' | 'frontmatter';
  mtimeField: string;
  progressDisplay: 'popup' | 'notification' | 'silent';
  notificationTimeout: number;
  // Interlink
  relatedFieldName: string;
  // Display
  viewMode: 'list' | 'graph';
  openMode: 'current' | 'new-tab' | 'split';
  colorHigh: string;
  colorMid: string;
  colorLow: string;
  autoFit: boolean;
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
  textFadeThreshold: number;
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
}

const DEFAULT_SETTINGS: LinkLinkSettings = {
  topN: 15,
  threshold: 0.5,
  embeddingSource: 'builtin',
  existingIndexPath: '',
  detectedIndexFiles: [],
  ollamaModels: [],
  indexMode: 'exclude',
  excludePaths: [],
  includePaths: [],
  ignoredPaths: [],
  readOnlyPaths: [],
  autoIndexMode: 'manual',
  mtimeSource: 'os',
  mtimeField: '',
  progressDisplay: 'popup',
  notificationTimeout: 3,
  relatedFieldName: '',
  viewMode: 'list',
  openMode: 'new-tab',
  colorHigh: '#22c55e',
  colorMid: '#eab308',
  colorLow: '#6b7280',
  autoFit: true,
  centerStrength: 0.5,
  repelStrength: 7,
  linkStrength: 0.3,
  linkDistance: 3,
  textFadeThreshold: 0.6,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
};


interface GNode {
  file: TFile | null;
  score: number;
  x: number; y: number;
  vx: number; vy: number;
  fx: number; fy: number;
  pinned: boolean;
  linked: boolean;
  isOutgoing: boolean; // outgoing link: body-text wiki link from current note to this node
  isBacklink: boolean; // this node's file links to the current note
}

interface GEdge { a: number; b: number; }
type ResultEntry = { file: TFile; score: number; isOutgoing: boolean; isBacklink: boolean };

class EmbeddingNotFoundError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly source: LinkLinkSettings['embeddingSource']
  ) { super('embedding_not_found'); }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function scoreToColor(score: number, s: LinkLinkSettings, minScore = 0, maxScore = 1): string {
  const span = maxScore - minScore;
  if (span <= 0) return s.colorHigh;
  const rel = (score - minScore) / span;
  if (rel >= 2 / 3) return s.colorHigh;
  if (rel >= 1 / 3) return s.colorMid;
  return s.colorLow;
}

// Fixed-position tooltip for list items (avoids overflow-y:auto clipping).
// Returns a cleanup function; caller must call it on mouseleave.
function showListTip(anchor: HTMLElement, title: string, body: string, align: 'left' | 'right' = 'left'): () => void {
  const tip = document.body.createEl('div', { cls: 'll-list-tip' });
  tip.createEl('strong', { text: title, cls: 'll-list-tip-title' });
  tip.createEl('span',   { text: body,  cls: 'll-list-tip-body' });
  const r = anchor.getBoundingClientRect();
  tip.style.top = (r.bottom + 4) + 'px';
  if (align === 'right') tip.style.right = (window.innerWidth - r.right) + 'px';
  else                   tip.style.left  = r.left + 'px';
  return () => tip.remove();
}

function contrastColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#1a1a1a' : '#ffffff';
}

// ─── Graph simulation ────────────────────────────────────────────────────────

class GraphSimulation {
  private nodes: GNode[] = [];
  private edges: GEdge[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animFrame: number | null = null;
  private W = 0;
  private H = 0;
  private settings: LinkLinkSettings;
  private dark: boolean;
  private panelEl: HTMLElement;
  private minScore = 0;
  private maxScore = 1;

  // View transform
  private scale = 1;
  private panX = 0;
  private panY = 0;
  private tgtScale: number | null = null;
  private tgtPanX = 0;
  private tgtPanY = 0;
  private autoFitTimer: number | null = null;

  // Node drag
  private dragNode: GNode | null = null;
  private dragFile: TFile | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private inGhostMode = false;
  private ghostEl: HTMLElement | null = null;

  // Background pan
  private isPanning = false;
  private panMouseX = 0;
  private panMouseY = 0;
  private panStartX = 0;
  private panStartY = 0;

  private onOpen: (file: TFile) => void;
  private onInsertLink: (file: TFile, dropTarget: Element | null, dropX: number, dropY: number) => void;
  private onContextMenu: (file: TFile, event: MouseEvent) => void;
  private onToggleRelated: (file: TFile) => Promise<void>;
  private isHoveringCenter = false;
  private accentColor: string;

  constructor(
    canvas: HTMLCanvasElement,
    panelEl: HTMLElement,
    currentFile: TFile,
    results: ResultEntry[],
    linkedPaths: Set<string>,
    settings: LinkLinkSettings,
    onOpen: (file: TFile) => void,
    onInsertLink: (file: TFile, dropTarget: Element | null, dropX: number, dropY: number) => void,
    onContextMenu: (file: TFile, event: MouseEvent) => void,
    onToggleRelated: (file: TFile) => Promise<void>
  ) {
    this.canvas          = canvas;
    this.panelEl         = panelEl;
    this.settings        = settings;
    this.onOpen          = onOpen;
    this.onInsertLink    = onInsertLink;
    this.onContextMenu   = onContextMenu;
    this.onToggleRelated = onToggleRelated;
    this.dark        = document.body.classList.contains('theme-dark');
    this.accentColor = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim() || '#8b5cf6';
    this.ctx  = canvas.getContext('2d')!;

    // Relative color range: exclude score=0 (linked-but-unindexed) from range
    const simScores = results.map(r => r.score).filter(s => s > 0);
    if (simScores.length > 0) {
      this.minScore = Math.min(...simScores);
      this.maxScore = Math.max(...simScores);
    }

    this.nodes.push({
      file: currentFile, score: 1,
      x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0,
      pinned: true, linked: false, isOutgoing: false, isBacklink: false
    });
    for (let i = 0; i < results.length; i++) {
      const isLinked = linkedPaths.has(results[i].file.path);
      this.nodes.push({
        file: results[i].file, score: results[i].score,
        x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0,
        pinned: false, linked: isLinked,
        isOutgoing: results[i].isOutgoing, isBacklink: results[i].isBacklink
      });
      if (isLinked) this.edges.push({ a: 0, b: this.nodes.length - 1 });
    }

    // Pointer events with capture: after pointerdown the canvas owns all
    // subsequent move/up events even if the pointer leaves the element.
    // This prevents Obsidian's panel focus handling from stealing the first click.
    canvas.addEventListener('pointerdown',   (e) => this.handlePointerDown(e));
    canvas.addEventListener('pointermove',   (e) => this.handlePointerMove(e));
    canvas.addEventListener('pointerup',     (e) => this.handlePointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.resetDrag());
    canvas.addEventListener('wheel',       (e) => this.handleWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  resize(W: number, H: number) {
    const firstTime = this.W === 0;
    this.W = W; this.H = H;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (firstTime) {
      const cx = W / 2, cy = H / 2;
      this.nodes[0].x = cx; this.nodes[0].y = cy;
      const s = Math.min(W, H) / 300;
      const linked   = this.nodes.slice(1).filter(n => n.linked);
      const unlinked = this.nodes.slice(1).filter(n => !n.linked);
      linked.forEach((n, i) => {
        const a = (i / Math.max(linked.length, 1)) * Math.PI * 2;
        n.x = cx + Math.cos(a) * 50 * s + (Math.random() - 0.5) * 20;
        n.y = cy + Math.sin(a) * 50 * s + (Math.random() - 0.5) * 20;
      });
      unlinked.forEach((n, i) => {
        const a = (i / Math.max(unlinked.length, 1)) * Math.PI * 2;
        n.x = cx + Math.cos(a) * 130 * s + (Math.random() - 0.5) * 30;
        n.y = cy + Math.sin(a) * 130 * s + (Math.random() - 0.5) * 30;
      });
      const fit = this.computeFit();
      this.scale = fit.scale; this.panX = fit.panX; this.panY = fit.panY;
    } else {
      this.nodes[0].x = W / 2; this.nodes[0].y = H / 2;
      const fit = this.computeFit();
      this.scale = fit.scale; this.panX = fit.panX; this.panY = fit.panY;
      this.tgtScale = null;
    }
  }

  start() {
    const tick = () => {
      if (this.W > 0) { this.step(); this.draw(); }
      this.animFrame = requestAnimationFrame(tick);
    };
    this.animFrame = requestAnimationFrame(tick);
    if (this.settings.autoFit) {
      this.autoFitTimer = window.setTimeout(() => this.animateToFit(), 2500);
    }
  }

  stop() {
    if (this.animFrame    !== null) { cancelAnimationFrame(this.animFrame);  this.animFrame    = null; }
    if (this.autoFitTimer !== null) { clearTimeout(this.autoFitTimer);       this.autoFitTimer = null; }
    this.ghostEl?.remove(); this.ghostEl = null;
  }

  toggleNodeLink(file: TFile, addLink: boolean) {
    const idx = this.nodes.findIndex(n => n.file?.path === file.path);
    if (idx < 1) return;
    this.nodes[idx].linked = addLink;
    if (addLink) {
      if (!this.edges.some(e => e.b === idx)) this.edges.push({ a: 0, b: idx });
    } else {
      this.edges = this.edges.filter(e => e.b !== idx);
    }
  }

  updateNodeFlags(flags: Map<string, { isOutgoing: boolean; isBacklink: boolean }>) {
    for (const node of this.nodes.slice(1)) {
      if (!node.file) continue;
      const f = flags.get(node.file.path);
      node.isOutgoing = f?.isOutgoing ?? false;
      node.isBacklink = f?.isBacklink ?? false;
    }
  }

  // ── Coordinates ──────────────────────────────────────────────────────────

  private toWorld(sx: number, sy: number): [number, number] {
    return [
      (sx - this.W / 2 - this.panX) / this.scale + this.W / 2,
      (sy - this.H / 2 - this.panY) / this.scale + this.H / 2,
    ];
  }

  private computeFit() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      const r = (n.pinned ? 11 : 8) + 24;
      minX = Math.min(minX, n.x - r); maxX = Math.max(maxX, n.x + r);
      minY = Math.min(minY, n.y - r); maxY = Math.max(maxY, n.y + r);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const scale = Math.min(this.W / ((maxX - minX) || 1), this.H / ((maxY - minY) || 1), 3);
    return { scale, panX: (this.W / 2 - cx) * scale, panY: (this.H / 2 - cy) * scale };
  }

  private animateToFit() {
    const fit = this.computeFit();
    this.tgtScale = fit.scale; this.tgtPanX = fit.panX; this.tgtPanY = fit.panY;
  }

  private scheduleAutoFit() {
    if (!this.settings.autoFit) return;
    if (this.autoFitTimer !== null) clearTimeout(this.autoFitTimer);
    this.autoFitTimer = window.setTimeout(() => this.animateToFit(), 5000);
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private nodeAt(wx: number, wy: number): GNode | null {
    for (let i = this.nodes.length - 1; i >= 1; i--) {
      const n = this.nodes[i];
      const r = (8) * this.settings.nodeSizeMultiplier + 6;
      if ((n.x - wx) ** 2 + (n.y - wy) ** 2 < r * r) return n;
    }
    return null;
  }

  private handlePointerDown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const rect = this.canvas.getBoundingClientRect();
    const [wx, wy] = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const node = this.nodeAt(wx, wy);

    if (e.button === 2 && node?.file) {
      e.preventDefault();
      this.onContextMenu(node.file, e as unknown as MouseEvent);
      return;
    }

    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    if (e.button === 0 && node) {
      this.dragNode    = node;
      this.dragFile    = node.file;
      this.dragStartX  = e.clientX;
      this.dragStartY  = e.clientY;
      this.inGhostMode = false;
      this.canvas.style.cursor = 'grabbing';
    } else {
      this.isPanning = true;
      this.panMouseX = e.clientX; this.panMouseY = e.clientY;
      this.panStartX = this.panX;  this.panStartY = this.panY;
      this.canvas.style.cursor = 'grabbing';
      this.tgtScale = null;
    }
  }

  private handlePointerMove(e: PointerEvent) {
    if (this.isPanning) {
      this.panX = this.panStartX + (e.clientX - this.panMouseX);
      this.panY = this.panStartY + (e.clientY - this.panMouseY);
      this.scheduleAutoFit();
      return;
    }

    if (!this.dragNode) {
      // Hover: update cursor when not dragging
      const rect = this.canvas.getBoundingClientRect();
      const [wx, wy] = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      this.canvas.style.cursor = this.nodeAt(wx, wy) ? 'grab' : 'default';
      return;
    }

    const panelRect = this.panelEl.getBoundingClientRect();
    const outside   = e.clientX < panelRect.left || e.clientX > panelRect.right ||
                      e.clientY < panelRect.top  || e.clientY > panelRect.bottom;

    if (outside && !this.inGhostMode) {
      this.inGhostMode = true;
      if (this.dragFile) {
        this.ghostEl = document.body.createEl('div', { cls: 'll-drag-ghost' });
        this.ghostEl.setText(`[[${this.dragFile.basename}]]`);
      }
    } else if (!outside && this.inGhostMode) {
      this.inGhostMode = false;
      this.ghostEl?.remove(); this.ghostEl = null;
    }

    if (this.inGhostMode) {
      if (this.ghostEl) {
        this.ghostEl.style.left = e.clientX + 'px';
        this.ghostEl.style.top  = e.clientY + 'px';
      }
      this.isHoveringCenter = false;
    } else {
      const rect = this.canvas.getBoundingClientRect();
      const [wx, wy] = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      this.dragNode.x = wx; this.dragNode.y = wy;
      this.dragNode.vx = 0; this.dragNode.vy = 0;

      // Track whether the dragged node is hovering over the center node
      if (this.dragNode !== this.nodes[0]) {
        const c  = this.nodes[0];
        const cr = 11 * this.settings.nodeSizeMultiplier + 14;
        this.isHoveringCenter = (wx - c.x) ** 2 + (wy - c.y) ** 2 < cr * cr;
      }
    }
  }

  private handlePointerUp(e: PointerEvent) {
    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = 'default';
      return;
    }
    if (!this.dragNode) return;

    const moved = (e.clientX - this.dragStartX) ** 2 + (e.clientY - this.dragStartY) ** 2;
    if (this.inGhostMode && this.dragFile) {
      this.ghostEl?.remove(); this.ghostEl = null;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el?.closest('.cm-editor, .cm-content, .CodeMirror, .markdown-source-view')) {
        this.onInsertLink(this.dragFile, el, e.clientX, e.clientY);
      }
    } else if (this.isHoveringCenter && this.dragFile && this.dragNode !== this.nodes[0]) {
      this.onToggleRelated(this.dragFile);
    } else if (moved < 25 && this.dragFile) {
      this.onOpen(this.dragFile);
    }

    this.dragNode.vx = 0; this.dragNode.vy = 0;
    this.resetDrag();
  }

  private resetDrag() {
    this.dragNode = null; this.dragFile = null;
    this.isPanning = false;
    this.inGhostMode = false;
    this.isHoveringCenter = false;
    this.ghostEl?.remove(); this.ghostEl = null;
    this.canvas.style.cursor = 'default';
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const z  = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const ns = Math.max(0.05, Math.min(8, this.scale * z));
    const az = ns / this.scale;
    this.panX  = (mx - this.W / 2) * (1 - az) + this.panX * az;
    this.panY  = (my - this.H / 2) * (1 - az) + this.panY * az;
    this.scale = ns;
    this.tgtScale = null;
    this.scheduleAutoFit();
  }

  // ── Physics ──────────────────────────────────────────────────────────────

  private step() {
    const { nodes, edges, settings } = this;
    const cx = this.W / 2, cy = this.H / 2;
    const s       = Math.min(this.W, this.H) / 300;
    const repelK  = settings.repelStrength * 250 * s * s;
    const springK = settings.linkStrength  * 0.08;
    const centerK = settings.centerStrength * 0.023;

    // Scale spring rest distance with node density so repel and spacing stay complementary.
    // Above 8 nodes, the rest distance grows with sqrt(nodeCount/8) so the graph
    // spreads gracefully instead of nodes being blasted past the configured link distance.
    const nodeCount   = Math.max(1, nodes.length - 1);
    const densityScale = nodeCount > 8 ? Math.sqrt(nodeCount / 8) : 1;
    const springR = settings.linkDistance * 12 * s * densityScale;

    for (const n of nodes) { n.fx = 0; n.fy = 0; }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
        const d2 = Math.max(dx * dx + dy * dy, 4);
        const d  = Math.sqrt(d2), f = repelK / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        if (!nodes[i].pinned) { nodes[i].fx -= fx; nodes[i].fy -= fy; }
        if (!nodes[j].pinned) { nodes[j].fx += fx; nodes[j].fy += fy; }
      }
    }

    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const f  = springK * (d - springR);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      if (!a.pinned) { a.fx += fx; a.fy += fy; }
      if (!b.pinned) { b.fx -= fx; b.fy -= fy; }
    }

    for (let i = 1; i < nodes.length; i++) {
      const b = nodes[i];
      if (b.linked) continue;
      const rest = springR * (4.5 - b.score * 2.0);
      const dx = b.x - nodes[0].x, dy = b.y - nodes[0].y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const f  = b.score * springK * 0.6 * (d - rest);
      b.fx -= (dx / d) * f; b.fy -= (dy / d) * f;
    }

    for (const n of nodes) {
      if (n.pinned) continue;
      n.fx += (cx - n.x) * centerK;
      n.fy += (cy - n.y) * centerK;
    }

    for (const n of nodes) {
      if (n.pinned || n === this.dragNode) continue;
      n.vx = (n.vx + n.fx) * 0.87; n.vy = (n.vy + n.fy) * 0.87;
      n.x += n.vx; n.y += n.vy;
    }

    if (this.tgtScale !== null) {
      const t = 0.09;
      this.scale = this.scale + (this.tgtScale - this.scale) * t;
      this.panX  = this.panX  + (this.tgtPanX  - this.panX)  * t;
      this.panY  = this.panY  + (this.tgtPanY  - this.panY)  * t;
      if (Math.abs(this.scale - this.tgtScale) < 0.001 &&
          Math.abs(this.panX  - this.tgtPanX)  < 0.5   &&
          Math.abs(this.panY  - this.tgtPanY)  < 0.5) {
        this.scale = this.tgtScale; this.panX = this.tgtPanX; this.panY = this.tgtPanY;
        this.tgtScale = null;
      }
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private draw() {
    const { ctx, nodes, edges, settings } = this;
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.save();
    ctx.translate(this.W / 2 + this.panX, this.H / 2 + this.panY);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-this.W / 2, -this.H / 2);

    ctx.strokeStyle = this.dark ? 'rgba(180,180,180,0.3)' : 'rgba(80,80,80,0.25)';
    ctx.lineWidth   = 1.5 * settings.lineSizeMultiplier / this.scale;
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    const textAlpha = Math.max(0, Math.min(1, (this.scale - settings.textFadeThreshold) / 0.15));

    for (const n of nodes) {
      const r    = (n.pinned ? 11 : 8) * settings.nodeSizeMultiplier;
      const fill = n.pinned ? '#8b5cf6' : scoreToColor(n.score, settings, this.minScore, this.maxScore);
      if (n.pinned && this.isHoveringCenter) {
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 6 / this.scale, 0, Math.PI * 2);
        ctx.strokeStyle = this.accentColor;
        ctx.lineWidth   = 2.5 / this.scale;
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();

      // Draw O/outgoing (vertical) / B/backlink (horizontal) marker lines inside node
      if (!n.pinned && (n.isOutgoing || n.isBacklink)) {
        const bgColor = getComputedStyle(document.body).getPropertyValue('--background-primary').trim() || (this.dark ? '#1e1e1e' : '#ffffff');
        ctx.strokeStyle = bgColor;
        ctx.lineWidth   = 1.5 / this.scale;
        const arm = r * 0.58;
        if (n.isOutgoing) {
          ctx.beginPath(); ctx.moveTo(n.x, n.y - arm); ctx.lineTo(n.x, n.y + arm); ctx.stroke();
        }
        if (n.isBacklink) {
          ctx.beginPath(); ctx.moveTo(n.x - arm, n.y); ctx.lineTo(n.x + arm, n.y); ctx.stroke();
        }
      }

      if (textAlpha <= 0) continue;
      const name = n.file?.basename ?? '';
      if (!name) continue;
      const fs   = Math.max(7, Math.min(11, 9 / this.scale));
      const maxW = 68 / this.scale;
      ctx.font      = `${fs}px sans-serif`;
      ctx.fillStyle = `rgba(${this.dark ? '210,210,210' : '40,40,40'},${(0.85 * textAlpha).toFixed(2)})`;
      ctx.textAlign = 'center';
      let text = name;
      while (ctx.measureText(text).width > maxW && text.length > 3) text = text.slice(0, -1);
      if (text.length < name.length) text = text.slice(0, -1) + '…';
      ctx.fillText(text, n.x, n.y + r + 11 / this.scale);
    }
    ctx.restore();
  }
}

// ─── View ────────────────────────────────────────────────────────────────────

class LinkLinkView extends ItemView {
  plugin: LinkLinkPlugin;
  private simulation: GraphSimulation | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private listUpdateFn: ((outgoingPaths: Set<string>, backlinkPaths: Set<string>) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LinkLinkPlugin) {
    super(leaf); this.plugin = plugin;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return 'Link Link!'; }
  getIcon()        { return 'link'; }

  async onOpen()  { await this.refresh(); }

  async onClose() {
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.simulation?.stop();          this.simulation = null;
    this.listUpdateFn = null;
  }

  async refresh() {
    this.resizeObserver?.disconnect(); this.resizeObserver = null;
    this.simulation?.stop();          this.simulation = null;
    this.listUpdateFn = null;

    const el = this.contentEl;
    el.empty();
    el.addClass('ll-container');

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      el.createEl('p', { text: 'No active note.', cls: 'll-empty' });
      return;
    }
    el.createEl('p', { text: 'Loading…', cls: 'll-loading' });

    try {
      // Compute natural connections first so they don't consume Top N slots
      const { outgoingPaths, backlinkPaths } = this.plugin.getOutgoingAndBacklinkPaths(activeFile);
      const naturalPaths = new Set([...outgoingPaths, ...backlinkPaths]);
      const baseResults = await this.plugin.getRelated(activeFile, naturalPaths);
      el.empty(); el.addClass('ll-container');

      const header  = el.createEl('div', { cls: 'll-header' });
      const isGraph = this.plugin.settings.viewMode === 'graph';

      // Always show linked notes regardless of Top N / threshold
      const extra = await this.plugin.getLinkedResults(activeFile, baseResults);
      const allResults = extra.length > 0 ? [...baseResults, ...extra] : baseResults;
      const results: ResultEntry[] = allResults.map(r => ({
        ...r,
        isOutgoing: outgoingPaths.has(r.file.path),
        isBacklink: backlinkPaths.has(r.file.path),
      }));

      const mkIconBtn = (
        parent: HTMLElement,
        icon: string,
        tipTitle: string,
        tipBody: string,
        tipAlign: 'left' | 'right',
        onClick: () => Promise<void>
      ) => {
        const btn = parent.createEl('div', { cls: 'll-icon-btn' });
        setIcon(btn, icon);
        // Fixed-position tooltip so button's hover opacity doesn't cascade into it
        let hideTip: (() => void) | null = null;
        btn.addEventListener('mouseenter', () => {
          hideTip = showListTip(btn, tipTitle, tipBody, tipAlign);
        });
        btn.addEventListener('mouseleave', () => { hideTip?.(); hideTip = null; });
        btn.addEventListener('click', async () => {
          hideTip?.(); hideTip = null;
          btn.addClass('ll-icon-btn-busy');
          try { await onClick(); } finally { btn.removeClass('ll-icon-btn-busy'); }
        });
        return btn;
      };

      mkIconBtn(header, 'link', 'Interlink current note',
        'Update related links for this note only. Other notes stay untouched.',
        'left',
        async () => {
          try {
            const index = await this.plugin.loadAnyIndex();
            const ok = await this.plugin.interlinkService.runForFile(activeFile, index);
            new Notice(ok
              ? `Updated related links for "${activeFile.basename}".`
              : `"${activeFile.basename}" is not in the index — run indexing first.`
            );
          } catch (e) { new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`); }
        }
      );

      header.createEl('span', { text: activeFile.basename, cls: 'll-title' });
      const controls = header.createEl('div', { cls: 'll-controls' });

      mkIconBtn(controls, 'refresh-cw', 'Update panel',
        this.plugin.settings.embeddingSource === 'existing'
          ? 'Refresh the panel to pick up recent changes.'
          : 'Re-index this note and refresh the panel to pick up recent changes.',
        'right',
        async () => {
          try {
            if (this.plugin.settings.embeddingSource !== 'existing') {
              await this.plugin.indexingService.index(() => {}, [activeFile]);
            }
            await this.refresh();
          } catch (e) { new Notice(`Update failed: ${e instanceof Error ? e.message : String(e)}`); }
        }
      );

      const toggle  = controls.createEl('div', {
        cls: 'll-view-toggle' + (isGraph ? ' is-graph' : ''),
        title: isGraph ? 'Switch to list' : 'Switch to graph',
      });
      const knob = toggle.createEl('div', { cls: 'll-view-toggle-knob' });
      setIcon(knob, isGraph ? 'network' : 'list');
      toggle.addEventListener('click', async () => {
        this.plugin.settings.viewMode = isGraph ? 'list' : 'graph';
        await this.plugin.saveData(this.plugin.settings);
        await this.refresh();
      });

      if (results.length === 0) {
        el.createEl('p', {
          text: isGraph
            ? 'No related or linked notes found.'
            : 'No related notes above threshold.',
          cls: 'll-empty'
        });
        return;
      }

      if (isGraph) this.renderGraph(el, activeFile, results);
      else         this.renderList(el, results, activeFile);

    } catch (e) {
      el.empty(); el.addClass('ll-container');
      if (e instanceof EmbeddingNotFoundError) {
        this.renderEmbeddingError(el, e, activeFile);
      } else {
        el.createEl('p', { text: `Error: ${e instanceof Error ? e.message : String(e)}`, cls: 'll-error' });
      }
    }
  }

  // Inserts [[link]] at the visual drop coordinates using CM6's posAtCoords,
  // falling back to the current cursor position if the internal API is unavailable.
  private insertLinkAtDrop(text: string, dropTarget: Element | null, dropX: number, dropY: number) {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (dropTarget && !view.containerEl.contains(dropTarget)) continue;
      const editor = view.editor;
      // @ts-ignore — CM6 internal EditorView, used to convert screen coords to doc offset
      const cm = editor.cm;
      if (cm?.posAtCoords) {
        const offset = cm.posAtCoords({ x: dropX, y: dropY }, false);
        if (typeof offset === 'number') editor.setCursor(editor.offsetToPos(offset));
      }
      editor.replaceSelection(text);
      return;
    }
    new Notice('Open a note first, then drop the link.');
  }

  updateBadges(activeFile: TFile) {
    const { outgoingPaths, backlinkPaths } = this.plugin.getOutgoingAndBacklinkPaths(activeFile);
    this.listUpdateFn?.(outgoingPaths, backlinkPaths);
    if (this.simulation) {
      const flags = new Map<string, { isOutgoing: boolean; isBacklink: boolean }>();
      for (const p of outgoingPaths) flags.set(p, { isOutgoing: true,  isBacklink: backlinkPaths.has(p) });
      for (const p of backlinkPaths) if (!flags.has(p)) flags.set(p, { isOutgoing: false, isBacklink: true });
      this.simulation.updateNodeFlags(flags);
    }
  }

  private renderEmbeddingError(el: HTMLElement, err: EmbeddingNotFoundError, activeFile: TFile) {
    const header = el.createEl('div', { cls: 'll-header' });
    header.createEl('span', { text: activeFile.basename, cls: 'll-title' });

    const body = el.createEl('div', { cls: 'll-emb-error' });

    const indexableFiles = this.plugin.indexingService.getFilesToIndex();
    const isExcluded = !indexableFiles.some(f => f.path === activeFile.path);

    const msgText = isExcluded
      ? `No embedding for "${err.fileName}", it is excluded from indexing.`
      : `No embedding for "${err.fileName}".`;
    body.createEl('p', { text: msgText, cls: 'll-error' });

    if (err.source === 'existing') {
      body.createEl('p', {
        text: 'Make sure an index file is selected in Settings → Embedding.',
        cls: 'll-error-hint'
      });
    } else if (isExcluded) {
      body.createEl('p', {
        text: 'To index this note, remove it from the exclusion list in the Indexing target settings.',
        cls: 'll-error-hint'
      });
    } else {
      const btnRow = body.createEl('div', { cls: 'll-reindex-row' });
      const btn = btnRow.createEl('button', { text: 'Index', cls: 'll-action-btn ll-action-btn-accent' });
      const progressWrap = body.createEl('div', { cls: 'll-progress-wrap' });
      progressWrap.style.display = 'none';
      const progLabel = body.createEl('p', { cls: 'll-prog-label' });
      progLabel.style.display = 'none';
      const bar = progressWrap.createEl('div', { cls: 'll-progress-bar' });

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        let confirmMsg: string;
        try {
          const preview = await this.plugin.indexingService.previewChanges();
          if (preview === null) {
            const count = this.plugin.indexingService.getFilesToIndex().length;
            confirmMsg = `${count} notes will be indexed for the first time. This may take several minutes.`;
          } else {
            const { toEmbed, unchanged, toRemove } = preview;
            const parts: string[] = [];
            if (toEmbed   > 0) parts.push(`${toEmbed} to index`);
            if (unchanged > 0) parts.push(`${unchanged} unchanged`);
            if (toRemove  > 0) parts.push(`${toRemove} entries to remove`);
            confirmMsg = parts.length > 0 ? parts.join(' · ') : 'Index is already up to date.';
          }
        } catch {
          confirmMsg = `Depending on your vault size, indexing may take several minutes.`;
        } finally {
          btn.disabled = false;
        }

        new ConfirmModal(
          this.app,
          'Index vault?',
          confirmMsg,
          async () => {
            btn.disabled = true;
            btn.setText('Indexing…');
            progressWrap.style.display = 'block';
            progLabel.style.display = 'block';
            const { onProgress, onDone, onError } = this.plugin.createProgressDisplay(
              (msg, pct) => {
                progLabel.setText(msg);
                bar.style.width = pct + '%';
                bar.classList.toggle('indeterminate', pct === 0);
              }
            );
            try {
              const { added, updated, removed } = await this.plugin.indexingService.index(onProgress);
              const summary = added + updated === 0
                ? 'Index is up to date.'
                : `+${added} new, ${updated} updated, ${removed} removed`;
              onDone(summary);
              progLabel.setText('Indexing complete!');
              bar.style.width = '100%';
              setTimeout(() => this.refresh(), 1500);
            } catch (e) {
              onError();
              progLabel.setText(`Error: ${e instanceof Error ? e.message : String(e)}`);
              setTimeout(() => this.refresh(), 4000);
            } finally {
              btn.disabled = false;
              btn.setText('Index');
            }
          }
        ).open();
      });
    }
  }

  private renderList(el: HTMLElement, results: ResultEntry[], activeFile: TFile) {
    const wrap = el.createEl('div', { cls: 'll-list-wrap' });
    const list = wrap.createEl('div', { cls: 'll-list' });
    const scores = results.map(r => r.score).filter(s => s > 0);
    const minScore = scores.length > 0 ? Math.min(...scores) : 0;
    const maxScore = scores.length > 0 ? Math.max(...scores) : 1;
    const field = this.plugin.settings.relatedFieldName || 'related';

    let dragGhost: HTMLElement | null = null;
    const itemUpdaters: Array<(outgoingPaths: Set<string>, backlinkPaths: Set<string>) => void> = [];

    for (const { file, score, isOutgoing: initIsOutgoing, isBacklink: initIsBacklink } of results) {
      let isOutgoing = initIsOutgoing;
      let isBacklink = initIsBacklink;

      const item    = list.createEl('div', { cls: 'll-item' });
      const scoreEl = item.createEl('span', { cls: 'll-score' });
      if (score > 0) {
        scoreEl.setText(score.toFixed(2));
        const bg = scoreToColor(score, this.plugin.settings, minScore, maxScore);
        scoreEl.style.background = bg;
        scoreEl.style.color      = contrastColor(bg);
      } else {
        scoreEl.setText('?');
        scoreEl.title            = 'Unindexed';
        scoreEl.style.background = 'var(--background-modifier-border)';
        scoreEl.style.color      = 'var(--text-muted)';
      }

      // O (outgoing) always before B (backlink); pre-created for in-place updates
      const badgeO = item.createEl('span', { cls: 'll-ref-badge', text: 'O' });
      const badgeB = item.createEl('span', { cls: 'll-ref-badge', text: 'B' });
      const renderBadges = () => {
        badgeO.style.display = isOutgoing ? '' : 'none';
        badgeB.style.display = isBacklink ? '' : 'none';
      };
      renderBadges();

      // Shared tip handle per row — one visible tip at a time
      let hideTip: (() => void) | null = null;
      const attachTip = (el: HTMLElement, title: string, body: string) => {
        el.addEventListener('mouseenter', () => { hideTip?.(); hideTip = showListTip(el, title, body); });
        el.addEventListener('mouseleave', () => { hideTip?.(); hideTip = null; });
      };
      attachTip(badgeO, 'Outgoing link', 'This note is referenced in the current note\'s body text.');
      attachTip(badgeB, 'Backlink',      'The current note is referenced in this note\'s body text.');

      item.createEl('span', { text: file.basename, cls: 'll-link' })
        .addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const menu = new Menu();
          this.app.workspace.trigger('file-menu', menu, file, 'link-link-view');
          menu.showAtMouseEvent(e);
        });

      // ── Related field toggle ──────────────────────────────────────────────
      const getRelated = (): string[] => {
        const fm = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;
        if (!fm?.[field]) return [];
        return Array.isArray(fm[field]) ? fm[field] : [String(fm[field])];
      };

      // ── Single button: add / remove frontmatter / faded warning for O or B ─
      const linkBtn = item.createEl('button', { cls: 'll-item-link-btn' });
      let isInFrontmatter = getRelated().some(r => r === `[[${file.basename}]]`);

      const refreshBtn = () => {
        linkBtn.empty();
        if (isInFrontmatter) {
          setIcon(linkBtn, 'unlink');
          linkBtn.toggleClass('is-connected', true);
          linkBtn.toggleClass('is-natural', false);
        } else {
          setIcon(linkBtn, 'link');
          linkBtn.toggleClass('is-connected', false);
          linkBtn.toggleClass('is-natural', isOutgoing || isBacklink);
        }
      };
      refreshBtn();

      linkBtn.addEventListener('mouseenter', () => {
        hideTip?.();
        hideTip = showListTip(linkBtn,
          isInFrontmatter ? `Remove from ${field}:` : `Add to ${field}:`,
          isInFrontmatter
            ? `Remove "${file.basename}" from the ${field} frontmatter field.`
            : `Add "${file.basename}" to the ${field} frontmatter field.`,
          'right'
        );
      });
      linkBtn.addEventListener('mouseleave', () => { hideTip?.(); hideTip = null; });

      linkBtn.addEventListener('click', async () => {
        if (isInFrontmatter) {
          await this.app.fileManager.processFrontMatter(activeFile, fm => {
            const current = getRelated();
            const updated = current.filter(r => r !== `[[${file.basename}]]`);
            if (updated.length > 0) fm[field] = updated;
            else delete fm[field];
          });
          new Notice(`Removed "${file.basename}" from ${field}:`);
          isInFrontmatter = false;
          refreshBtn();
        } else {
          await this.app.fileManager.processFrontMatter(activeFile, fm => {
            fm[field] = [...getRelated(), `[[${file.basename}]]`];
          });
          new Notice(`Added "${file.basename}" to ${field}:`);
          isInFrontmatter = true;
          refreshBtn();
        }
      });

      // Per-item updater for real-time badge/button refresh via metadataCache.changed
      itemUpdaters.push((newOutgoingPaths: Set<string>, newBacklinkPaths: Set<string>) => {
        isOutgoing = newOutgoingPaths.has(file.path);
        isBacklink = newBacklinkPaths.has(file.path);
        isInFrontmatter = getRelated().some(r => r === `[[${file.basename}]]`);
        renderBadges();
        refreshBtn();
      });

      // ── Click to open, drag to insert [[link]] ───────────────────────────
      // click handles opens; pointerdown/move/up on document handles drag.
      // Keeping e.preventDefault() off pointerdown so click fires naturally
      // (preventDefault suppresses click in Chromium/Electron).
      // user-select: none on .ll-item prevents text selection instead.
      let wasDragged = false;

      item.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.ll-item-link-btn')) return;
        if (wasDragged) { wasDragged = false; return; }
        this.plugin.openFile(file);
      });

      item.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('.ll-item-link-btn')) return;

        let isDragging = false;
        const startX = e.clientX, startY = e.clientY;

        const onMove = (me: PointerEvent) => {
          if (!isDragging && (me.clientX - startX) ** 2 + (me.clientY - startY) ** 2 > 64) {
            isDragging = true;
            wasDragged = true;
            dragGhost?.remove();
            dragGhost = document.body.createEl('div', { cls: 'll-drag-ghost' });
            dragGhost.setText(`[[${file.basename}]]`);
            item.style.cursor = 'grabbing';
          }
          if (dragGhost) {
            dragGhost.style.left = me.clientX + 'px';
            dragGhost.style.top  = me.clientY + 'px';
          }
        };

        const cleanup = () => {
          item.style.cursor = '';
          dragGhost?.remove(); dragGhost = null;
          document.removeEventListener('pointermove',   onMove);
          document.removeEventListener('pointerup',     onUp);
          document.removeEventListener('pointercancel', onCancel);
        };

        const onUp = (ue: PointerEvent) => {
          if (!isDragging) { cleanup(); return; } // click handler will open file
          const dropX = ue.clientX, dropY = ue.clientY;
          cleanup();
          const target = document.elementFromPoint(dropX, dropY);
          if (target?.closest('.cm-editor, .cm-content, .CodeMirror, .markdown-source-view')) {
            this.insertLinkAtDrop(`[[${file.basename}]]`, target, dropX, dropY);
          }
        };

        const onCancel = () => { wasDragged = false; cleanup(); };

        document.addEventListener('pointermove',   onMove);
        document.addEventListener('pointerup',     onUp);
        document.addEventListener('pointercancel', onCancel);
      });
    }

    // Store list updater for real-time badge/button refresh
    this.listUpdateFn = (outgoingPaths, backlinkPaths) => {
      for (const upd of itemUpdaters) upd(outgoingPaths, backlinkPaths);
    };
  }

  private renderGraph(el: HTMLElement, currentFile: TFile, results: ResultEntry[]) {
    const wrap   = el.createEl('div', { cls: 'll-graph-wrap' });
    const canvas = wrap.createEl('canvas', { cls: 'll-graph' });
    const linked = this.plugin.getLinkedPaths(currentFile, results);

    this.simulation = new GraphSimulation(
      canvas, this.contentEl,
      currentFile, results, linked,
      this.plugin.settings,
      (f) => this.plugin.openFile(f),
      (f, dropTarget, dropX, dropY) => {
        this.insertLinkAtDrop(`[[${f.basename}]]`, dropTarget, dropX, dropY);
      },
      (f, e) => {
        const menu = new Menu();
        this.app.workspace.trigger('file-menu', menu, f, 'link-link-view');
        menu.showAtMouseEvent(e);
      },
      async (f) => {
        const field = this.plugin.settings.relatedFieldName || 'related';
        const getRelated = (): string[] => {
          const fm = this.app.metadataCache.getFileCache(currentFile)?.frontmatter;
          if (!fm?.[field]) return [];
          return Array.isArray(fm[field]) ? fm[field] : [String(fm[field])];
        };
        const isInFrontmatter = getRelated().some(r => r === `[[${f.basename}]]`);
        const entry = results.find(r => r.file.path === f.path);
        const isOutgoing = entry?.isOutgoing ?? false;
        const isBacklink = entry?.isBacklink ?? false;

        if (isInFrontmatter) {
          await this.app.fileManager.processFrontMatter(currentFile, fm => {
            const current = getRelated();
            const updated = current.filter(r => r !== `[[${f.basename}]]`);
            if (updated.length > 0) fm[field] = updated;
            else delete fm[field];
          });
          this.simulation?.toggleNodeLink(f, isOutgoing || isBacklink);
          new Notice(`Removed "${f.basename}" from ${field}:`);
        } else {
          await this.app.fileManager.processFrontMatter(currentFile, fm => {
            fm[field] = [...getRelated(), `[[${f.basename}]]`];
          });
          this.simulation?.toggleNodeLink(f, true);
          new Notice(`Added "${f.basename}" to ${field}:`);
        }
      }
    );
    this.simulation.start();

    this.resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) this.simulation?.resize(width, height);
    });
    this.resizeObserver.observe(wrap);

    const { settings } = this.plugin;
    const rScores = results.map(r => r.score).filter(s => s > 0);
    const minS = rScores.length > 0 ? Math.min(...rScores) : 0;
    const maxS = rScores.length > 0 ? Math.max(...rScores) : 1;
    const span = maxS - minS;
    const legend = el.createEl('div', { cls: 'll-legend' });

    // Row 1: similarity color legend
    const colorRow = legend.createEl('div', { cls: 'll-legend-row' });
    for (const [color, label] of [
      ['#8b5cf6', 'current'],
      [settings.colorHigh, `≥ ${(minS + (2 * span) / 3).toFixed(2)}`],
      [settings.colorMid,  `≥ ${(minS + span / 3).toFixed(2)}`],
      [settings.colorLow,  `< ${(minS + span / 3).toFixed(2)}`],
    ] as [string, string][]) {
      const item = colorRow.createEl('span', { cls: 'll-legend-item' });
      item.createEl('span', { cls: 'll-legend-dot' }).style.background = color;
      item.createEl('span', { text: label });
    }

    // Row 2: node type markers + drag tip
    const typeRow = legend.createEl('div', { cls: 'll-legend-row' });
    const oTypeItem = typeRow.createEl('span', { cls: 'll-legend-item' });
    oTypeItem.createEl('span', { cls: 'll-legend-node ll-legend-node-o' });
    oTypeItem.createEl('span', { text: 'Outgoing link' });
    const bTypeItem = typeRow.createEl('span', { cls: 'll-legend-item' });
    bTypeItem.createEl('span', { cls: 'll-legend-node ll-legend-node-b' });
    bTypeItem.createEl('span', { text: 'Backlink' });
    typeRow.createEl('span', { text: 'Drag out → insert [[link]]', cls: 'll-legend-item ll-legend-hint' });
  }
}

// ─── Index progress popup ─────────────────────────────────────────────────────

const INDEX_PHRASES = [
  'Teaching notes to recognize each other',
  'Measuring the distance between thoughts',
  'Asking vectors how they feel about each other',
  'Quantifying the vibe',
  'Converting ideas into coordinates',
  'Mapping the shape of your mind',
  'Whispering to orphaned notes',
  'Doing math so you don\'t have to',
  'The model is thinking. Please hold',
  'Embeddings are embedding',
];

class IndexProgressPopup {
  private el: HTMLElement;
  private titleEl: HTMLElement;
  private phraseEl: HTMLElement;
  private statusEl: HTMLElement;
  private barEl: HTMLElement;
  private phraseTimer: number | null = null;
  private phraseIndex: number;
  dismissed  = false;
  isFinished = false;

  constructor() {
    this.phraseIndex = Math.floor(Math.random() * INDEX_PHRASES.length);

    this.el = document.body.createEl('div', { cls: 'll-idx-popup' });

    const header = this.el.createEl('div', { cls: 'll-idx-popup-header' });
    this.titleEl = header.createEl('span', { text: 'Link Link — Indexing', cls: 'll-idx-popup-title' });
    const closeBtn = header.createEl('button', { cls: 'll-idx-popup-close', text: '×' });
    closeBtn.addEventListener('click', () => {
      this.dismissed = true;
      if (!this.isFinished) new Notice('Indexing continues in the background.', 3000);
      this.close();
    });

    this.phraseEl = this.el.createEl('div', { cls: 'll-idx-popup-phrase' });
    this.phraseEl.setText(INDEX_PHRASES[this.phraseIndex]);

    const barWrap = this.el.createEl('div', { cls: 'll-progress-wrap' });
    this.barEl = barWrap.createEl('div', { cls: 'll-progress-bar indeterminate' });

    this.statusEl = this.el.createEl('div', { cls: 'll-idx-popup-status' });

    this.phraseTimer = window.setInterval(() => {
      this.phraseIndex = (this.phraseIndex + 1) % INDEX_PHRASES.length;
      this.phraseEl.style.opacity = '0';
      setTimeout(() => {
        this.phraseEl.setText(INDEX_PHRASES[this.phraseIndex]);
        this.phraseEl.style.opacity = '1';
      }, 220);
    }, 3500);
  }

  update(msg: string, pct: number) {
    this.titleEl.setText(pct > 0 ? `Link Link — Indexing: ${Math.round(pct)}%` : 'Link Link — Indexing');
    this.statusEl.setText(msg);
    this.barEl.style.width = pct + '%';
    this.barEl.classList.toggle('indeterminate', pct === 0);
  }

  finish(summary: string, timeoutSec: number) {
    this.isFinished = true;
    if (this.phraseTimer !== null) { clearInterval(this.phraseTimer); this.phraseTimer = null; }
    this.titleEl.setText('Link Link ✓');
    this.phraseEl.style.opacity = '1';
    this.phraseEl.setText('Done!');
    this.barEl.classList.remove('indeterminate');
    this.barEl.style.width = '100%';
    this.statusEl.setText(summary);
    if (timeoutSec > 0) setTimeout(() => this.close(), timeoutSec * 1000);
  }

  close() {
    if (this.phraseTimer !== null) { clearInterval(this.phraseTimer); this.phraseTimer = null; }
    this.el.remove();
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class LinkLinkPlugin extends Plugin {
  settings: LinkLinkSettings = DEFAULT_SETTINGS;
  indexingService!: IndexingService;
  interlinkService!: InterlinkService;
  private existingIndexCache: IndexEntry[] | null = null;
  private existingIndexMtime = 0;
  private indexPopup: IndexProgressPopup | null = null;

  createProgressDisplay(secondary?: (msg: string, pct: number) => void): {
    onProgress: (msg: string, pct: number) => void;
    onDone: (summary: string) => void;
    onError: () => void;
  } {
    const mode = this.settings.progressDisplay;
    const t    = this.settings.notificationTimeout; // seconds; 0 = no auto-close

    if (mode === 'popup') {
      this.indexPopup?.close();
      const popup = new IndexProgressPopup();
      this.indexPopup = popup;
      return {
        onProgress: (msg, pct) => { popup.update(msg, pct); secondary?.(msg, pct); },
        onDone: (summary) => {
          if (popup.dismissed) new Notice(`Link Link ✓  ${summary}`, t > 0 ? t * 1000 : 0);
          else popup.finish(summary, t);
          // Keep this.indexPopup pointing at the finished popup so the next
          // run's close() call dismisses it before creating a fresh one.
        },
        onError: () => { popup.close(); this.indexPopup = null; },
      };
    } else if (mode === 'notification') {
      const notice = new Notice('', 0);
      let phraseIdx = Math.floor(Math.random() * INDEX_PHRASES.length);
      let lastPct   = 0;
      let lastMsg   = '';
      const phraseTimer = window.setInterval(() => {
        phraseIdx = (phraseIdx + 1) % INDEX_PHRASES.length;
        notice.setMessage(`Link Link — Indexing: ${Math.round(lastPct)}%\n${INDEX_PHRASES[phraseIdx]}\n${lastMsg}`);
      }, 3500);
      return {
        onProgress: (msg, pct) => {
          lastPct = pct; lastMsg = msg;
          notice.setMessage(`Link Link — Indexing: ${Math.round(pct)}%\n${INDEX_PHRASES[phraseIdx]}\n${msg}`);
          secondary?.(msg, pct);
        },
        onDone: (summary) => {
          clearInterval(phraseTimer);
          notice.setMessage(`Link Link ✓  ${summary}`);
          if (t > 0) setTimeout(() => notice.hide(), t * 1000);
        },
        onError: () => { clearInterval(phraseTimer); notice.hide(); },
      };
    } else {
      return {
        onProgress: (msg, pct) => secondary?.(msg, pct),
        onDone:  (summary) => { new Notice(`Link Link ✓  ${summary}`, t > 0 ? t * 1000 : 0); },
        onError: () => {},
      };
    }
  }

  async onload() {
    await this.loadSettings();
    this.indexingService  = new IndexingService(this.app, this);
    this.interlinkService = new InterlinkService(this.app, this);
    this.registerView(VIEW_TYPE, (leaf) => new LinkLinkView(leaf, this));
    this.addRibbonIcon('link', 'Link Link!', () => this.activateView());
    this.addCommand({ id: 'open-link-link', name: 'Open related notes panel', callback: () => this.activateView() });

    this.addCommand({
      id: 'index-vault',
      name: 'Index Vault',
      callback: async () => {
        if (this.settings.embeddingSource === 'existing') {
          new Notice('Index Vault is not available when using an existing index file. Switch to Built-in or Local model (Ollama) in Settings → Embedding.');
          return;
        }
        if (this.settings.embeddingSource === 'local' && !this.settings.ollamaModels.some(m => m.active)) {
          new Notice('No Ollama model is active. Add and activate one in Settings → Embedding.');
          return;
        }
        const { onProgress, onDone, onError } = this.createProgressDisplay();
        try {
          const { added, updated, removed } = await this.indexingService.index(onProgress);
          const summary = added + updated === 0
            ? 'Index is up to date.'
            : `+${added} new, ${updated} updated, ${removed} removed`;
          onDone(summary);
          this.refreshView();
        } catch (e) {
          onError();
          new Notice(`Index Vault failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: 'interlink-current-note',
      name: 'Interlink Current Note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        (async () => {
          try {
            const index = await this.loadAnyIndex();
            const ok = await this.interlinkService.runForFile(file, index);
            new Notice(ok
              ? `Updated related links for "${file.basename}".`
              : `"${file.basename}" is not in the index — run Index Vault first.`
            );
          } catch (e) {
            new Notice(`Interlink failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        })();
        return true;
      },
    });

    this.addCommand({
      id: 'interlink-vault',
      name: 'Interlink Vault',
      callback: async () => {
        const { onProgress, onDone, onError } = this.createProgressDisplay();
        try {
          const index = await this.loadAnyIndex();
          const { updated } = await this.interlinkService.run(index, onProgress);
          onDone(`Interlinked — updated ${updated} notes.`);
          this.refreshView();
        } catch (e) {
          onError();
          new Notice(`Interlink Vault failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      // Clicking the graph canvas activates the link-link leaf itself — skip
      // that refresh so the simulation stays alive and first click works.
      if (leaf?.view instanceof LinkLinkView) return;
      this.refreshView();
    }));

    // Real-time badge updates: when a file's metadata changes, update O/B badges
    // without a full panel re-render (avoids graph jitter and list flash).
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile) return;
      const resolved = this.app.metadataCache.resolvedLinks;
      // Only update if the changed file is the active note or links to/from it
      if (file.path !== activeFile.path &&
          !resolved[file.path]?.[activeFile.path] &&
          !resolved[activeFile.path]?.[file.path]) return;
      this.updateViewBadges(activeFile);
    }));

    // Auto-index on file save — debounced to batch rapid saves and absorb
    // Linter's second write, eliminating race conditions on the index file.
    let fileSaveTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingFiles = new Set<TFile>();
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      if (this.settings.autoIndexMode !== 'file-save') return;
      if (this.settings.embeddingSource === 'existing') return;
      pendingFiles.add(file);
      if (fileSaveTimer) clearTimeout(fileSaveTimer);
      fileSaveTimer = setTimeout(() => {
        fileSaveTimer = null;
        const batch = [...pendingFiles];
        pendingFiles.clear();
        const { onProgress, onDone, onError } = this.createProgressDisplay();
        this.indexingService.index(onProgress, batch)
          .then(({ added, updated }) => {
            // Only notify if something was actually embedded; skip "up to date" noise
            if (added + updated > 0) {
              onDone(`+${added} new, ${updated} updated`);
              this.refreshView();
            }
          })
          .catch(e => {
            onError();
            console.warn('link-link: file-save index failed', e);
          });
      }, 3000);
    }));

    this.addSettingTab(new LinkLinkSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.activateView();
      // Auto-index on startup (delayed to not block Obsidian loading)
      if (this.settings.autoIndexMode === 'startup' && this.settings.embeddingSource !== 'existing') {
        setTimeout(() => {
          const { onProgress, onDone, onError } = this.createProgressDisplay();
          this.indexingService.index(onProgress)
            .then(({ added, updated, removed }) => {
              const summary = added + updated === 0
                ? 'Index is up to date.'
                : `+${added} new, ${updated} updated, ${removed} removed`;
              onDone(summary);
              this.refreshView();
            })
            .catch(e => { onError(); console.warn('link-link: startup auto-index failed', e); });
        }, 8000);
      }
    });
  }

  openFile(file: TFile) {
    const { openMode } = this.settings;
    this.app.workspace.openLinkText(
      file.path, '',
      openMode === 'current' ? false : openMode === 'split' ? 'split' : true
    );
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf?.view instanceof LinkLinkView) leaf.view.refresh();
  }

  updateViewBadges(file: TFile) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf?.view instanceof LinkLinkView) leaf.view.updateBadges(file);
  }

  private static normalizeIndex(raw: string): IndexEntry[] {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return (parsed as any[])
        .filter(e => e.path && e.embedding)
        .map(e => ({ path: e.path, title: e.title ?? e.path, embedding: e.embedding, mtime: e.mtime }));
    }
    if (parsed?.docs?.docs && typeof parsed.docs.docs === 'object') {
      const seen = new Map<string, IndexEntry>();
      for (const d of Object.values(parsed.docs.docs) as any[]) {
        if (!d.path || !d.embedding) continue;
        if (!seen.has(d.path)) seen.set(d.path, { path: d.path, title: d.title ?? d.path, embedding: d.embedding });
      }
      return [...seen.values()];
    }
    throw new Error('Unrecognized index format');
  }

  private async loadExistingIndex(): Promise<IndexEntry[]> {
    const path = this.settings.existingIndexPath.trim();
    if (!path) throw new Error('Index file is not configured');
    const adapter = this.app.vault.adapter;
    // @ts-ignore
    const stat = await adapter.stat(path);
    if (!stat) throw new Error('Index file is not configured');
    if (this.existingIndexCache && stat.mtime === this.existingIndexMtime) return this.existingIndexCache;
    // @ts-ignore
    const raw = await adapter.read(path);
    this.existingIndexCache = LinkLinkPlugin.normalizeIndex(raw);
    this.existingIndexMtime = stat.mtime ?? 0;
    return this.existingIndexCache;
  }

  async scanForIndexFiles(): Promise<{ path: string; format: string }[]> {
    const adapter = this.app.vault.adapter;
    // @ts-ignore
    const listed = await adapter.list('.obsidian');
    const results: { path: string; format: string }[] = [];
    for (const filePath of listed.files as string[]) {
      if (!filePath.endsWith('.json')) continue;
      try {
        // @ts-ignore
        const raw = await adapter.read(filePath);
        const parsed = JSON.parse(raw);
        if (parsed?.docs?.docs && typeof parsed.docs.docs === 'object') {
          results.push({ path: filePath, format: 'Copilot index' });
        } else if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.embedding) {
          results.push({ path: filePath, format: 'Link-link index' });
        }
      } catch { /* skip unreadable files */ }
    }
    return results;
  }

  async loadAnyIndex(): Promise<IndexEntry[]> {
    if (this.settings.embeddingSource === 'existing') return this.loadExistingIndex();
    return this.indexingService.loadIndex();
  }

  async getRelated(file: TFile, naturalPaths?: Set<string>): Promise<{ file: TFile; score: number }[]> {
    if (this.settings.embeddingSource === 'existing') return this.getRelatedFromExisting(file, naturalPaths);
    return this.getRelatedFromBuiltin(file, naturalPaths);
  }

  private async getRelatedFromBuiltin(file: TFile, naturalPaths?: Set<string>): Promise<{ file: TFile; score: number }[]> {
    let index: IndexEntry[];
    try {
      index = await this.indexingService.loadIndex();
    } catch {
      throw new EmbeddingNotFoundError(file.basename, this.settings.embeddingSource);
    }
    const curr = index.find(e => e.path === file.path);
    if (!curr) throw new EmbeddingNotFoundError(file.basename, this.settings.embeddingSource);

    const results: { file: TFile; score: number }[] = [];
    for (const e of index) {
      if (e.path === file.path) continue;
      const s = cosine(curr.embedding, e.embedding);
      if (s < this.settings.threshold) continue;
      const tf = this.app.vault.getFileByPath(e.path);
      if (tf) results.push({ file: tf, score: s });
    }
    results.sort((a, b) => b.score - a.score);
    const { topN } = this.settings;
    if (topN === 0) return results;
    // Natural connections (O/B) don't consume Top N slots — count only semantic results
    const semantic = results.filter(r => !naturalPaths?.has(r.file.path));
    const natural  = results.filter(r =>  naturalPaths?.has(r.file.path));
    return [...semantic.slice(0, topN), ...natural];
  }

  private async getRelatedFromExisting(file: TFile, naturalPaths?: Set<string>): Promise<{ file: TFile; score: number }[]> {
    let index: IndexEntry[];
    try {
      index = await this.loadExistingIndex();
    } catch {
      throw new EmbeddingNotFoundError(file.basename, this.settings.embeddingSource);
    }
    const curr = index.find(e => e.path === file.path);
    if (!curr) throw new EmbeddingNotFoundError(file.basename, this.settings.embeddingSource);
    const results: { file: TFile; score: number }[] = [];
    for (const e of index) {
      if (e.path === file.path) continue;
      const s = cosine(curr.embedding, e.embedding);
      if (s < this.settings.threshold) continue;
      const tf = this.app.vault.getFileByPath(e.path);
      if (tf) results.push({ file: tf, score: s });
    }
    results.sort((a, b) => b.score - a.score);
    const { topN } = this.settings;
    if (topN === 0) return results;
    // Natural connections (O/B) don't consume Top N slots — count only semantic results
    const semantic = results.filter(r => !naturalPaths?.has(r.file.path));
    const natural  = results.filter(r =>  naturalPaths?.has(r.file.path));
    return [...semantic.slice(0, topN), ...natural];
  }

  // Returns naturally-connected files NOT already in `existing` (body-text outgoing links +
  // backlinks), with their cosine score. Frontmatter-only links (e.g. the related: field) are
  // intentionally excluded so they remain subject to threshold filtering — otherwise interlink's
  // own output would force notes below threshold to always appear in the panel.
  async getLinkedResults(
    currentFile: TFile,
    existing: { file: TFile; score: number }[]
  ): Promise<{ file: TFile; score: number }[]> {
    const resolved = this.app.metadataCache.resolvedLinks;
    const linkedPaths = new Set<string>();

    // Body-text outgoing links only (excludes frontmatter wiki-links such as related:)
    const bodyLinks = this.app.metadataCache.getFileCache(currentFile)?.links ?? [];
    for (const link of bodyLinks) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, currentFile.path);
      if (dest) linkedPaths.add(dest.path);
    }
    // Backlinks — any note that links to the current note
    for (const [src, links] of Object.entries(resolved)) {
      if (src !== currentFile.path && links[currentFile.path]) linkedPaths.add(src);
    }
    linkedPaths.delete(currentFile.path);

    const existingPaths = new Set(existing.map(r => r.file.path));
    const missing = [...linkedPaths]
      .filter(p => !existingPaths.has(p))
      .map(p => this.app.vault.getFileByPath(p))
      .filter((f): f is TFile => f !== null && f.extension === 'md');

    if (missing.length === 0) return [];

    try {
      const index = await this.loadAnyIndex();
      const currEntry = index.find(e => e.path === currentFile.path);
      if (!currEntry) return missing.map(f => ({ file: f, score: 0 }));
      return missing.map(f => {
        const entry = index.find(e => e.path === f.path);
        return { file: f, score: entry ? cosine(currEntry.embedding, entry.embedding) : 0 };
      });
    } catch {
      return missing.map(f => ({ file: f, score: 0 }));
    }
  }

  getLinkedPaths(currentFile: TFile, results: { file: TFile; score: number }[]): Set<string> {
    const linked = new Set<string>();
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const path of Object.keys(resolved[currentFile.path] ?? {})) linked.add(path);
    for (const { file } of results) {
      if (resolved[file.path]?.[currentFile.path]) linked.add(file.path);
    }
    return linked;
  }

  getOutgoingAndBacklinkPaths(currentFile: TFile): { outgoingPaths: Set<string>; backlinkPaths: Set<string> } {
    const resolved  = this.app.metadataCache.resolvedLinks;
    const bodyLinks = this.app.metadataCache.getFileCache(currentFile)?.links ?? [];

    const outgoingPaths = new Set<string>();
    for (const link of bodyLinks) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, currentFile.path);
      if (dest) outgoingPaths.add(dest.path);
    }

    const backlinkPaths = new Set<string>();
    for (const [src, links] of Object.entries(resolved)) {
      if (src !== currentFile.path && links[currentFile.path]) backlinkPaths.add(src);
    }

    return { outgoingPaths, backlinkPaths };
  }

  async loadSettings() {
    const data = await this.loadData() ?? {};
    if (data.embeddingSource === 'copilot') {
      data.embeddingSource = 'existing';
      data.existingIndexPath = '';
      delete data.copilotIndexPath;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshView();
  }
}

// ─── Path picker modal ───────────────────────────────────────────────────────

class PathSuggestModal extends FuzzySuggestModal<string> {
  private paths: string[];
  private onChoose: (path: string) => void;

  constructor(app: App, onChoose: (path: string) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder('Type folder or file name…');

    const folders: string[] = [];
    const addFolders = (f: TFolder) => {
      if (f.path) folders.push(f.path + '/');
      for (const child of f.children) {
        if (child instanceof TFolder) addFolders(child);
      }
    };
    addFolders(app.vault.getRoot());

    const files = app.vault.getMarkdownFiles().map(f => f.path);
    this.paths = [...folders.sort(), ...files.sort()];
  }

  getItems()              { return this.paths; }
  getItemText(item: string) { return item; }
  onChooseItem(item: string) { this.onChoose(item); }
}

// ─── Filter section (two-column chip list) ────────────────────────────────────

function filterSection(
  parent: HTMLElement,
  app: App,
  title: string,
  desc: string,
  values: string[],
  onChange: (v: string[]) => Promise<void>
) {
  const section = parent.createEl('div', { cls: 'll-filter-section' });
  const body    = section.createEl('div', { cls: 'll-filter-body' });
  const left    = body.createEl('div',   { cls: 'll-filter-left' });
  left.createEl('div', { text: title, cls: 'll-filter-title' });
  left.createEl('div', { text: desc,  cls: 'll-filter-desc'  });

  const right    = body.createEl('div', { cls: 'll-filter-right' });
  const chipZone = right.createEl('div', { cls: 'll-chip-zone' });

  const renderChips = () => {
    chipZone.empty();
    if (values.length === 0) {
      chipZone.createEl('div', { cls: 'll-chip-empty', text: 'No patterns configured' });
    } else {
      for (const v of values) {
        const chip = chipZone.createEl('span', { cls: 'll-chip' });
        const iconEl = chip.createEl('span', { cls: 'll-chip-icon' });
        setIcon(iconEl, v.endsWith('/') ? 'folder' : 'file-text');
        chip.createEl('span', { text: v, cls: 'll-chip-text' });
        const x = chip.createEl('button', { cls: 'll-chip-x', text: '×' });
        x.addEventListener('click', async () => {
          values.splice(values.indexOf(v), 1);
          await onChange([...values]);
          renderChips();
        });
      }
    }
  };
  renderChips();

  const addRow = right.createEl('div', { cls: 'll-filter-add-row' });
  const addBtn = addRow.createEl('button', { cls: 'll-filter-add' });
  setIcon(addBtn, 'plus');
  addBtn.createEl('span', { text: 'Add…' });
  addBtn.addEventListener('click', () => {
    new PathSuggestModal(app, (path) => {
      if (!values.includes(path)) {
        values.push(path);
        onChange([...values]).then(() => renderChips());
      }
    }).open();
  });
}

// ─── Chip input ──────────────────────────────────────────────────────────────

function chipField(
  parent: HTMLElement,
  values: string[],
  placeholder: string,
  onChange: (v: string[]) => Promise<void>
) {
  const wrap = parent.createEl('div', { cls: 'll-chip-field' });
  const render = () => {
    wrap.empty();
    for (const v of values) {
      const chip = wrap.createEl('span', { cls: 'll-chip' });
      chip.createEl('span', { text: v, cls: 'll-chip-text' });
      const x = chip.createEl('button', { cls: 'll-chip-x', text: '×' });
      x.addEventListener('click', async () => {
        values.splice(values.indexOf(v), 1);
        await onChange([...values]);
        render();
      });
    }
    const add = wrap.createEl('button', { cls: 'll-chip-add', text: '+ Add' });
    add.addEventListener('click', () => {
      add.remove();
      const inp = wrap.createEl('input', { cls: 'll-chip-input' });
      inp.placeholder = placeholder;
      const commit = async () => {
        const val = inp.value.trim();
        if (val && !values.includes(val)) { values.push(val); await onChange([...values]); }
        render();
      };
      inp.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') { e.preventDefault(); await commit(); }
        if (e.key === 'Escape') render();
      });
      inp.addEventListener('blur', commit);
      inp.focus();
    });
  };
  render();
}

// ─── Ollama model modal ───────────────────────────────────────────────────────

class OllamaModelModal extends Modal {
  private onSave: (modelName: string, displayName: string, baseUrl: string) => void;
  private existing?: OllamaModel;

  constructor(app: App, existing: OllamaModel | undefined, onSave: (modelName: string, displayName: string, baseUrl: string) => void) {
    super(app);
    this.existing = existing;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: this.existing ? 'Edit model' : 'Add custom embedding model', cls: 'll-modal-heading' });

    const form = contentEl.createEl('div', { cls: 'll-modal-form' });

    const makeField = (label: string, required: boolean) => {
      const f = form.createEl('div', { cls: 'll-modal-field' });
      const lbl = f.createEl('label', { cls: 'll-modal-label' });
      lbl.createEl('span', { text: label });
      if (required) lbl.createEl('span', { text: ' *', cls: 'll-modal-required' });
      return f;
    };

    const nameField = makeField('Model name', true);
    const nameInput = nameField.createEl('input', { type: 'text', cls: 'll-modal-input' });
    nameInput.placeholder = 'Enter exact model name (e.g. bge-m3)';
    nameInput.value = this.existing?.modelName ?? '';
    const nameErr = nameField.createEl('p', { cls: 'll-modal-error' });
    nameErr.style.display = 'none';

    const dispField = makeField('Display name', false);
    const dispInput = dispField.createEl('input', { type: 'text', cls: 'll-modal-input' });
    dispInput.placeholder = 'Custom display name (e.g. BGE-M3 local)';
    dispInput.value = this.existing?.displayName ?? '';

    const urlField = makeField('Base URL', false);
    const urlInput = urlField.createEl('input', { type: 'text', cls: 'll-modal-input' });
    urlInput.placeholder = 'http://localhost:11434';
    urlInput.value = this.existing?.baseUrl ?? '';
    urlField.createEl('p', { text: 'Leave it blank, unless you are using a proxy.', cls: 'll-modal-hint' });

    const btns = contentEl.createEl('div', { cls: 'll-modal-btns' });
    btns.createEl('button', { text: 'Cancel', cls: 'll-action-btn ll-action-btn-secondary' })
      .addEventListener('click', () => this.close());
    const saveBtn = btns.createEl('button', {
      text: this.existing ? 'Save changes' : 'Add model',
      cls: 'll-action-btn ll-action-btn-accent',
    });

    const doSave = () => {
      const mn = nameInput.value.trim();
      if (!mn) {
        nameErr.setText('Model name is required.');
        nameErr.style.display = 'block';
        nameInput.focus();
        return;
      }
      nameErr.style.display = 'none';
      this.onSave(mn, dispInput.value.trim(), urlInput.value.trim());
      this.close();
    };

    saveBtn.addEventListener('click', doSave);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });

    setTimeout(() => nameInput.focus(), 50);
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Settings tab ────────────────────────────────────────────────────────────

class LinkLinkSettingTab extends PluginSettingTab {
  plugin: LinkLinkPlugin;
  private tooltipEl:            HTMLElement | null = null;
  private mtimeTipEl:          HTMLElement | null = null;
  private autoIndexTipEl:      HTMLElement | null = null;
  private progressDisplayTipEl: HTMLElement | null = null;

  constructor(app: App, plugin: LinkLinkPlugin) {
    super(app, plugin); this.plugin = plugin;
  }

  hide() {
    this.tooltipEl?.remove();              this.tooltipEl             = null;
    this.mtimeTipEl?.remove();            this.mtimeTipEl            = null;
    this.autoIndexTipEl?.remove();        this.autoIndexTipEl        = null;
    this.progressDisplayTipEl?.remove(); this.progressDisplayTipEl = null;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    this.tooltipEl?.remove();              this.tooltipEl             = null;
    this.mtimeTipEl?.remove();            this.mtimeTipEl            = null;
    this.autoIndexTipEl?.remove();        this.autoIndexTipEl        = null;
    this.progressDisplayTipEl?.remove(); this.progressDisplayTipEl = null;

    const S    = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    const app  = this.app;

    // ── Tab bar: Embedding | Interlink Vault | Graph ─────────────────────
    const tabBar = containerEl.createEl('div', { cls: 'll-tab-bar' });
    const body   = containerEl.createEl('div', { cls: 'll-tab-body' });

    type TabId = 'embedding' | 'interlink' | 'graph';
    let activeTab: TabId = 'embedding';

    const switchTab = (tab: TabId) => {
      activeTab = tab;
      body.empty();
      tabBar.querySelectorAll('.ll-tab').forEach(t =>
        t.classList.toggle('active', t.getAttribute('data-tab') === tab)
      );
      if (tab === 'embedding') renderEmbedding();
      else if (tab === 'interlink') renderInterlink();
      else renderGraph();
    };

    for (const [id, label] of [
      ['embedding', 'Embedding'],
      ['interlink', 'Interlink Vault'],
      ['graph',     'Graph'],
    ] as const) {
      const btn = tabBar.createEl('button', {
        cls: 'll-tab' + (id === 'embedding' ? ' active' : ''),
        text: label,
      });
      btn.setAttribute('data-tab', id);
      btn.addEventListener('click', () => switchTab(id));
    }

    // ── Shared helpers ───────────────────────────────────────────────────

    const makeProgress = (parent: HTMLElement) => {
      const wrap     = parent.createEl('div', { cls: 'll-settings-prog' });
      wrap.style.display = 'none';
      const pctEl    = wrap.createEl('p',   { cls: 'll-prog-pct' });
      const phraseEl = wrap.createEl('p',   { cls: 'll-prog-phrase' });
      const label    = wrap.createEl('p',   { cls: 'll-prog-label' });
      const track    = wrap.createEl('div', { cls: 'll-progress-wrap' });
      const bar      = track.createEl('div', { cls: 'll-progress-bar' });

      let phraseIdx   = Math.floor(Math.random() * INDEX_PHRASES.length);
      let phraseTimer: number | null = null;

      const startPhrases = () => {
        if (phraseTimer !== null) return;
        phraseEl.setText(INDEX_PHRASES[phraseIdx]);
        phraseTimer = window.setInterval(() => {
          phraseIdx = (phraseIdx + 1) % INDEX_PHRASES.length;
          phraseEl.style.opacity = '0';
          setTimeout(() => {
            phraseEl.setText(INDEX_PHRASES[phraseIdx]);
            phraseEl.style.opacity = '1';
          }, 220);
        }, 3500);
      };

      const show = (msg: string, pct: number) => {
        wrap.style.display = 'block';
        pctEl.setText(pct > 0 ? `${Math.round(pct)}%` : '');
        label.setText(msg);
        bar.style.width = pct + '%';
        bar.classList.toggle('indeterminate', pct === 0);
        startPhrases();
      };
      const hide = (delay = 1800) => {
        if (phraseTimer !== null) { clearInterval(phraseTimer); phraseTimer = null; }
        setTimeout(() => { wrap.style.display = 'none'; }, delay);
      };
      return { show, hide };
    };

    const addReset = (setting: Setting, key: keyof LinkLinkSettings) => {
      const btn = setting.controlEl.createEl('button', {
        cls: 'll-reset-btn', title: 'Reset to default',
      });
      setIcon(btn, 'rotate-ccw');
      btn.addEventListener('click', async () => {
        (S as any)[key] = (DEFAULT_SETTINGS as any)[key];
        await save();
        const scroller = containerEl.closest('.vertical-tab-content') as HTMLElement | null;
        const scrollTop = scroller?.scrollTop ?? 0;
        switchTab(activeTab);
        requestAnimationFrame(() => { if (scroller) scroller.scrollTop = scrollTop; });
      });
    };

    const slider = (
      parent: HTMLElement, name: string, desc: string,
      key: keyof LinkLinkSettings, min: number, max: number, step: number
    ): Setting => {
      const s = new Setting(parent).setName(name).setDesc(desc)
        .addSlider(sl => sl.setLimits(min, max, step)
          .setValue(S[key] as number).setDynamicTooltip()
          .onChange(async v => { (S as any)[key] = v; await save(); }));
      addReset(s, key);
      return s;
    };

    // ── EMBEDDING TAB ────────────────────────────────────────────────────

    const renderEmbedding = () => {
      const { show: showProg, hide: hideProg } = makeProgress(body);

      // Model source
      body.createEl('h3', { text: 'Model source' });

      const embSetting = new Setting(body)
        .setName('Embedding model')
        .addDropdown(d => d
          .addOptions({
            builtin:  'Built-in (lightweight)',
            local:    'Local model (Ollama)',
            existing: 'Existing index file',
          })
          .setValue(S.embeddingSource)
          .onChange(async v => {
            S.embeddingSource = v as LinkLinkSettings['embeddingSource'];
            await save();
            this.display();
          })
        );

      // ? tooltip
      const helpBtn = embSetting.nameEl.createEl('button', { cls: 'll-help-btn', text: '?' });
      const tip = document.body.createEl('div', { cls: 'll-emb-tooltip' });
      this.tooltipEl = tip;
      tip.innerHTML = `
        <div class="ll-tip-item"><div class="ll-tip-title">Built-in (lightweight)</div>
          <div class="ll-tip-body">A compact model shipped with the plugin. Runs fully offline with no downloads required.</div></div>
        <div class="ll-tip-item"><div class="ll-tip-title">Local model (Ollama)</div>
          <div class="ll-tip-body">Use a locally-running Ollama server for full control and more powerful models. Requires Ollama installed and running on your machine.</div></div>
        <div class="ll-tip-item"><div class="ll-tip-title">Existing index file</div>
          <div class="ll-tip-body">Reads an existing index file from inside your vault — for example, one created by the Copilot plugin. Supports any recognized index format.</div></div>`;
      helpBtn.addEventListener('mouseenter', () => {
        const r = helpBtn.getBoundingClientRect();
        tip.style.top  = r.bottom + 6 + 'px';
        tip.style.left = r.left   + 'px';
        tip.classList.add('visible');
      });
      helpBtn.addEventListener('mouseleave', () => tip.classList.remove('visible'));

      if (S.embeddingSource === 'builtin') {
        const info = body.createEl('div', { cls: 'll-model-info' });
        info.createEl('div', { text: 'bge-small-en-v1.5 by BAAI', cls: 'll-model-info-name' });
        info.createEl('div', {
          text: '384-dimensional sentence embeddings · shipped with the plugin · no downloads, no cloud',
          cls: 'll-model-info-desc',
        });
        const link = info.createEl('a', { text: 'View on HuggingFace →', cls: 'll-model-info-link' });
        link.addEventListener('click', (e) => {
          e.preventDefault();
          // @ts-ignore
          window.open('https://huggingface.co/Xenova/bge-small-en-v1.5', '_blank');
        });
      } else if (S.embeddingSource === 'local') {
        const modelArea = body.createEl('div', { cls: 'll-model-area' });

        const renderModels = () => {
          modelArea.empty();

          const mh = modelArea.createEl('div', { cls: 'll-model-header' });
          mh.createEl('span', { text: 'Embedding Models', cls: 'll-model-header-title' });
          const ab = mh.createEl('button', { cls: 'll-action-btn ll-action-btn-accent' });
          setIcon(ab.createEl('span', { cls: 'll-btn-icon' }), 'plus');
          ab.createEl('span', { text: 'Add Model' });
          ab.addEventListener('click', () => {
            new OllamaModelModal(app, undefined, async (mn, dn, bu) => {
              const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
              const isFirst = S.ollamaModels.length === 0;
              S.ollamaModels.push({ id, modelName: mn, displayName: dn, baseUrl: bu, active: isFirst });
              await save();
              renderModels();
            }).open();
          });

          if (S.ollamaModels.length === 0) {
            modelArea.createEl('div', {
              cls: 'll-model-empty',
              text: 'No local models configured — click + Add Model to get started',
            });
          } else {
            const list = modelArea.createEl('div', { cls: 'll-model-list' });
            for (const model of [...S.ollamaModels]) {
              const row = list.createEl('div', { cls: 'll-model-row' });

              // Active checkbox (radio-like: checking one unchecks all others)
              const activeCell = row.createEl('div', { cls: 'll-model-active-cell' });
              const chk = activeCell.createEl('input');
              chk.type = 'checkbox'; chk.checked = model.active;
              chk.className = 'll-model-active-chk';
              chk.title = 'Set as active model';
              chk.addEventListener('change', async () => {
                if (!chk.checked) { chk.checked = true; return; }
                for (const m of S.ollamaModels) m.active = m.id === model.id;
                await save();
                renderModels();
              });

              // Display name
              row.createEl('div', { cls: 'll-model-name', text: model.displayName || model.modelName });

              // Model name (monospace)
              row.createEl('div', { cls: 'll-model-slug', text: model.modelName });

              // Check connection cell
              const connCell = row.createEl('div', { cls: 'll-model-conn-cell' });
              const checkBtn = connCell.createEl('button', { cls: 'll-model-check-btn', text: 'Check' });
              checkBtn.addEventListener('click', async () => {
                checkBtn.disabled = true;
                checkBtn.setText('Checking…');
                connCell.querySelector('.ll-conn-badge')?.remove();

                // Returns true (found), false (up but model missing), null (unreachable)
                const ping = async (): Promise<boolean | null> => {
                  try {
                    const base = (model.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
                    const resp = await fetch(`${base}/api/tags`);
                    if (!resp.ok) return null;
                    const data = await resp.json() as { models?: { name: string }[] };
                    return (data.models ?? []).some(
                      (m: { name: string }) => m.name === model.modelName || m.name.startsWith(model.modelName + ':')
                    );
                  } catch { return null; }
                };

                const showBadge = (r: boolean | null) => connCell.createEl('span', {
                  cls: `ll-conn-badge ${r === true ? 'll-conn-badge-ok' : r === false ? 'll-conn-badge-warn' : 'll-conn-badge-fail'}`,
                  text: r === true ? '✓ Reachable' : r === false ? '! Not installed' : '✗ Unreachable',
                });

                try {
                  const first = await ping();
                  // Ollama can take a moment to list models after startup —
                  // if server is up but model not yet visible, wait and retry once.
                  if (first === false) {
                    const loading = connCell.createEl('span', { cls: 'll-conn-badge ll-conn-badge-warn', text: '⟳ Model loading…' });
                    await new Promise(r => setTimeout(r, 2000));
                    loading.remove();
                    showBadge(await ping());
                  } else {
                    showBadge(first);
                  }
                } finally {
                  checkBtn.disabled = false;
                  checkBtn.setText('Check');
                }
              });

              // Edit button
              const editBtn = row.createEl('button', { cls: 'll-model-icon-btn', title: 'Edit model' });
              setIcon(editBtn, 'pencil');
              editBtn.addEventListener('click', () => {
                new OllamaModelModal(app, model, async (mn, dn, bu) => {
                  model.modelName = mn;
                  model.displayName = dn;
                  model.baseUrl = bu;
                  await save();
                  renderModels();
                }).open();
              });

              // Delete button
              const delBtn = row.createEl('button', { cls: 'll-action-btn ll-action-btn-danger', title: 'Delete model' });
              setIcon(delBtn.createEl('span', { cls: 'll-btn-icon' }), 'trash-2');
              delBtn.addEventListener('click', () => {
                new ConfirmModal(app,
                  `Delete model "${model.displayName || model.modelName}"?`,
                  'This also deletes its embedding index file. This action cannot be undone.',
                  async () => {
                    const idxPath = this.plugin.indexingService.indexPathForModel(model.id);
                    if (await this.app.vault.adapter.exists(idxPath)) {
                      await this.app.vault.adapter.remove(idxPath);
                    }
                    S.ollamaModels = S.ollamaModels.filter(m => m.id !== model.id);
                    if (model.active && S.ollamaModels.length > 0) S.ollamaModels[0].active = true;
                    await save();
                    renderModels();
                  }
                ).open();
              });
            }
          }
        };

        renderModels();
      } else {
        body.createEl('p', {
          text: 'Use an existing embedding index created by another plugin. The index file must be located inside your vault.',
          cls: 'll-model-info-desc',
        });

        // ── auto-detected files ──────────────────────────────────────────
        const detectedWrap = body.createEl('div', { cls: 'll-detected-wrap' });
        const detectedHeader = detectedWrap.createEl('div', { cls: 'll-detected-header' });
        detectedHeader.createEl('span', { text: 'Auto-detected index files', cls: 'll-detected-title' });
        const scanBtn = detectedHeader.createEl('button', { cls: 'll-action-btn ll-action-btn-accent' });
        setIcon(scanBtn.createEl('span', { cls: 'll-btn-icon' }), 'search');
        scanBtn.createEl('span', { text: 'Scan' });
        const detectedList = detectedWrap.createEl('div', { cls: 'll-detected-list' });

        let pathInput: HTMLInputElement | null = null;

        const renderDetected = (files: { path: string; format: string }[]) => {
          detectedList.empty();
          if (files.length === 0) {
            detectedList.createEl('p', { text: 'No index files found.', cls: 'll-detected-empty' });
            return;
          }
          for (const f of files) {
            const row = detectedList.createEl('div', { cls: 'll-detected-row' });
            const cb = row.createEl('input') as HTMLInputElement;
            cb.type = 'checkbox';
            cb.checked = S.existingIndexPath === f.path;
            const label = row.createEl('span', { cls: 'll-detected-path' });
            label.createEl('span', { text: f.path, cls: 'll-detected-path-text' });
            label.createEl('span', { text: f.format, cls: 'll-detected-format' });
            cb.addEventListener('change', async () => {
              if (!cb.checked) {
                S.existingIndexPath = '';
              } else {
                // uncheck others
                detectedList.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(c => { if (c !== cb) c.checked = false; });
                S.existingIndexPath = f.path;
              }
              if (pathInput) pathInput.value = S.existingIndexPath;
              validationEl.style.display = S.existingIndexPath ? 'none' : '';
              await save();
            });
          }
        };

        const runScan = async (): Promise<{ path: string; format: string }[]> => {
          scanBtn.disabled = true;
          scanBtn.querySelector('span:last-child')!.textContent = 'Scanning…';
          try {
            const found = await this.plugin.scanForIndexFiles();
            renderDetected(found);
            return found;
          } finally {
            scanBtn.disabled = false;
            scanBtn.querySelector('span:last-child')!.textContent = 'Scan';
          }
        };

        scanBtn.addEventListener('click', async () => {
          const found = await runScan();
          S.detectedIndexFiles = found;
          await save();
        });

        // On open: show stored list, pruning any files no longer on disk
        const initList = async () => {
          const adapter = this.plugin.app.vault.adapter;
          const alive: { path: string; format: string }[] = [];
          for (const f of S.detectedIndexFiles) {
            // @ts-ignore
            if (await adapter.exists(f.path)) alive.push(f);
          }
          if (alive.length !== S.detectedIndexFiles.length) {
            S.detectedIndexFiles = alive;
            if (!alive.some(f => f.path === S.existingIndexPath)) S.existingIndexPath = '';
            await save();
          }
          if (alive.length > 0) {
            renderDetected(alive);
          } else if (!S.existingIndexPath) {
            // nothing stored and nothing selected — auto-scan once
            const found = await runScan();
            S.detectedIndexFiles = found;
            await save();
          } else {
            detectedList.createEl('p', { text: 'Press Scan to detect index files.', cls: 'll-detected-empty' });
          }
        };
        initList();

        // ── manual path ──────────────────────────────────────────────────
        new Setting(body)
          .setName('Index file path')
          .addText(t => {
            t.setPlaceholder('.obsidian/<path-to-your-index-file>')
             .setValue(S.existingIndexPath)
             .onChange(async v => {
               S.existingIndexPath = v;
               // uncheck all detected rows when typing manually
               detectedList.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(c => { c.checked = false; });
               validationEl.style.display = v.trim() ? 'none' : '';
               await save();
             });
            pathInput = t.inputEl;
          });

        // ── validation message ───────────────────────────────────────────
        const validationEl = body.createEl('p', { text: 'Index file is not configured', cls: 'll-error' });
        validationEl.style.display = S.existingIndexPath.trim() ? 'none' : '';
      }

      if (S.embeddingSource !== 'existing') {
        body.createEl('h3', { text: 'Indexing target' });

        const targetSection = body.createEl('div', { cls: 'll-action-section ll-action-section-flat' });
        const modeHeader = targetSection.createEl('div', { cls: 'll-filter-mode-header' });
        modeHeader.createEl('span', { text: 'Targeting mode', cls: 'll-filter-mode-label' });
        const modeRow = modeHeader.createEl('div', { cls: 'll-mode-row' });

        const modeDesc = targetSection.createEl('p', { cls: 'll-mode-desc' });
        const filterWrap = targetSection.createEl('div');

        const updateModeDesc = () => modeDesc.setText(
          S.indexMode === 'exclude'
            ? 'Listed folders and files are skipped during indexing. Subfolders are excluded automatically.'
            : 'Only listed folders and files are indexed. Everything else is skipped.'
        );

        const renderTargetFilter = () => {
          filterWrap.empty();
          const activePaths = S.indexMode === 'exclude' ? S.excludePaths : S.includePaths;
          filterSection(filterWrap, app,
            S.indexMode === 'exclude' ? 'Excluded paths' : 'Included paths',
            S.indexMode === 'exclude'
              ? 'These folders and files are skipped. Everything else gets indexed.'
              : 'Only these folders and files are indexed. Everything else is skipped.',
            activePaths,
            async v => {
              if (S.indexMode === 'exclude') S.excludePaths = v;
              else S.includePaths = v;
              await save();
            }
          );
        };

        updateModeDesc();
        renderTargetFilter();

        for (const [val, label] of [['exclude', 'Exclude'], ['include', 'Only include']] as const) {
          const btn = modeRow.createEl('button', {
            cls: 'll-mode-btn' + (S.indexMode === val ? ' active' : ''),
            text: label,
          });
          btn.addEventListener('click', async () => {
            S.indexMode = val;
            await save();
            modeRow.querySelectorAll('.ll-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateModeDesc();
            renderTargetFilter();
          });
        }
      }

      if (S.embeddingSource !== 'existing') {
        body.createEl('h3', { text: 'Index vault' });

        const idxSection = body.createEl('div', { cls: 'll-action-section' });
        idxSection.createEl('p', { cls: 'll-idx-desc',
          text: 'Embeddings help your device understand the meaning of your notes — not just keywords, but context and intent. ' +
                'Index your vault before using the plugin. Notes that were added or heavily modified post-indexing will not appear or won\'t have a relevant similarity score.' });

        // Auto-index setting
        const autoIdxSetting = new Setting(idxSection)
          .setName('Auto-index')
          .addDropdown(d => d
            .addOptions({
              'manual':    'Only manually',
              'startup':   'On startup (recommended)',
              'file-save': 'On file save',
            })
            .setValue(S.autoIndexMode)
            .onChange(async v => {
              S.autoIndexMode = v as LinkLinkSettings['autoIndexMode'];
              await save();
            })
          );

        const autoIdxHelpBtn = autoIdxSetting.nameEl.createEl('button', { cls: 'll-help-btn', text: '?' });
        const autoIdxTip = document.body.createEl('div', { cls: 'll-emb-tooltip ll-wide-tooltip' });
        this.autoIndexTipEl = autoIdxTip;
        autoIdxTip.innerHTML = `
          <div class="ll-tip-item">
            <div class="ll-tip-title">Only manually</div>
            <div class="ll-tip-body">You control when the indexer runs. No background activity.<br>
              ✦ Zero performance impact<br>
              ✦ Predictable — nothing runs unless you ask<br>
              ✗ Index might go stale in the background; new or edited notes won't appear in results until you re-index</div>
          </div>
          <div class="ll-tip-item">
            <div class="ll-tip-title">On startup <span style="font-weight:400;color:var(--text-muted)">(recommended)</span></div>
            <div class="ll-tip-body">Indexer runs once when Obsidian opens, then stays out of the way.<br>
              ✦ Index is always fresh at the start of each session<br>
              ✦ No impact during your work<br>
              ✗ Notes edited between sessions are stale until next restart or manual re-indexing</div>
          </div>
          <div class="ll-tip-item">
            <div class="ll-tip-title">On file save</div>
            <div class="ll-tip-body">Indexes notes a few seconds after a file save.<br>
              ✦ Results stay continuously current<br>
              ✗ Light background processing after each save; may be noticeable on large vaults or slow machines</div>
          </div>`;
        autoIdxHelpBtn.addEventListener('mouseenter', () => {
          const r = autoIdxHelpBtn.getBoundingClientRect();
          autoIdxTip.style.top  = r.bottom + 6 + 'px';
          autoIdxTip.style.left = r.left   + 'px';
          autoIdxTip.classList.add('visible');
        });
        autoIdxHelpBtn.addEventListener('mouseleave', () => autoIdxTip.classList.remove('visible'));

        // mtime source
        const mtimeSetting = new Setting(idxSection)
          .setName('Changes detection')
          .addDropdown(d => d
            .addOptions({
              'os':          'OS file modification time',
              'frontmatter': 'Custom frontmatter field',
            })
            .setValue(S.mtimeSource)
            .onChange(async v => {
              S.mtimeSource = v as LinkLinkSettings['mtimeSource'];
              await save();
              fieldWrap.style.display = v === 'frontmatter' ? '' : 'none';
            })
          );

        // ? tooltip on the setting name (same pattern as Embedding model)
        const mtimeHelpBtn = mtimeSetting.nameEl.createEl('button', { cls: 'll-help-btn', text: '?' });
        const mtimeTip = document.body.createEl('div', { cls: 'll-emb-tooltip' });
        this.mtimeTipEl = mtimeTip;
        mtimeTip.innerHTML = `
          <div class="ll-tip-item">
            <div class="ll-tip-body">
              The index command compares a modification timestamp to skip unchanged notes.<br><br>
              OS timestamp is the default signal, but keep in mind: sync tools such as Dropbox,
              iCloud, and others may overwrite it on transfer. If you have your modified timestamp
              stored in a custom frontmatter field, you can use it instead of the OS timestamp.<br><br>
              If the custom field is absent or unreadable, the OS timestamp is used as a fallback
              so notes without the field still get reliable change detection.
            </div>
          </div>`;
        mtimeHelpBtn.addEventListener('mouseenter', () => {
          const r = mtimeHelpBtn.getBoundingClientRect();
          mtimeTip.style.top  = r.bottom + 6 + 'px';
          mtimeTip.style.left = r.left   + 'px';
          mtimeTip.classList.add('visible');
        });
        mtimeHelpBtn.addEventListener('mouseleave', () => mtimeTip.classList.remove('visible'));

        const fieldWrap = idxSection.createEl('div', { cls: 'll-mtime-field-wrap' });
        fieldWrap.style.display = S.mtimeSource === 'frontmatter' ? '' : 'none';

        new Setting(fieldWrap)
          .setName('Frontmatter field')
          .setDesc('Name of the date field written by your Linter plugin.')
          .addText(t => t
            .setPlaceholder('updated')
            .setValue(S.mtimeField)
            .onChange(async v => { S.mtimeField = v; await save(); })
          );

        // Indexing progress display
        const progDispSetting = new Setting(idxSection)
          .setName('Indexing progress display')
          .addDropdown(d => d
            .addOptions({
              'popup':        'Pop-up window',
              'notification': 'Obsidian notifications',
              'silent':       'Silent',
            })
            .setValue(S.progressDisplay)
            .onChange(async v => {
              S.progressDisplay = v as LinkLinkSettings['progressDisplay'];
              await save();
            })
          );

        const progDispHelpBtn = progDispSetting.nameEl.createEl('button', { cls: 'll-help-btn', text: '?' });
        const progDispTip = document.body.createEl('div', { cls: 'll-emb-tooltip ll-wide-tooltip' });
        this.progressDisplayTipEl = progDispTip;
        progDispTip.innerHTML = `
          <div class="ll-tip-item">
            <div class="ll-tip-body">Indexing a large vault can make Obsidian feel sluggish for a bit. Pick how you'd like to follow along — or just let it run quietly in the background.</div>
          </div>
          <div class="ll-tip-item">
            <div class="ll-tip-title">Pop-up window</div>
            <div class="ll-tip-body">Completion summary stays open until you close it.</div>
          </div>
          <div class="ll-tip-item">
            <div class="ll-tip-title">Obsidian notifications &amp; Silent</div>
            <div class="ll-tip-body">Show a brief completion summary for a few seconds.</div>
          </div>`;
        progDispHelpBtn.addEventListener('mouseenter', () => {
          const r = progDispHelpBtn.getBoundingClientRect();
          progDispTip.style.top  = r.bottom + 6 + 'px';
          progDispTip.style.left = r.left   + 'px';
          progDispTip.classList.add('visible');
        });
        progDispHelpBtn.addEventListener('mouseleave', () => progDispTip.classList.remove('visible'));

        // Notification timeout slider
        slider(idxSection, 'Notification timeout (sec)',
          'Pick 0 to disable timeout — notification stays until closed.',
          'notificationTimeout', 0, 10, 1);

        idxSection.createEl('div', { cls: 'll-section-sep' });
        const idxRow  = idxSection.createEl('div', { cls: 'll-idx-row' });
        const idxBtn  = idxRow.createEl('button', { cls: 'll-action-btn ll-action-btn-accent' });
        const idxIcon = idxBtn.createEl('span', { cls: 'll-btn-icon' });
        setIcon(idxIcon, 'database');
        const idxLabel = idxBtn.createEl('span', { text: 'Index vault' });

        const deleteSlot = idxRow.createEl('div');
        const rebuildDeleteGroup = async () => {
          deleteSlot.empty();
          type IndexOpt = { value: string; label: string; path: string; canDelete: boolean };

          const loadStat = async (path: string): Promise<{ exists: boolean; count: number }> => {
            try {
              const raw = await this.app.vault.adapter.read(path);
              const arr = JSON.parse(raw);
              return { exists: true, count: Array.isArray(arr) ? arr.length : 0 };
            } catch { return { exists: false, count: 0 }; }
          };

          const opts: IndexOpt[] = [];

          const bPath = this.plugin.indexingService.builtinIndexPath;
          const bStat = await loadStat(bPath);
          opts.push({
            value:     '__builtin',
            label:     bStat.exists
              ? `bge-small-en-v1.5 — ${bStat.count.toLocaleString()} notes`
              : 'bge-small-en-v1.5 — no index',
            path:      bPath,
            canDelete: bStat.exists,
          });

          if (S.embeddingSource === 'existing') opts.push({ value: '__existing', label: 'Existing index file — cannot delete', path: '', canDelete: false });

          for (const m of S.ollamaModels) {
            const mp    = this.plugin.indexingService.indexPathForModel(m.id);
            const mStat = await loadStat(mp);
            opts.push({
              value:     m.id,
              label:     mStat.exists
                ? `${m.displayName || m.modelName} — ${mStat.count.toLocaleString()} notes`
                : `${m.displayName || m.modelName} — no index`,
              path:      mp,
              canDelete: mStat.exists,
            });
          }

          const group  = deleteSlot.createEl('div', { cls: 'll-idx-delete-group' });
          const sel    = group.createEl('select', { cls: 'll-idx-select' });
          const ph     = sel.createEl('option', { value: '', text: 'Select a saved index' });
          ph.disabled = true; ph.selected = true;
          for (const o of opts) {
            const el = sel.createEl('option', { value: o.value, text: o.label });
            if (!o.canDelete) el.disabled = true;
          }

          const delBtn = group.createEl('button', { cls: 'll-action-btn ll-action-btn-danger' });
          delBtn.disabled = true;
          setIcon(delBtn.createEl('span', { cls: 'll-btn-icon' }), 'trash-2');
          delBtn.createEl('span', { text: 'Delete' });

          sel.addEventListener('change', () => {
            delBtn.disabled = !(opts.find(x => x.value === sel.value)?.canDelete ?? false);
          });

          delBtn.addEventListener('click', () => {
            const o = opts.find(x => x.value === sel.value);
            if (!o?.canDelete) return;
            const name = o.label.split(' — ')[0].trim();
            new ConfirmModal(app,
              `Delete the "${name}" index?`,
              'This removes the cached embeddings. You will need to re-index to restore it.',
              async () => {
                await this.app.vault.adapter.remove(o.path);
                await rebuildDeleteGroup();
              }
            ).open();
          });
        };
        rebuildDeleteGroup();

        // Restore indexing defaults
        body.createEl('div', { cls: 'll-restore-sep' });
        new Setting(body)
          .setName('Restore indexing defaults')
          .setDesc('Reset all indexing settings to their defaults.')
          .addButton(btn => {
            btn.setButtonText('Restore defaults');
            btn.buttonEl.classList.add('ll-action-btn', 'll-action-btn-danger');
            btn.onClick(async () => {
              const keys: (keyof LinkLinkSettings)[] = [
                'autoIndexMode', 'mtimeSource', 'mtimeField',
                'progressDisplay', 'notificationTimeout',
                'indexMode',
              ];
              for (const k of keys) (S as any)[k] = (DEFAULT_SETTINGS as any)[k];
              S.excludePaths = []; S.includePaths = [];
              await save();
              body.empty();
              renderEmbedding();
            });
          });

        idxBtn.addEventListener('click', async () => {
          idxBtn.disabled = true;
          let confirmMsg: string;
          try {
            const preview = await this.plugin.indexingService.previewChanges();
            if (preview === null) {
              const count = this.plugin.indexingService.getFilesToIndex().length;
              confirmMsg = `${count} notes will be indexed for the first time. This may take several minutes.`;
            } else {
              const { toEmbed, unchanged, toRemove } = preview;
              const parts: string[] = [];
              if (toEmbed   > 0) parts.push(`${toEmbed} to index`);
              if (unchanged > 0) parts.push(`${unchanged} unchanged`);
              if (toRemove  > 0) parts.push(`${toRemove} entries to remove`);
              confirmMsg = parts.length > 0 ? parts.join(' · ') : 'Index is already up to date.';
            }
          } catch {
            confirmMsg = `Depending on your vault size, indexing may take several minutes.`;
          } finally {
            idxBtn.disabled = false;
          }

          new ConfirmModal(
            app,
            'Index vault?',
            confirmMsg,
            async () => {
              idxBtn.disabled = true;
              showProg('Starting…', 0);
              const { onProgress, onDone, onError } = this.plugin.createProgressDisplay(
                (msg, pct) => showProg(msg, pct)
              );
              try {
                const { added, updated, removed } = await this.plugin.indexingService.index(onProgress);
                const summary = added + updated === 0
                  ? 'Index is up to date.'
                  : `+${added} new, ${updated} updated, ${removed} removed`;
                onDone(summary);
                showProg('Indexing complete!', 100);
                hideProg();
                this.plugin.refreshView();
                setTimeout(() => rebuildDeleteGroup(), 2000);
              } catch (e) {
                onError();
                showProg(`Error: ${e instanceof Error ? e.message : String(e)}`, 0);
                hideProg(4000);
              } finally { idxBtn.disabled = false; }
            }
          ).open();
        });
      }
    };

    // ── INTERLINK VAULT TAB ──────────────────────────────────────────────

    const renderInterlink = () => {
      const { show: showProg, hide: hideProg } = makeProgress(body);


      body.createEl('h3', { text: 'Exceptions' });

      filterSection(body.createEl('div', { cls: 'll-action-section ll-action-section-flat' }), app,
        'Completely ignored',
        'No read, no write, no references. These paths are invisible to the plugin.',
        S.ignoredPaths,
        async v => { S.ignoredPaths = v; await save(); }
      );

      filterSection(body.createEl('div', { cls: 'll-action-section ll-action-section-flat' }), app,
        'Referenced, never written',
        'Can appear as related links in other notes, but the plugin will never modify these files.',
        S.readOnlyPaths,
        async v => { S.readOnlyPaths = v; await save(); }
      );

      body.createEl('h3', { text: 'Search parameters' });

      slider(body,
        'Top N results',
        'How many similar notes to show in the panel and add to the `related:` field. Lower = more focused, higher = more connections, 0 = show all.',
        'topN', 0, 100, 5
      );
      slider(body,
        'Similarity threshold',
        'How alike notes must be to count as related. 0 = any note qualifies, 1 = only near-identical notes. Around 0.5 is a good starting point.',
        'threshold', 0, 1, 0.05
      );

      body.createEl('h3', { text: 'Frontmatter field' });

      const RESERVED_FM_KEYS = new Set(['tags', 'aliases', 'title', 'cssclass', 'cssclasses', 'publish', 'created', 'modified', 'date']);
      new Setting(body)
        .setName('Related field name')
        .setDesc('The frontmatter field where related links are written. Rename if you already use "related" for something else.')
        .addText(t => t
          .setPlaceholder('related')
          .setValue(S.relatedFieldName)
          .onChange(async v => {
            const trimmed = v.trim();
            const effective = trimmed || 'related';
            if (RESERVED_FM_KEYS.has(effective)) {
              new Notice(`⚠️ "${effective}" is a reserved frontmatter key — choose a different field name.`);
              return;
            }
            S.relatedFieldName = trimmed;
            await save();
          })
        );

      body.createEl('h3', { text: 'Run interlink' });

      const ilSection = body.createEl('div', { cls: 'll-action-section' });
      ilSection.createEl('div', { cls: 'll-interlink-lead',
        text: 'Interlink Vault connects your notes with similar concepts and ideas.' });
      ilSection.createEl('div', { cls: 'll-interlink-body',
        text: 'It reads your vault\'s embeddings — a compact numerical representation of each note\'s content — ' +
              'and finds notes that are semantically similar to each other. When you run Interlink, it writes those ' +
              'connections into each note\'s frontmatter as native Obsidian [[links]], under the field you configure above.' });
      ilSection.createEl('div', { cls: 'll-interlink-footer',
        text: 'Nothing leaves your machine — everything runs locally.' });

      ilSection.createEl('div', { cls: 'll-section-sep' });
      const ilRow = ilSection.createEl('div', { cls: 'll-il-btn-row' });

      const ilBtn = ilRow.createEl('button', { cls: 'll-action-btn ll-action-btn-accent' });
      setIcon(ilBtn.createEl('span', { cls: 'll-btn-icon' }), 'git-branch');
      ilBtn.createEl('span', { text: 'Interlink Vault' });

      const clearBtn = ilRow.createEl('button', { cls: 'll-action-btn ll-action-btn-danger' });
      setIcon(clearBtn.createEl('span', { cls: 'll-btn-icon' }), 'eraser');
      clearBtn.createEl('span', { text: 'Clear related field' });

      ilBtn.addEventListener('click', async () => {
        const existing = await this.plugin.interlinkService.findNotesWithRelated();
        const proceed  = async () => {
          ilBtn.disabled = true; clearBtn.disabled = true;
          showProg('Loading index…', 0);
          try {
            const index = await this.plugin.loadAnyIndex();
            const { updated } = await this.plugin.interlinkService.run(
              index, (msg, pct) => showProg(msg, pct)
            );
            showProg(`Done — updated ${updated} notes.`, 100);
            hideProg();
          } catch (e) {
            showProg(`Error: ${e instanceof Error ? e.message : String(e)}`, 0);
            hideProg(4000);
          } finally { ilBtn.disabled = false; clearBtn.disabled = false; }
        };

        if (existing.length > 0) {
          new ConfirmModal(app,
            `${existing.length} note${existing.length > 1 ? 's' : ''} already have a "${S.relatedFieldName || 'related'}:" field`,
            'Running interlink will replace their existing content. Continue?',
            proceed
          ).open();
        } else { await proceed(); }
      });

      clearBtn.addEventListener('click', () => {
        new ConfirmModal(app,
          `Clear "${S.relatedFieldName || 'related'}:" from all notes?`,
          `This permanently removes the "${S.relatedFieldName || 'related'}" field from every note that has it.`,
          async () => {
            ilBtn.disabled = true; clearBtn.disabled = true;
            showProg('Clearing…', 0);
            try {
              const count = await this.plugin.interlinkService.clearRelated((msg, pct) => showProg(msg, pct));
              showProg(`Cleared ${count} notes.`, 100);
              hideProg();
            } catch (e) {
              showProg(`Error: ${e instanceof Error ? e.message : String(e)}`, 0);
              hideProg(4000);
            } finally { ilBtn.disabled = false; clearBtn.disabled = false; }
          },
          'I understand. Delete.',
          true  // destructive
        ).open();
      });

      body.createEl('div', { cls: 'll-restore-sep' });
      new Setting(body)
        .setName('Restore interlink defaults')
        .setDesc('Reset all interlink settings and exceptions to their defaults.')
        .addButton(btn => {
          btn.setButtonText('Restore defaults');
          btn.buttonEl.classList.add('ll-action-btn', 'll-action-btn-danger');
          btn.onClick(async () => {
            const keys: (keyof LinkLinkSettings)[] = [
              'topN', 'threshold', 'relatedFieldName',
            ];
            for (const k of keys) (S as any)[k] = (DEFAULT_SETTINGS as any)[k];
            S.ignoredPaths = []; S.readOnlyPaths = [];
            await save();
            body.empty();
            renderInterlink();
          });
        });
    };

    // ── GRAPH TAB ────────────────────────────────────────────────────────

    const renderGraph = () => {
      body.createEl('h3', { text: 'Display' });

      new Setting(body)
        .setName('View mode')
        .setDesc('Show related notes as a scrollable list or a force-directed graph.')
        .addDropdown(d => d
          .addOptions({ list: 'List', graph: 'Graph' })
          .setValue(S.viewMode)
          .onChange(async v => { S.viewMode = v as 'list' | 'graph'; await save(); })
        );

      new Setting(body)
        .setName('Open notes in')
        .setDesc('Where to open a note when you click it in the panel.')
        .addDropdown(d => d
          .addOptions({
            'new-tab': 'New tab',
            'current': 'Current tab',
            'split':   'Open to the right',
          })
          .setValue(S.openMode)
          .onChange(async v => { S.openMode = v as LinkLinkSettings['openMode']; await save(); })
        );

      const addColor = (name: string, desc: string, key: 'colorHigh' | 'colorMid' | 'colorLow') => {
        const s = new Setting(body).setName(name).setDesc(desc);
        const inp = s.controlEl.createEl('input');
        inp.type  = 'color';
        inp.value = S[key];
        inp.style.cssText = 'cursor:pointer;border:none;background:none;width:36px;height:28px;padding:2px';
        inp.addEventListener('input', async () => { S[key] = inp.value; await save(); });
        addReset(s, key);
      };
      addColor('High similarity color', 'Top third of the score range above threshold.', 'colorHigh');
      addColor('Mid similarity color',  'Middle third.',                                  'colorMid');
      addColor('Low similarity color',  'Bottom third.',                                  'colorLow');

      new Setting(body)
        .setName('Auto-fit graph')
        .setDesc('Returns to fit-all 5sec after manual zoom or pan.')
        .addToggle(t => t.setValue(S.autoFit).onChange(async v => { S.autoFit = v; await save(); }));

      slider(body, 'Text fade threshold', 'Zoom below which labels fade out.',  'textFadeThreshold', 0.1, 2,   0.05);
      slider(body, 'Node size',           'Multiplier for all node sizes.',      'nodeSizeMultiplier', 0.5, 3,  0.1);
      slider(body, 'Link thickness',      'Multiplier for edge thickness.',      'lineSizeMultiplier', 0.5, 5,  0.25);

      body.createEl('h3', { text: 'Forces' });

      slider(body, 'Center force',  'How strongly notes are pulled toward the center.', 'centerStrength', 0,  1,  0.05);
      slider(body, 'Repel force',   'How strongly notes push away from each other.',    'repelStrength',  0,  20, 0.5);
      slider(body, 'Link force',    'Spring strength for linked notes.',                'linkStrength',   0,  1,  0.05);
      slider(body, 'Link distance', 'Inner ring rest distance.',                        'linkDistance',   1,  10, 0.5);

      body.createEl('div', { cls: 'll-restore-sep' });
      new Setting(body)
        .setName('Restore graph defaults')
        .setDesc('Reset all graph display and force settings to their defaults.')
        .addButton(btn => {
          btn.setButtonText('Restore defaults');
          btn.buttonEl.classList.add('ll-action-btn', 'll-action-btn-danger');
          btn.onClick(async () => {
            const keys: (keyof LinkLinkSettings)[] = [
              'viewMode', 'colorHigh', 'colorMid', 'colorLow', 'autoFit',
              'textFadeThreshold', 'nodeSizeMultiplier', 'lineSizeMultiplier',
              'centerStrength', 'repelStrength', 'linkStrength', 'linkDistance',
            ];
            for (const k of keys) (S as any)[k] = (DEFAULT_SETTINGS as any)[k];
            await save();
            body.empty();
            renderGraph();
          });
        });
    };

    switchTab('embedding');
  }
}
