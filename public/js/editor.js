// The collaborative editor surface.
//
// A transparent <textarea> handles typing, IME, selection and accessibility.
// Behind it a <pre> shows the highlighted code; in front of the text sit
// layers for line bands (pinned highlights, everyone's current line) and for
// remote carets and selections. All layers share one scroll container, so they
// cannot drift apart while scrolling.
//
// The editor turns every change into a TextOperation (see /shared/ot.js) and
// reports it upward; it never talks to the network itself.

import { TextOperation, transformIndex } from '/shared/ot.js';
import { LIMITS } from '/shared/protocol.js';
import { escapeAttr, escapeHtml, highlightLines } from './highlight.js';
import { h } from './ui.js';

const LINE_HEIGHT = 22;
const PAD_X = 14;
const PAD_Y = 10;
const TAB_SIZE = 4;
const INDENT = '  ';
const UNDO_GROUP_MS = 900;

function visualColumn(text, col) {
  let v = 0;
  for (let i = 0; i < col && i < text.length; i++) v = text[i] === '\t' ? v + TAB_SIZE - (v % TAB_SIZE) : v + 1;
  return v;
}

function caretAfter(op) {
  let pos = 0;
  let caret = null;
  for (const c of op.ops) {
    if (TextOperation.isRetain(c)) pos += c;
    else if (TextOperation.isInsert(c)) { pos += c.length; caret = pos; }
    else caret = pos;
  }
  return caret;
}

function transformStack(stack, op) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const [entry, rest] = TextOperation.transform(stack[i], op);
    stack[i] = entry;
    op = rest;
  }
}

