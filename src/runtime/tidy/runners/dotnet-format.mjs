// dotnet-format — toolchain formatter for loose .cs files (no .csproj).
//
// `dotnet format whitespace <folder> --folder --include <relative files…>`
// Check adds `--verify-no-changes --report <json>`; fix omits verify-no-changes.
// The `--report` JSON is an array of { FilePath, FileChanges:[{ LineNumber,
// CharNumber, FormatDescription }] }. FolderWorkspace walks the given folder,
// so the folder is the parent of each include list — never the repo root.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../process.mjs';
import { FILES_PER_SPAWN, chunkFiles, diagnostic, spawnFailureResult, tail, toRel, uniquePaths } from './shared.mjs';

export const DOTNET_FORMAT_ID = 'dotnet-format';
export const DOTNET_FORMAT_INSTALL_HINT = 'install the .NET SDK (dotnet format)';

function formatRel(cwd, raw) {
  let value = String(raw || '');
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`;
  else if (value.startsWith('\\\\?\\')) value = value.slice(4);
  return toRel(cwd, value);
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.documentReports)) return payload.documentReports;
  if (Array.isArray(payload?.DocumentReports)) return payload.DocumentReports;
  if (Array.isArray(payload?.files)) return payload.files;
  return [];
}

function filePathOf(row) {
  return row?.FilePath || row?.filePath || row?.FileName || row?.fileName || '';
}

function changesOf(row) {
  const changes = row?.FileChanges || row?.fileChanges || row?.Changes || row?.changes;
  return Array.isArray(changes) ? changes : [];
}

function changeMessage(change) {
  return String(
    change?.FormatDescription ||
      change?.formatDescription ||
      change?.Message ||
      change?.message ||
      'dotnet-format would reformat this file'
  ).trim();
}

/** Parse `dotnet format --report` JSON. */
export function parseDotnetFormatReport(jsonText, cwd) {
  const text = String(jsonText || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!text) return { diagnostics: [], changedFiles: [] };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { diagnostics: [], changedFiles: [] };
  }
  const diagnostics = [];
  const files = [];
  for (const row of rowsOf(payload)) {
    const file = formatRel(cwd, filePathOf(row));
    if (!file) continue;
    files.push(file);
    const changes = changesOf(row);
    if (changes.length === 0) {
      diagnostics.push(
        diagnostic({
          file,
          code: DOTNET_FORMAT_ID,
          message: 'dotnet-format would reformat this file',
          severity: 'warning',
          fixable: true,
        })
      );
      continue;
    }
    for (const change of changes) {
      diagnostics.push(
        diagnostic({
          file,
          line: change?.LineNumber ?? change?.lineNumber ?? change?.Line ?? change?.line ?? 0,
          col: change?.CharNumber ?? change?.charNumber ?? change?.Column ?? change?.column ?? 0,
          code: DOTNET_FORMAT_ID,
          message: changeMessage(change),
          severity: 'warning',
          fixable: true,
        })
      );
    }
  }
  return { diagnostics, changedFiles: uniquePaths(files) };
}

/** True when `dotnet` is missing or too old for `format whitespace --folder`. */
export function isUnsupportedDotnetFormat(result) {
  const text = `${result?.stderr || ''}\n${result?.stdout || ''}`;
  return (
    /Could not execute because the specified command or file was not found/i.test(text) ||
    /No executable found matching command/i.test(text) ||
    /dotnet-format does not exist/i.test(text) ||
    /unrecognized command or argument/i.test(text)
  );
}

function withInstallHint(result) {
  const failure = spawnFailureResult(DOTNET_FORMAT_ID, result);
  if (!result?.timedOut) {
    failure.diagnostics[0].message += `. ${DOTNET_FORMAT_INSTALL_HINT}`;
  }
  return failure;
}

function readReport(reportPath) {
  try {
    const info = statSync(reportPath);
    if (info.isDirectory()) return readFileSync(join(reportPath, 'format-report.json'), 'utf8');
    return readFileSync(reportPath, 'utf8');
  } catch {
    try {
      return readFileSync(join(reportPath, 'format-report.json'), 'utf8');
    } catch {
      return '';
    }
  }
}

/**
 * One spawn per parent folder (FolderWorkspace walks `<folder>`), with include
 * lists chunked to stay inside the Windows argv cap.
 */
export function planDotnetFormatSpawns(files = [], cwd = '', filesPerSpawn = FILES_PER_SPAWN) {
  const groups = new Map();
  for (const file of files) {
    const rel = formatRel(cwd, file);
    if (!rel) continue;
    const slash = rel.lastIndexOf('/');
    const folder = slash === -1 ? '.' : rel.slice(0, slash);
    const name = slash === -1 ? rel : rel.slice(slash + 1);
    if (!name) continue;
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(name);
  }
  const spawns = [];
  for (const [folder, names] of groups) {
    for (const chunk of chunkFiles(names, filesPerSpawn)) {
      if (chunk.length) spawns.push({ folder, files: chunk });
    }
  }
  return spawns;
}

function spawnArgv({ args, folder, files, verify, reportPath }) {
  return [
    ...args,
    'whitespace',
    folder,
    '--folder',
    ...(verify ? ['--verify-no-changes'] : []),
    '--report',
    reportPath,
    '--include',
    ...files,
  ];
}

async function invoke({
  files,
  cwd,
  bin,
  args = [],
  timeoutMs,
  signal,
  verify,
  run = runProcess,
  filesPerSpawn = FILES_PER_SPAWN,
}) {
  const spawns = planDotnetFormatSpawns(files, cwd, filesPerSpawn);
  if (spawns.length === 0) return { diagnostics: [], changedFiles: [], stderrTail: '' };

  const reportRoot = mkdtempSync(join(tmpdir(), 'mixdog-dotnet-format-'));
  try {
    const diagnostics = [];
    const changedFiles = [];
    let stderr = '';
    for (const [index, spawn] of spawns.entries()) {
      const reportPath = join(reportRoot, `report-${index}.json`);
      const result = await run(
        bin,
        spawnArgv({
          args,
          folder: spawn.folder,
          files: spawn.files,
          verify,
          reportPath,
        }),
        { cwd, timeoutMs, signal }
      );
      stderr += result.stderr || '';
      if (result.error) {
        return result.timedOut ? spawnFailureResult(DOTNET_FORMAT_ID, result) : withInstallHint(result);
      }
      if (isUnsupportedDotnetFormat(result)) {
        return withInstallHint({ ...result, error: result.error || tail(result.stderr) || `exit ${result.code}` });
      }
      if (!verify) continue;
      const parsed = parseDotnetFormatReport(readReport(reportPath), cwd);
      if (parsed.changedFiles.length === 0 && parsed.diagnostics.length === 0 && result.code !== 0) {
        return spawnFailureResult(DOTNET_FORMAT_ID, {
          ...result,
          error: result.error || tail(result.stderr) || `exit ${result.code}`,
        });
      }
      diagnostics.push(...parsed.diagnostics);
      changedFiles.push(...parsed.changedFiles);
    }
    const unique = uniquePaths(changedFiles);
    return {
      diagnostics: verify ? diagnostics : [],
      changedFiles: verify ? unique : [],
      stderrTail: unique.length ? '' : tail(stderr),
    };
  } finally {
    rmSync(reportRoot, { recursive: true, force: true });
  }
}

export const runner = {
  id: DOTNET_FORMAT_ID,
  check: (options) => invoke({ ...options, verify: true }),
  fix: (options) => invoke({ ...options, verify: false }),
};

export default runner;
