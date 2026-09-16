import type { CSSProperties } from 'react';
import { setiIconFor } from './seti-icons';

/** Seti file glyph (file icon theme; folders stay icon-less). Shared by the
 *  explorer, dock rows and chat file links so a file looks the same everywhere. */
export function SetiFileIcon({ name, className = '' }: { name: string; className?: string }) {
  const icon = setiIconFor(name);
  // The colour goes out as a custom property, never as an inline `color`: the
  // table is Seti's dark set, and desktop.css retunes it on light surfaces.
  // An inline color would win that cascade and keep 1.7:1 glyphs on paper.
  return (
    <span
      className={className ? `seti-icon ${className}` : 'seti-icon'}
      style={icon.color ? ({ '--seti-color': icon.color } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {icon.glyph}
    </span>
  );
}