function hexToRgba(hex, alpha) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class Editor {
  constructor(mount, { onChange, onSelection, onGutterClick, onCompositionEnd, onReject, placeholder } = {}) {
    this.onChange = onChange;
    this.onSelection = onSelection;
    this.onGutterClick = onGutterClick;
    this.onCompositionEnd = onCompositionEnd;
    this.onReject = onReject;

    this.doc = '';
    this.lines = [''];
    this.lineStarts = [0];
    this.lang = 'plaintext';
    this.readOnly = false;
    this.composing = false;
    this.peers = new Map();
    this.highlights = [];
    this.undoStack = [];
    this.redoStack = [];
    this.lastUndo = { at: 0, kind: null };
    this.lastSel = null;
    this.tabEscaped = false;
    this.charWidth = 8.4;
    this.dirty = { doc: true, overlay: true };
    this.frame = 0;
    this.gutterKey = '';

    this.build(mount, placeholder);
    this.measure();
    document.fonts?.ready.then(() => { this.measure(); this.invalidate(true); });
    this.resizeObserver = new ResizeObserver(() => this.invalidate(true));
    this.resizeObserver.observe(this.scroller);
    this.invalidate(true);
  }

  build(mount, placeholder) {
    this.gutter = h('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
    this.bands = h('div', { class: 'ed-bands', 'aria-hidden': 'true' });
    this.code = h('pre', { class: 'ed-code', 'aria-hidden': 'true' });
    this.peerLayer = h('div', { class: 'ed-peers', 'aria-hidden': 'true' });
    this.input = h('textarea', {
      class: 'ed-input',
      wrap: 'off',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      autocorrect: 'off',
      'aria-label': 'Shared editor',
      'aria-multiline': 'true',
      placeholder: placeholder ?? '',
    });
    this.main = h('div', { class: 'ed-main' }, this.bands, this.code, this.peerLayer, this.input);
    this.sizer = h('div', { class: 'ed-sizer' }, this.gutter, this.main);
    this.scroller = h('div', { class: 'ed-scroll' }, this.sizer);
    this.probe = h('span', { class: 'ed-probe', 'aria-hidden': 'true' }, 'M'.repeat(100));
    this.root = h('div', { class: 'ed' }, this.scroller, this.probe);
    mount.append(this.root);

    const ta = this.input;
    ta.addEventListener('input', () => this.syncFromInput());
    ta.addEventListener('compositionstart', () => { this.composing = true; });
    ta.addEventListener('compositionend', () => {
      this.composing = false;
      this.syncFromInput();
      this.onCompositionEnd?.();
    });
    ta.addEventListener('keydown', (e) => this.onKeyDown(e));
    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); }
      else if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); }
    });
    // The textarea is sized to its content; never let it scroll internally.
    ta.addEventListener('scroll', () => { ta.scrollTop = 0; ta.scrollLeft = 0; });
    ta.addEventListener('focus', () => this.invalidate());
    ta.addEventListener('blur', () => { this.tabEscaped = false; this.invalidate(); });
    this.onSelectionChange = () => {
      if (document.activeElement === ta && !this.composing) this.emitSelection(true);
    };
    document.addEventListener('selectionchange', this.onSelectionChange);

    this.gutter.addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-line]');
      if (!row) return;
      e.preventDefault();
      this.onGutterClick?.(Number(row.dataset.line));
    });
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.root.remove();
  }

  measure() {
    const w = this.probe.getBoundingClientRect().width / 100;
    if (w > 0) this.charWidth = w;
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  // ---- public state -------------------------------------------------------

  setDoc(text) {
    this.doc = text;
    this.input.value = text;
    this.undoStack = [];
    this.redoStack = [];
    this.lastSel = null;
    const end = Math.min(this.input.selectionEnd, text.length);
    this.input.setSelectionRange(end, end);
    this.invalidate(true);
  }

  setLanguage(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    this.invalidate(true);
  }

  setReadOnly(readOnly) {
    this.readOnly = readOnly;
    this.input.readOnly = readOnly;
    this.root.classList.toggle('is-readonly', readOnly);
  }

  getSelection() {
    const { selectionStart: s, selectionEnd: e, selectionDirection: d } = this.input;
    return d === 'backward' ? { anchor: e, head: s } : { anchor: s, head: e };
  }

  cursorPosition() {
    const { head } = this.getSelection();
    const line = this.lineAt(head);
    return { line: line + 1, col: head - this.lineStarts[line] + 1 };
  }

  setPeer(id, data) {
    const prev = this.peers.get(id) ?? {};
    this.peers.set(id, { ...prev, ...data });
    this.invalidate();
  }

  removePeer(id) {
    this.peers.delete(id);
    this.invalidate();
  }

  setHighlights(list) {
    this.highlights = list.map((hl) => ({ ...hl }));
    this.invalidate();
  }

  highlightedLines() {
    return new Set(this.highlights.map((hl) => this.lineAt(hl.offset)));
  }

  // ---- applying changes ---------------------------------------------------

  syncFromInput() {
    if (this.composing) return;
    const value = this.input.value;
    if (value === this.doc) return;
    if (this.readOnly) return this.restoreInput();
    if (value.length > LIMITS.MAX_DOC_LENGTH) {
      this.restoreInput();
      this.onReject?.('too-large');
      return;
    }
    const op = TextOperation.fromDiff(this.doc, value, this.input.selectionEnd);
    const insertsNewline = op.ops.some((c) => typeof c === 'string' && c.includes('\n'));
    this.commit(op, { fromInput: true, kind: insertsNewline ? 'newline' : 'type' });
  }

  restoreInput() {
    const { selectionStart, selectionEnd } = this.input;
    this.input.value = this.doc;
    this.input.setSelectionRange(Math.min(selectionStart, this.doc.length), Math.min(selectionEnd, this.doc.length));
  }

  // Apply a local operation: update the document, carry every tracked
  // position across it, record undo, and report it.
  commit(op, { fromInput = false, kind = 'edit', undoable = true, select = null } = {}) {
    const before = this.doc;
    this.doc = op.apply(before);
    if (!fromInput) {
      this.input.value = this.doc;
      const caret = select ?? caretAfter(op) ?? Math.min(this.input.selectionEnd, this.doc.length);
      if (Array.isArray(caret)) this.input.setSelectionRange(caret[0], caret[1]);
      else this.input.setSelectionRange(caret, caret);
    }
    this.carryPositions(op);
    if (undoable) {
      this.recordUndo(op.invert(before), kind);
      this.redoStack = [];
    }
    this.invalidate(true);
    this.onChange?.(op);
    this.emitSelection(true);
  }

  // Apply an operation that came from another peer (already transformed).
  applyRemote(op) {
    if (op.isNoop()) return;
    const ta = this.input;
    const { selectionStart, selectionEnd, selectionDirection } = ta;
    const topLine = Math.floor(Math.max(0, this.scroller.scrollTop - PAD_Y) / LINE_HEIGHT);
    const topOffset = this.lineStarts[Math.min(topLine, this.lineStarts.length - 1)] ?? 0;

    this.doc = op.apply(this.doc);
    ta.value = this.doc;
    ta.setSelectionRange(transformIndex(selectionStart, op), transformIndex(selectionEnd, op), selectionDirection);
    if (this.lastSel) {
      this.lastSel = { anchor: transformIndex(this.lastSel.anchor, op), head: transformIndex(this.lastSel.head, op) };
    }
    this.carryPositions(op);
    transformStack(this.undoStack, op);
    transformStack(this.redoStack, op);

    // Keep the text you are looking at still when someone edits above it.
    this.refreshLines();
    const newTopLine = this.lineAt(transformIndex(topOffset, op, true));
    if (newTopLine !== topLine && this.scroller.scrollTop > 0) {
      this.scroller.scrollTop += (newTopLine - topLine) * LINE_HEIGHT;
    }
    this.invalidate(true);
  }

  carryPositions(op) {
    for (const peer of this.peers.values()) {
      if (peer.sel) peer.sel = { anchor: transformIndex(peer.sel.anchor, op), head: transformIndex(peer.sel.head, op) };
    }
    for (const hl of this.highlights) hl.offset = transformIndex(hl.offset, op, true);
  }

  // ---- undo / redo (only your own edits, rebased over everyone else's) ---

  recordUndo(inverse, kind) {
    const now = Date.now();
    const top = this.undoStack.length - 1;
    const groupable = kind === 'type' && this.lastUndo.kind === 'type' && now - this.lastUndo.at < UNDO_GROUP_MS;
    if (groupable && top >= 0) this.undoStack[top] = inverse.compose(this.undoStack[top]);
    else this.undoStack.push(inverse);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.lastUndo = { at: now, kind };
  }

  undo() {
    if (this.readOnly) return;
    const op = this.undoStack.pop();
    if (!op) return;
    this.redoStack.push(op.invert(this.doc));
    this.lastUndo = { at: 0, kind: null };
    this.commit(op, { undoable: false });
  }

  redo() {
    if (this.readOnly) return;
    const op = this.redoStack.pop();
    if (!op) return;
    this.undoStack.push(op.invert(this.doc));
    this.lastUndo = { at: 0, kind: null };
    this.commit(op, { undoable: false });
  }

  // ---- keyboard -----------------------------------------------------------

  onKeyDown(e) {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && !e.altKey && key === 'y') { e.preventDefault(); this.redo(); return; }
    if (e.key === 'Escape') { this.tabEscaped = true; return; }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      // Escape, then Tab, moves focus out of the editor (keyboard users are not trapped).
      if (this.tabEscaped) { this.tabEscaped = false; return; }
      e.preventDefault();
      if (!this.readOnly) this.indent(e.shiftKey);
      return;
    }
    this.tabEscaped = false;
    if (this.readOnly || e.isComposing || this.composing) return;
    if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart } = this.input;
      const line = this.lineAt(selectionStart);
      const before = this.doc.slice(this.lineStarts[line], selectionStart);
      let indent = before.match(/^[ \t]*/)[0];
      if (/[{[(:]\s*$/.test(before)) indent += INDENT;
      this.replaceSelection(`\n${indent}`, 'newline');
      return;
    }
    // Typing a closing bracket on a blank, indented line steps back one level.
    if ((e.key === '}' || e.key === ']' || e.key === ')') && !mod && !e.altKey) {
      const { selectionStart, selectionEnd } = this.input;
      if (selectionStart !== selectionEnd) return;
      const lineStart = this.lineStarts[this.lineAt(selectionStart)];
      const before = this.doc.slice(lineStart, selectionStart);
      if (before.length >= INDENT.length && /^[ ]+$/.test(before)) {
        e.preventDefault();
        const op = new TextOperation().retain(selectionStart - INDENT.length).delete(INDENT.length).insert(e.key)
          .retain(this.doc.length - selectionStart);
        this.commit(op, { kind: 'type', select: selectionStart - INDENT.length + 1 });
      }
    }
  }

  replaceSelection(text, kind = 'edit') {
    const s = this.input.selectionStart;
    const e = this.input.selectionEnd;
    const op = new TextOperation().retain(s).insert(text).delete(e - s).retain(this.doc.length - e);
    this.commit(op, { kind, select: s + text.length });
  }

  indent(outdent) {
    const { selectionStart: s, selectionEnd: e } = this.input;
    const first = this.lineAt(s);
    const last = this.lineAt(e > s && this.doc[e - 1] === '\n' ? e - 1 : e);
    if (!outdent && first === last && s === e) {
      this.replaceSelection(INDENT, 'indent');
      return;
    }
    const op = new TextOperation();
    let cursor = 0;
    for (let line = first; line <= last; line++) {
      const start = this.lineStarts[line];
      op.retain(start - cursor);
      cursor = start;
      if (!outdent) {
        op.insert(INDENT);
      } else {
        const m = this.lines[line].match(/^( {1,2}|\t)/);
        if (m) { op.delete(m[0].length); cursor += m[0].length; }
      }
    }
    op.retain(this.doc.length - cursor);
    if (op.isNoop()) return;
    const selStart = this.lineStarts[first];
    const selEnd = transformIndex(e, op, true);
    this.commit(op, { kind: 'indent', select: [selStart, selEnd] });
  }

  // ---- selection ----------------------------------------------------------

  emitSelection(fromUser = false) {
    const sel = this.getSelection();
    if (this.lastSel && this.lastSel.anchor === sel.anchor && this.lastSel.head === sel.head) return;
    this.lastSel = sel;
    this.invalidate();
    if (fromUser) this.ensureCaretVisible();
    this.onSelection?.(sel);
  }

  ensureCaretVisible() {
    this.refreshLines();
    const head = this.getSelection().head;
    const line = this.lineAt(head);
    const col = visualColumn(this.lines[line], head - this.lineStarts[line]);
    const y = PAD_Y + line * LINE_HEIGHT;
    const x = PAD_X + col * this.charWidth;
    const sc = this.scroller;
    const gutterWidth = this.gutter.offsetWidth;
    if (y < sc.scrollTop) sc.scrollTop = y - PAD_Y;
    else if (y + LINE_HEIGHT > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + LINE_HEIGHT * 2 - sc.clientHeight;
    const visibleWidth = sc.clientWidth - gutterWidth;
    if (x < sc.scrollLeft + PAD_X) sc.scrollLeft = Math.max(0, x - PAD_X * 2);
    else if (x > sc.scrollLeft + visibleWidth - PAD_X * 2) sc.scrollLeft = x - visibleWidth + PAD_X * 4;
  }

  // ---- geometry -----------------------------------------------------------

  refreshLines() {
    if (this.linesFor === this.doc) return;
    this.lines = this.doc.split('\n');
    const starts = new Array(this.lines.length);
    let offset = 0;
    for (let i = 0; i < this.lines.length; i++) {
      starts[i] = offset;
      offset += this.lines[i].length + 1;
    }
    this.lineStarts = starts;
    this.linesFor = this.doc;
  }

  lineAt(offset) {
    this.refreshLines();
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  point(offset) {
    const line = this.lineAt(Math.min(offset, this.doc.length));
    const col = visualColumn(this.lines[line], offset - this.lineStarts[line]);
    return { line, x: PAD_X + col * this.charWidth, y: PAD_Y + line * LINE_HEIGHT };
  }

  // ---- rendering ----------------------------------------------------------

  invalidate(docChanged = false) {
    if (docChanged) this.dirty.doc = true;
    this.dirty.overlay = true;
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  render() {
    if (this.dirty.doc) {
      this.refreshLines();
      this.code.innerHTML = `${highlightLines(this.lines, this.lang).join('\n')}\n`;
      let maxCols = 0;
      for (const line of this.lines) {
        const cols = line.includes('\t') ? visualColumn(line, line.length) : line.length;
        if (cols > maxCols) maxCols = cols;
      }
      this.maxCols = maxCols;
      this.dirty.doc = false;
    }

    const gutterWidth = Math.ceil(Math.max(2, String(this.lines.length).length) * this.charWidth + 30);
    const contentHeight = Math.max(this.scroller.clientHeight, this.lines.length * LINE_HEIGHT + PAD_Y * 2 + LINE_HEIGHT * 4);
    const contentWidth = Math.max(this.scroller.clientWidth - gutterWidth, Math.ceil((this.maxCols + 2) * this.charWidth + PAD_X * 2));
    this.gutter.style.width = `${gutterWidth}px`;
    this.gutter.style.height = `${contentHeight}px`;
    this.main.style.width = `${contentWidth}px`;
    this.main.style.height = `${contentHeight}px`;

    if (this.dirty.overlay) {
      this.renderGutter();
      this.renderBands(contentWidth);
      this.renderPeers();
      this.dirty.overlay = false;
    }
  }

  renderGutter() {
    const active = this.lineAt(this.getSelection().head);
    const marks = new Map();
    for (const hl of this.highlights) marks.set(this.lineAt(hl.offset), hl);
    const key = `${this.lines.length}|${active}|${[...marks].map(([l, hl]) => `${l}:${hl.color}`).join(',')}`;
    if (key === this.gutterKey) return;
    this.gutterKey = key;
    let html = '';
    for (let i = 0; i < this.lines.length; i++) {
      const mark = marks.get(i);
      const cls = `ed-ln${i === active ? ' is-active' : ''}${mark ? ' is-marked' : ''}`;
      const title = mark ? `Highlighted by ${escapeAttr(mark.name ?? 'someone')}, click to clear` : 'Click to highlight this line for everyone';
      html += `<div class="${cls}" data-line="${i}" title="${title}" style="top:${PAD_Y + i * LINE_HEIGHT}px">${mark ? `<i style="background:${mark.color}"></i>` : ''}${i + 1}</div>`;
    }
    this.gutter.innerHTML = html;
  }

  renderBands(width) {
    let html = '';
    for (const hl of this.highlights) {
      const line = this.lineAt(hl.offset);
      html += `<div class="band band-pin" style="top:${PAD_Y + line * LINE_HEIGHT}px;width:${width}px;--c:${hl.color}"></div>`;
    }
    for (const peer of this.peers.values()) {
      if (!peer.sel || !peer.connected) continue;
      const line = this.lineAt(peer.sel.head);
      html += `<div class="band band-peer" style="top:${PAD_Y + line * LINE_HEIGHT}px;width:${width}px;background:${hexToRgba(peer.color, 0.07)}"></div>`;
    }
    if (document.activeElement === this.input) {
      const line = this.lineAt(this.getSelection().head);
      html += `<div class="band band-self" style="top:${PAD_Y + line * LINE_HEIGHT}px;width:${width}px"></div>`;
    }
    this.bands.innerHTML = html;
  }

  renderPeers() {
    let html = '';
    for (const [id, peer] of this.peers) {
      if (!peer.sel || !peer.connected) continue;
      const len = this.doc.length;
      const from = Math.min(peer.sel.anchor, peer.sel.head, len);
      const to = Math.min(Math.max(peer.sel.anchor, peer.sel.head), len);
      if (from !== to) {
        const a = this.point(from);
        const b = this.point(to);
        for (let line = a.line; line <= b.line; line++) {
          const x0 = line === a.line ? a.x : PAD_X;
          const x1 = line === b.line ? b.x : PAD_X + (visualColumn(this.lines[line], this.lines[line].length) + 1) * this.charWidth;
          html += `<div class="peer-sel" style="left:${x0}px;top:${PAD_Y + line * LINE_HEIGHT}px;width:${Math.max(2, x1 - x0)}px;background:${hexToRgba(peer.color, 0.22)}"></div>`;
        }
      }
      const c = this.point(Math.min(peer.sel.head, len));
      const below = c.line === 0 ? ' is-below' : '';
      html += `<div class="peer-caret${peer.typing ? ' is-typing' : ''}" data-peer="${escapeAttr(id)}" style="left:${c.x}px;top:${c.y}px;--c:${peer.color}">`
        + `<span class="peer-flag${below}">${escapeHtml(peer.name)}${peer.typing ? '<b class="dots"><i></i><i></i><i></i></b>' : ''}</span></div>`;
    }
    this.peerLayer.innerHTML = html;
  }
}
