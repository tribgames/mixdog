// Worker side of model-catalog.mjs: parses a multi-MB price/metadata overlay
// and narrows it to its read surface, so the host receives only the projection.
// The disk caches keep the full payload.
import { readFile } from 'node:fs/promises';
import { serveWorkerRequests } from '../../../../../../../../src/runtime/shared/worker-requests.mjs';
import { projectLitellmCatalog, projectModelsDevCatalog } from './model-catalog-projection.mjs';

const PROJECTIONS = { litellm: projectLitellmCatalog, modelsdev: projectModelsDevCatalog };

serveWorkerRequests(async ({ op, kind, file, text }) => {
  const project = PROJECTIONS[kind];
  if (op === 'parse') return project(JSON.parse(text));
  // 'disk': a cache file stored as `{ fetchedAt, data }`; null when it has no payload.
  const raw = JSON.parse(await readFile(file, 'utf-8'));
  return raw?.data ? { fetchedAt: raw.fetchedAt, projection: project(raw.data) } : null;
});
