import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import { FileArchive, Folder, Globe, Presentation } from 'lucide-react';
import { SetiFileIcon } from './SetiFileIcon';

// The Seti set has no slide-deck glyph and only one (grey) archive box, so
// these two kinds, the folder and the external-link globe share one inline
// SVG glyph box with the Seti file glyphs: same size, baseline and ink rules.
const SLIDE_EXTENSION = /\.(?:pptx?|odp)$/i;
const ARCHIVE_EXTENSION = /\.(?:zip|7z|rar|tar|gz|tgz)$/i;

export type LinkIconKind = 'folder' | 'external' | 'file';

/** A recorded site icon until the image fails to decode; then undefined, so
 *  the caller draws its globe. A new `src` gets a fresh try. */
export function useLoadableFavicon(src: string | undefined): [string | undefined, () => void] {
  const [failed, setFailed] = useState<string | null>(null);
  const onError = useCallback(() => setFailed(src ?? null), [src]);
  return [src && src !== failed ? src : undefined, onError];
}

function GlyphBox({ kind, color, children }: { kind: string; color?: string; children: ReactNode }) {
  return (
    <span
      className="seti-icon link-glyph"
      data-icon-kind={kind}
      style={color ? ({ '--seti-color': color } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

/** The icon before a transcript link: a folder glyph, for web links the site
 *  icon the in-app browser recorded (`favicon`) or else a monochrome globe,
 *  otherwise the file-type glyph of `name` (the same one the explorer and
 *  auto-detected paths show). */
export function LinkKindIcon({ kind, name = '', favicon }: { kind: LinkIconKind; name?: string; favicon?: string }) {
  const [icon, onIconError] = useLoadableFavicon(kind === 'external' ? favicon : undefined);
  if (kind === 'folder') {
    return (
      <GlyphBox kind="folder">
        <Folder size="1em" aria-hidden="true" />
      </GlyphBox>
    );
  }
  if (kind === 'external') {
    return (
      <GlyphBox kind={icon ? 'favicon' : 'external'}>
        {icon ? (
          <img
            src={icon}
            alt=""
            width={14}
            height={14}
            draggable={false}
            onError={onIconError}
            style={{ borderRadius: 3, objectFit: 'contain' }}
          />
        ) : (
          <Globe size="1em" aria-hidden="true" />
        )}
      </GlyphBox>
    );
  }
  if (SLIDE_EXTENSION.test(name)) {
    return (
      <GlyphBox kind="presentation" color="#e37933">
        <Presentation size="1em" aria-hidden="true" />
      </GlyphBox>
    );
  }
  if (ARCHIVE_EXTENSION.test(name)) {
    return (
      <GlyphBox kind="archive" color="#cbcb41">
        <FileArchive size="1em" aria-hidden="true" />
      </GlyphBox>
    );
  }
  return <SetiFileIcon name={name} />;
}
