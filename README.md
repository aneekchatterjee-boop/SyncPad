# SyncPad

A live collaborative workspace and code pad. People join **persistent rooms**, edit the same code or notes at the same time **without collisions**, and see each other's **cursors, selections, line highlights and typing status** in real time. A live **activity feed** keeps an audit trail of everything that happens in the room.

Built with Node.js, Express and Socket.IO. The frontend is plain ES modules with no build step and no framework. Text sync uses an operational-transformation (OT) engine written for this project (`shared/ot.js`), and the same module runs on the server and in the browser.

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [How it works](#how-it-works)
- [Socket protocol](#socket-protocol)
- [Disconnects and reconnects](#disconnects-and-reconnects)
- [Security notes](#security-notes)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Limitations](#limitations)

---

## Features

| Requirement | How SyncPad covers it |
| --- | --- |
| **Synchronized editor interface** | Split layout: a shared code/text editor (line numbers, syntax highlighting for 9 modes, auto-indent, per-user undo) beside a live participant list and a live activity audit feed. The side panel collapses (the window's `–` button), and the layout stacks on phones. |
| **Room management & security** | You pick the room ID (`quiet-otter-42`, `cs101-lab3`, …). An optional passcode is stored only as a salted **scrypt** hash. **The credentials are checked before the socket joins the room channel**, so a client that fails the check never receives any room traffic. Wrong guesses are rate limited per IP. After a successful join the server issues a rejoin token (stored hashed) so reconnects and page reloads skip the passcode prompt. |
| **Real-time broadcast protocol** | Character insertions and deletions travel as OT operations. Cursor positions and selections, plus **line highlights** (click a line number), sync to every peer. Each participant shows a **typing / active / away / reconnecting** badge, and remote carets show name flags with a typing indicator. |
| **Connection & spam throttling** | A per-connection token bucket allows **5 updates/second** (burst 5). Excess cursor and highlight updates are dropped. Excess edits are bounced back to the sender with `retryAfter`, so nothing is lost and nothing is broadcast early. Throttling shows up in the activity feed. A connection that keeps flooding is disconnected. The browser client batches keystrokes, so normal typing never hits the limit. You can demo it with **Room controls → Flood test**. |
| **Dynamic role reassignment** | The room creator is the host. If the host disconnects, host privileges move automatically to the **oldest active remaining member** (by join order). Host controls: host-only editing, set/remove passcode, transfer host, remove a participant, delete the room. Every privileged action is validated on the server. |
| **Graceful disconnects & smooth reconnects** | Keep typing while offline. On reconnect the client rejoins the same seat (same colour, same join order), the server replays the operations it missed, and its queued edits merge in. Lost acknowledgements are de-duplicated. See [Disconnects and reconnects](#disconnects-and-reconnects). |
| **Persistent rooms** | Rooms (document, mode, highlights, feed, passcode hash, settings) are saved to `data/rooms.json` with debounced atomic writes and survive restarts. |

---

## Quick start

**Requirements:** Node.js **20.12 or newer** (tested on Node 24) and npm.

```bash
git clone https://github.com/aneekchatterjee-boop/SyncPad.git
cd syncpad
npm install
npm start
```

Open <http://localhost:3000>. To see it working with several people:

1. Create a room in one browser window (optionally with a passcode).
2. Click **Invite** in the room header to copy the link.
3. Open the link in a **private/incognito window** or another browser. Each window needs its own browser storage to count as a separate person.
4. Type in both and watch carets, typing badges, highlights and the activity feed update.

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## Configuration

Configuration comes from environment variables. To use a file, copy `.env.example` to `.env`; it is loaded automatically at startup (`process.loadEnvFile`).

```bash
cp .env.example .env
```

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port. |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to keep it local. |
| `DATA_DIR` | `data` | Where `rooms.json` is stored. Relative paths resolve from the repo root. |
| `RECONNECT_GRACE_MS` | `8000` | How long a dropped connection keeps its seat (name, colour, join order) before it is removed. |
| `HOST_GRACE_MS` | `3000` | How long a disconnected host keeps admin rights before they pass to the oldest active member. It is long enough to survive a page refresh. Set it to `0` for immediate handover. |
| `CORS_ORIGIN` | unset | Only needed if the frontend is served from a different origin. |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy so the per-IP passcode limit uses `X-Forwarded-For`. |

Protocol limits (rate limit, document size, name length, …) are in `shared/protocol.js`. The client and server both read them from there.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the server. |
| `npm run dev` | Start with `node --watch` (restarts on changes). |
| `npm test` | Run the unit and integration tests (`node:test`, no extra framework). |

---

## How it works

```
 browser A                              server                               browser B
 ─────────                              ──────                               ─────────
 textarea ─input─▶ diff ─▶ op           ┌──────────────────────────┐
                           │            │  Room                    │
             SyncClient ◀──┘            │   doc, rev, history[]    │
   (1 op in flight + 1 buffer,          │   members, host          │
    ≤ 1 message / 200 ms)               │   highlights, feed       │
                │  emit('op',{rev,op})  │                          │
                └──────────────────────▶│ throttle (token bucket)  │
                                        │ transform op against     │
                                        │   history[rev..]         │
                                        │ apply, rev++             │──emit('op')──▶ SyncClient
                ◀──────── ack {rev} ────│ carry cursors/highlights │                transform vs
                                        │ persist (debounced)      │                own pending ops
                                        └──────────────────────────┘                    │
                                                                                 editor.applyRemote
```

**Operational transformation.** An edit is a list of `retain n` / `insert "text"` / `delete n` components (`shared/ot.js`). When two people edit concurrently, the server transforms the later operation against everything applied since that client's revision. The client transforms incoming operations against its own unacknowledged ones. Both sides end with the same text, so no keystroke is lost and nobody overwrites anyone. `test/ot.test.js` fuzzes this property thousands of times, and `test/server.test.js` runs three real socket clients editing at random until they converge.

**No UI freezing.** The editor is a transparent `<textarea>`, so native typing, IME, selection, copy/paste and accessibility all work. Highlighted code, line bands and remote carets render in layers behind and in front of it, batched to one repaint per animation frame. Network work never blocks typing: edits apply locally first and are sent asynchronously. Remote edits above your viewport keep the text you are reading in place.

**Undo** only undoes *your own* changes. Undo entries are rebased over everyone else's edits as they arrive.

**Presence.** Cursor and selection updates are coalesced with edits, so one message carries both. Typing status is derived on the server from incoming edits (it clears 1.5 s after the last one). Away status comes from the page's visibility.

**Line highlights** are stored as offsets of the line start and carried through every edit (sticky to the right). A highlighted line therefore follows its text when someone inserts lines above it.

**Activity feed.** The server writes the audit entries: create, join, leave, disconnect, reconnect, host changes, edits (grouped per person into one line per burst, e.g. `edited L4–9 (+32 −5 chars)`), highlights, mode changes, lock/passcode changes, removals and throttling.

---

## Socket protocol

All requests use Socket.IO acknowledgements and answer `{ ok: true, ... }` or `{ ok: false, error: '<code>' }`.

**Client → server**

| Event | Payload | Notes |
| --- | --- | --- |
| `room:check` | `{ roomId }` | → `{ exists, hasPasscode, online }` |
| `room:create` | `{ roomId, name, sessionId, passcode? }` | Creator becomes host. Same response as `room:join`. |
| `room:join` | `{ roomId, name, sessionId, passcode?, token?, rev? }` | → `{ me, token, room: snapshot, missed: ops since rev or null }` |
| `room:resync` | — | → full snapshot |
| `room:leave` | — | Leave immediately (no grace period). |
| `op` | `{ rev, op, opId, sel }` | Throttled. Ack `{ rev }`, or `{ error: 'throttled', retryAfter }`, `'locked'`, `'resync'`. |
| `cursor` | `{ rev, sel: { anchor, head } }` | Throttled; excess dropped. |
| `highlight:toggle` | `{ line }` | Throttled. |
| `highlight:clear` | — | Your own highlights, or all of them if you are host. |
| `lang:set` | `{ lang }` | Throttled. |
| `status` | `{ away }` | Throttled. |
| `host:transfer` | `{ to }` | Host only. |
| `member:kick` | `{ id }` | Host only. |
| `room:lock` | `{ locked }` | Host only: host-only editing. |
| `room:passcode` | `{ passcode \| null }` | Host only. Revokes the rejoin tokens of people not currently connected. |
| `room:delete` | — | Host only. |

**Server → client**

`op`, `cursor`, `highlights`, `member:joined`, `member:update`, `member:left`, `host:changed`, `feed`, `lang`, `room:settings`, `throttled`, `kicked`, `room:deleted`, `session:replaced`.

---

## Disconnects and reconnects

- **Abrupt drop (Wi-Fi off, laptop lid, tab killed):** the member is marked *reconnecting* and keeps their seat for `RECONNECT_GRACE_MS`. If they were host, the host role passes to the oldest active member after `HOST_GRACE_MS`.
- **While offline** the editor stays editable. Edits queue locally and the banner says so.
- **On reconnect** Socket.IO reconnects with backoff, and the client rejoins with its session ID, rejoin token and last known revision. The server returns the operations it missed. The client applies them, recognises its own operation if only the acknowledgement was lost, then re-sends its pending edit, which the server transforms and applies. Every operation carries an ID, so a re-sent duplicate is acknowledged but not applied twice.
- **Server restart:** rooms and rejoin tokens are on disk, so clients reconnect without a passcode prompt. If a client is too far behind for the server's in-memory history to replay, it reloads the document from the server and says so.
- **Same session in two places** (e.g. a duplicated tab): the new connection takes over the seat and the old tab offers to take it back. Duplicated tabs are also detected up front with a `BroadcastChannel` handshake and get their own session.
- **Shutdown:** `SIGINT`/`SIGTERM` flush the room store before exiting.

---

## Security notes

- Passcodes: scrypt with a random 16-byte salt, constant-time comparison; never stored or logged in plain text.
- Rejoin tokens: 144-bit random, stored as SHA-256 hashes, compared in constant time; revoked when a participant leaves, is removed, or the passcode changes.
- Admission happens only after credentials check out. Rejected sockets are never added to the room channel.
- Wrong-passcode attempts are limited to 8 per minute per IP.
- Every payload is validated (types, lengths, room ID pattern, operation structure, document size cap of 200,000 characters). Admin events check host status on the server.
- All user-provided text is rendered with `textContent` or escaped before it reaches the DOM.
- HTTP responses send a restrictive Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy`.
- No accounts: identity is a per-tab session ID plus a display name. Treat a passcode as a shared room secret, not as user authentication.

---

## Testing

```bash
npm test
```

- `test/ot.test.js`: apply/compose/invert/transform properties under randomized fuzzing, caret-aware diffing, index transformation.
- `test/server.test.js`: starts a real server on a random port with a temp data directory and drives it with real Socket.IO clients using the browser's `SyncClient`. It covers:
  - room ID validation and duplicates
  - the passcode gate (a rejected client receives no traffic)
  - three-peer concurrent editing convergence
  - host handover to the oldest active member
  - host-only editing
  - throttling (dropped, bounced, logged)
  - reconnect with seat retention and lost-ack de-duplication
  - grace-period removal
  - highlights following edits
  - persistence of rooms and rejoin tokens across a restart

---

## Project structure

```
server/
  index.js        entry point: env, listen, graceful shutdown
  app.js          Express + Socket.IO wiring, security headers, /api/stats
  sockets.js      all socket events: auth, sync, presence, host logic, throttling
  room.js         Room state: document, OT history, members, highlights, feed
  store.js        JSON persistence (debounced, atomic)
  passcode.js     scrypt hashing
  throttle.js     token bucket + sliding window counter
  config.js       environment variables
shared/           runs on both server and browser
  ot.js           TextOperation: apply, compose, invert, transform, diff
  sync-client.js  client-side OT state machine + send batching
  protocol.js     limits, languages, peer colours, room ID rules
public/
  index.html
  css/theme.css   window chrome, lobby, room, panels (all theme tokens)
  css/editor.css  editor layers + syntax colours
  js/main.js      shell + hash router + socket
  js/lobby.js     create / join / recent / docs
  js/room.js      room controller: sync, presence, feed, host controls
  js/editor.js    collaborative editor surface
  js/highlight.js small syntax highlighter
  js/halftone.js  the halftone eye banner
  js/session.js   session id, name, tokens, recent rooms
  js/ui.js        DOM helpers, icons, toasts, dialogs
test/
```

---

## Limitations

- **Single process.** Room state lives in one Node process, so scaling out would need a shared store (e.g. Redis) and sticky sessions or the Socket.IO Redis adapter.
- **Monospace layout.** Remote caret placement assumes a monospace grid, and very wide glyphs (some emoji, CJK) can offset carets on that line. Lines do not wrap; the editor scrolls horizontally.
- **Seats after a restart.** After a server restart, people reclaim their seats as they reconnect, and host goes to whoever returns first.

The visual theme is based on a "retro browser window" Carrd template reference (sage `#8aab8b`, panel `#344332`, cream halftone `#f1faa0`, CRT green `#1fe12c`, Space Mono). The halftone eye in the banner is drawn procedurally on a canvas.
