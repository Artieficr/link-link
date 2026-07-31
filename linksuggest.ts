import { App, TFile, editorInfoField, parseFrontMatterAliases } from 'obsidian';
import { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate, PluginValue } from '@codemirror/view';
import type LinkLinkPlugin from './main';

// Cap on how many trailing words are considered as a candidate phrase. Titles/
// aliases longer than this simply won't be matched — keeps the per-trigger
// cost bounded regardless of vault content.
const MAX_PHRASE_WORDS = 6;
const WORD_BOUNDARY_RE = /[\s.,;:!?()[\]{}"'`]/;
const TRIGGER_DEBOUNCE_MS = 150;

interface TitleAliasEntry {
  file: TFile;
  displayAs: string; // canonical title or alias text, in its original casing
  isTitle: boolean;  // true = filename match, false = alias match
}

// ── Title/alias index ───────────────────────────────────────────────────────
//
// Maps lowercased title/alias text -> the note(s) it refers to. Lookup is a
// plain Map.get(), so cost is independent of vault size; the only real cost is
// keeping this fresh, which the incremental add/remove/update methods handle
// in O(1) per affected file (recomputing minKeyLength is the one O(n) path,
// and only runs when the shortest entry is actually removed). Callers
// (main.ts onload) wire vault/metadataCache events to these methods — this
// class itself isn't a Component and doesn't register anything.
export class TitleAliasIndex {
  private app: App;
  private byKey  = new Map<string, TitleAliasEntry[]>();
  private byPath = new Map<string, string[]>(); // file path -> lowercased keys it owns

  // Shortest title/alias currently in the vault, used as an automatic noise
  // gate instead of a user-configured minimum length — matches shorter than
  // this can't correspond to any real note anyway.
  minKeyLength = Infinity;

  constructor(app: App) {
    this.app = app;
  }

  build() {
    this.byKey.clear();
    this.byPath.clear();
    this.minKeyLength = Infinity;
    for (const file of this.app.vault.getMarkdownFiles()) this.addFile(file);
  }

  private keysForFile(file: TFile): { key: string; displayAs: string; isTitle: boolean }[] {
    const out = [{ key: file.basename.toLowerCase(), displayAs: file.basename, isTitle: true }];
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
    const aliases = parseFrontMatterAliases(fm) ?? [];
    for (const alias of aliases) {
      const trimmed = alias.trim();
      if (trimmed) out.push({ key: trimmed.toLowerCase(), displayAs: trimmed, isTitle: false });
    }
    return out;
  }

  addFile(file: TFile) {
    const keys = this.keysForFile(file);
    for (const { key, displayAs, isTitle } of keys) {
      if (key.length < this.minKeyLength) this.minKeyLength = key.length;
      const list = this.byKey.get(key);
      const entry: TitleAliasEntry = { file, displayAs, isTitle };
      if (list) list.push(entry); else this.byKey.set(key, [entry]);
    }
    this.byPath.set(file.path, keys.map(k => k.key));
  }

  removeFile(path: string) {
    const keys = this.byPath.get(path);
    if (!keys) return;
    let mayShrinkMin = false;
    for (const key of keys) {
      if (key.length === this.minKeyLength) mayShrinkMin = true;
      const list = this.byKey.get(key);
      if (!list) continue;
      const filtered = list.filter(e => e.file.path !== path);
      if (filtered.length > 0) this.byKey.set(key, filtered);
      else this.byKey.delete(key);
    }
    this.byPath.delete(path);
    if (mayShrinkMin) this.recomputeMinKeyLength();
  }

  private recomputeMinKeyLength() {
    let min = Infinity;
    for (const key of this.byKey.keys()) if (key.length < min) min = key.length;
    this.minKeyLength = min;
  }

  updateFile(file: TFile) {
    this.removeFile(file.path);
    this.addFile(file);
  }

  renameFile(file: TFile, oldPath: string) {
    this.removeFile(oldPath);
    this.addFile(file);
  }

  lookup(phrase: string): TitleAliasEntry[] | undefined {
    return this.byKey.get(phrase.toLowerCase());
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────

interface PhraseMatch {
  startCh: number;
  endCh: number;
  phrase: string;
  entries: TitleAliasEntry[];
}

// Reads the trailing run of up to MAX_PHRASE_WORDS words ending at `boundaryCh`
// (exclusive) on `line`, and tries longest-run-first lookups against the
// index so a multi-word alias ("New York City") wins over a coincidental
// match on its last word alone.
function findPhraseMatch(
  line: string,
  boundaryCh: number,
  index: TitleAliasIndex,
  minLength: number
): PhraseMatch | null {
  const words: string[] = [];
  const starts: number[] = [];
  let i = boundaryCh;
  while (words.length < MAX_PHRASE_WORDS && i > 0) {
    // Skip the boundary character(s) separating this word from the previous one.
    while (i > 0 && WORD_BOUNDARY_RE.test(line[i - 1])) i--;
    const wordEnd = i;
    while (i > 0 && !WORD_BOUNDARY_RE.test(line[i - 1])) i--;
    const wordStart = i;
    if (wordStart === wordEnd) break;
    words.unshift(line.slice(wordStart, wordEnd));
    starts.unshift(wordStart);
  }
  if (words.length === 0) return null;

  for (let k = words.length; k >= 1; k--) {
    const startCh = starts[words.length - k];
    const phrase  = words.slice(words.length - k).join(' ');
    if (phrase.length < minLength) continue;
    const entries = index.lookup(phrase);
    if (entries && entries.length > 0) return { startCh, endCh: boundaryCh, phrase, entries };
  }
  return null;
}

// True when `ch` on `line` sits inside an unclosed [[wikilink]] or inline
// `code` span — checked with a plain bracket/backtick count rather than
// touching CM6's syntax tree, so it stays dependency-free.
function isInsideLinkOrCode(line: string, ch: number): boolean {
  const before = line.slice(0, ch);
  const opens  = (before.match(/\[\[/g) ?? []).length;
  const closes = (before.match(/\]\]/g) ?? []).length;
  if (opens > closes) return true;
  const backticks = (before.match(/`/g) ?? []).length;
  return backticks % 2 === 1;
}

// True when [startCh, endCh) overlaps an already-closed [[...]] span anywhere
// on the line — e.g. right after accepting a suggestion, the plain text
// "Paris" is still readable inside "[[Paris]]" and would otherwise get
// matched (and wrapped) a second time. isInsideLinkOrCode only catches an
// unclosed "[[" typed earlier on the line; this catches the closed case.
function overlapsClosedLink(line: string, startCh: number, endCh: number): boolean {
  const linkRe = /\[\[.*?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(line))) {
    if (startCh < m.index + m[0].length && endCh > m.index) return true;
  }
  return false;
}

function resolveTarget(app: App, entries: TitleAliasEntry[], phrase: string, sourcePath: string): TitleAliasEntry {
  if (entries.length === 1) return entries[0];
  const titleMatch = entries.find(e => e.isTitle);
  const dest = app.metadataCache.getFirstLinkpathDest(phrase, sourcePath);
  const destMatch = dest && entries.find(e => e.file.path === dest.path);
  return destMatch ?? titleMatch ?? entries[0];
}

function buildLinkText(entry: TitleAliasEntry, asTyped: string): string {
  if (entry.isTitle && entry.displayAs === asTyped) return `[[${entry.displayAs}]]`;
  return `[[${entry.displayAs}|${asTyped}]]`;
}

// ── CM6 editor extension ─────────────────────────────────────────────────────

interface ActiveSuggestion {
  from: number; // absolute doc offsets — remapped through edits via ChangeSet.mapPos,
  to: number;   // so this survives typing elsewhere in the document (not tied to a line index)
  phrase: string;
  linkText: string;
  tooltipEl: HTMLElement;
  dismissTimer: number | null;
}

export function buildLinkSuggestExtension(app: App, plugin: LinkLinkPlugin, index: TitleAliasIndex): Extension {
  class LinkSuggestPlugin implements PluginValue {
    private view: EditorView;
    private suggestions: ActiveSuggestion[] = [];
    private triggerTimer: number | null = null;
    private onResize = () => this.scheduleReposition();
    private onScroll = () => this.scheduleReposition();
    private onKeydownCapture = (event: KeyboardEvent) => this.handleKeydownCapture(event);

    constructor(view: EditorView) {
      this.view = view;
      window.addEventListener('resize', this.onResize);
      view.dom.addEventListener('keydown', this.onKeydownCapture, true);
      // Native scrolling doesn't dispatch a state transaction, so update()
      // never runs for it — without this, a suggestion stays stuck at its
      // last computed screen position instead of tracking the text as the
      // editor scrolls.
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    }

    update(update: ViewUpdate) {
      if (!plugin.settings.linkSuggestEnabled) { this.dismissAll(); return; }

      if (update.docChanged) this.remapSuggestions(update);
      if (this.suggestions.length > 0 && (update.docChanged || update.viewportChanged || update.geometryChanged)) {
        this.scheduleReposition();
      }

      if (update.docChanged) {
        if (this.triggerTimer !== null) window.clearTimeout(this.triggerTimer);
        this.triggerTimer = window.setTimeout(() => {
          this.triggerTimer = null;
          this.tryTrigger();
        }, TRIGGER_DEBOUNCE_MS);
      }
    }

    destroy() {
      window.removeEventListener('resize', this.onResize);
      this.view.dom.removeEventListener('keydown', this.onKeydownCapture, true);
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      if (this.triggerTimer !== null) window.clearTimeout(this.triggerTimer);
      this.dismissAll();
    }

    // Remaps every active suggestion's anchor through the just-applied edit so
    // typing anywhere else in the document (e.g. further paragraphs below)
    // never invalidates suggestions earlier in the text. Only drops a
    // suggestion when its own anchored text was actually edited.
    private remapSuggestions(update: ViewUpdate) {
      const kept: ActiveSuggestion[] = [];
      for (const s of this.suggestions) {
        const from = update.changes.mapPos(s.from, -1);
        const to   = update.changes.mapPos(s.to, 1);
        if (from >= to || to > update.state.doc.length) { this.removeTooltip(s); continue; }
        if (update.state.sliceDoc(from, to).toLowerCase() !== s.phrase.toLowerCase()) { this.removeTooltip(s); continue; }
        s.from = from; s.to = to;
        kept.push(s);
      }
      this.suggestions = kept;
    }

    // Positioning must go through requestMeasure rather than reading
    // coordsAtPos synchronously inside update() — CM6 doesn't guarantee
    // layout is settled at that point, and a premature read can spuriously
    // return null for text that is genuinely still on-screen. A suggestion
    // scrolling out of view is only ever hidden (and reshown once back in
    // view), never removed — removal is reserved for actual dismissal
    // (timeout, accept, Esc, toggle off) or the underlying text being edited.
    private scheduleReposition() {
      this.view.requestMeasure({
        key: this,
        // coordsAtPos can return real (non-null) coordinates for a position
        // that's outside the pane's visible area but still within CM6's
        // internal render buffer — e.g. scrolled just above the editor,
        // behind the tab bar. Compare against the pane's own visible rect
        // rather than trusting non-null as "on screen".
        read: (view) => ({
          paneRect: view.scrollDOM.getBoundingClientRect(),
          items: this.suggestions.map(s => ({
            s, start: view.coordsAtPos(s.from), end: view.coordsAtPos(s.to, -1),
          })),
        }),
        write: ({ paneRect, items }) => {
          for (const { s, start, end } of items) {
            if (!start || !end || start.top < paneRect.top || start.top > paneRect.bottom) {
              s.tooltipEl.setCssStyles({ display: 'none' });
              continue;
            }
            const midX = (start.left + end.right) / 2;
            s.tooltipEl.setCssStyles({ display: '', left: midX + 'px', top: (start.top - 6) + 'px' });
          }
        },
      });
    }

    private tryTrigger() {
      if (!plugin.settings.linkSuggestEnabled) return;
      const info = this.view.state.field(editorInfoField, false);
      const sourceFile = info?.file ?? null;
      if (!sourceFile) return;

      const pos  = this.view.state.selection.main.head;
      const line = this.view.state.doc.lineAt(pos);
      const ch   = pos - line.from;
      if (ch === 0) return;

      // Only fire right after a word-boundary character was typed.
      if (!WORD_BOUNDARY_RE.test(line.text[ch - 1])) return;
      if (isInsideLinkOrCode(line.text, ch - 1)) return;
      if (this.isInFrontmatter(sourceFile, pos)) return;

      const minLength = Number.isFinite(index.minKeyLength) ? index.minKeyLength : 1;
      const match = findPhraseMatch(line.text, ch - 1, index, minLength);
      if (!match) return;
      if (overlapsClosedLink(line.text, match.startCh, match.endCh)) return;

      const candidates = match.entries.filter(e => e.file.path !== sourceFile.path);
      if (candidates.length === 0) return;

      const from = line.from + match.startCh;
      const to   = line.from + match.endCh;
      // Don't stack a duplicate tooltip over a span that already has one.
      if (this.suggestions.some(s => s.from === from && s.to === to)) return;

      const target   = resolveTarget(app, candidates, match.phrase, sourceFile.path);
      const linkText = buildLinkText(target, match.phrase);
      this.show(from, to, match.phrase, linkText);
    }

    private isInFrontmatter(file: TFile, pos: number): boolean {
      const fmPos = app.metadataCache.getFileCache(file)?.frontmatterPosition;
      if (!fmPos) return false;
      return pos >= fmPos.start.offset && pos <= fmPos.end.offset;
    }

    private show(from: number, to: number, phrase: string, linkText: string) {
      const tooltipEl = activeDocument.body.createDiv({ cls: 'll-linksuggest-tip' });
      tooltipEl.setText(`Link ${linkText}`);

      const dismissSec = plugin.settings.linkSuggestDismissSec;
      const suggestion: ActiveSuggestion = {
        from, to, phrase, linkText, tooltipEl,
        dismissTimer: dismissSec > 0
          ? window.setTimeout(() => this.dismiss(suggestion), dismissSec * 1000)
          : null,
      };

      tooltipEl.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep editor focus/selection intact
        this.accept(suggestion);
      });

      this.suggestions.push(suggestion);
      this.scheduleReposition();
    }

    private accept(s: ActiveSuggestion) {
      if (!this.suggestions.includes(s)) return;
      this.view.dispatch({ changes: { from: s.from, to: s.to, insert: s.linkText } });
      this.dismiss(s);
    }

    private removeTooltip(s: ActiveSuggestion) {
      if (s.dismissTimer !== null) window.clearTimeout(s.dismissTimer);
      s.tooltipEl.remove();
    }

    private dismiss(s: ActiveSuggestion) {
      const idx = this.suggestions.indexOf(s);
      if (idx === -1) return;
      this.removeTooltip(s);
      this.suggestions.splice(idx, 1);
    }

    private dismissAll() {
      for (const s of this.suggestions) this.removeTooltip(s);
      this.suggestions = [];
    }

    // Registered on the capture phase directly (rather than via CM6's
    // PluginSpec.eventHandlers) so it runs before Obsidian/CM6's own Enter
    // (new line) and Escape keymaps, regardless of their extension precedence.
    private handleKeydownCapture(event: KeyboardEvent) {
      if (event.key === 'Escape' && this.suggestions.length > 0) {
        this.dismissAll();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Enter') return;
      const pos = this.view.state.selection.main.head;
      // Inclusive of s.to + 1: right after the phrase is typed, the cursor
      // sits one past `to` (past the boundary character that triggered the
      // match), not at `to` itself.
      const match = this.suggestions.find(s => pos >= s.from && pos <= s.to + 1);
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      this.accept(match);
    }
  }

  return ViewPlugin.fromClass(LinkSuggestPlugin);
}
