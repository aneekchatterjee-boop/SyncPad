// Small DOM helpers, icons, toasts and in-window dialogs.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'html') el.innerHTML = value; // only ever used with trusted, static markup
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const svg = (body, { size = 20, stroke = 2.6, fill = 'none' } = {}) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill}" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  back: svg('<path d="M15 5l-7 7 7 7"/>', { stroke: 3 }),
  forward: svg('<path d="M9 5l7 7-7 7"/>', { stroke: 3 }),
  reload: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', { stroke: 2.8 }),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>', { size: 18, stroke: 2.2 }),
  minus: svg('<path d="M5 12h14"/>', { size: 18, stroke: 3 }),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', { size: 18, stroke: 3 }),
  chevron: svg('<path d="M5 9l7 7 7-7"/>', { stroke: 3 }),
  plus: svg('<path d="M12 5v14M5 12h14"/>', { size: 18, stroke: 3 }),
  user: svg('<circle cx="12" cy="7.5" r="4.5"/><path d="M3.5 21c0-4.7 3.8-8 8.5-8s8.5 3.3 8.5 8z"/>', { size: 18, stroke: 0, fill: 'currentColor' }),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>', { size: 18, stroke: 2.8 }),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', { size: 16, stroke: 2.4 }),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>', { size: 16, stroke: 2.2 }),
  dice: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>', { size: 18, stroke: 2.2 }),
  star: svg('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>', { size: 14, stroke: 0, fill: 'currentColor' }),
  bolt: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', { size: 16, stroke: 0, fill: 'currentColor' }),
  door: svg('<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/>', { size: 16, stroke: 2.4 }),
  pin: svg('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/>', { size: 16, stroke: 2.2 }),
};

// replaceChildren that accepts nested arrays and skips null/false.
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export function icon(name, extraClass = '') {
  return h('span', { class: `icon ${extraClass}`.trim(), html: icons[name] });
}

// ---- toasts ---------------------------------------------------------------

let toastHost = null;
export function toast(message, { tone = 'info', timeout = 3500 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast-${tone}` }, h('span', { class: 'toast-prompt' }, tone === 'error' ? 'ERR' : '>'), ' ', message);
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

// ---- dialogs --------------------------------------------------------------

// A small window-styled dialog. `body` builds the content and receives
// `close(value)`; the returned promise resolves with that value.
export function dialog({ title, body, dismissible = true }) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(null); }
    };
    const win = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog-bar' },
        h('span', { class: 'dialog-title' }, title),
        h('span', { class: 'win-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
      h('div', { class: 'dialog-body' }, body(close)));
    const backdrop = h('div', { class: 'dialog-backdrop', onmousedown: (e) => { if (e.target === backdrop && dismissible) close(null); } }, win);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => (win.querySelector('input, button.btn-black, button') ?? win).focus());
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  return dialog({
    title,
    body: (close) => [
      h('p', { class: 'dialog-text' }, message),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sage', type: 'button', onclick: () => close(false) }, cancelLabel),
        h('button', { class: 'btn btn-black', type: 'button', onclick: () => close(true) }, confirmLabel)),
    ],
  });
}

export function noticeDialog({ title, message, actionLabel = 'OK', dismissible = true }) {
  return dialog({
    title,
    dismissible,
    body: (close) => [
      h('p', { class: 'dialog-text' }, message),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-black', type: 'button', onclick: () => close(true) }, actionLabel)),
    ],
  });
}

// Prompt for one or more fields. Returns an object of values, or null.
export function formDialog({ title, message, fields, submitLabel = 'Continue', error = null }) {
  return dialog({
    title,
    body: (close) => {
      const inputs = {};
      const form = h('form', {
        class: 'stack',
        onsubmit: (e) => {
          e.preventDefault();
          close(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])));
        },
      },
      message && h('p', { class: 'dialog-text' }, message),
      error && h('p', { class: 'form-error', role: 'alert' }, error),
      fields.map((f) => {
        inputs[f.name] = h('input', {
          class: 'input', name: f.name, type: f.type ?? 'text', value: f.value ?? '', placeholder: f.placeholder ?? '',
          autocomplete: f.autocomplete ?? 'off', maxlength: f.maxlength, minlength: f.minlength, required: f.required, spellcheck: 'false',
        });
        return h('label', { class: 'field' }, h('span', { class: 'field-label' }, f.label), inputs[f.name]);
      }),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-sage', type: 'button', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn btn-black', type: 'submit' }, icon('arrow'), submitLabel)));
      return form;
    },
  });
}

export function formatTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
