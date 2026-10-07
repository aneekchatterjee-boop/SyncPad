import { LIMITS } from '/shared/protocol.js';

const ERRORS = {
  'not-found': 'That room does not exist (yet).',
  'room-exists': 'A room with that ID already exists. Join it instead, or pick another ID.',
  'invalid-room-id': 'Room IDs are 3–32 characters: lowercase letters, digits, - and _. They must start with a letter or digit.',
  'invalid-name': 'Pick a display name first.',
  'invalid-passcode': `Passcodes are ${LIMITS.MIN_PASSCODE_LENGTH}–${LIMITS.MAX_PASSCODE_LENGTH} characters.`,
  'passcode-required': 'This room is protected. Enter its passcode.',
  'wrong-passcode': 'That passcode is not right.',
  'too-many-attempts': 'Too many wrong passcodes from this network. Wait a minute and try again.',
  'not-host': 'Only the host can do that.',
  'not-in-room': 'You are not in this room any more.',
  'bad-target': 'That person is no longer available.',
  locked: 'The host has locked editing.',
  throttled: `Slow down: each connection is limited to ${LIMITS.UPDATES_PER_SECOND} updates per second.`,
  'slow-down': 'Too many requests. Try again in a moment.',
  'too-large': `Documents are capped at ${LIMITS.MAX_DOC_LENGTH.toLocaleString()} characters.`,
  resync: 'The document was out of date and has been reloaded.',
  timeout: 'The server did not answer in time.',
  'server-error': 'The server hit an error. Try again.',
};

export function errorText(code) {
  return ERRORS[code] ?? `Something went wrong (${code}).`;
}

// socket.emit with an acknowledgement, as a promise that also resolves when
// the server never answers (e.g. the connection dropped mid-request).
export function request(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, res) => {
      resolve(err ? { ok: false, error: 'timeout' } : res ?? { ok: false, error: 'server-error' });
    });
  });
}
