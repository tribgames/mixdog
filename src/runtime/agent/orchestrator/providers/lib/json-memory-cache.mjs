import { existsSync, readFileSync } from 'node:fs';

export class JsonMemoryCache {
  #entry = { at: 0, file: '', value: null };

  constructor(ttlMs = 1000) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
  }

  read(file) {
    if (this.#entry.file === file && Date.now() - this.#entry.at < this.ttlMs) {
      return this.#entry.value;
    }
    try {
      if (!existsSync(file)) return null;
      const value = JSON.parse(readFileSync(file, 'utf8'));
      this.remember(file, value);
      return value;
    } catch {
      return null;
    }
  }

  remember(file, value) {
    this.#entry = { at: Date.now(), file, value };
  }
}
