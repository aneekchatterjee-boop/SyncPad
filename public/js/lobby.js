// Lobby: create or join a room, recent rooms, and a short "how it works".

import { LIMITS, isValidRoomId, normalizeRoomId } from '/shared/protocol.js';
import { mountHalftone } from './halftone.js';
import { errorText, request } from './messages.js';
import { session } from './session.js';
import { fill, h, icon } from './ui.js';

const ADJECTIVES = ['quiet', 'neon', 'rusty', 'brave', 'lucky', 'mossy', 'swift', 'lunar', 'sunny', 'tidy', 'fuzzy', 'polar'];
const NOUNS = ['otter', 'falcon', 'lynx', 'cactus', 'comet', 'kernel', 'pixel', 'socket', 'badger', 'walrus', 'gecko', 'quokka'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randomRoomId = () => `${pick(ADJECTIVES)}-${pick(NOUNS)}-${10 + Math.floor(Math.random() * 90)}`;

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function formatUptime(sec) {
  const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function mountLobby(shell, app, tab = 'home') {
  const { socket } = app;
  const cleanups = [];

  shell.setTabs([
    { label: 'Home', active: tab === 'home', onclick: () => app.navigate('/') },
    { label: 'Rooms', active: tab === 'rooms', onclick: () => app.navigate('/rooms') },
    { label: 'Docs', active: tab === 'docs', onclick: () => app.navigate('/docs') },
  ]);
  shell.setUrl('');
  shell.setNav({
    back: () => history.back(),
    forward: () => history.forward(),
    reload: () => location.reload(),
    minimize: null,
    close: null,
  });

  const footerLeft = h('span', null, 'by syncpad · real-time rooms');
  const footerRight = h('span', { class: 'status-right' });
  shell.footer.replaceChildren(footerLeft, footerRight);
  const renderSocket = () => {
    fill(footerRight, h('span', { class: `led led-${socket.connected ? 'online' : 'offline'}` }), socket.connected ? 'socket connected' : 'socket offline');
  };
  renderSocket();
  socket.on('connect', renderSocket);
  socket.on('disconnect', renderSocket);
  cleanups.push(() => { socket.off('connect', renderSocket); socket.off('disconnect', renderSocket); });

  const canvas = h('canvas', { class: 'halftone', 'aria-hidden': 'true' });
  const banner = h('div', { class: 'banner' }, canvas);
  cleanups.push(mountHalftone(canvas));

  let content;
  if (tab === 'rooms') content = roomsView(app);
  else if (tab === 'docs') content = docsView();
  else content = homeView(app, cleanups);

  shell.body.replaceChildren(banner, content);

  return {
    unmount() {
      for (const fn of cleanups) fn();
    },
  };
}

// ---- home ---------------------------------------------------------------------

function homeView(app, cleanups) {
  const { socket } = app;

  // Stats terminal (the "CRT" panel).
  const crt = h('pre', { class: 'crt-text', 'aria-live': 'off' });
  const crtBox = h('div', { class: 'crt terminal', role: 'img', 'aria-label': 'Live server statistics' }, crt);
  let stats = null;
  const renderCrt = () => {
    const row = (label, value) => `> ${label.padEnd(15, '.')} ${value}\n`;
    crt.textContent = '> SYNCPAD v1.0 // OT ENGINE\n'
      + row('socket', socket.connected ? 'ONLINE' : 'OFFLINE')
      + row('rooms stored', stats ? stats.rooms : '--')
      + row('rooms live', stats ? stats.activeRooms : '--')
      + row('peers online', stats ? stats.online : '--')
      + row('rate limit', `${LIMITS.UPDATES_PER_SECOND} upd/s`)
      + row('uptime', stats ? formatUptime(stats.uptime) : '--:--:--')
      + '> _';
  };
  const loadStats = async () => {
    try {
      const res = await fetch('/api/stats', { cache: 'no-store' });
      if (res.ok) stats = await res.json();
    } catch {
      stats = null;
    }
    renderCrt();
  };
  renderCrt();
  loadStats();
  socket.on('connect', loadStats);
  socket.on('disconnect', renderCrt);
  cleanups.push(() => { socket.off('connect', loadStats); socket.off('disconnect', renderCrt); });
  const statsTimer = setInterval(loadStats, 4000);
  cleanups.push(() => clearInterval(statsTimer));

  // Forms.
  const createPanel = formPanel('Create a room', true);
  const joinPanel = formPanel('Join a room', false);

  const nameValue = session.name;
  const mkName = () => h('input', { class: 'input', name: 'name', value: nameValue, placeholder: 'your display name', maxlength: LIMITS.MAX_NAME_LENGTH, required: true, autocomplete: 'nickname', spellcheck: 'false' });

  // -- create
  const cId = h('input', { class: 'input', name: 'room', value: randomRoomId(), maxlength: 32, required: true, spellcheck: 'false', autocapitalize: 'off', pattern: '[a-z0-9][a-z0-9_\\-]{2,31}', title: 'lowercase letters, digits, - and _' });
  const cName = mkName();
  const cPass = h('input', { class: 'input', name: 'passcode', type: 'password', placeholder: 'optional', minlength: LIMITS.MIN_PASSCODE_LENGTH, maxlength: LIMITS.MAX_PASSCODE_LENGTH, autocomplete: 'new-password' });
  const cError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const cSubmit = h('button', { class: 'btn btn-black', type: 'submit' }, icon('plus'), 'Create');
  cId.addEventListener('input', () => { cId.value = cId.value.toLowerCase().replace(/\s+/g, '-'); });
  const createForm = h('form', { class: 'stack', novalidate: true },
    field('Room ID', cId), field('Display name', cName), field('Passcode', cPass),
    cError,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-sage', type: 'button', onclick: () => { cId.value = randomRoomId(); cId.focus(); } }, icon('dice'), 'Random ID'),
      cSubmit));
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const roomId = normalizeRoomId(cId.value);
    const name = cName.value.trim();
    const passcode = cPass.value;
    const problem = !isValidRoomId(roomId) ? 'invalid-room-id' : !name ? 'invalid-name'
      : passcode && passcode.length < LIMITS.MIN_PASSCODE_LENGTH ? 'invalid-passcode' : null;
    if (problem) return showError(cError, errorText(problem));
    session.name = name;
    cSubmit.disabled = true;
    const res = await request(socket, 'room:create', { roomId, name, passcode: passcode || null, sessionId: session.id });
    cSubmit.disabled = false;
    if (!res.ok) return showError(cError, errorText(res.error));
    app.navigate(`/room/${roomId}`, { initial: res });
  });
  createPanel.body.append(h('p', { class: 'panel-text' }, 'Pick an ID people can type. You become the host: you can lock editing, set or change the passcode, and remove people.'), createForm);

  // -- join
  const jId = h('input', { class: 'input', name: 'room', placeholder: 'room id, e.g. quiet-otter-42', maxlength: 32, required: true, spellcheck: 'false', autocapitalize: 'off' });
  const jName = mkName();
  const jPass = h('input', { class: 'input', name: 'passcode', type: 'password', placeholder: 'if the room has one', maxlength: LIMITS.MAX_PASSCODE_LENGTH, autocomplete: 'off' });
  const jInfo = h('p', { class: 'room-info', 'aria-live': 'polite' });
  const jError = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const jSubmit = h('button', { class: 'btn btn-black', type: 'submit' }, icon('arrow'), 'Join');
  const passField = field('Passcode', jPass);

  let checkTimer = 0;
  let checkSeq = 0;
  const checkRoom = async () => {
    const roomId = normalizeRoomId(jId.value);
    const seq = ++checkSeq;
    if (!roomId) { jInfo.textContent = ''; return; }
    if (!isValidRoomId(roomId)) { jInfo.textContent = 'not a valid room id'; return; }
    const res = await request(socket, 'room:check', { roomId }, 4000);
    if (seq !== checkSeq) return;
    if (!res.ok) { jInfo.textContent = ''; return; }
    if (!res.exists) {
      fill(jInfo, h('span', { class: 'led led-offline' }), `#${roomId} does not exist yet. Joining will offer to create it.`);
    } else {
      fill(jInfo, h('span', { class: 'led led-online' }), `#${roomId} · ${res.online} online`, res.hasPasscode ? [' · ', icon('lock'), 'passcode required'] : ' · open room');
      if (res.hasPasscode) jPass.focus();
    }
    passField.classList.toggle('is-required', Boolean(res.hasPasscode));
  };
  jId.addEventListener('input', () => {
    jId.value = jId.value.toLowerCase().replace(/\s+/g, '-');
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkRoom, 350);
  });
  cleanups.push(() => clearTimeout(checkTimer));

  const joinForm = h('form', { class: 'stack', novalidate: true },
    field('Room ID', jId), jInfo, field('Display name', jName), passField,
    jError,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-sage', type: 'button', onclick: checkRoom }, icon('search'), 'Check'),
      jSubmit));
  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const roomId = normalizeRoomId(jId.value);
    const name = jName.value.trim();
    if (!isValidRoomId(roomId)) return showError(jError, errorText('invalid-room-id'));
    if (!name) return showError(jError, errorText('invalid-name'));
    session.name = name;
    jSubmit.disabled = true;
    const res = await request(socket, 'room:join', { roomId, name, sessionId: session.id, token: session.token(roomId), passcode: jPass.value || undefined });
    jSubmit.disabled = false;
    if (res.ok) return app.navigate(`/room/${roomId}`, { initial: res });
    if (res.error === 'not-found') return app.navigate(`/room/${roomId}`); // the room view offers to create it
    showError(jError, errorText(res.error));
    if (res.error === 'passcode-required' || res.error === 'wrong-passcode') jPass.focus();
  });
  joinPanel.body.append(joinForm);

  const openPanel = (target, focusEl) => {
    for (const p of [createPanel, joinPanel]) p.setOpen(p === target);
    focusEl.focus();
  };

  // Intro + quick links (the reference's title / blurb / four buttons).
  const intro = h('div', { class: 'intro' },
    h('h1', { class: 'display' }, 'SyncPad'),
    h('p', { class: 'blurb' }, 'A shared code pad for study groups and hack teams. Rooms persist, everyone types at once without stepping on each other, and you can see who is here, where their cursor is, and who is typing.'),
    h('div', { class: 'link-grid' },
      h('button', { class: 'btn btn-sage', type: 'button', onclick: () => openPanel(createPanel, cId) }, 'new room'),
      h('button', { class: 'btn btn-sage', type: 'button', onclick: () => openPanel(joinPanel, jId) }, 'join room'),
      h('button', { class: 'btn btn-sage', type: 'button', onclick: () => app.navigate('/rooms') }, 'recent'),
      h('button', { class: 'btn btn-sage', type: 'button', onclick: () => app.navigate('/docs') }, 'how it works')));

  const protocol = h('div', { class: 'terminal protocol' },
    h('div', { class: 'protocol-head' }, 'ERROR 409: collision not found'),
    h('ul', { class: 'protocol-list' },
      ['every keystroke becomes an operation, not a whole-file save',
        'concurrent operations are transformed, so nobody overwrites anyone',
        'cursors, selections and line highlights sync to every peer',
        'over 5 updates/s from one connection gets throttled at the server',
        'host leaves? the oldest active member takes over'].map((t) => h('li', null, t))));

  return h('div', { class: 'lobby' },
    h('div', { class: 'lobby-row row-a' }, intro, crtBox),
    h('div', { class: 'lobby-row row-b' }, protocol, h('div', { class: 'panel-stack' }, createPanel.el, joinPanel.el)));
}

