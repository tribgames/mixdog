import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHost } from '../session-host.ts';

export async function viewSyncHost() {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-view-sync-'));
  const previousDataDirectory = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const records = new Map();
  const sinks = new Set();
  const state = { creates: 0, submits: 0, agents: [], reads: 0 };
  const full = (record) => ({
    sessionId: record.id, revision: record.revision, full: record.snapshot,
  });
  const put = (id, text) => {
    const old = records.get(id);
    const record = {
      id, revision: (old?.revision ?? 0) + 1, submissions: old?.submissions ?? new Set(),
      snapshot: { sessionId: id, busy: false, items: [{ id: 'answer', kind: 'assistant', text }], queued: [] },
    };
    records.set(id, record);
    for (const sink of sinks) sink({ type: 'session-state', ...full(record) });
    return record;
  };
  const runtime = {
    async attachSessionClient({ onFrame }) {
      sinks.add(onFrame);
      return {
        async list() {
          return { sessions: [...records.values()].map((row) => ({
            id: row.id, title: row.id, preview: row.id, cwd: directory,
            updatedAt: Date.now(), messageCount: row.snapshot.items.length,
          })) };
        },
        async create({ sessionId }) {
          state.creates++;
          return full(records.get(sessionId) ?? put(sessionId, ''));
        },
        async read({ sessionId, baseRevision }) {
          state.reads++;
          const record = records.get(sessionId);
          if (!record) throw new Error(`session ${sessionId} is not available`);
          return baseRevision === record.revision
            ? { sessionId, revision: record.revision, unchanged: true } : full(record);
        },
        async subscribe({ sessionId }) {
          const record = records.get(sessionId);
          if (!record) throw new Error(`session ${sessionId} is not available`);
          return full(record);
        },
        async unsubscribe() { return {}; },
        async submit({ sessionId, prompt, options }) {
          const record = records.get(sessionId);
          if (!record.submissions.has(options.id)) {
            state.submits++;
            record.submissions.add(options.id);
            put(sessionId, String(prompt));
          }
          return { ...full(records.get(sessionId)), accepted: true };
        },
        async configure() { throw new Error('Unexpected configuration'); },
        async close() { sinks.delete(onFrame); },
      };
    },
    async loadProjects() { return {}; },
    async loadSessionStore() { return { listStoredAgentWorkers: () => state.agents }; },
    async loadStatuslineSegments() { return {}; },
    async executeCodeGraphTool() { return {}; },
  };
  const options = { userDataPath: directory, resourcesPath: directory, appPath: directory, packaged: false };
  const host = await SessionHost.create(options, runtime);
  return {
    host, runtime, options, directory, records, state, put,
    async close() {
      await host.dispose();
      if (previousDataDirectory === undefined) delete process.env.MIXDOG_DATA_DIR;
      else process.env.MIXDOG_DATA_DIR = previousDataDirectory;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
