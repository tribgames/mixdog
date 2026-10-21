import { useContext, useEffect, useState } from 'react';
import { submissionIdentity } from './transcript-rows';
import {
  fitImageThumbnail,
  onSessionPreviewsDeleted,
  persistentImagePreviews,
  previewKey,
} from './image-preview-store';
import { AttachmentCard, composerCardMeta } from './attachment-card';
import {
  type extractFileMarkers,
  fileChipKind,
  sentFileSource,
  sentPastedTextSource,
  type StoredAttachment,
} from './attachment-menu';
import { openAttachmentSource, useAttachmentContextMenu } from './attachment-context-menu';
import { MarkdownOpenFileContext, MarkdownSessionContext } from './MarkdownLink';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { VISUALIZE_TWEAKS_MARK } from './visualize-feedback-store';
import { imagePreviewCache, imagePreviewKey } from './transcript-metrics';

export function stripImageTokens(text: string): string {
  return text
    .replace(/ ?\[Image #\d+(?::[^\]]*)?\] ?/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** The runtime spells an image part as a bare `[Image]` line in a prompt's
 *  display text (the model and the terminal read it so). A row that draws the
 *  images as thumbnails drops those lines instead of repeating them as words. */
export function stripImagePlaceholders(text: string): string {
  if (!text.includes('[Image]')) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '[Image]')
    .join('\n')
    .trim();
}

export interface PastedTextChip {
  name: string;
  token: string;
  /** Null when the count is unknown. */
  lines: number | null;
}

export function extractPastedTextMarkers(text: string): { text: string; chips: PastedTextChip[] } {
  const chips: PastedTextChip[] = [];
  // A restored paste whose line count was not worked out reads `[Pasted text #n]`.
  const stripped = String(text || '').replace(
    / ?(\[Pasted text #\d+(?: \+(\d+) lines)?\]) ?/g,
    (_match, token, lines) => {
      chips.push(
        lines === undefined
          ? { name: 'Pasted text', token, lines: null }
          : { name: `Pasted text · ${lines} lines`, token, lines: Number(lines) }
      );
      return ' ';
    }
  );
  if (chips.length === 0) return { text, chips };
  const cleaned = stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, chips };
}

/** Tweaks lines of a feedback message (`<mark> accent: #fff (was #000)`) come out of the text, to be drawn with an icon. */
export function extractTweaksLines(text: string): { text: string; lines: string[] } {
  const lines: string[] = [];
  const kept: string[] = [];
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith(`${VISUALIZE_TWEAKS_MARK} `)) lines.push(line.slice(VISUALIZE_TWEAKS_MARK.length + 1).trim());
    else kept.push(line);
  }
  return lines.length ? { text: kept.join('\n').trim(), lines } : { text, lines };
}

export interface ImageMarkerChip {
  name: string;
  dims: string;
  title: string;
  /** The `[Image: …]` line the chip comes from: restored rows name each
   *  image's stored original by it. */
  line?: string;
}

/** Each marker chip's stored original: the next unused `imageRefs` entry drawn
 *  by the chip's line. Chips with no such entry (omitted images, bare `#N`
 *  references) get none. */
export function markerChipRefs(
  chips: readonly ImageMarkerChip[],
  refs: TranscriptItem['imageRefs']
): Array<string | undefined> {
  const pool = Array.isArray(refs) ? [...refs] : [];
  return chips.map((chip) => {
    const at = chip.line ? pool.findIndex((entry) => entry?.line === chip.line) : -1;
    return at < 0 ? undefined : pool.splice(at, 1)[0]?.ref;
  });
}

export const inflightThumbnails = new Map<string, Promise<string | undefined>>();
export const failedThumbnails = new Set<string>();

// A deleted session's attachments are gone with it: forget their misses.
onSessionPreviewsDeleted((session) => {
  const prefix = previewKey(session, '');
  for (const key of failedThumbnails) if (key.startsWith(prefix)) failedThumbnails.delete(key);
});

/** The cached thumbnail of a stored attachment; on a miss it is rebuilt from
 *  the stored original through the host (one host call per ref at a time). A
 *  ref the host has no picture for is not asked again in this run; a failed
 *  call (host unreachable) is retried on the next render that needs it. */
export function loadAttachmentThumbnail(
  session: string,
  ref: string,
  fit: (dataUrl: string) => Promise<string> = fitImageThumbnail
): Promise<string | undefined> {
  const key = previewKey(session, `attachment:${ref}`);
  const pending = inflightThumbnails.get(key);
  if (pending) return pending;
  const request = (async () => {
    const cached = await persistentImagePreviews.get(key).catch(() => undefined);
    if (cached) return cached;
    if (failedThumbnails.has(key)) return undefined;
    const read = window.mixdogDesktop?.readAttachmentThumbnail;
    if (!read) return undefined;
    let picture: string | null;
    try {
      picture = await read(ref);
    } catch {
      return undefined;
    }
    // A phone gets the original: fit it to thumbnail size before it is cached.
    const url = picture ? await fit(picture).catch(() => undefined) : undefined;
    if (!url) {
      failedThumbnails.add(key);
      return undefined;
    }
    await persistentImagePreviews.put(key, session, url).catch(() => undefined);
    return url;
  })().finally(() => inflightThumbnails.delete(key));
  inflightThumbnails.set(key, request);
  return request;
}

/** The thumbnail of a sent image, by its stored attachment ref. Loaded async;
 *  the card keeps its size meanwhile. */
export function useStoredImagePreview(session: string, attachmentRef: string | undefined): string | undefined {
  const key = attachmentRef ? previewKey(session, `attachment:${attachmentRef}`) : '';
  const sync = key ? persistentImagePreviews.peek(key) : undefined;
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key || !attachmentRef) return;
    let active = true;
    void loadAttachmentThumbnail(session, attachmentRef).then((url) => {
      if (url && active) setLoaded({ key, url });
    });
    return () => {
      active = false;
    };
  }, [key, session, attachmentRef]);
  return sync ?? (loaded?.key === key ? loaded.url : undefined);
}