function field(label, input) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function formPanel(label, open) {
  const body = h('div', { class: 'panel-body' });
  const toggle = h('button', { class: 'panel-head', type: 'button', 'aria-expanded': String(open) }, h('span', null, label), icon('chevron', 'chev'));
  const el = h('section', { class: `panel${open ? ' is-open' : ''}` }, toggle, body);
  const setOpen = (value) => {
    el.classList.toggle('is-open', value);
    toggle.setAttribute('aria-expanded', String(value));
  };
  toggle.addEventListener('click', () => setOpen(!el.classList.contains('is-open')));
  return { el, body, setOpen };
}

// ---- recent rooms ---------------------------------------------------------------

function roomsView(app) {
  const list = h('ul', { class: 'recent' });
  const render = () => {
    const rooms = session.recentRooms();
    if (!rooms.length) {
      list.replaceChildren(h('li', { class: 'empty' }, 'No rooms yet. Rooms you create or join in this browser show up here.'));
      return;
    }
    list.replaceChildren(...rooms.map((r) => h('li', { class: 'recent-item' },
      h('div', { class: 'recent-main' },
        h('span', { class: 'recent-id' }, `#${r.id}`),
        h('span', { class: 'recent-meta' }, r.hasPasscode ? [icon('lock'), 'passcode · '] : null, `visited ${timeAgo(r.at)}`)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sage btn-sm', type: 'button', onclick: () => { session.forgetRoom(r.id); render(); } }, 'forget'),
        h('button', { class: 'btn btn-black btn-sm', type: 'button', onclick: () => app.navigate(`/room/${r.id}`) }, icon('arrow'), 'open')))));
  };
  render();
  return h('div', { class: 'lobby lobby-page' },
    h('h1', { class: 'display display-sm' }, 'Recent rooms'),
    h('p', { class: 'blurb' }, 'Stored only in this browser. Rooms themselves live on the server until their host deletes them.'),
    list);
}

