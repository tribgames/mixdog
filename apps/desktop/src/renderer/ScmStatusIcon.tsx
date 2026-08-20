// The changed-file STATUS GLYPH, shared by every file list in the dock
// (working directory, commit detail, pull-request changes) so all three read
// identically. Each status colour lands on one of our own semantic tokens —
// see desktop.css.
//
// The five path strings below are Octicons glyphs carried unmodified:
// diffAdded, diffModified, diffRemoved, diffRenamed and alert, each the
// symbol's single 16px path. Nothing is reassembled, subset or re-derived —
// the glyph is a thin outlined rounded square (outer contour + inner contour)
// with the +, ·, − or → sitting INSIDE it, drawn on a 16 viewBox with
// fill="currentColor". Attribution and license: NOTICE.md.

/** Octicons diffAdded, 16px path. */
const DIFF_ADDED = "M2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Zm10.5 1.5H2.75a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4Z";
/** Octicons diffModified, 16px path. */
const DIFF_MODIFIED = "M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z";
/** Octicons diffRemoved, 16px path. */
const DIFF_REMOVED = "M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Zm8.5 6.25h-6.5a.75.75 0 0 1 0-1.5h6.5a.75.75 0 0 1 0 1.5Z";
/** Octicons diffRenamed, 16px path. */
const DIFF_RENAMED = "M13.25 1c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1ZM2.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Zm9.03 6.03-3.25 3.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.97-1.97H4.75a.75.75 0 0 1 0-1.5h4.69L7.47 5.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l3.25 3.25a.75.75 0 0 1 0 1.06Z";
/** Octicons alert, 16px path — the conflict glyph. */
const ALERT = "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z";

/** One 16px octicon, drawn from its single path string. */
function StatusGlyph({ path, size }: { path: string; size: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor"
    className="dock-scm-status-glyph" aria-hidden="true" focusable="false">
    <path fillRule="evenodd" d={path} />
  </svg>;
}

export type ScmStatusKind =
  | "new"
  | "copied"
  | "modified"
  | "renamed"
  | "deleted"
  | "conflicted";

/** Status-to-glyph mapping over the Octicons set: diffAdded, diffModified,
 *  diffRemoved, diffRenamed and alert. The label is
 *  the icon's ACCESSIBLE NAME — the row still says "Modified" out loud now
 *  that the letter badge is gone. */
const STATUS_ICONS: Record<ScmStatusKind, { path: string; label: string }> = {
  new: { path: DIFF_ADDED, label: "New" },
  copied: { path: DIFF_ADDED, label: "Copied" },
  modified: { path: DIFF_MODIFIED, label: "Modified" },
  renamed: { path: DIFF_RENAMED, label: "Renamed" },
  deleted: { path: DIFF_REMOVED, label: "Deleted" },
  conflicted: { path: ALERT, label: "Conflicted" },
};

/** Git's status CODE (porcelain XY, `git show --name-status`) mapped onto the
 *  same kinds the reference switches on. Anything unrecognised is a
 *  modification, exactly like the old letter fallback. */
export function scmStatusKind(code: string): ScmStatusKind {
  switch ((code ?? "").trim().toUpperCase().charAt(0)) {
    case "A":
    case "?":
      return "new";
    case "C":
      return "copied";
    case "R":
      return "renamed";
    case "D":
      return "deleted";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

/** The trailing status icon of one file row. */
export function ScmStatusIcon({ kind, size = 13, className = "" }: {
  kind: ScmStatusKind;
  size?: number;
  className?: string;
}) {
  const { path, label } = STATUS_ICONS[kind];
  return <span className={`dock-scm-status${className ? ` ${className}` : ""}`}
    data-status={kind} role="img" aria-label={label} title={label}>
    <StatusGlyph path={path} size={size} />
  </span>;
}
