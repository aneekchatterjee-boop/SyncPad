// Operational transformation for plain text.
//
// An operation is a list of components that walks the whole document:
//   positive integer  -> retain that many characters
//   string            -> insert that text
//   negative integer  -> delete that many characters
//
// The same module runs in Node (server, tests) and in the browser (editor),
// so it has no dependencies and no environment-specific code.

export class TextOperation {
  constructor() {
    this.ops = [];
    this.baseLength = 0;   // length of the document this op applies to
    this.targetLength = 0; // length of the document after applying it
  }

  static isRetain(c) { return typeof c === 'number' && c > 0; }
  static isInsert(c) { return typeof c === 'string'; }
  static isDelete(c) { return typeof c === 'number' && c < 0; }

  retain(n) {
    if (!Number.isInteger(n) || n < 0) throw new Error('retain expects a non-negative integer');
    if (n === 0) return this;
    this.baseLength += n;
    this.targetLength += n;
    const last = this.ops.length - 1;
    if (TextOperation.isRetain(this.ops[last])) this.ops[last] += n;
    else this.ops.push(n);
    return this;
  }

  insert(str) {
    if (typeof str !== 'string') throw new Error('insert expects a string');
    if (str === '') return this;
    this.targetLength += str.length;
    const ops = this.ops;
    const last = ops.length - 1;
    if (TextOperation.isInsert(ops[last])) {
      ops[last] += str;
    } else if (TextOperation.isDelete(ops[last])) {
      // Keep a canonical order: insert always comes before an adjacent delete.
      if (TextOperation.isInsert(ops[last - 1])) ops[last - 1] += str;
      else { ops[last + 1] = ops[last]; ops[last] = str; }
    } else {
      ops.push(str);
    }
    return this;
  }

  delete(n) {
    if (typeof n === 'string') n = n.length;
    if (!Number.isInteger(n)) throw new Error('delete expects an integer');
    if (n === 0) return this;
    if (n > 0) n = -n;
    this.baseLength -= n;
    const last = this.ops.length - 1;
    if (TextOperation.isDelete(this.ops[last])) this.ops[last] += n;
    else this.ops.push(n);
    return this;
  }

  isNoop() {
    return this.ops.length === 0 || (this.ops.length === 1 && TextOperation.isRetain(this.ops[0]));
  }

  apply(doc) {
    if (doc.length !== this.baseLength) {
      throw new Error(`operation base length ${this.baseLength} does not match document length ${doc.length}`);
    }
    const out = [];
    let index = 0;
    for (const c of this.ops) {
      if (TextOperation.isRetain(c)) {
        out.push(doc.slice(index, index + c));
        index += c;
      } else if (TextOperation.isInsert(c)) {
        out.push(c);
      } else {
        index -= c;
      }
    }
    return out.join('');
  }

  // The operation that undoes this one, given the document it was applied to.
  invert(doc) {
    const inverse = new TextOperation();
    let index = 0;
    for (const c of this.ops) {
      if (TextOperation.isRetain(c)) {
        inverse.retain(c);
        index += c;
      } else if (TextOperation.isInsert(c)) {
        inverse.delete(c.length);
      } else {
        inverse.insert(doc.slice(index, index - c));
        index -= c;
      }
    }
    return inverse;
  }

  // this then other  ==  this.compose(other)
  compose(other) {
    if (this.targetLength !== other.baseLength) {
      throw new Error('compose: first operation target length must equal second base length');
    }
    const result = new TextOperation();
    const a = this.ops, b = other.ops;
    let i = 0, j = 0;
    let ca = a[i++], cb = b[j++];
    for (;;) {
      if (ca === undefined && cb === undefined) break;
      if (TextOperation.isDelete(ca)) { result.delete(ca); ca = a[i++]; continue; }
      if (TextOperation.isInsert(cb)) { result.insert(cb); cb = b[j++]; continue; }
      if (ca === undefined) throw new Error('compose: first operation is too short');
      if (cb === undefined) throw new Error('compose: first operation is too long');

      if (TextOperation.isRetain(ca) && TextOperation.isRetain(cb)) {
        if (ca > cb) { result.retain(cb); ca -= cb; cb = b[j++]; }
        else if (ca === cb) { result.retain(ca); ca = a[i++]; cb = b[j++]; }
        else { result.retain(ca); cb -= ca; ca = a[i++]; }
      } else if (TextOperation.isInsert(ca) && TextOperation.isDelete(cb)) {
        if (ca.length > -cb) { ca = ca.slice(-cb); cb = b[j++]; }
        else if (ca.length === -cb) { ca = a[i++]; cb = b[j++]; }
        else { cb += ca.length; ca = a[i++]; }
      } else if (TextOperation.isInsert(ca) && TextOperation.isRetain(cb)) {
        if (ca.length > cb) { result.insert(ca.slice(0, cb)); ca = ca.slice(cb); cb = b[j++]; }
        else if (ca.length === cb) { result.insert(ca); ca = a[i++]; cb = b[j++]; }
        else { result.insert(ca); cb -= ca.length; ca = a[i++]; }
      } else if (TextOperation.isRetain(ca) && TextOperation.isDelete(cb)) {
        if (ca > -cb) { result.delete(cb); ca += cb; cb = b[j++]; }
        else if (ca === -cb) { result.delete(cb); ca = a[i++]; cb = b[j++]; }
        else { result.delete(ca); cb += ca; ca = a[i++]; }
      } else {
        throw new Error('compose: unexpected component pair');
      }
    }
    return result;
  }