/** The host file behind a sent image: its store reference in this session. */
export function storedAttachmentRef(session: string, ref: string | undefined): StoredAttachment | undefined {
  return session && ref && /^[a-f0-9]{64}$/.test(ref) ? { sessionId: session, id: ref } : undefined;
}

export type SentAttachmentRecord = NonNullable<TranscriptItem['attachments']>[number];

/** The message-metadata attachment each file / pasted chip stands for: files
 *  by their name first, then pasted texts by name or, failing that, in order. */
export function chipAttachments(
  records: TranscriptItem['attachments'],
  fileChips: readonly { name: string }[],
  pastedChips: readonly { name: string }[]
): { files: Array<SentAttachmentRecord | undefined>; pasted: Array<SentAttachmentRecord | undefined> } {
  const pool = Array.isArray(records) ? [...records] : [];
  const take = (match: (record: SentAttachmentRecord) => boolean) => {
    const at = pool.findIndex(match);
    return at < 0 ? undefined : pool.splice(at, 1)[0];
  };
  const files = fileChips.map((chip) => take((record) => record.name === chip.name && record.kind !== 'image'));
  const pasted = pastedChips.map(
    (chip) =>
      take((record) => record.name === chip.name && record.kind === 'text') ?? take((record) => record.kind === 'text')
  );
  return { files, pasted };
}

export function SentImageCard({
  session,
  attachmentRef,
  live,
  name,
  dims,
  tooltip,
  menuProps,
}: {
  session: string;
  /** Reference of the stored original, from which the host rebuilds the thumbnail. */
  attachmentRef?: string;
  live?: string;
  name: string;
  dims?: string;
  tooltip?: string;
  menuProps: ReturnType<typeof useAttachmentContextMenu>['menuProps'];
}) {
  const stored = useStoredImagePreview(session, attachmentRef);
  const preview = live || stored;
  const openFile = useContext(MarkdownOpenFileContext);
  const hostFile = storedAttachmentRef(session, attachmentRef);
  return (
    <AttachmentCard
      kind="image"
      name={name}
      imageUrl={preview || undefined}
      tooltip={tooltip}
      meta={preview ? undefined : dims}
      menu={menuProps(
        preview
          ? { kind: 'image', name, dataUrl: preview, stored: hostFile }
          : { kind: 'image-marker', name, stored: hostFile }
      )}
      onOpen={
        preview
          ? () => openAttachmentSource({ kind: 'image', name, dataUrl: preview, stored: hostFile }, openFile)
          : undefined
      }
    />
  );
}

