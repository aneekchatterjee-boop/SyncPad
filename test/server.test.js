import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { io as connectClient } from 'socket.io-client';
import { createServer } from '../server/app.js';
import { TextOperation } from '../shared/ot.js';
import { SyncClient } from '../shared/sync-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const sessionId = () => randomBytes(12).toString('base64url');

async function waitFor(check, timeoutMs = 4000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function testConfig(dataDir) {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    reconnectGraceMs: 600,
    hostGraceMs: 150,
    saveDebounceMs: 10,
    corsOrigin: null,
    trustProxy: false,
  };
}

// A headless participant driving the same SyncClient the browser uses.
class Peer {
  constructor(url, name) {
    this.url = url;
    this.name = name;
    this.sessionId = sessionId();
    this.events = [];
  }

  async connect() {
    this.socket = connectClient(this.url, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('connect_error', reject);
    });
    this.socket.onAny((event, payload) => this.events.push({ event, payload }));
    return this;
  }

  attach(res) {
    this.res = res;
    if (!res.ok) return res;
    this.me = res.me;
    this.doc = res.room.doc;
    this.client = new SyncClient({
      revision: res.room.rev,
      sessionId: this.sessionId,
      sendOp: (payload, ack) => this.socket.emit('op', payload, ack),
      sendCursor: (payload) => this.socket.emit('cursor', payload),
      getSelection: () => null,
    });
    this.client.setConnected(true);
    this.socket.off('op');
    this.socket.on('op', (msg) => {
      const op = this.client.applyRemote(TextOperation.fromJSON(msg.op));
      this.doc = op.apply(this.doc);
    });
    return res;
  }

  async create(roomId, passcode) {
    return this.attach(await call(this.socket, 'room:create', { roomId, name: this.name, sessionId: this.sessionId, passcode }));
  }

  async join(roomId, extra = {}) {
    return this.attach(await call(this.socket, 'room:join', { roomId, name: this.name, sessionId: this.sessionId, ...extra }));
  }

  type(op) {
    this.doc = op.apply(this.doc);
    this.client.applyLocal(op);
  }

  insertAt(index, text) {
    this.type(new TextOperation().retain(index).insert(text).retain(this.doc.length - index));
  }

  received(event) {
    return this.events.filter((e) => e.event === event).map((e) => e.payload);
  }

  close() {
    this.client?.setConnected(false);
    this.socket?.disconnect();
  }
}