// ---- docs -----------------------------------------------------------------------

function docsView() {
  const section = (title, ...items) => h('section', { class: 'doc-section' },
    h('h2', { class: 'doc-title' }, title),
    h('ul', { class: 'protocol-list' }, items.map((t) => h('li', null, t))));
  const keys = [
    ['Tab / Shift+Tab', 'indent / outdent the line or selection'],
    ['Enter', 'new line, keeping the indentation'],
    ['Ctrl/Cmd+Z', 'undo your own changes only'],
    ['Ctrl/Cmd+Shift+Z or Ctrl+Y', 'redo'],
    ['Esc, then Tab', 'move focus out of the editor'],
    ['Click a line number', 'highlight that line for everyone; click again to clear'],
  ];
  return h('div', { class: 'lobby lobby-page docs' },
    h('h1', { class: 'display display-sm' }, 'How it works'),
    h('div', { class: 'docs-grid' },
      h('div', { class: 'terminal' },
        section('Sync without collisions',
          'Edits travel as small operations (retain / insert / delete), never as whole documents.',
          'The server orders operations and transforms late ones against what already happened, so concurrent edits all land.',
          'Each browser keeps at most one edit in flight and batches the rest, so the UI never waits on the network.'),
        section('Presence',
          'Each participant gets a colour, a live caret and selection, and a typing / active / away / reconnecting badge.',
          'Line highlights are pinned to text, not line numbers: they move when someone inserts lines above.',
          'The activity feed is an audit log: joins, leaves, edits (grouped), highlights, host changes and throttling.')),
      h('div', { class: 'terminal' },
        section('Rooms & security',
          'Room IDs are chosen by you. A passcode is optional and stored only as a salted scrypt hash.',
          'The passcode is checked before the socket joins the room, so a client that fails never sees any traffic.',
          'Repeated wrong passcodes from one network are rate limited.'),
        section('Resilience',
          `Each connection may send ${LIMITS.UPDATES_PER_SECOND} updates/s; the excess is dropped or bounced back, never broadcast.`,
          'Drop off the network and you keep typing. On reconnect, missed changes replay and your edits merge in.',
          'The host role passes to the oldest active member if the host disconnects.'))),
    h('h2', { class: 'doc-title' }, 'Keyboard'),
    h('dl', { class: 'keys' }, keys.map(([k, v]) => [h('dt', null, h('kbd', null, k)), h('dd', null, v)])));
}
