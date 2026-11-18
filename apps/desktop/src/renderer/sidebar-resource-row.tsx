import type { ReactNode } from 'react';

export type SidebarResourceTagTone = 'muted' | 'warn' | 'danger' | 'ok';

export type SidebarResourceTag = {
  label: string;
  tone?: SidebarResourceTagTone;
  /** The tag's tooltip: the status detail a narrow row does not print. */
  title?: string;
};

function SidebarResourceTagBadge({ tag }: { tag?: SidebarResourceTag | null }) {
  if (!tag?.label) return null;
  return (
    <span className="sidebar-resource-tag" data-tone={tag.tone || 'muted'} title={tag.title || undefined}>
      {tag.label}
    </span>
  );
}

/** Shared title line for sidebar rail resource rows (Workflows, Schedules,
 *  Webhooks, Extensions). Places a small framed status tag immediately next
 *  to the title, vertically centered on the line box. The title ellipsizes
 *  first; the tag never wraps or pushes the layout. */
export function SidebarResourceTitle({
  label,
  tag,
  children,
}: {
  label: ReactNode;
  tag?: SidebarResourceTag | null;
  /** A live status in the tag's place (a connector's sign-in step). */
  children?: ReactNode;
}) {
  return (
    <span className="sidebar-resource-title">
      <b title={typeof label === 'string' ? label : undefined}>{label}</b>
      <SidebarResourceTagBadge tag={tag} />
      {children}
    </span>
  );
}
