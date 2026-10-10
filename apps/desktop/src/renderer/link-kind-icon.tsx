import type { CSSProperties, ReactNode } from 'react';
import { FileArchive, Folder, Globe, Presentation } from 'lucide-react';
import { SetiFileIcon } from './SetiFileIcon';

// The Seti set has no slide-deck glyph and only one (grey) archive box, so
// these two kinds, the folder and the external-link globe share one inline
// SVG glyph box with the Seti file glyphs: same size, baseline and ink rules.
const SLIDE_EXTENSION = /\.(?:pptx?|odp)$/i;
const ARCHIVE_EXTENSION = /\.(?:zip|7z|rar|tar|gz|tgz)$/i;

export type LinkIconKind = 'folder' | 'external' | 'file';

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

/** The icon before a transcript link: a folder glyph, a monochrome globe for
 *  web links, otherwise the file-type glyph of `name` (the same one the
 *  explorer and auto-detected paths show). */
export function LinkKindIcon({ kind, name = '' }: { kind: LinkIconKind; name?: string }) {
  if (kind === 'folder') {
    return (
      <GlyphBox kind="folder">
        <Folder size="1em" aria-hidden="true" />
      </GlyphBox>
    );
  }
  if (kind === 'external') {
    return (
      <GlyphBox kind="external">
        <Globe size="1em" aria-hidden="true" />
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
