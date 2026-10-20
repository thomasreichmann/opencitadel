/**
 * A plugin's persistent key/value store: `<dataDir>/storage.json`, read lazily, written
 * atomically a short while after the last change and flushed on unload.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_KEY = 200;

export class PluginStorage {
  private data: Record<string, unknown> | undefined;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly debounceMs = 250,
    private readonly onError: (err: Error) => void = () => {},
  ) {}

  private load(): Record<string, unknown> {
    if (!this.data) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        this.data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(new Error(`${this.file} is unreadable, starting empty: ${(err as Error).message}`));
        this.data = {};
      }
    }
    return this.data;
  }

  private checkKey(key: string): void {
    if (typeof key !== 'string' || !key || key.length > MAX_KEY) throw new TypeError(`Storage keys must be non-empty strings up to ${MAX_KEY} characters`);
  }

  get<T = unknown>(key: string): T | undefined {
    this.checkKey(key);
    const value = this.load()[key];
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  set(key: string, value: unknown): void {
    this.checkKey(key);
    if (value === undefined) return this.delete(key);
    // Round-trip through JSON so stored values are exactly what will be persisted.
    this.load()[key] = JSON.parse(JSON.stringify(value));
    this.schedule();
  }

  delete(key: string): void {
    this.checkKey(key);
    const data = this.load();
    if (!(key in data)) return;
    delete data[key];
    this.schedule();
  }

  keys(): string[] {
    return Object.keys(this.load());
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref();
  }

  /** Writes pending changes now. Safe to call repeatedly. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const snapshot = JSON.stringify(this.data ?? {}, null, 2) + '\n';
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, snapshot);
        await rename(tmp, this.file);
      } catch (err) {
        this.onError(err as Error);
      }
    });
    return this.writing;
  }
}
