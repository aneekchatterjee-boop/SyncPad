// Limits and constants shared by the server and the browser client.

export const LIMITS = {
  // Client-side batching: at most one update leaves the browser per window.
  SEND_INTERVAL_MS: 200,
  // Server-side token bucket per connection: sustained 5 updates/second.
  UPDATES_PER_SECOND: 5,
  BURST: 5,
  // A connection that keeps flooding after being throttled gets disconnected.
  FLOOD_DROPS_BEFORE_KICK: 60,
  FLOOD_WINDOW_MS: 5000,

  MAX_DOC_LENGTH: 200_000,
  MAX_NAME_LENGTH: 24,
  MIN_PASSCODE_LENGTH: 4,
  MAX_PASSCODE_LENGTH: 64,
  MAX_FEED_ENTRIES: 200,
  HISTORY_SIZE: 2000,
  TYPING_TIMEOUT_MS: 1500,
};

export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/;

export const LANGUAGES = [
  { id: 'plaintext', label: 'Plain text' },
  { id: 'markdown', label: 'Notes (Markdown)' },
  { id: 'javascript', label: 'JavaScript / TS' },
  { id: 'python', label: 'Python' },
  { id: 'clike', label: 'C / C++ / Java' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'sql', label: 'SQL' },
  { id: 'json', label: 'JSON' },
];

// Peer colours. #1fe12c, #f1faa0 and #fefdfc are sampled from the theme
// reference; the others are added so that up to eight peers stay distinguishable.
export const PEER_COLORS = [
  '#1fe12c', '#f1faa0', '#6fd3e8', '#f0a35a',
  '#f08fbf', '#b49cf0', '#fefdfc', '#f07a6a',
];

export function normalizeRoomId(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidRoomId(id) {
  return ROOM_ID_PATTERN.test(id);
}
