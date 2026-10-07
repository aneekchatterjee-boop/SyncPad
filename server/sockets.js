import { LIMITS, LANGUAGES, isValidRoomId, normalizeRoomId } from '../shared/protocol.js';
import { hashPasscode, verifyPasscode } from './passcode.js';
import { Room, RoomError } from './room.js';
import { TokenBucket, WindowCounter } from './throttle.js';

const SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const LANGUAGE_IDS = new Set(LANGUAGES.map((l) => l.id));
const MAX_FAILED_JOINS_PER_MINUTE = 8;

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return name.slice(0, LIMITS.MAX_NAME_LENGTH);
}

function validPasscode(p) {
  return typeof p === 'string' && p.length >= LIMITS.MIN_PASSCODE_LENGTH && p.length <= LIMITS.MAX_PASSCODE_LENGTH;
}

// Every handler answers through an acknowledgement callback when one is given;
// clients that skip it (or send garbage) just get nothing back.
function reply(cb, payload) {
  if (typeof cb === 'function') cb(payload);
}

export function attachRoomSockets(io, { rooms, store, config }) {
  const failedJoins = new Map(); // ip -> WindowCounter
  setInterval(() => {
    for (const [ip, counter] of failedJoins) if (counter.count() === 0) failedJoins.delete(ip);
  }, 60_000).unref();

  const roomChannel = (room) => `room:${room.id}`;
  const persist = () => store.markDirty();

  function emitFeed(room, entry) {
    if (entry) io.to(roomChannel(room)).emit('feed', entry);
    persist();
  }

  function emitMember(room, member) {
    io.to(roomChannel(room)).emit('member:update', room.publicMember(member));
  }

  function emitHost(room) {
    io.to(roomChannel(room)).emit('host:changed', { hostId: room.host?.id ?? null });
  }

  function clientIp(socket) {
    if (config.trustProxy) {
      const fwd = socket.handshake.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
    }
    return socket.handshake.address;
  }

  function setHost(room, member, reason) {
    const previous = room.host;
    room.hostSession = member?.sessionId ?? null;
    if (previous && previous !== member) {
      clearTimeout(previous.hostTimer);
      if (room.members.has(previous.sessionId)) emitMember(room, previous);
    }
    if (member) {
      clearTimeout(member.hostTimer);
      emitMember(room, member);
      emitFeed(room, room.log('host', reason, member));
    }
    emitHost(room);
  }

  // Hand admin rights to the oldest member who is still connected.
  function reassignHost(room, reasonPrefix) {
    const next = room.oldestActiveMember(room.hostSession);
    if (next) setHost(room, next, `${reasonPrefix}; host privileges moved to the oldest active member`);
    else {
      room.hostSession = null;
      emitHost(room);
    }
  }

  function removeMember(room, member, { reason, text }) {
    const wasHost = room.isHost(member);
    room.removeMember(member.sessionId);
    emitFeed(room, room.flushEdits(member));
    io.to(roomChannel(room)).emit('member:left', { id: member.id, reason });
    emitFeed(room, room.log(reason === 'kicked' ? 'kick' : 'leave', text, member));
    if (wasHost) reassignHost(room, `${member.name} left`);
  }

  function detachSocket(socket) {
    const { roomId, sessionId } = socket.data;
    socket.data.roomId = null;
    socket.data.sessionId = null;
    if (roomId) socket.leave(`room:${roomId}`);
    return roomId ? { room: rooms.get(roomId), sessionId } : null;
  }

  function currentMember(socket) {
    const room = socket.data.roomId ? rooms.get(socket.data.roomId) : null;
    const member = room?.members.get(socket.data.sessionId);
    if (!room || !member || member.socketId !== socket.id) return {};
    return { room, member };
  }

  // Rate limiting for everything that gets broadcast. Returns true if the
  // update may go through. Excess updates are dropped (or, for edits, bounced
  // back to the sender to retry) and never reach the other peers.
  function allowUpdate(socket) {
    if (socket.data.bucket.take()) return true;
    const drops = socket.data.drops.add();
    const now = Date.now();
    const { room, member } = currentMember(socket);
    if (now - socket.data.lastThrottleNotice > 1000) {
      socket.data.lastThrottleNotice = now;
      socket.emit('throttled', { retryAfter: socket.data.bucket.retryAfter(), limit: LIMITS.UPDATES_PER_SECOND });
    }
    if (room && member && now - socket.data.lastThrottleLog > 5000) {
      socket.data.lastThrottleLog = now;
      emitFeed(room, room.log('throttle', `throttled: more than ${LIMITS.UPDATES_PER_SECOND} updates/s, excess updates dropped`, member));
    }
    if (drops > LIMITS.FLOOD_DROPS_BEFORE_KICK) {
      socket.emit('kicked', { reason: 'flooding' });
      if (room && member) removeMember(room, member, { reason: 'kicked', text: 'disconnected for flooding the room' });
      detachSocket(socket);
      socket.disconnect(true);
    }
    return false;
  }

  function markTyping(room, member) {
    clearTimeout(member.typingTimer);
    if (!member.typing) {
      member.typing = true;
      emitMember(room, member);
    }
    member.typingTimer = setTimeout(() => {
      member.typing = false;
      if (room.members.get(member.sessionId) === member) emitMember(room, member);
    }, LIMITS.TYPING_TIMEOUT_MS);

    clearTimeout(member.edits?.timer);
    if (member.edits) {
      member.edits.timer = setTimeout(() => emitFeed(room, room.flushEdits(member)), 2500);
    }
  }

  async function admit(socket, room, { sessionId, name, rev, creator = false }) {
    // Leaving any previous room first keeps one socket = one seat.
    const prev = detachSocket(socket);
    if (prev?.room && prev.room !== room) {
      const old = prev.room.members.get(prev.sessionId);
      if (old) removeMember(prev.room, old, { reason: 'left', text: 'left the room' });
    }

    let member = room.members.get(sessionId);
    let rejoined = false;
    if (member) {
      // Same session coming back inside the grace window: keep its seat.
      clearTimeout(member.graceTimer);
      clearTimeout(member.hostTimer);
      member.graceTimer = member.hostTimer = null;
      member.socketId = socket.id;
      member.connected = true;
      member.away = false;
      if (name) member.name = name;
      rejoined = true;
    } else {
      member = room.addMember({ sessionId, name, socketId: socket.id });
    }

    socket.data.roomId = room.id;
    socket.data.sessionId = sessionId;
    socket.join(roomChannel(room));

    const token = room.issueToken(sessionId);
    let hostNote = null;
    if (creator) hostNote = 'is the host (room creator)';
    else if (!room.host) hostNote = 'is now the host (first one in)';
    if (hostNote) room.hostSession = sessionId;

    const missed = rejoined || Number.isInteger(rev) ? room.opsSince(rev) : null;
    const response = {
      ok: true,
      me: { id: member.id, color: member.color, name: member.name },
      token,
      missed,
    };

    socket.to(roomChannel(room)).emit(rejoined ? 'member:update' : 'member:joined', room.publicMember(member));
    emitFeed(room, room.log(rejoined ? 'reconnect' : 'join', rejoined ? 'reconnected' : 'joined the room', member));
    if (hostNote) {
      emitFeed(room, room.log('host', hostNote, member));
      emitHost(room);
    }
    response.room = room.snapshot();
    return response;
  }

  io.on('connection', (socket) => {
    socket.data = {
      roomId: null,
      sessionId: null,
      bucket: new TokenBucket(LIMITS.UPDATES_PER_SECOND, LIMITS.BURST),
      drops: new WindowCounter(LIMITS.FLOOD_WINDOW_MS),
      lookups: new TokenBucket(3, 10),
      lastThrottleNotice: 0,
      lastThrottleLog: 0,
    };

    socket.on('room:check', (payload, cb) => {
      if (!socket.data.lookups.take()) return reply(cb, { ok: false, error: 'slow-down' });
      const id = normalizeRoomId(payload?.roomId);
      if (!isValidRoomId(id)) return reply(cb, { ok: false, error: 'invalid-room-id' });
      const room = rooms.get(id);
      reply(cb, {
        ok: true,
        exists: Boolean(room),
        hasPasscode: room?.hasPasscode ?? false,
        online: room ? room.connectedMembers().length : 0,
      });
    });

    socket.on('room:create', async (payload, cb) => {
      try {
        if (!socket.data.lookups.take()) throw new RoomError('slow-down');
        const id = normalizeRoomId(payload?.roomId);
        const name = cleanName(payload?.name);
        const sessionId = payload?.sessionId;
        const passcode = payload?.passcode || null;
        if (!isValidRoomId(id)) throw new RoomError('invalid-room-id');
        if (!name) throw new RoomError('invalid-name');
        if (typeof sessionId !== 'string' || !SESSION_PATTERN.test(sessionId)) throw new RoomError('bad-request');
        if (passcode !== null && !validPasscode(passcode)) throw new RoomError('invalid-passcode');
        if (rooms.has(id)) throw new RoomError('room-exists');

        const room = new Room({ id, passHash: passcode ? await hashPasscode(passcode) : null });
        if (rooms.has(id)) throw new RoomError('room-exists'); // lost a race during hashing
        rooms.set(id, room);
        room.log('create', passcode ? 'room created with a passcode' : 'room created', null);
        reply(cb, await admit(socket, room, { sessionId, name, creator: true }));
      } catch (err) {
        reply(cb, { ok: false, error: err.code || 'server-error' });
        if (!err.code) console.error('[room:create]', err);
      }
    });

    socket.on('room:join', async (payload, cb) => {
      try {
        const id = normalizeRoomId(payload?.roomId);
        const name = cleanName(payload?.name);
        const sessionId = payload?.sessionId;
        if (!isValidRoomId(id)) throw new RoomError('invalid-room-id');
        if (typeof sessionId !== 'string' || !SESSION_PATTERN.test(sessionId)) throw new RoomError('bad-request');
        const room = rooms.get(id);
        if (!room) throw new RoomError('not-found');

        const existing = room.members.get(sessionId);
        if (!name && !existing) throw new RoomError('invalid-name');

        // Credentials are checked before the socket is placed in the room
        // channel, so an unauthorised client never receives a broadcast.
        if (room.hasPasscode) {
          const ip = clientIp(socket);
          const fails = failedJoins.get(ip) ?? new WindowCounter(60_000);
          if (fails.count() >= MAX_FAILED_JOINS_PER_MINUTE) throw new RoomError('too-many-attempts');
          const token = payload?.token;
          const tokenOk = room.checkToken(sessionId, token);
          const guessed = typeof payload?.passcode === 'string' && payload.passcode !== '';
          const passOk = !tokenOk && guessed && await verifyPasscode(payload.passcode, room.passHash);
          if (!tokenOk && !passOk) {
            if (!guessed) throw new RoomError('passcode-required');
            // Only real guesses count toward the brute-force limit.
            fails.add();
            failedJoins.set(ip, fails);
            throw new RoomError('wrong-passcode');
          }
          if (!rooms.has(id)) throw new RoomError('not-found'); // deleted while verifying
        }

        // The same session arriving on a new socket (a reconnect the server has
        // not noticed yet, or a second tab) takes over the seat.
        if (existing?.connected && existing.socketId !== socket.id) {
          const stale = io.sockets.sockets.get(existing.socketId);
          if (stale) {
            stale.emit('session:replaced');
            detachSocket(stale);
            stale.disconnect(true);
          }
        }

        reply(cb, await admit(socket, room, { sessionId, name, rev: payload?.rev }));
      } catch (err) {
        reply(cb, { ok: false, error: err.code || 'server-error' });
        if (!err.code) console.error('[room:join]', err);
      }
    });

    socket.on('room:resync', (_payload, cb) => {
      const { room, member } = currentMember(socket);
      if (!member) return reply(cb, { ok: false, error: 'not-in-room' });
      reply(cb, { ok: true, room: room.snapshot() });
    });

    socket.on('op', (payload, cb) => {
      const { room, member } = currentMember(socket);
      if (!member) return reply(cb, { ok: false, error: 'not-in-room' });
      if (room.locked && !room.isHost(member)) return reply(cb, { ok: false, error: 'locked' });
      if (!allowUpdate(socket)) {
        return reply(cb, { ok: false, error: 'throttled', retryAfter: socket.data.bucket.retryAfter() });
      }
      try {
        const result = room.applyOperation(member, payload ?? {});
        if (result.duplicate) return reply(cb, { ok: true, rev: result.rev, duplicate: true });
        socket.to(roomChannel(room)).emit('op', {
          op: result.op.toJSON(),
          opId: payload.opId,
          by: member.id,
          sel: result.sel,
          rev: result.rev,
        });
        reply(cb, { ok: true, rev: result.rev });
        markTyping(room, member);
        persist();
      } catch (err) {
        reply(cb, { ok: false, error: err.code || 'server-error' });
        if (!err.code) console.error('[op]', err);
      }
    });

    socket.on('cursor', (payload) => {
      const { room, member } = currentMember(socket);
      if (!member || !allowUpdate(socket)) return;
      member.sel = room.selectionAt(payload?.sel, payload?.rev);
      socket.to(roomChannel(room)).emit('cursor', { id: member.id, sel: member.sel, rev: room.rev });
    });

    socket.on('highlight:toggle', (payload, cb) => {
      const { room, member } = currentMember(socket);
      if (!member) return reply(cb, { ok: false, error: 'not-in-room' });
      if (!allowUpdate(socket)) return reply(cb, { ok: false, error: 'throttled' });
      if (room.locked && !room.isHost(member)) return reply(cb, { ok: false, error: 'locked' });
      const line = payload?.line;
      if (!Number.isInteger(line) || line < 0) return reply(cb, { ok: false, error: 'bad-request' });
      const result = room.toggleHighlight(member, line);
      if (!result) return reply(cb, { ok: false, error: 'bad-request' });
      io.to(roomChannel(room)).emit('highlights', { list: room.highlights, rev: room.rev });
      emitFeed(room, room.log('highlight', `${result.action === 'added' ? 'highlighted' : 'cleared highlight on'} L${result.line}`, member));
      reply(cb, { ok: true });
    });

    socket.on('highlight:clear', (_payload, cb) => {
      const { room, member } = currentMember(socket);
      if (!member) return reply(cb, { ok: false, error: 'not-in-room' });
      const before = room.highlights.length;
      // Anyone can clear their own highlights; the host can clear everyone's.
      room.highlights = room.isHost(member) ? [] : room.highlights.filter((h) => h.by !== member.id);
      if (room.highlights.length !== before) {
        io.to(roomChannel(room)).emit('highlights', { list: room.highlights, rev: room.rev });
        emitFeed(room, room.log('highlight', room.isHost(member) ? 'cleared all highlights' : 'cleared their highlights', member));
      }
      reply(cb, { ok: true });
    });

    socket.on('lang:set', (payload, cb) => {
      const { room, member } = currentMember(socket);
      if (!member) return reply(cb, { ok: false, error: 'not-in-room' });
      if (room.locked && !room.isHost(member)) return reply(cb, { ok: false, error: 'locked' });
      if (!allowUpdate(socket)) return reply(cb, { ok: false, error: 'throttled' });
      const lang = payload?.lang;
      if (!LANGUAGE_IDS.has(lang)) return reply(cb, { ok: false, error: 'bad-request' });
      if (room.lang !== lang) {
        room.lang = lang;
        io.to(roomChannel(room)).emit('lang', { lang });
        emitFeed(room, room.log('lang', `switched the mode to ${LANGUAGES.find((l) => l.id === lang).label}`, member));
      }
      reply(cb, { ok: true });
    });

    socket.on('status', (payload) => {
      const { room, member } = currentMember(socket);
      if (!member || !allowUpdate(socket)) return;
      const away = Boolean(payload?.away);
      if (member.away !== away) {
        member.away = away;
        emitMember(room, member);
      }
    });

    // ---- host-only controls -------------------------------------------------

    function requireHost(cb) {
      const ctx = currentMember(socket);
      if (!ctx.member) { reply(cb, { ok: false, error: 'not-in-room' }); return null; }
      if (!ctx.room.isHost(ctx.member)) { reply(cb, { ok: false, error: 'not-host' }); return null; }
      return ctx;
    }

    socket.on('host:transfer', (payload, cb) => {
      const ctx = requireHost(cb);
      if (!ctx) return;
      const target = [...ctx.room.members.values()].find((m) => m.id === payload?.to);
      if (!target || !target.connected || target === ctx.member) return reply(cb, { ok: false, error: 'bad-target' });
      setHost(ctx.room, target, `received host privileges from ${ctx.member.name}`);
      reply(cb, { ok: true });
    });

    socket.on('member:kick', (payload, cb) => {
      const ctx = requireHost(cb);
      if (!ctx) return;
      const target = [...ctx.room.members.values()].find((m) => m.id === payload?.id);
      if (!target || target === ctx.member) return reply(cb, { ok: false, error: 'bad-target' });
      ctx.room.tokens.delete(target.sessionId);
      const targetSocket = io.sockets.sockets.get(target.socketId);
      removeMember(ctx.room, target, { reason: 'kicked', text: `was removed by ${ctx.member.name}` });
      if (targetSocket) {
        targetSocket.emit('kicked', { reason: 'host', by: ctx.member.name });
        detachSocket(targetSocket);
      }
      reply(cb, { ok: true });
    });

    socket.on('room:lock', (payload, cb) => {
      const ctx = requireHost(cb);
      if (!ctx) return;
      ctx.room.locked = Boolean(payload?.locked);
      io.to(roomChannel(ctx.room)).emit('room:settings', { locked: ctx.room.locked, hasPasscode: ctx.room.hasPasscode });
      emitFeed(ctx.room, ctx.room.log('lock', ctx.room.locked ? 'locked editing (host only)' : 'unlocked editing for everyone', ctx.member));
      reply(cb, { ok: true });
    });

    socket.on('room:passcode', async (payload, cb) => {
      const ctx = requireHost(cb);
      if (!ctx) return;
      const passcode = payload?.passcode ?? null;
      if (passcode !== null && !validPasscode(passcode)) return reply(cb, { ok: false, error: 'invalid-passcode' });
      ctx.room.passHash = passcode ? await hashPasscode(passcode) : null;
      // Old rejoin tokens stop working, except for people currently in the room.
      for (const sessionId of [...ctx.room.tokens.keys()]) {
        if (!ctx.room.members.get(sessionId)?.connected) ctx.room.tokens.delete(sessionId);
      }
      io.to(roomChannel(ctx.room)).emit('room:settings', { locked: ctx.room.locked, hasPasscode: ctx.room.hasPasscode });
      emitFeed(ctx.room, ctx.room.log('passcode', passcode ? 'set a new passcode' : 'removed the passcode', ctx.member));
      reply(cb, { ok: true });
    });

    socket.on('room:delete', (_payload, cb) => {
      const ctx = requireHost(cb);
      if (!ctx) return;
      const { room } = ctx;
      io.to(roomChannel(room)).emit('room:deleted', { by: ctx.member.name });
      for (const m of room.members.values()) {
        const s = io.sockets.sockets.get(m.socketId);
        if (s) detachSocket(s);
        room.removeMember(m.sessionId);
      }
      rooms.delete(room.id);
      persist();
      reply(cb, { ok: true });
    });

    // ---- leaving ------------------------------------------------------------

    socket.on('room:leave', (_payload, cb) => {
      const { room, member } = currentMember(socket);
      detachSocket(socket);
      if (member) {
        room.tokens.delete(member.sessionId);
        removeMember(room, member, { reason: 'left', text: 'left the room' });
      }
      reply(cb, { ok: true });
    });

    socket.on('disconnect', (reason) => {
      const { room, member } = currentMember(socket);
      if (!member) return;
      // Abrupt drop: keep the seat for a while so a reconnect is seamless.
      member.connected = false;
      member.typing = false;
      clearTimeout(member.typingTimer);
      emitMember(room, member);
      emitFeed(room, room.log('disconnect', `connection lost (${reason}), holding seat for ${Math.round(config.reconnectGraceMs / 1000)}s`, member));

      if (room.isHost(member)) {
        member.hostTimer = setTimeout(() => {
          if (room.members.get(member.sessionId) === member && !member.connected && room.isHost(member)) {
            reassignHost(room, `host ${member.name} disconnected`);
          }
        }, Math.min(config.hostGraceMs, config.reconnectGraceMs));
      }
      member.graceTimer = setTimeout(() => {
        if (room.members.get(member.sessionId) === member && !member.connected) {
          removeMember(room, member, { reason: 'timeout', text: 'did not reconnect and was removed' });
        }
      }, config.reconnectGraceMs);
    });
  });
}