describe('SyncPad server', () => {
  let server;
  let url;
  let dataDir;
  const peers = [];
  const peer = async (name) => {
    const p = await new Peer(url, name).connect();
    peers.push(p);
    return p;
  };

  before(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'syncpad-test-'));
    server = await createServer(testConfig(dataDir));
    const addr = await server.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    for (const p of peers) p.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test('rejects invalid room ids and duplicate rooms', async () => {
    const a = await peer('ada');
    assert.equal((await call(a.socket, 'room:create', { roomId: 'no spaces!', name: 'ada', sessionId: a.sessionId })).error, 'invalid-room-id');
    assert.equal((await a.create('dupe-room')).ok, true);
    const b = await peer('bob');
    assert.equal((await b.create('dupe-room')).error, 'room-exists');
  });

  test('passcode is validated before a client is admitted', async () => {
    const host = await peer('host');
    assert.equal((await host.create('secret-room', 'hunter22')).ok, true);

    const guest = await peer('guest');
    const check = await call(guest.socket, 'room:check', { roomId: 'secret-room' });
    assert.deepEqual(check, { ok: true, exists: true, hasPasscode: true, online: 1 });

    assert.equal((await guest.join('secret-room')).error, 'passcode-required');
    assert.equal((await guest.join('secret-room', { passcode: 'wrong-one' })).error, 'wrong-passcode');

    // A rejected client must not receive any room traffic.
    host.insertAt(0, 'classified');
    await waitFor(() => !host.client.hasPendingChanges(), 2000, 'host ack');
    await sleep(100);
    assert.equal(guest.received('op').length, 0);
    assert.equal(guest.received('feed').length, 0);

    const ok = await guest.join('secret-room', { passcode: 'hunter22' });
    assert.equal(ok.ok, true);
    assert.equal(ok.room.doc, 'classified');
    assert.equal(typeof ok.token, 'string');
  });

  test('concurrent edits from three peers converge without collisions', async () => {
    const a = await peer('a');
    const b = await peer('b');
    const c = await peer('c');
    await a.create('converge');
    await b.join('converge');
    await c.join('converge');
    const all = [a, b, c];

    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let round = 0; round < 60; round++) {
      for (const p of all) {
        const doc = p.doc;
        const pos = Math.floor(rand() * (doc.length + 1));
        if (doc.length > 0 && rand() < 0.35) {
          const len = Math.min(doc.length - pos, 1 + Math.floor(rand() * 3));
          if (len > 0) p.type(new TextOperation().retain(pos).delete(len).retain(doc.length - pos - len));
        } else {
          p.insertAt(pos, String.fromCharCode(97 + Math.floor(rand() * 26)) + (rand() < 0.2 ? '\n' : ''));
        }
      }
      await sleep(15 + Math.floor(rand() * 30));
    }

    await waitFor(() => all.every((p) => !p.client.hasPendingChanges()), 15000, 'all edits acknowledged');
    await sleep(150);
    const serverDoc = server.rooms.get('converge').doc;
    assert.ok(serverDoc.length > 0);
    for (const p of all) assert.equal(p.doc, serverDoc, `${p.name} diverged`);
    // Batching kept everyone under the limit: nothing was throttled.
    for (const p of all) assert.equal(p.received('throttled').length, 0);
  });

  test('host privileges move to the oldest active member when the host drops', async () => {
    const host = await peer('host');
    const second = await peer('second');
    const third = await peer('third');
    await host.create('handover');
    await second.join('handover');
    await third.join('handover');
    assert.equal(third.res.room.hostId, host.me.id);

    host.socket.disconnect(); // abrupt: no room:leave
    await waitFor(() => third.received('host:changed').some((e) => e.hostId === second.me.id), 3000, 'host change');
    const room = server.rooms.get('handover');
    assert.equal(room.host.id, second.me.id);

    // Non-hosts cannot use admin controls.
    assert.equal((await call(third.socket, 'member:kick', { id: second.me.id })).error, 'not-host');
    // The new host can.
    assert.equal((await call(second.socket, 'room:lock', { locked: true })).ok, true);
  });

  test('locked rooms reject edits from non-hosts', async () => {
    const host = await peer('host');
    const guest = await peer('guest');
    await host.create('locked-room');
    await guest.join('locked-room');
    await call(host.socket, 'room:lock', { locked: true });
    const res = await call(guest.socket, 'op', { rev: guest.client.revision, op: ['x'], opId: `${guest.sessionId}:1` });
    assert.equal(res.error, 'locked');
    assert.equal(server.rooms.get('locked-room').doc, '');
  });

  test('bursts above 5 updates/second are throttled and not broadcast', async () => {
    const spammer = await peer('spammer');
    const watcher = await peer('watcher');
    await spammer.create('flood');
    await watcher.join('flood');
    await sleep(1100); // let the bucket refill after joining

    for (let i = 0; i < 25; i++) spammer.socket.emit('cursor', { rev: 0, sel: { anchor: 0, head: 0 } });
    await waitFor(() => spammer.received('throttled').length > 0, 2000, 'throttle notice');
    await sleep(200);
    const delivered = watcher.received('cursor').length;
    assert.ok(delivered <= 6, `watcher received ${delivered} cursor updates from a burst of 25`);
    assert.ok(watcher.received('feed').some((f) => f.type === 'throttle'), 'throttle shows in the audit feed');

    // Edits over the limit are bounced back to the sender, not applied.
    await sleep(1100);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      call(spammer.socket, 'op', { rev: 0, op: ['x'], opId: `${spammer.sessionId}:${i}` })));
    const throttled = results.filter((r) => r.error === 'throttled');
    assert.ok(throttled.length >= 4, `expected some edits throttled, got ${JSON.stringify(results)}`);
    assert.ok(throttled.every((r) => r.retryAfter > 0));
  });

  test('reconnecting peers keep their seat and lost acks are not applied twice', async () => {
    const a = await peer('alpha');
    const b = await peer('beta');
    await a.create('reconnect');
    await b.join('reconnect');
    const seatId = a.me.id;

    // Send an edit, then drop the connection before handling the ack.
    const opId = `${a.sessionId}:1`;
    const rev = a.client.revision;
    const ack = await call(a.socket, 'op', { rev, op: ['hello'], opId });
    assert.equal(ack.ok, true);
    a.socket.disconnect();

    await waitFor(() => b.received('member:update').some((m) => m.id === seatId && !m.connected), 2000, 'disconnect seen');

    const a2 = await peer('alpha');
    a2.sessionId = a.sessionId;
    const res = await call(a2.socket, 'room:join', { roomId: 'reconnect', name: 'alpha', sessionId: a.sessionId, rev });
    assert.equal(res.ok, true);
    assert.equal(res.me.id, seatId, 'same seat after reconnect');
    assert.deepEqual(res.missed.map((m) => m.opId), [opId]);

    // A client that never saw the ack resends the same op: it must not duplicate.
    const again = await call(a2.socket, 'op', { rev, op: ['hello'], opId });
    assert.equal(again.duplicate, true);
    assert.equal(server.rooms.get('reconnect').doc, 'hello');

    // SyncClient treats its own replayed op as the acknowledgement.
    const replay = new SyncClient({ revision: rev, sessionId: a.sessionId, sendOp: () => assert.fail('should not resend'), sendCursor() {}, getSelection: () => null });
    replay.setConnected(true);
    replay.outstanding = { op: TextOperation.fromJSON(['hello']), opId };
    replay.catchUp(res.missed, () => assert.fail('own op is not a remote op'));
    assert.equal(replay.outstanding, null);
    assert.equal(replay.revision, rev + 1);
    replay.setConnected(false);

    assert.ok(b.received('feed').some((f) => f.type === 'reconnect'));
  });

  test('a member that does not come back is removed after the grace period', async () => {
    const a = await peer('stays');
    const b = await peer('goes');
    await a.create('grace');
    await b.join('grace');
    b.socket.disconnect();
    await waitFor(() => a.received('member:left').some((m) => m.id === b.me.id), 3000, 'member removal');
    assert.equal(server.rooms.get('grace').members.size, 1);
  });

  test('line highlights are shared and follow edits', async () => {
    const a = await peer('a');
    const b = await peer('b');
    await a.create('lines');
    await b.join('lines');
    a.insertAt(0, 'one\ntwo\nthree');
    await waitFor(() => b.doc === 'one\ntwo\nthree', 2000, 'doc sync');
    assert.equal((await call(b.socket, 'highlight:toggle', { line: 1 })).ok, true);
    await waitFor(() => a.received('highlights').length > 0, 2000, 'highlight broadcast');
    assert.equal(a.received('highlights').at(-1).list[0].offset, 4);

    // Inserting a line above moves the highlight down with its text.
    a.insertAt(0, 'zero\n');
    await waitFor(() => !a.client.hasPendingChanges(), 2000);
    assert.equal(server.rooms.get('lines').highlights[0].offset, 9);
  });

  test('rooms persist across a server restart', async () => {
    const a = await peer('keeper');
    await a.create('persisted', 'letmein');
    a.insertAt(0, 'survives restarts');
    await waitFor(() => !a.client.hasPendingChanges(), 2000);
    await server.store.flush();

    const second = await createServer(testConfig(dataDir));
    try {
      const room = second.rooms.get('persisted');
      assert.ok(room);
      assert.equal(room.doc, 'survives restarts');
      assert.equal(room.hasPasscode, true);
      assert.notEqual(room.passHash, 'letmein');
      assert.ok(!JSON.stringify(room.toJSON()).includes(a.res.token), 'tokens are stored hashed');

      // The rejoin token issued before the restart still admits the same session.
      const addr = await second.listen(0, '127.0.0.1');
      const back = await new Peer(`http://127.0.0.1:${addr.port}`, 'keeper').connect();
      back.sessionId = a.sessionId;
      const res = await back.join('persisted', { token: a.res.token });
      back.close();
      assert.equal(res.ok, true, `rejoin after restart failed: ${res.error}`);
      assert.equal(res.room.doc, 'survives restarts');
    } finally {
      await second.close();
    }
  });
});
