// Client half of the OT protocol, independent of the DOM so the browser editor
// and the Node test suite drive exactly the same code.
//
// At most one operation is in flight ("outstanding"); edits made while waiting
// for its acknowledgement are composed into a single "buffer". Together with a
// minimum send interval this keeps a fast typist under the server's rate limit.

import { TextOperation, transformIndex } from './ot.js';
import { LIMITS } from './protocol.js';

export class SyncClient {
  /**
   * @param {object} opts
   * @param {number} opts.revision     server revision the local document matches
   * @param {string} opts.sessionId
   * @param {(payload: object, ack: (res: object) => void) => void} opts.sendOp
   * @param {(payload: object) => void} opts.sendCursor
   * @param {() => ({anchor:number, head:number} | null)} opts.getSelection
   * @param {number} [opts.sendIntervalMs]
   */
  constructor({ revision, sessionId, sendOp, sendCursor, getSelection, sendIntervalMs = LIMITS.SEND_INTERVAL_MS }) {
    this.revision = revision;
    this.sessionId = sessionId;
    this.sendOp = sendOp;
    this.sendCursor = sendCursor;
    this.getSelection = getSelection;
    this.sendIntervalMs = sendIntervalMs;

    this.outstanding = null; // { op: TextOperation, opId: string }
    this.buffer = null;      // TextOperation not yet sent
    this.cursorDirty = false;
    this.connected = false;
    this.seq = 0;
    this.lastSendAt = 0;
    this.timer = null;
    this.retryTimer = null;
    this.onThrottled = null; // optional hook for the UI
    this.onResyncNeeded = null;
  }

  get state() {
    if (!this.outstanding) return 'synchronized';
    return this.buffer ? 'awaiting-with-buffer' : 'awaiting-confirm';
  }

  hasPendingChanges() {
    return Boolean(this.outstanding || this.buffer);
  }

  setConnected(connected) {
    this.connected = connected;
    if (!connected) {
      clearTimeout(this.timer);
      clearTimeout(this.retryTimer);
      this.timer = this.retryTimer = null;
    }
  }

  // A change typed locally (already applied to the local document).
  applyLocal(op) {
    if (op.isNoop()) return;
    this.buffer = this.buffer ? this.buffer.compose(op) : op;
    this.schedule();
  }

  cursorMoved() {
    this.cursorDirty = true;
    this.schedule();
  }

  // An operation broadcast by the server. Returns the operation to apply to the
  // local document, transformed past everything not yet acknowledged.
  applyRemote(op) {
    if (this.outstanding) {
      const [outPrime, opPrime] = TextOperation.transform(this.outstanding.op, op);
      this.outstanding.op = outPrime;
      op = opPrime;
    }
    if (this.buffer) {
      const [bufPrime, opPrime] = TextOperation.transform(this.buffer, op);
      this.buffer = bufPrime;
      op = opPrime;
    }
    this.revision++;
    return op;
  }

  // Map an index the server reported (in server coordinates at this revision)
  // into the local document, which also contains our unacknowledged edits.
  toLocalIndex(index, stickRight = false) {
    if (this.outstanding) index = transformIndex(index, this.outstanding.op, stickRight);
    if (this.buffer) index = transformIndex(index, this.buffer, stickRight);
    return index;
  }

  schedule() {
    if (!this.connected || this.timer) return;
    const wait = Math.max(0, this.lastSendAt + this.sendIntervalMs - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
  }

  flush() {
    if (!this.connected) return;
    if (!this.outstanding && this.buffer) {
      this.outstanding = { op: this.buffer, opId: `${this.sessionId}:${++this.seq}` };
      this.buffer = null;
      this.cursorDirty = false;
      this.transmitOutstanding();
      return;
    }
    if (this.cursorDirty && !this.buffer) {
      this.cursorDirty = false;
      this.lastSendAt = Date.now();
      this.sendCursor({ rev: this.revision, sel: this.getSelection() });
      if (this.cursorDirty || this.buffer) this.schedule();
    }
  }

  transmitOutstanding() {
    const { op, opId } = this.outstanding;
    this.lastSendAt = Date.now();
    this.sendOp({ rev: this.revision, op: op.toJSON(), opId, sel: this.getSelection() }, (res) => this.handleAck(opId, res));
  }

  handleAck(opId, res) {
    if (!this.outstanding || this.outstanding.opId !== opId) return; // stale ack
    if (res && res.ok) {
      this.acknowledge(res.rev);
    } else if (res && res.error === 'throttled') {
      // The server refused to broadcast it; the op is still ours to send.
      this.onThrottled?.(res.retryAfter);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.connected && this.outstanding && this.outstanding.opId === opId) this.transmitOutstanding();
      }, Math.max(this.sendIntervalMs, res.retryAfter || 0));
    } else {
      this.onResyncNeeded?.(res?.error || 'rejected');
    }
  }

  acknowledge(rev) {
    this.outstanding = null;
    this.revision = typeof rev === 'number' ? rev : this.revision + 1;
    if (this.buffer || this.cursorDirty) this.schedule();
  }

  // After a reconnect the server replays what we missed. Our own outstanding op
  // may be among them if it was applied but the acknowledgement was lost.
  // `apply` receives each transformed remote op for the local document.
  catchUp(entries, apply) {
    for (const entry of entries) {
      if (this.outstanding && entry.opId === this.outstanding.opId) {
        this.acknowledge(this.revision + 1);
      } else {
        apply(this.applyRemote(TextOperation.fromJSON(entry.op)), entry);
      }
    }
    if (this.outstanding) this.transmitOutstanding();
    else this.schedule();
  }

  // Server could not replay history (too old, or it restarted): start over
  // from its snapshot. Returns true if unsynced local edits were discarded.
  reset(revision) {
    const lost = this.hasPendingChanges();
    this.outstanding = null;
    this.buffer = null;
    this.cursorDirty = false;
    this.revision = revision;
    return lost;
  }
}
