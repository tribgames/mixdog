import type { TranscriptItem } from './desktop-types';
import { asRecord } from './text-format';
import {
  desktopToolActivityCategory,
  desktopToolActivitySurface,
  flattenedToolActivityItems,
  toolItemDone,
} from './transcript-tool-core';
import { toolActivityFirstText } from './transcript-tool-format';
import { toolActivityResultValue } from './transcript-tool-result';

export interface TranscriptArtifact {
  key: string;
  kind: 'image' | 'video' | 'document';
  name: string;
  path: string;
  assetId?: string;
  /** Width/height the generation asked for; sizes the card before the thumbnail decodes. */
  aspect?: number;
}

function requestedAspect(value: unknown): number | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value ?? '').trim());
  const ratio = match ? Number(match[1]) / Number(match[2]) : NaN;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

const DOCUMENT = /\.(?:docx|xlsx|pptx|pdf|csv|tsv|rtf|odt|ods|odp)$/i;
const SVG = /\.svg$/i;

/** Files a successful edit/apply_patch call wrote: its own write targets, not
 *  paths guessed from prose. Deleted files and move sources are excluded. */
function writtenFiles(normalizedName: string, args: Record<string, unknown>): string[] {
  if (normalizedName === 'edit') {
    const path = toolActivityFirstText(args, 'file_path', 'filePath', 'path');
    return path ? [path] : [];
  }
  if (normalizedName !== 'apply_patch' || typeof args.patch !== 'string') return [];
  const paths: string[] = [];
  for (const line of args.patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add File|Update File|Move to): (.+)$/.exec(line);
    if (!header) continue;
    if (header[1] === 'Move to') paths.pop();
    paths.push(header[2].trim());
  }
  return paths;
}

// Otherwise only parse structured tool output, never paths guessed from prose or input args.
function resultRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 3) return [];
  if (typeof value === 'string') {
    try {
      return resultRecords(JSON.parse(value), depth + 1);
    } catch {
      return [];
    }
  }
  const record = asRecord(value);
  if (!record || record.isError === true || record.ok === false) return [];
  if (record.structuredContent) return resultRecords(record.structuredContent, depth + 1);
  if (Array.isArray(record.content)) {
    return record.content.flatMap((entry) => {
      const part = asRecord(entry);
      return part?.type === 'text' ? resultRecords(part.text, depth + 1) : [];
    });
  }
  return [record];
}

export function transcriptArtifacts(items: readonly TranscriptItem[]): TranscriptArtifact[] {
  const artifacts = new Map<string, TranscriptArtifact>();
  for (const item of flattenedToolActivityItems(items)) {
    if (
      !toolItemDone(item) ||
      item.isError ||
      Number(item.errorCount || 0) > 0 ||
      Number(item.callErrorCount || 0) > 0 ||
      Number(item.exitErrorCount || 0) > 0
    )
      continue;
    const surface = desktopToolActivitySurface(item.name, item.args);
    for (const path of writtenFiles(surface.normalizedName, surface.args)) {
      if (!SVG.test(path)) continue;
      const key = `file:${path.replace(/\\/g, '/')}`;
      artifacts.set(key, { key, kind: 'image', path, name: path.split(/[\\/]/).pop() || path });
    }
    const category = desktopToolActivityCategory(item.name, item.args);
    if (category !== 'Media' && category !== 'Office') continue;
    for (const result of resultRecords(toolActivityResultValue(item))) {
      if (['running', 'failed', 'canceled', 'cancelled'].includes(String(result.status || ''))) continue;
      if (
        category === 'Media' &&
        result.ok === true &&
        typeof result.assetId === 'string' &&
        result.assetId &&
        (result.output || result.status === 'done')
      ) {
        const path = typeof result.output === 'string' ? result.output : '';
        const args = asRecord(item.args);
        const kind =
          result.kind === 'video' || args?.kind === 'video' || /\.(mp4|webm|mov)$/i.test(path) ? 'video' : 'image';
        const key = `media:${result.assetId}`;
        artifacts.set(key, {
          key,
          kind,
          assetId: result.assetId,
          path,
          name: path.split(/[\\/]/).pop() || result.assetId,
        });
        const aspect = requestedAspect(args?.aspect);
        if (aspect) artifacts.get(key)!.aspect = aspect;
      }
      if (category !== 'Office') continue;
      const outputs = Array.isArray(result.artifacts) ? result.artifacts : [];
      for (const output of outputs) {
        const artifact = asRecord(output);
        const path = typeof artifact?.path === 'string' ? artifact.path : '';
        if (!DOCUMENT.test(path) || !['create', 'edit'].includes(String(artifact?.operation))) continue;
        const key = `file:${path.replace(/\\/g, '/')}`;
        artifacts.set(key, { key, kind: 'document', path, name: path.split(/[\\/]/).pop() || path });
      }
    }
  }
  return [...artifacts.values()];
}
