import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TextOperation, transformIndex, transformSelection } from '../shared/ot.js';
import { LIMITS, PEER_COLORS } from '../shared/protocol.js';

export class RoomError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const newId = (bytes = 6) => randomBytes(bytes).toString('base64url');
const hashToken = (token) => createHash('sha256').update(token).digest();
const MAX_TOKENS = 500;

function lineStartAt(doc, offset) {
  return doc.lastIndexOf('\n', offset - 1) + 1;
}

function lineNumberAt(doc, offset) {
  let line = 1;
  for (let i = doc.indexOf('\n'); i !== -1 && i < offset; i = doc.indexOf('\n', i + 1)) line++;
  return line;
}

function offsetOfLine(doc, line) {
  let offset = 0;
  for (let n = 0; n < line; n++) {
    const next = doc.indexOf('\n', offset);
    if (next === -1) return null;
    offset = next + 1;
  }
  return offset;
}

// One persistent room: the document, its operation history, the people in it
// and the audit feed. Socket plumbing lives in sockets.js; this class only
// knows about state, so it can be reasoned about (and tested) on its own.
export class Room {
  constructor(data) {
    this.id = data.id;
    this.createdAt = data.createdAt ?? Date.now();
    this.passHash = data.passHash ?? null;
    this.doc = data.doc ?? '';
    this.rev = data.rev ?? 0;
    this.lang = data.lang ?? 'javascript';
    this.locked = data.locked ?? false;
    this.highlights = data.highlights ?? [];
    this.feed = data.feed ?? [];

    // Not persisted: history is only needed to transform in-flight edits.
    this.history = [];
    this.historyBase = this.rev;
    this.appliedOps = new Map(); // opId -> revision it produced (duplicate guard)

    this.members = new Map(); // sessionId -> member
    this.hostSession = null;
    // sessionId -> sha256 of the rejoin token issued after a successful join.
    // Persisted, so a server restart does not force everyone to re-enter the passcode.
    this.tokens = new Map(Object.entries(data.tokens ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64url')]));
    this.joinSeq = 0;
  }

  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      passHash: this.passHash,
      doc: this.doc,
      rev: this.rev,
      lang: this.lang,
      locked: this.locked,
      highlights: this.highlights,
      feed: this.feed.slice(-LIMITS.MAX_FEED_ENTRIES),
      tokens: Object.fromEntries([...this.tokens].map(([k, v]) => [k, v.toString('base64url')])),
    };
  }

  get hasPasscode() {
    return Boolean(this.passHash);
  }

  get host() {
    return this.hostSession ? this.members.get(this.hostSession) ?? null : null;
  }

  isHost(member) {
    return member != null && member.sessionId === this.hostSession;
  }

  connectedMembers() {
    return [...this.members.values()].filter((m) => m.connected);
  }

