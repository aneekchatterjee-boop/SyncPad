import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextOperation, transformIndex } from '../shared/ot.js';

// Small seeded PRNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'ab\nc d{}';
function randomString(rand, max = 8) {
  let s = '';
  const n = Math.floor(rand() * max);
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

export function randomOperation(rand, doc) {
  const op = new TextOperation();
  let left = doc.length;
  while (left > 0) {
    const n = 1 + Math.floor(rand() * Math.min(left, 6));
    const r = rand();
    if (r < 0.2) op.insert(randomString(rand, 4) || 'x');
    else if (r < 0.45) { op.delete(n); left -= n; }
    else { op.retain(n); left -= n; }
  }
  if (rand() < 0.4) op.insert(randomString(rand, 4) || 'y');
  return op;
}

test('apply builds the expected document', () => {
  const op = new TextOperation().retain(6).delete(5).insert('there');
  assert.equal(op.apply('hello world'), 'hello there');
  assert.throws(() => op.apply('short'));
});

test('adjacent components are merged and inserts precede deletes', () => {
  const op = new TextOperation().retain(1).retain(2).delete(1).insert('x').insert('y');
  assert.deepEqual(op.toJSON(), [3, 'xy', -1]);
});

test('transform converges for random concurrent operations', () => {
  const rand = rng(42);
  for (let i = 0; i < 3000; i++) {
    const doc = randomString(rand, 20);
    const a = randomOperation(rand, doc);
    const b = randomOperation(rand, doc);
    const [aPrime, bPrime] = TextOperation.transform(a, b);
    assert.equal(bPrime.apply(a.apply(doc)), aPrime.apply(b.apply(doc)), `doc=${JSON.stringify(doc)} a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
  }
});

test('compose equals sequential application', () => {
  const rand = rng(7);
  for (let i = 0; i < 2000; i++) {
    const doc = randomString(rand, 20);
    const a = randomOperation(rand, doc);
    const afterA = a.apply(doc);
    const b = randomOperation(rand, afterA);
    assert.equal(a.compose(b).apply(doc), b.apply(afterA));
  }
});

test('invert undoes an operation', () => {
  const rand = rng(99);
  for (let i = 0; i < 1000; i++) {
    const doc = randomString(rand, 20);
    const op = randomOperation(rand, doc);
    assert.equal(op.invert(doc).apply(op.apply(doc)), doc);
  }
});

test('fromDiff reproduces the new text and respects the caret', () => {
  const rand = rng(5);
  for (let i = 0; i < 2000; i++) {
    const before = randomString(rand, 20);
    const after = randomString(rand, 20);
    assert.equal(TextOperation.fromDiff(before, after).apply(before), after);
  }
  // Typing "a" after the first "a" of "aa": with the caret at 2 the insert is at 1.
  assert.deepEqual(TextOperation.fromDiff('aa', 'aaa', 2).toJSON(), [1, 'a', 1]);
  assert.deepEqual(TextOperation.fromDiff('aa', 'aaa', 3).toJSON(), [2, 'a']);
});

test('JSON round trip validates components', () => {
  const op = new TextOperation().retain(2).insert('hi').delete(3);
  assert.deepEqual(TextOperation.fromJSON(JSON.parse(JSON.stringify(op))).toJSON(), op.toJSON());
  assert.throws(() => TextOperation.fromJSON([1.5]));
  assert.throws(() => TextOperation.fromJSON([{}]));
  assert.throws(() => TextOperation.fromJSON('nope'));
});

test('transformIndex shifts carets around inserts and deletes', () => {
  const insertAt2 = new TextOperation().retain(2).insert('XYZ').retain(3);
  assert.equal(transformIndex(1, insertAt2), 1);
  assert.equal(transformIndex(2, insertAt2), 2);
  assert.equal(transformIndex(2, insertAt2, true), 5);
  assert.equal(transformIndex(4, insertAt2), 7);

  const deleteMiddle = new TextOperation().retain(1).delete(3).retain(1);
  assert.equal(transformIndex(0, deleteMiddle), 0);
  assert.equal(transformIndex(2, deleteMiddle), 1);
  assert.equal(transformIndex(5, deleteMiddle), 2);
});
