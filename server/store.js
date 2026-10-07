import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Rooms are kept in one JSON file. Writes are debounced and atomic
// (write to a temp file, then rename) so a crash never leaves half a file.
export class RoomStore {
  constructor(dataDir, { debounceMs = 750 } = {}) {
    this.file = path.join(dataDir, 'rooms.json');
    this.dataDir = dataDir;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.writing = Promise.resolve();
    this.getRooms = () => [];
    this.closed = false;
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(raw.rooms) ? raw.rooms : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      // A corrupt file should not take the server down; keep a copy and start empty.
      console.error(`[store] could not read ${this.file}: ${err.message}`);
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {});
      return [];
    }
  }

  markDirty() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const body = JSON.stringify({ version: 1, savedAt: Date.now(), rooms: this.getRooms().map((r) => r.toJSON()) });
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, this.file);
    }).catch((err) => console.error(`[store] save failed: ${err.message}`));
    return this.writing;
  }

  // Final save; later changes (e.g. grace timers firing during shutdown) are ignored.
  async close() {
    await this.flush();
    this.closed = true;
  }
}