  // Given a and b applied to the same document, return [a', b'] such that
  // apply(apply(doc, a), b') === apply(apply(doc, b), a').
  // When both insert at the same position, a's text goes first.
  static transform(a, b) {
    if (a.baseLength !== b.baseLength) {
      throw new Error('transform: both operations must have the same base length');
    }
    const aPrime = new TextOperation();
    const bPrime = new TextOperation();
    const x = a.ops, y = b.ops;
    let i = 0, j = 0;
    let ca = x[i++], cb = y[j++];
    for (;;) {
      if (ca === undefined && cb === undefined) break;
      if (TextOperation.isInsert(ca)) {
        aPrime.insert(ca); bPrime.retain(ca.length); ca = x[i++]; continue;
      }
      if (TextOperation.isInsert(cb)) {
        aPrime.retain(cb.length); bPrime.insert(cb); cb = y[j++]; continue;
      }
      if (ca === undefined) throw new Error('transform: first operation is too short');
      if (cb === undefined) throw new Error('transform: first operation is too long');

      let min;
      if (TextOperation.isRetain(ca) && TextOperation.isRetain(cb)) {
        if (ca > cb) { min = cb; ca -= cb; cb = y[j++]; }
        else if (ca === cb) { min = cb; ca = x[i++]; cb = y[j++]; }
        else { min = ca; cb -= ca; ca = x[i++]; }
        aPrime.retain(min); bPrime.retain(min);
      } else if (TextOperation.isDelete(ca) && TextOperation.isDelete(cb)) {
        // Both deleted the same text: nothing left to do for either side.
        if (-ca > -cb) { ca -= cb; cb = y[j++]; }
        else if (ca === cb) { ca = x[i++]; cb = y[j++]; }
        else { cb -= ca; ca = x[i++]; }
      } else if (TextOperation.isDelete(ca) && TextOperation.isRetain(cb)) {
        if (-ca > cb) { min = cb; ca += cb; cb = y[j++]; }
        else if (-ca === cb) { min = cb; ca = x[i++]; cb = y[j++]; }
        else { min = -ca; cb += ca; ca = x[i++]; }
        aPrime.delete(min);
      } else if (TextOperation.isRetain(ca) && TextOperation.isDelete(cb)) {
        if (ca > -cb) { min = -cb; ca += cb; cb = y[j++]; }
        else if (ca === -cb) { min = ca; ca = x[i++]; cb = y[j++]; }
        else { min = ca; cb += ca; ca = x[i++]; }
        bPrime.delete(min);
      } else {
        throw new Error('transform: unexpected component pair');
      }
    }
    return [aPrime, bPrime];
  }

  toJSON() { return this.ops; }

  static fromJSON(ops) {
    if (!Array.isArray(ops)) throw new Error('operation must be an array');
    const op = new TextOperation();
    for (const c of ops) {
      if (TextOperation.isRetain(c) && Number.isInteger(c)) op.retain(c);
      else if (TextOperation.isInsert(c)) op.insert(c);
      else if (TextOperation.isDelete(c) && Number.isInteger(c)) op.delete(c);
      else throw new Error('invalid operation component');
    }
    return op;
  }

  // Build the smallest single-region edit turning oldStr into newStr.
  // `caret` (the selection end after the edit) settles ambiguous cases such as
  // typing "a" into "aa", so the op describes what the user actually did.
  static fromDiff(oldStr, newStr, caret) {
    const op = new TextOperation();
    if (oldStr === newStr) return op.retain(oldStr.length);
    const minLen = Math.min(oldStr.length, newStr.length);
    let suffix = 0;
    const maxSuffix = caret == null ? minLen : Math.min(minLen, newStr.length - caret);
    while (suffix < maxSuffix &&
      oldStr.charCodeAt(oldStr.length - 1 - suffix) === newStr.charCodeAt(newStr.length - 1 - suffix)) {
      suffix++;
    }
    let prefix = 0;
    const maxPrefix = minLen - suffix;
    while (prefix < maxPrefix && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) prefix++;
    op.retain(prefix);
    op.insert(newStr.slice(prefix, newStr.length - suffix));
    op.delete(oldStr.length - prefix - suffix);
    op.retain(suffix);
    return op;
  }
}

// Move a document index across an operation.
// `stickRight` decides what happens when text is inserted exactly at the index:
// true pushes the index past the new text (used for highlights pinned to a line
// start), false leaves it in front (used for carets).
export function transformIndex(index, op, stickRight = false) {
  let newIndex = index;
  let pos = 0; // position in the original document
  for (const c of op.ops) {
    if (pos > index) break;
    if (TextOperation.isRetain(c)) {
      pos += c;
    } else if (TextOperation.isInsert(c)) {
      if (pos < index || (stickRight && pos === index)) newIndex += c.length;
    } else {
      const len = -c;
      newIndex -= Math.min(len, Math.max(0, index - pos));
      pos += len;
    }
  }
  return newIndex;
}

export function transformSelection(sel, op) {
  if (!sel) return sel;
  return { anchor: transformIndex(sel.anchor, op), head: transformIndex(sel.head, op) };
}
