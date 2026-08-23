import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const relayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = resolve(relayDir, '../desktop');
const repoRoot = resolve(relayDir, '../..');
const schemaVersion = 1;
const defaultStatePath = join(relayDir, '.cache', 'deploy-state.json');
const defaultPlanPath = join(relayDir, '.cache', 'deploy-plan.json');
const desktopPackageManifest = join(desktopDir, 'package.json');
const ignoredSource = /(?:^|[\\/])(?:node_modules|out|dist|target|\.cache|\.runtime)(?:[\\/]|$)|(?:^|[\\/]).*\.(?:test|spec)\.[^.]+$/i;

export const rendererInputs = [
  join(desktopDir, 'src', 'renderer'),
  join(desktopDir, 'src', 'shared'),
  join(desktopDir, 'vendor'),
  join(desktopDir, 'electron.vite.config.ts'),
  desktopPackageManifest,
  join(desktopDir, 'package-lock.json'),
  join(relayDir, 'scripts', 'stage-web.mjs'),
];

const relayInputs = [
  join(relayDir, 'server.mjs'),
  join(relayDir, 'package.json'),
  join(relayDir, 'package-lock.json'),
  join(relayDir, 'lib'),
  join(relayDir, 'deploy'),
];

function parseArgs(argv) {
  return Object.fromEntries(argv.map((entry) => {
    const match = /^--([^=]+)=(.*)$/s.exec(entry);
    return match ? [match[1], match[2]] : ['', ''];
  }).filter(([name]) => name));
}

async function walkFiles(input, files = [], knownType = '') {
  if (ignoredSource.test(input)) return files;
  let type = knownType;
  if (!type) {
    try {
      const metadata = await stat(input);
      type = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other';
    } catch (error) {
      if (error?.code === 'ENOENT') return files;
      throw error;
    }
  }
  if (type === 'file') {
    files.push(input);
    return files;
  }
  if (type !== 'directory') return files;
  const entries = await readdir(input, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(input, entry.name);
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory()) await walkFiles(path, files, 'directory');
    else await walkFiles(path, files);
  }
  return files;
}

async function mapPool(items, limit, run) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await run(items[index], index);
    }
  });
  await Promise.all(lanes);
}

export function rendererManifestForFingerprint(manifest) {
  const normalized = structuredClone(manifest);
  delete normalized.scripts;
  return normalized;
}

export async function fingerprint(inputs) {
  const files = [];
  for (const input of inputs) await walkFiles(input, files);
  files.sort((left, right) => left.localeCompare(right));
  const details = new Array(files.length);
  await mapPool(files, 16, async (file, index) => {
    const [metadata, contents] = await Promise.all([stat(file), readFile(file)]);
    details[index] = {
      file,
      metadata,
      contents: resolve(file) === desktopPackageManifest
        ? Buffer.from(JSON.stringify(
          rendererManifestForFingerprint(JSON.parse(contents.toString('utf8'))),
        ))
        : contents,
    };
  });
  const hash = createHash('sha256');
  let newestMtimeMs = 0;
  for (const { file, metadata, contents } of details) {
    newestMtimeMs = Math.max(newestMtimeMs, metadata.mtimeMs);
    hash.update(relative(repoRoot, file).replaceAll(sep, '/'));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), newestMtimeMs, fileCount: files.length };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function rendererOutputFresh(newestMtimeMs) {
  try {
    return (await stat(join(desktopDir, 'out', 'renderer', 'index.html'))).mtimeMs
      >= newestMtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function decideDeployPlan({
  previous,
  renderer,
  relay,
  outputFresh,
}) {
  const currentState = previous?.schemaVersion === schemaVersion ? previous : null;
  const rendererChanged = currentState?.rendererHash !== renderer.hash;
  const relayChanged = currentState?.relayHash !== relay.hash;
  return {
    rendererChanged,
    relayChanged,
    rendererBuild: rendererChanged && !outputFresh,
    stageRenderer: rendererChanged,
    deploy: rendererChanged || relayChanged,
  };
}

async function createPlan(statePath, planPath) {
  const [renderer, relay, previous] = await Promise.all([
    fingerprint(rendererInputs),
    fingerprint(relayInputs),
    readJson(statePath),
  ]);
  const outputFresh = await rendererOutputFresh(renderer.newestMtimeMs);
  const plan = {
    schemaVersion,
    statePath: resolve(statePath),
    renderer,
    relay,
    outputFresh,
    ...decideDeployPlan({ previous, renderer, relay, outputFresh }),
  };
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

async function commitPlan(statePath, planPath) {
  const plan = await readJson(planPath);
  if (!plan || plan.schemaVersion !== schemaVersion) {
    throw new Error('Live deploy plan is missing or incompatible.');
  }
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion,
    rendererHash: plan.renderer.hash,
    relayHash: plan.relay.hash,
    deployedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action || 'plan';
  const statePath = resolve(args.state || defaultStatePath);
  const planPath = resolve(args.plan || defaultPlanPath);
  if (action === 'plan') {
    process.stdout.write(`${JSON.stringify(await createPlan(statePath, planPath))}\n`);
    return;
  }
  if (action === 'commit') {
    await commitPlan(statePath, planPath);
    return;
  }
  throw new Error(`Unknown deploy-plan action: ${action}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
