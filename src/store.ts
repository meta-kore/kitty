// Tiny JSON-file store. Good enough for a demo; swap for a database in production.
import fs from 'node:fs';
import path from 'node:path';

export function makeStore<T>(file: string, initial: T) {
  const full = path.resolve(file);
  let data: T = initial;
  try { data = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { /* first run */ }
  return {
    get: () => data,
    set(next: T) { data = next; this.save(); },
    save() {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, JSON.stringify(data, null, 2));
    },
  };
}