// Chip for an `[Image: …]` / `[Image source: …]` metadata line: the file name
// from its source path and its dimensions.
export function imageMetaChip(meta: string, line: string): ImageMarkerChip {
  // A visualize pin's crop (`[Image: visualize pin N · label, WxH]`): named
  // like its composer card (number · label; history written before the emoji went still reads this way). Restored history has no crop thumbnail to show.
  const pin = /^visualize pin (\d+) · (.+), (\d+)x(\d+)$/.exec(meta);
  if (pin) return { name: `${pin[1]} · ${pin[2]}`, dims: `${pin[3]}\u00D7${pin[4]}`, title: line, line };
  const parts = meta.split(/,\s*/);
  const source =
    (parts.find((part) => part.startsWith('source: ')) || '').slice(8).trim() ||
    (line.startsWith('[Image source:') ? meta.trim() : '');
  const dims = parts.find((part) => /^\d+x\d+$/.test(part)) || '';
  const name = source
    ? source
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || 'Image'
    : 'Image';
  return { name, dims: dims.replace('x', '\u00D7'), title: source || line, line };
}

export function extractImageMarkers(text: string): { text: string; chips: ImageMarkerChip[] } {
  const chips: ImageMarkerChip[] = [];
  const kept: string[] = [];
  let pendingRefs = 0;
  let lastWasMeta = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[Image #\d+(?::[^\]]*)?\]$/.test(line)) {
      pendingRefs += 1;
      lastWasMeta = false;
      continue;
    }
    const meta = /^\[Image(?::| source:) ([^\]]+)\]$/.exec(line);
    if (meta && !/^omitted\b/i.test(meta[1])) {
      chips.push(imageMetaChip(meta[1], line));
      if (pendingRefs > 0) pendingRefs -= 1;
      lastWasMeta = true;
      continue;
    }
    if (/^\[Image omitted from stored history[^\]]*\]$/.test(line)) {
      if (!lastWasMeta) {
        chips.push({ name: 'Image', dims: '', title: line });
        if (pendingRefs > 0) pendingRefs -= 1;
      }
      lastWasMeta = false;
      continue;
    }
    lastWasMeta = false;
    const inlineRefs = rawLine.match(/\[Image #\d+(?::[^\]]*)?\]/g);
    if (inlineRefs && inlineRefs.length > 0) {
      pendingRefs += inlineRefs.length;
      const strippedLine = stripImageTokens(rawLine);
      if (strippedLine) kept.push(strippedLine);
      continue;
    }
    kept.push(rawLine);
  }
  for (let index = 0; index < pendingRefs; index += 1) {
    chips.push({ name: t('Image'), dims: '', title: t('Attached image') });
  }
  return { text: kept.join('\n').trim(), chips };
}

