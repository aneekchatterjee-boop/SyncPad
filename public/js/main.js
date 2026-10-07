import { io } from '/socket.io/socket.io.esm.min.js';
import { isValidRoomId, normalizeRoomId } from '/shared/protocol.js';
import { mountLobby } from './lobby.js';
import { mountRoom } from './room.js';
import { ensureUniqueSession } from './session.js';
import { h, icon, toast } from './ui.js';

// ---- background: a dim, blurred wall of terminal text ------------------------

function paintBackdrop() {
  const words = ['ACCESS', 'GRANTED', 'SYNC', '0x7F', 'ACK', 'REV', 'OP', 'NULL', '>>', 'PEER', 'HOST', '404', '::', 'RETAIN', 'INSERT', 'DELETE', '{ }', 'SOCKET'];
  let text = '';
  for (let line = 0; line < 60; line++) {
    let row = '';
    while (row.length < 160) row += `${words[Math.floor(Math.random() * words.length)]} `;
    text += `${row}\n`;
  }
  document.body.prepend(h('pre', { class: 'backdrop-code', 'aria-hidden': 'true' }, text));
}

// ---- the browser-window shell shared by every view ---------------------------

function createShell(onUrlSubmit) {
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Views' });
  const dots = h('div', { class: 'win-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const titlebar = h('div', { class: 'titlebar' }, tabs, dots);

  const btn = (name, label) => h('button', { class: 'nav-btn', type: 'button', 'aria-label': label, title: label }, icon(name));
  const back = btn('back', 'Back');
  const forward = btn('forward', 'Forward');
  const reload = btn('reload', 'Reload');
  const url = h('input', { class: 'url-input', type: 'text', placeholder: 'type a room id here...', 'aria-label': 'Room address', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
  const go = h('button', { class: 'url-go', type: 'submit', 'aria-label': 'Go to room' }, icon('search'));
  const urlbar = h('form', { class: 'urlbar', role: 'search' }, url, go);
  urlbar.addEventListener('submit', (e) => {
    e.preventDefault();
    onUrlSubmit(url.value);
  });
  const minimize = h('button', { class: 'win-btn', type: 'button', 'aria-label': 'Minimize' }, icon('minus'));
  const close = h('button', { class: 'win-btn', type: 'button', 'aria-label': 'Close' }, icon('close'));
  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'nav-group' }, back, forward, reload), urlbar, h('div', { class: 'nav-group' }, minimize, close));

  const body = h('div', { class: 'window-body' });
  const footer = h('footer', { class: 'window-footer' });
  const root = h('main', { class: 'window' }, titlebar, toolbar, body, footer);
  document.body.append(root);

  const handlers = {};
  for (const [key, el] of Object.entries({ back, forward, reload, minimize, close })) {
    el.addEventListener('click', () => handlers[key]?.());
  }

  return {
    root,
    body,
    footer,
    setTabs(list) {
      tabs.replaceChildren(...list.map((t) => h('button', {
        class: `tab${t.active ? ' is-active' : ''}`,
        type: 'button',
        'aria-current': t.active ? 'page' : null,
        onclick: t.active ? null : t.onclick,
      }, t.label)));
    },
    setUrl(text) {
      url.value = text;
    },
    setNav(next) {
      for (const key of ['back', 'forward', 'reload', 'minimize', 'close']) {
        handlers[key] = next[key];
        const el = { back, forward, reload, minimize, close }[key];
        el.disabled = !next[key];
      }
      minimize.setAttribute('aria-label', next.minimizeLabel ?? 'Minimize');
      minimize.title = next.minimizeLabel ?? '';
      close.setAttribute('aria-label', next.closeLabel ?? 'Close');
      close.title = next.closeLabel ?? '';
    },
  };
}

// ---- app + router -------------------------------------------------------------

await ensureUniqueSession();
paintBackdrop();

const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionDelay: 500,
  reconnectionDelayMax: 4000,
  randomizationFactor: 0.3,
});

let current = null;
let pending = null;

const app = {
  socket,
  navigate(path, { initial } = {}) {
    pending = initial ?? null;
    const target = `#${path}`;
    if (location.hash === target) route();
    else location.hash = target;
  },
};

const shell = createShell((raw) => {
  const value = raw.trim().replace(/^syncpad:\/\/(room\/)?/i, '').replace(/^#/, '');
  if (!value || value === 'lobby') return app.navigate('/');
  const id = normalizeRoomId(value);
  if (!isValidRoomId(id)) return toast('Room IDs are 3–32 lowercase letters, digits, - or _.', { tone: 'error' });
  app.navigate(`/room/${id}`);
});

function route() {
  const path = location.hash.replace(/^#/, '') || '/';
  const initial = pending;
  pending = null;
  current?.unmount();
  current = null;
  window.scrollTo(0, 0);

  const roomMatch = path.match(/^\/room\/([^/?#]+)/);
  if (roomMatch) {
    const id = normalizeRoomId(decodeURIComponent(roomMatch[1]));
    if (isValidRoomId(id)) {
      document.title = `#${id} · SyncPad`;
      current = mountRoom(shell, app, id, initial);
      return;
    }
    toast('That room link is not valid.', { tone: 'error' });
  }
  const tab = path === '/rooms' ? 'rooms' : path === '/docs' ? 'docs' : 'home';
  document.title = 'SyncPad';
  current = mountLobby(shell, app, tab);
}

window.addEventListener('hashchange', route);
route();
