// The room view: editor + participants + activity feed + room controls.
// Owns the SyncClient and translates socket events into editor updates.

import { TextOperation } from '/shared/ot.js';
import { LANGUAGES, LIMITS } from '/shared/protocol.js';
import { SyncClient } from '/shared/sync-client.js';
import { Editor } from './editor.js';
import { errorText, request } from './messages.js';
import { session } from './session.js';
import { confirmDialog, copyText, dialog, fill, formatTime, formDialog, h, icon, noticeDialog, toast } from './ui.js';

const FEED_GLYPH = {
  create: '*', join: '+', leave: '-', timeout: '-', kick: 'x', disconnect: '!', reconnect: '~',
  host: '★', edit: '>', highlight: '▌', lang: '#', throttle: '⚠', lock: '#', passcode: '#',
};

export function mountRoom(shell, app, roomId, initial = null) {
  const { socket } = app;
  const state = {
    me: null,
    members: new Map(),
    hostId: null,
    lang: 'plaintext',
    locked: false,
    hasPasscode: false,
    feed: [],
    joined: false,
    everJoined: false,
    blocked: false, // kicked / replaced / deleted: do not auto-rejoin
    resyncing: false,
    connected: socket.connected,
    sidebar: true,
  };
  let sync = null;
  let queued = []; // remote events held back while an IME composition is open
  let lastThrottleToast = 0;
  let unmounted = false;
  let joining = false;

  // ---- layout -------------------------------------------------------------

  const title = h('h1', { class: 'room-title' }, h('span', { class: 'hash' }, '#'), roomId);
  const badges = h('div', { class: 'badges' });
  const langSelect = h('select', { class: 'select', 'aria-label': 'Editor mode' },
    LANGUAGES.map((l) => h('option', { value: l.id }, l.label)));
  const inviteBtn = h('button', { class: 'btn btn-sage btn-sm', type: 'button', onclick: copyInvite }, icon('copy'), 'Invite');
  const head = h('div', { class: 'pad-head' }, h('div', { class: 'pad-title' }, title, badges), h('div', { class: 'pad-tools' }, langSelect, inviteBtn));

  const banner = h('div', { class: 'conn-banner', role: 'status', hidden: true });
  const editorMount = h('div', { class: 'editor-frame' });
  const padCol = h('section', { class: 'pad-col', 'aria-label': 'Editor' }, head, banner, editorMount);

  const memberCount = h('span', { class: 'count' }, '0');
  const memberList = h('ul', { class: 'members', 'aria-live': 'polite' });
  const feedList = h('ol', { class: 'feed', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const feedBox = h('div', { class: 'feed-box terminal' }, feedList);
  const controls = h('div', { class: 'controls' });

  const side = h('aside', { class: 'side', 'aria-label': 'Room details' },
    panel('Participants', memberCount, memberList, { open: true, cls: 'panel-members' }),
    panel('Activity', null, feedBox, { open: true, cls: 'panel-feed' }),
    panel('Room controls', null, controls, { open: false, cls: 'panel-controls' }));

  const grid = h('div', { class: 'room-grid' }, padCol, side);
  shell.body.replaceChildren(grid);
  shell.root.classList.add('is-room');

  const statusLeft = h('span', { class: 'status-left' });
  const statusRight = h('span', { class: 'status-right' });
  shell.footer.replaceChildren(statusLeft, statusRight);

  shell.setTabs([
    { label: 'Home', onclick: () => app.navigate('/') },
    { label: roomId, active: true },
  ]);
  shell.setUrl(`syncpad://room/${roomId}`);
  shell.setNav({
    back: () => app.navigate('/'),
    forward: null,
    reload: () => resync('manual'),
    minimize: () => {
      state.sidebar = !state.sidebar;
      grid.classList.toggle('side-hidden', !state.sidebar);
      editor.invalidate(true);
    },
    close: () => app.navigate('/'),
    minimizeLabel: 'Toggle side panel',
    closeLabel: 'Leave room',
  });

  const editor = new Editor(editorMount, {
    placeholder: '// start typing: everyone in this room sees it live.\n// click a line number to highlight that line for everyone.',
    onChange: (op) => {
      sync?.applyLocal(op);
      renderStatus();
    },
    onSelection: () => {
      sync?.cursorMoved();
      renderStatus();
    },
    onGutterClick: toggleHighlight,
    onCompositionEnd: drainQueue,
    onReject: (code) => toast(errorText(code), { tone: 'error' }),
  });

  langSelect.addEventListener('change', async () => {
    const res = await request(socket, 'lang:set', { lang: langSelect.value });
    if (!res.ok) {
      toast(errorText(res.error), { tone: 'error' });
      langSelect.value = state.lang;
    }
  });

  function panel(label, counter, content, { open, cls }) {
    const body = h('div', { class: 'panel-body' }, content);
    const toggle = h('button', { class: 'panel-head', type: 'button', 'aria-expanded': String(open) },
      h('span', null, label, counter ? [' [', counter, ']'] : null), icon('chevron', 'chev'));
    const el = h('section', { class: `panel ${cls}${open ? ' is-open' : ''}` }, toggle, body);
    toggle.addEventListener('click', () => {
      const isOpen = el.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });
    return el;
  }

  // ---- helpers ------------------------------------------------------------

  const isHost = () => state.me && state.hostId === state.me.id;
  const canEdit = () => !state.locked || isHost();
  const mapSel = (sel) => (sel && sync ? { anchor: sync.toLocalIndex(sel.anchor), head: sync.toLocalIndex(sel.head) } : null);
  const memberStatus = (m) => (!m.connected ? 'reconnecting' : m.typing ? 'typing' : m.away ? 'away' : 'active');

  function syncPeerToEditor(m) {
    if (!state.me || m.id === state.me.id) return;
    editor.setPeer(m.id, { name: m.name, color: m.color, connected: m.connected, typing: m.typing });
  }

  function applyHighlights(list) {
    editor.setHighlights(list.map((hl) => ({ ...hl, offset: sync ? sync.toLocalIndex(hl.offset, true) : hl.offset })));
  }

  function applyEditability() {
    editor.setReadOnly(!canEdit() || state.resyncing);
    langSelect.disabled = !canEdit();
  }

  // ---- joining ------------------------------------------------------------

  async function joinFlow() {
    let name = session.name;
    let passcode;
    let error = null;
    for (;;) {
      if (unmounted) return;
      if (!name) {
        const res = await formDialog({
          title: 'Who are you?',
          message: `Pick a display name for #${roomId}.`,
          fields: [{ name: 'name', label: 'Display name', value: '', maxlength: LIMITS.MAX_NAME_LENGTH, required: true, autocomplete: 'nickname' }],
          submitLabel: 'Join',
        });
        if (!res?.name?.trim()) return app.navigate('/');
        name = res.name.trim();
        session.name = name;
      }
      setConnState('joining');
      const res = await request(socket, 'room:join', {
        roomId, name, sessionId: session.id, token: session.token(roomId), passcode,
      });
      if (unmounted) return;
      if (res.ok) return applyJoin(res, false);

      error = res.error;
      if (error === 'passcode-required' || error === 'wrong-passcode') {
        const entered = await formDialog({
          title: `#${roomId} is protected`,
          message: 'The host set a passcode for this room.',
          error: error === 'wrong-passcode' ? errorText(error) : null,
          fields: [{ name: 'passcode', label: 'Passcode', type: 'password', required: true, autocomplete: 'off' }],
          submitLabel: 'Unlock',
        });
        if (!entered) return app.navigate('/');
        passcode = entered.passcode;
      } else if (error === 'invalid-name') {
        name = '';
      } else if (error === 'not-found') {
        const create = await confirmDialog({
          title: 'Room not found',
          message: `#${roomId} does not exist. Create it now? You will be its host.`,
          confirmLabel: 'Create room',
          cancelLabel: 'Back',
        });
        if (!create) return app.navigate('/');
        const created = await request(socket, 'room:create', { roomId, name, sessionId: session.id });
        if (created.ok) return applyJoin(created, false);
        await noticeDialog({ title: 'Could not create room', message: errorText(created.error) });
        return app.navigate('/');
      } else if (error === 'timeout' && !socket.connected) {
        return; // the connect handler retries once we are back online
      } else {
        await noticeDialog({ title: 'Could not join', message: errorText(error) });
        return app.navigate('/');
      }
    }
  }

  async function rejoin() {
    if (unmounted || state.blocked || !state.everJoined) return;
    setConnState('joining');
    const res = await request(socket, 'room:join', {
      roomId,
      name: state.me?.name ?? session.name,
      sessionId: session.id,
      token: session.token(roomId),
      rev: sync?.revision,
    });
    if (unmounted) return;
    if (res.ok) return applyJoin(res, true);
    if (res.error === 'not-found') return roomGone('This room was deleted while you were offline.');
    if (res.error === 'timeout') return; // still flaky; the next connect event tries again
    // Passcode changed while we were away, or we were removed: go through the full flow.
    state.everJoined = false;
    joinFlow();
  }

  function applyJoin(res, resume) {
    const snap = res.room;
    session.setToken(roomId, res.token);
    session.rememberRoom(roomId, { hasPasscode: snap.hasPasscode });
    state.me = res.me;

    if (resume && sync && Array.isArray(res.missed)) {
      sync.setConnected(true);
      sync.catchUp(res.missed, (op) => editor.applyRemote(op));
      if (res.missed.length) toast(`Back online. Caught up on ${res.missed.length} change${res.missed.length === 1 ? '' : 's'}.`);
      else toast('Back online.');
    } else {
      if (sync) {
        const lost = sync.reset(snap.rev);
        if (lost) toast('Reconnected, but your offline edits were too old to merge and were dropped.', { tone: 'error', timeout: 6000 });
      } else {
        sync = new SyncClient({
          revision: snap.rev,
          sessionId: session.id,
          sendOp: (payload, ack) => socket.emit('op', payload, ack),
          sendCursor: (payload) => socket.emit('cursor', payload),
          getSelection: () => editor.getSelection(),
        });
        sync.onThrottled = () => throttleToast();
        sync.onResyncNeeded = (code) => {
          if (code === 'locked') toast('Editing is locked by the host. Your last change was reverted.', { tone: 'error' });
          else if (code === 'too-large') toast(errorText(code), { tone: 'error' });
          resync(code);
        };
      }
      sync.setConnected(true);
      editor.setDoc(snap.doc);
    }

    state.joined = true;
    state.everJoined = true;
    state.hostId = snap.hostId;
    state.lang = snap.lang;
    state.locked = snap.locked;
    state.hasPasscode = snap.hasPasscode;
    state.members = new Map(snap.members.map((m) => [m.id, m]));

    for (const id of [...editor.peers.keys()]) if (!state.members.has(id)) editor.removePeer(id);
    for (const m of state.members.values()) {
      syncPeerToEditor(m);
      if (m.id !== state.me.id) editor.setPeer(m.id, { sel: mapSel(m.sel) });
    }
    applyHighlights(snap.highlights);
    editor.setLanguage(state.lang);
    langSelect.value = state.lang;

    const known = new Set(state.feed.map((f) => f.id));
    state.feed = resume ? state.feed.concat(snap.feed.filter((f) => !known.has(f.id))) : snap.feed.slice();
    state.feed.sort((a, b) => a.t - b.t);

    applyEditability();
    setConnState('online');
    renderAll();
    if (!resume) editor.focus();
    sync.cursorMoved();
  }

  async function resync(reason) {
    if (!state.joined || state.resyncing) return;
    state.resyncing = true;
    applyEditability();
    const res = await request(socket, 'room:resync', {});
    state.resyncing = false;
    if (unmounted) return;
    if (res.ok) {
      sync.reset(res.room.rev);
      editor.setDoc(res.room.doc);
      applyHighlights(res.room.highlights);
      for (const m of res.room.members) if (m.id !== state.me.id) editor.setPeer(m.id, { sel: mapSel(m.sel) });
      if (reason === 'manual') toast(`Reloaded #${roomId} from the server (rev ${res.room.rev}).`);
    }
    applyEditability();
    renderStatus();
  }

  // ---- socket events --------------------------------------------------------

  const docEvents = {
    op(msg) {
      const op = sync.applyRemote(TextOperation.fromJSON(msg.op));
      editor.applyRemote(op);
      if (msg.sel) editor.setPeer(msg.by, { sel: mapSel(msg.sel) });
      renderStatus();
    },
    cursor(msg) {
      editor.setPeer(msg.id, { sel: mapSel(msg.sel) });
    },
    highlights(msg) {
      applyHighlights(msg.list);
    },
  };

  function drainQueue() {
    const pending = queued;
    queued = [];
    for (const [event, msg] of pending) docEvents[event](msg);
  }

  const handlers = {
    op: (msg) => routeDocEvent('op', msg),
    cursor: (msg) => routeDocEvent('cursor', msg),
    highlights: (msg) => routeDocEvent('highlights', msg),
    'member:joined': (m) => {
      if (!state.joined) return;
      state.members.set(m.id, m);
      syncPeerToEditor(m);
      renderMembers();
    },
    'member:update': (m) => {
      if (!state.joined) return;
      const prev = state.members.get(m.id);
      state.members.set(m.id, { ...prev, ...m, sel: prev?.sel ?? m.sel });
      syncPeerToEditor(m);
      renderMembers();
    },
    'member:left': ({ id }) => {
      if (!state.joined) return;
      state.members.delete(id);
      editor.removePeer(id);
      renderMembers();
    },
    'host:changed': ({ hostId }) => {
      if (!state.joined) return;
      const wasHost = isHost();
      state.hostId = hostId;
      for (const m of state.members.values()) m.isHost = m.id === hostId;
      if (!wasHost && isHost()) toast('You are now the host of this room.');
      applyEditability();
      renderMembers();
      renderControls();
    },
    feed: (entry) => {
      if (!state.joined || state.feed.some((f) => f.id === entry.id)) return;
      state.feed.push(entry);
      if (state.feed.length > LIMITS.MAX_FEED_ENTRIES) state.feed.shift();
      appendFeed(entry);
    },
    lang: ({ lang }) => {
      state.lang = lang;
      langSelect.value = lang;
      editor.setLanguage(lang);
      renderStatus();
    },
    'room:settings': ({ locked, hasPasscode }) => {
      state.locked = locked;
      state.hasPasscode = hasPasscode;
      applyEditability();
      renderHead();
      renderControls();
    },
    throttled: () => throttleToast(),
    kicked: ({ reason, by }) => {
      block();
      noticeDialog({
        title: 'Removed from room',
        message: reason === 'flooding'
          ? 'Your connection kept sending updates far above the rate limit, so the server disconnected it.'
          : `${by ?? 'The host'} removed you from #${roomId}.`,
        actionLabel: 'Back to lobby',
        dismissible: false,
      }).then(() => app.navigate('/'));
    },
    'room:deleted': ({ by }) => {
      session.forgetRoom(roomId);
      roomGone(`${by ?? 'The host'} deleted #${roomId}.`);
    },
    'session:replaced': () => {
      block();
      dialog({
        title: 'Opened somewhere else',
        dismissible: false,
        body: (close) => [
          h('p', { class: 'dialog-text' }, 'This seat was taken over by another tab or window using the same session.'),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-sage', type: 'button', onclick: () => close('lobby') }, 'Back to lobby'),
            h('button', { class: 'btn btn-black', type: 'button', onclick: () => close('here') }, 'Use it here')),
        ],
      }).then((choice) => {
        if (choice !== 'here') return app.navigate('/');
        state.blocked = false;
        if (socket.connected) rejoin();
        else socket.connect();
      });
    },
    connect: () => {
      state.connected = true;
      if (state.everJoined && !state.blocked) rejoin();
      else if (!state.everJoined && !state.blocked && !joining) startJoin();
    },
    disconnect: (reason) => {
      state.connected = false;
      state.joined = false;
      sync?.setConnected(false);
      queued = [];
      for (const m of state.members.values()) m.typing = false;
      setConnState('offline');
      renderMembers();
      if (reason === 'io server disconnect' && !state.blocked) socket.connect();
    },
  };

  function routeDocEvent(event, msg) {
    if (!state.joined || !sync) return;
    if (editor.composing || queued.length) queued.push([event, msg]);
    else docEvents[event](msg);
  }

  for (const [event, fn] of Object.entries(handlers)) socket.on(event, fn);
  const onAttempt = (n) => setConnState('offline', n);
  socket.io.on('reconnect_attempt', onAttempt);

  const onVisibility = () => {
    if (state.joined) socket.emit('status', { away: document.hidden });
  };
  document.addEventListener('visibilitychange', onVisibility);

  function block() {
    state.blocked = true;
    state.joined = false;
    sync?.setConnected(false);
    editor.setReadOnly(true);
  }

  function roomGone(message) {
    block();
    noticeDialog({ title: 'Room closed', message, actionLabel: 'Back to lobby', dismissible: false }).then(() => app.navigate('/'));
  }

  function throttleToast() {
    const now = Date.now();
    if (now - lastThrottleToast < 3000) return;
    lastThrottleToast = now;
    toast(errorText('throttled'), { tone: 'warn' });
  }

  // ---- actions --------------------------------------------------------------

  async function toggleHighlight(line) {
    if (!state.joined) return;
    if (!canEdit()) return toast(errorText('locked'), { tone: 'error' });
    const res = await request(socket, 'highlight:toggle', { line });
    if (!res.ok) toast(errorText(res.error), { tone: 'error' });
  }

  async function copyInvite() {
    const link = `${location.origin}/#/room/${roomId}`;
    const ok = await copyText(link);
    toast(ok ? `Invite link copied${state.hasPasscode ? '. Share the passcode separately.' : '.'}` : link);
  }

  async function hostAction(event, payload, success) {
    const res = await request(socket, event, payload);
    if (!res.ok) toast(errorText(res.error), { tone: 'error' });
    else if (success) toast(success);
    return res.ok;
  }

  async function floodTest() {
    toast('Sending 30 cursor updates in one second…');
    for (let i = 0; i < 30; i++) {
      socket.emit('cursor', { rev: sync.revision, sel: editor.getSelection() });
      await new Promise((r) => setTimeout(r, 33));
    }
  }

  // ---- rendering ------------------------------------------------------------

  function setConnState(kind, attempt) {
    state.conn = kind;
    banner.hidden = kind === 'online';
    banner.className = `conn-banner is-${kind}`;
    if (kind === 'offline') {
      const queuedEdits = sync?.hasPendingChanges() ? ' Your edits are kept locally and will sync when you are back.' : ' You can keep typing; edits will sync when you are back.';
      banner.textContent = `Connection lost. Reconnecting${attempt ? ` (attempt ${attempt})` : ''}…${queuedEdits}`;
    } else if (kind === 'joining') {
      banner.textContent = `Connecting to #${roomId}…`;
    }
    renderStatus();
  }

  function renderAll() {
    renderHead();
    renderMembers();
    renderFeed();
    renderControls();
    renderStatus();
  }

  function renderHead() {
    fill(badges, 
      state.hasPasscode ? h('span', { class: 'badge', title: 'Joining requires a passcode' }, icon('lock'), 'passcode') : null,
      state.locked ? h('span', { class: 'badge badge-cream', title: 'Only the host can edit' }, 'host-only edits') : null,
      !canEdit() ? h('span', { class: 'badge badge-black' }, 'read-only') : null,
    );
  }

  function renderMembers() {
    const list = [...state.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    memberCount.textContent = String(list.filter((m) => m.connected).length);
    memberList.replaceChildren(...list.map((m) => {
      const me = state.me && m.id === state.me.id;
      const status = memberStatus(m);
      const actions = isHost() && !me ? h('div', { class: 'member-actions' },
        m.connected ? h('button', {
          class: 'btn btn-xs btn-sage', type: 'button', title: `Make ${m.name} the host`,
          onclick: () => hostAction('host:transfer', { to: m.id }, `${m.name} is now the host.`),
        }, icon('star'), 'host') : null,
        h('button', {
          class: 'btn btn-xs btn-black', type: 'button', title: `Remove ${m.name} from the room`,
          onclick: async () => {
            if (await confirmDialog({ title: 'Remove participant', message: `Remove ${m.name} from #${roomId}? They can rejoin unless you also change the passcode.`, confirmLabel: 'Remove' })) {
              hostAction('member:kick', { id: m.id }, `${m.name} was removed.`);
            }
          },
        }, 'kick')) : null;
      return h('li', { class: `member is-${status}` },
        h('span', { class: 'swatch', style: { background: m.color } }),
        h('div', { class: 'member-main' },
          h('div', { class: 'member-name' },
            h('span', { class: 'name' }, m.name),
            me ? h('span', { class: 'you' }, '(you)') : null,
            m.id === state.hostId ? h('span', { class: 'host-badge', title: 'Room host' }, icon('star'), 'host') : null),
          h('span', { class: `status status-${status}` },
            status === 'typing' ? ['typing', h('b', { class: 'dots' }, h('i'), h('i'), h('i'))] : status)),
        actions);
    }));
  }

  function feedItem(entry) {
    return h('li', { class: `feed-item feed-${entry.type}` },
      h('time', { datetime: new Date(entry.t).toISOString() }, formatTime(entry.t)),
      h('span', { class: 'glyph', 'aria-hidden': 'true' }, FEED_GLYPH[entry.type] ?? '>'),
      h('span', { class: 'feed-text' },
        entry.by ? [h('b', { style: { color: entry.by.color } }, entry.by.name), ' '] : null,
        entry.text));
  }

  function renderFeed() {
    feedList.replaceChildren(...state.feed.map(feedItem));
    feedBox.scrollTop = feedBox.scrollHeight;
  }

  function appendFeed(entry) {
    const stick = feedBox.scrollHeight - feedBox.scrollTop - feedBox.clientHeight < 40;
    feedList.append(feedItem(entry));
    while (feedList.children.length > LIMITS.MAX_FEED_ENTRIES) feedList.firstChild.remove();
    if (stick) feedBox.scrollTop = feedBox.scrollHeight;
  }

  function renderControls() {
    const everyone = h('div', { class: 'ctl-group' },
      h('div', { class: 'ctl-label' }, 'Everyone'),
      h('div', { class: 'btn-grid' },
        h('button', { class: 'btn btn-sage btn-sm', type: 'button', onclick: copyInvite }, icon('copy'), 'Copy invite'),
        h('button', { class: 'btn btn-sage btn-sm', type: 'button', onclick: () => hostAction('highlight:clear', {}, null) }, icon('pin'), isHost() ? 'Clear all marks' : 'Clear my marks'),
        h('button', { class: 'btn btn-sage btn-sm', type: 'button', onclick: () => resync('manual') }, icon('reload'), 'Reload doc'),
        h('button', { class: 'btn btn-black btn-sm', type: 'button', onclick: floodTest, title: 'Fires 30 updates in one second to show the server-side rate limit' }, icon('bolt'), 'Flood test')),
      h('p', { class: 'hint' }, `Flood test sends 30 updates in a second. The server lets ${LIMITS.UPDATES_PER_SECOND}/s through and drops the rest; watch the activity feed.`));

    if (!isHost()) {
      const host = state.members.get(state.hostId);
      fill(controls, everyone, h('div', { class: 'ctl-group' },
        h('div', { class: 'ctl-label' }, 'Host'),
        h('p', { class: 'hint' }, host ? `${host.name} is the host. ` : 'No host right now. ',
          'Lock, passcode and kick controls show up here for the host. If the host disconnects, the oldest active member takes over.')));
      return;
    }

    const passInput = h('input', { class: 'input', type: 'password', placeholder: state.hasPasscode ? 'new passcode' : 'set a passcode', minlength: LIMITS.MIN_PASSCODE_LENGTH, maxlength: LIMITS.MAX_PASSCODE_LENGTH, autocomplete: 'new-password', 'aria-label': 'Room passcode' });
    const passForm = h('form', {
      class: 'inline-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (await hostAction('room:passcode', { passcode: passInput.value }, 'Passcode updated. Share it with your team.')) passInput.value = '';
      },
    }, passInput, h('button', { class: 'btn btn-black btn-sm', type: 'submit' }, 'Set'));

    fill(controls, everyone, h('div', { class: 'ctl-group' },
      h('div', { class: 'ctl-label' }, 'Host controls'),
      h('label', { class: 'switch' },
        h('input', {
          type: 'checkbox', checked: state.locked,
          onchange: (e) => hostAction('room:lock', { locked: e.target.checked }, e.target.checked ? 'Only you can edit now.' : 'Everyone can edit again.'),
        }),
        h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        h('span', null, 'Host-only editing')),
      passForm,
      state.hasPasscode ? h('button', { class: 'btn btn-sage btn-sm', type: 'button', onclick: () => hostAction('room:passcode', { passcode: null }, 'Passcode removed. Anyone with the link can join.') }, 'Remove passcode') : null,
      h('button', {
        class: 'btn btn-danger btn-sm', type: 'button',
        onclick: async () => {
          if (await confirmDialog({ title: 'Delete room', message: `Delete #${roomId} and its document for everyone? This cannot be undone.`, confirmLabel: 'Delete room' })) {
            hostAction('room:delete', {}, null);
          }
        },
      }, 'Delete room')));
  }

  function renderStatus() {
    const { line, col } = editor.cursorPosition();
    const online = [...state.members.values()].filter((m) => m.connected).length;
    const typing = [...state.members.values()].filter((m) => m.typing && m.id !== state.me?.id).map((m) => m.name);
    const conn = state.conn === 'online' ? 'online' : state.conn === 'joining' ? 'connecting' : 'offline';
    const syncState = !sync ? '' : !sync.hasPendingChanges() ? 'saved' : state.conn === 'online' ? 'syncing…' : 'unsynced edits';
    fill(statusLeft, 
      h('span', { class: `led led-${conn}`, 'aria-hidden': 'true' }), conn,
      ' · ', `rev ${sync?.revision ?? 0}`,
      ' · ', `Ln ${line}, Col ${col}`,
      ' · ', LANGUAGES.find((l) => l.id === state.lang)?.label ?? state.lang,
      syncState ? [' · ', syncState] : null);
    fill(statusRight, 
      typing.length ? `${typing.slice(0, 2).join(', ')}${typing.length > 2 ? ` +${typing.length - 2}` : ''} typing · ` : '',
      `${online} here`);
  }

  // Status refresh for "syncing…" → "saved" transitions without new events.
  const statusTimer = setInterval(() => { if (state.joined) renderStatus(); }, 500);

  async function startJoin() {
    joining = true;
    try {
      await joinFlow();
    } finally {
      joining = false;
    }
  }

  if (initial) applyJoin(initial, false);
  else if (socket.connected) startJoin();
  else setConnState('offline');

  return {
    unmount() {
      unmounted = true;
      clearInterval(statusTimer);
      for (const [event, fn] of Object.entries(handlers)) socket.off(event, fn);
      socket.io.off('reconnect_attempt', onAttempt);
      document.removeEventListener('visibilitychange', onVisibility);
      if (state.joined) socket.emit('room:leave', {});
      sync?.setConnected(false);
      editor.destroy();
      shell.root.classList.remove('is-room');
    },
  };
}
