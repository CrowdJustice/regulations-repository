// Reading and writing the repository: records, the seen-before list, the review pile and the run log.

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const RECORD_KEYS = ['id', 'country', 'status', 'regulator', 'title', 'summary', 'what_changes', 'applies_to',
  'who_it_applies_to', 'topic', 'stage', 'dates', 'source', 'last_checked', 'history', 'admin_notes'];

const readJson = async (file, fallback) => (existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : fallback);
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

export function createStore(root) {
  const recordFile = (rec) => path.join(root, 'data', rec.country, `${rec.id}.json`);
  const seenFile = path.join(root, 'data', 'seen.json');

  return {
    root,
    recordFile,

    async loadSources(country) {
      return readJson(path.join(root, 'sources', `${country}.json`), []);
    },

    async loadRecords(country) {
      const dir = path.join(root, 'data', country);
      if (!existsSync(dir)) return [];
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
      return Promise.all(files.map((f) => readJson(path.join(dir, f))));
    },

    async findRecord(id) {
      const file = path.join(root, 'data', id.slice(0, 2), `${id}.json`);
      return existsSync(file) ? readJson(file) : null;
    },

    async saveRecord(rec) {
      const ordered = Object.fromEntries(RECORD_KEYS.filter((k) => k in rec).map((k) => [k, rec[k]]));
      await writeJson(recordFile(rec), ordered);
      return recordFile(rec);
    },

    loadSeen: () => readJson(seenFile, {}),
    saveSeen: (seen) => writeJson(seenFile, Object.fromEntries(Object.entries(seen).sort(([a], [b]) => a.localeCompare(b)))),

    async addToReview(name, entry) {
      const file = path.join(root, 'review', `${name}.json`);
      await writeJson(file, entry);
      return file;
    },

    async appendLog(date, run) {
      const file = path.join(root, 'data', 'log', `${date}.json`);
      const runs = await readJson(file, []);
      runs.push(run);
      await writeJson(file, runs);
    },

    // Git, for one-commit-per-change. Each published change is its own commit, so it can be undone on its own.
    git(...args) {
      return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    },

    commit(files, subject, body = '') {
      const present = files.filter((f) => existsSync(path.resolve(root, f)));
      if (!present.length) return false;
      this.git('add', '--', ...present);
      if (!this.git('status', '--porcelain', '--', ...present)) return false;
      this.git('commit', '-q', '-m', subject, ...(body ? ['-m', body] : []), '--', ...present);
      return true;
    },
  };
}