  publicMember(m) {
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      joinedAt: m.joinedAt,
      connected: m.connected,
      typing: m.typing,
      away: m.away,
      isHost: this.isHost(m),
      sel: m.sel,
    };
  }

  snapshot() {
    return {
      id: this.id,
      doc: this.doc,
      rev: this.rev,
      lang: this.lang,
      locked: this.locked,
      hasPasscode: this.hasPasscode,
      hostId: this.host?.id ?? null,
      members: [...this.members.values()].map((m) => this.publicMember(m)),
      highlights: this.highlights,
      feed: this.feed.slice(-100),
    };
  }

  pickColor() {
    const used = new Set([...this.members.values()].map((m) => m.color));
    return PEER_COLORS.find((c) => !used.has(c)) ?? PEER_COLORS[this.members.size % PEER_COLORS.length];
  }

  addMember({ sessionId, name, socketId }) {
    const member = {
      id: newId(),
      sessionId,
      name,
      color: this.pickColor(),
      joinedAt: Date.now(),
      joinOrder: ++this.joinSeq,
      socketId,
      connected: true,
      typing: false,
      away: false,
      sel: null,
      typingTimer: null,
      graceTimer: null,
      hostTimer: null,
      edits: null,
    };
    this.members.set(sessionId, member);
    return member;
  }

  removeMember(sessionId) {
    const m = this.members.get(sessionId);
    if (!m) return null;
    clearTimeout(m.typingTimer);
    clearTimeout(m.graceTimer);
    clearTimeout(m.hostTimer);
    this.members.delete(sessionId);
    return m;
  }

  issueToken(sessionId) {
    const token = newId(18);
    this.tokens.delete(sessionId); // re-insert so the map stays in issue order
    this.tokens.set(sessionId, hashToken(token));
    if (this.tokens.size > MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value);
    return token;
  }

  checkToken(sessionId, token) {
    const expected = this.tokens.get(sessionId);
    return Boolean(expected && typeof token === 'string' && timingSafeEqual(hashToken(token), expected));
  }

  // The oldest member (by join order) whose connection is currently live.
  oldestActiveMember(excludeSession = null) {
    let best = null;
    for (const m of this.members.values()) {
      if (!m.connected || m.sessionId === excludeSession) continue;
      if (!best || m.joinOrder < best.joinOrder) best = m;
    }
    return best;
  }

  log(type, text, member = null, extra = {}) {
    const entry = {
      id: newId(4),
      t: Date.now(),
      type,
      text,
      by: member ? { id: member.id, name: member.name, color: member.color } : null,
      ...extra,
    };
    this.feed.push(entry);
    if (this.feed.length > LIMITS.MAX_FEED_ENTRIES) this.feed.splice(0, this.feed.length - LIMITS.MAX_FEED_ENTRIES);
    return entry;
  }

  // Apply a client operation made against `rev`. Returns the transformed op,
  // the new revision and the sender's selection mapped into server coordinates.
  applyOperation(member, { rev, op: rawOp, opId, sel }) {
    if (!Number.isInteger(rev)) throw new RoomError('bad-request');
    if (typeof opId !== 'string' || opId.length > 80) throw new RoomError('bad-request');
    if (this.appliedOps.has(opId)) {
      return { duplicate: true, rev: this.appliedOps.get(opId) };
    }
    if (rev > this.rev || rev < this.historyBase) throw new RoomError('resync');

    let op;
    try {
      op = TextOperation.fromJSON(rawOp);
    } catch {
      throw new RoomError('bad-request');
    }

    let selection = sanitizeSelection(sel);
    for (const past of this.history.slice(rev - this.historyBase)) {
      const [opPrime, pastPrime] = TextOperation.transform(op, past.op);
      op = opPrime;
      if (selection) selection = transformSelection(selection, pastPrime);
    }
    if (op.baseLength !== this.doc.length) throw new RoomError('resync');
    if (op.targetLength > LIMITS.MAX_DOC_LENGTH) throw new RoomError('too-large');

    const before = this.doc;
    this.doc = op.apply(before);
    this.rev++;
    this.history.push({ op, opId, by: member.id });
    this.appliedOps.set(opId, this.rev);
    if (this.history.length > LIMITS.HISTORY_SIZE) {
      const drop = this.history.length - LIMITS.HISTORY_SIZE;
      this.history.splice(0, drop);
      this.historyBase += drop;
    }
    if (this.appliedOps.size > LIMITS.HISTORY_SIZE) {
      this.appliedOps.delete(this.appliedOps.keys().next().value);
    }

    for (const other of this.members.values()) {
      if (other !== member && other.sel) other.sel = transformSelection(other.sel, op);
    }
    if (selection) selection = clampSelection(selection, this.doc.length);
    member.sel = selection;
    this.transformHighlights(op);
    this.trackEdit(member, op, before);

    return { op, rev: this.rev, sel: selection };
  }

  // Operations a reconnecting client missed, or null if they are gone.
  opsSince(rev) {
    if (!Number.isInteger(rev) || rev < this.historyBase || rev > this.rev) return null;
    return this.history.slice(rev - this.historyBase).map((h) => ({ op: h.op.toJSON(), opId: h.opId, by: h.by }));
  }

  // Selection reported against an older revision, moved to the current one.
  selectionAt(sel, rev) {
    let s = sanitizeSelection(sel);
    if (!s) return null;
    if (Number.isInteger(rev) && rev >= this.historyBase && rev < this.rev) {
      for (const past of this.history.slice(rev - this.historyBase)) s = transformSelection(s, past.op);
    }
    return clampSelection(s, this.doc.length);
  }

  transformHighlights(op) {
    const seen = new Set();
    this.highlights = this.highlights.filter((h) => {
      h.offset = lineStartAt(this.doc, transformIndex(h.offset, op, true));
      if (seen.has(h.offset)) return false;
      seen.add(h.offset);
      return true;
    });
  }

  // Toggle the highlight on a 0-based line. Returns the action taken.
  toggleHighlight(member, line) {
    const offset = offsetOfLine(this.doc, line);
    if (offset == null) return null;
    const existing = this.highlights.findIndex((h) => h.offset === offset);
    if (existing !== -1) {
      this.highlights.splice(existing, 1);
      return { action: 'removed', line: line + 1 };
    }
    if (this.highlights.length >= 200) return null;
    this.highlights.push({ id: newId(4), offset, by: member.id, name: member.name, color: member.color });
    return { action: 'added', line: line + 1 };
  }

  // Accumulate edits per member so the feed gets one line per burst of typing.
  trackEdit(member, op, before) {
    let pos = 0;
    let inserted = 0;
    let deleted = 0;
    let first = null;
    for (const c of op.ops) {
      if (TextOperation.isRetain(c)) { pos += c; continue; }
      if (first == null) first = pos;
      if (TextOperation.isInsert(c)) inserted += c.length;
      else { deleted += -c; pos += -c; }
    }
    if (first == null) return;
    const startLine = lineNumberAt(before, first);
    const endLine = startLine + Math.max(0, (op.ops.find(TextOperation.isInsert) ?? '').split('\n').length - 1);
    const e = member.edits ?? (member.edits = { inserted: 0, deleted: 0, from: startLine, to: endLine, timer: null });
    e.inserted += inserted;
    e.deleted += deleted;
    e.from = Math.min(e.from, startLine);
    e.to = Math.max(e.to, endLine);
  }

  flushEdits(member) {
    const e = member.edits;
    if (!e) return null;
    member.edits = null;
    clearTimeout(e.timer);
    const where = e.from === e.to ? `L${e.from}` : `L${e.from}–${e.to}`;
    const delta = [e.inserted && `+${e.inserted}`, e.deleted && `−${e.deleted}`].filter(Boolean).join(' ');
    return this.log('edit', `edited ${where} (${delta || '0'} chars)`, member);
  }
}

function sanitizeSelection(sel) {
  if (!sel || typeof sel !== 'object') return null;
  const { anchor, head } = sel;
  if (!Number.isInteger(anchor) || !Number.isInteger(head) || anchor < 0 || head < 0) return null;
  return { anchor, head };
}

function clampSelection(sel, length) {
  return { anchor: Math.min(sel.anchor, length), head: Math.min(sel.head, length) };
}
