import type { ReactNode } from 'react';

export type SidebarResourceTagTone = 'muted' | 'warn' | 'danger' | 'ok';

export type SidebarResourceTag = {
  label: string;
  tone?: SidebarResourceTagTone;
};

/** Shared title line for sidebar rail resource rows (Workflows, Schedules,
 *  Webhooks, Extensions). Places a small framed status tag immediately next
 *  to the title, vertically centered on the line box. The title ellipsizes
 *  first; the tag never wraps or pushes the layout. */
export function SidebarResourceTitle({
  label,
  tag,
}: {
  label: ReactNode;
  tag?: SidebarResourceTag | null;
}) {
  return <span className="sidebar-resource-title">
    <b>{label}</b>
    {tag?.label ? <span className="sidebar-resource-tag" data-tone={tag.tone || 'muted'}>{tag.label}</span> : null}
  </span>;
}