/** The cards above a sent prompt: its images, pasted text and files. */
export function SentAttachments({
  item,
  session,
  images,
  markerChips,
  pastedChips,
  fileChips,
  menuProps,
}: {
  item: TranscriptItem;
  session: string;
  images: NonNullable<TranscriptItem['images']>;
  markerChips: readonly ImageMarkerChip[];
  pastedChips: readonly PastedTextChip[];
  fileChips: ReturnType<typeof extractFileMarkers>['chips'];
  menuProps: ReturnType<typeof useAttachmentContextMenu>['menuProps'];
}) {
  const markerRefs = markerChipRefs(markerChips, item.imageRefs);
  const records = chipAttachments(item.attachments, fileChips, pastedChips);
  const hostFileOf = (record: SentAttachmentRecord | undefined) => storedAttachmentRef(session, record?.id);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border, padding and min-width into the card row.
    <div className="message-attachments" role="group" aria-label={t('Attachments')}>
      {images.map((image, index) => {
        const preview = imagePreviewCache.peek(
          imagePreviewKey(submissionIdentity(String(item.id ?? '')), image.id, image.bytes)
        );
        const name = image.name || t('Attached image');
        return (
          <SentImageCard
            // biome-ignore lint/suspicious/noArrayIndexKey: a sent message's attachments never reorder; the index separates images without an id.
            key={`${image.id ?? 'img'}-${index}`}
            session={session}
            attachmentRef={image.attachmentRef}
            live={preview || undefined}
            name={preview ? name : image.name || 'Image'}
            menuProps={menuProps}
          />
        );
      })}
      {markerChips.map((chip, index) => (
        <SentImageCard
          // biome-ignore lint/suspicious/noArrayIndexKey: chips are parsed from a sent message and never reorder.
          key={`marker-${index}`}
          session={session}
          attachmentRef={markerRefs[index]}
          name={chip.name}
          tooltip={chip.title}
          dims={chip.dims}
          menuProps={menuProps}
        />
      ))}
      {pastedChips.map((chip, index) => {
        const stored = sentPastedTextSource(chip.token, chip.name, item.id);
        const hostFile = hostFileOf(records.pasted[index]);
        return (
          <AttachmentCard
            // biome-ignore lint/suspicious/noArrayIndexKey: chips are parsed from a sent message and never reorder.
            key={`pasted-${index}`}
            kind="pasted"
            name={chip.name}
            content={stored.kind === 'pasted-text' ? stored.text : undefined}
            meta={chip.lines === null ? undefined : t('{{count}} lines', { count: chip.lines })}
            menu={menuProps(() => ({ ...sentPastedTextSource(chip.token, chip.name, item.id), stored: hostFile }))}
          />
        );
      })}
      {fileChips.map((chip, index) => {
        const kind = fileChipKind(chip);
        const stored = sentFileSource(chip, item.id);
        const hostFile = hostFileOf(records.files[index]);
        let meta = '';
        let content: string | undefined;
        if (stored.kind === 'text-file' && stored.text !== undefined) {
          content = stored.text;
          meta = composerCardMeta({ kind: 'text', data: stored.text });
        } else if ((stored.kind === 'pdf' || stored.kind === 'office') && stored.dataUrl) {
          content = stored.dataUrl.split(',')[1] || '';
          meta = composerCardMeta({ kind: stored.kind, data: content });
        }
        return (
          <AttachmentCard
            // biome-ignore lint/suspicious/noArrayIndexKey: chips are parsed from a sent message and never reorder.
            key={`file-${index}`}
            kind={kind === 'text-file' ? 'text' : kind}
            name={chip.name}
            content={content}
            meta={meta}
            menu={menuProps(() => ({ ...sentFileSource(chip, item.id), stored: hostFile }))}
          />
        );
      })}
    </div>
  );
}

/** The files a bot's or agent's turn returned (a task report, a member's room
 *  speech), from the row's stored attachment records: images as thumbnails,
 *  the rest as file cards that open from the store. */
export function ReturnedAttachments({ records }: { records: TranscriptItem['attachments'] }) {
  const session = useContext(MarkdownSessionContext);
  const openFile = useContext(MarkdownOpenFileContext);
  const { menuProps, menuElement } = useAttachmentContextMenu(openFile);
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border, padding and min-width into the card row.
    <div className="message-attachments" role="group" aria-label={t('Attachments')}>
      {list.map((record) => {
        if (record.kind === 'image') {
          return (
            <SentImageCard
              key={record.id}
              session={session}
              attachmentRef={record.id}
              name={record.name}
              menuProps={menuProps}
            />
          );
        }
        const kind = record.kind === 'text' ? 'text-file' : record.mimeType === 'application/pdf' ? 'pdf' : 'office';
        const source = { kind, name: record.name, stored: storedAttachmentRef(session, record.id) } as const;
        return (
          <AttachmentCard
            key={record.id}
            kind={kind === 'text-file' ? 'text' : kind}
            name={record.name}
            menu={menuProps(source)}
            onOpen={() => openAttachmentSource(source, openFile)}
          />
        );
      })}
      {menuElement}
    </div>
  );
}
