// Per-browser identity and conveniences. Storage can be unavailable (private
// windows, blocked site data), so every access is guarded and the app keeps
// working with in-memory values.

const memory = new Map();

function read(store, key) {
  try {
    return window[store].getItem(key);
  } catch {
    return memory.get(`${store}:${key}`) ?? null;
  }
}

function write(store, key, value) {
  memory.set(`${store}:${key}`, value);
  try {
    if (value == null) window[store].removeItem(key);
    else window[store].setItem(key, value);
  } catch {
    // ignore: the in-memory copy is enough for this page's lifetime
  }
}

function randomId(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const session = {
  // The session id survives reloads of this tab (sessionStorage), which is
  // what lets a refresh reclaim the same seat in a room.
  get id() {
    let id = read('sessionStorage', 'syncpad.session');
    if (!id) {
      id = randomId();
      write('sessionStorage', 'syncpad.session', id);
    }
    return id;
  },

  regenerate() {
    const id = randomId();
    write('sessionStorage', 'syncpad.session', id);
    for (const key of Object.keys(sessionStorageSafe())) {
      if (key.startsWith('syncpad.token.')) write('sessionStorage', key, null);
    }
    return id;
  },

  get name() {
    return read('localStorage', 'syncpad.name') ?? '';
  },
  set name(value) {
    write('localStorage', 'syncpad.name', value);
  },

  token(roomId) {
    return read('sessionStorage', `syncpad.token.${roomId}`);
  },
  setToken(roomId, token) {
    write('sessionStorage', `syncpad.token.${roomId}`, token);
  },

  recentRooms() {
    try {
      const list = JSON.parse(read('localStorage', 'syncpad.recent') ?? '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },
  rememberRoom(id, info = {}) {
    const list = this.recentRooms().filter((r) => r.id !== id);
    list.unshift({ id, at: Date.now(), ...info });
    write('localStorage', 'syncpad.recent', JSON.stringify(list.slice(0, 12)));
  },
  forgetRoom(id) {
    write('localStorage', 'syncpad.recent', JSON.stringify(this.recentRooms().filter((r) => r.id !== id)));
  },
};

function sessionStorageSafe() {
  try {
    return window.sessionStorage;
  } catch {
    return {};
  }
}

// A duplicated tab copies sessionStorage, so two tabs would share one seat.
// Ask the other tabs whether this id is taken and pick a new one if so.
export async function ensureUniqueSession() {
  if (typeof BroadcastChannel === 'undefined') return session.id;
  const channel = new BroadcastChannel('syncpad-session');
  const mine = session.id;
  let taken = false;
  channel.onmessage = (e) => {
    if (e.data?.type === 'mine' && e.data.id === mine) taken = true;
  };
  channel.postMessage({ type: 'who', id: mine });
  await new Promise((r) => setTimeout(r, 120));
  const id = taken ? session.regenerate() : mine;
  channel.onmessage = (e) => {
    if (e.data?.type === 'who' && e.data.id === session.id) channel.postMessage({ type: 'mine', id: session.id });
  };
  return id;
}
