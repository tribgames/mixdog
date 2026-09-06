import { useLayoutEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useSurfaceActive } from "./surface-activity";

/** Composer menus escape the input's stacking/paint containment, but keep
 * their React owner, selection refs, and textarea keyboard handling. */
export function ComposerPalette({
  anchor,
  panel,
  id,
  label,
  className = "",
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const active = useSurfaceActive();
  useLayoutEffect(() => {
    const input = anchor.current;
    const menu = panel.current;
    if (!active || !input || !menu) return;
    const visual = window.visualViewport;
    const place = () => {
      const rect = input.getBoundingClientRect();
      const left = visual?.offsetLeft ?? 0;
      const top = visual?.offsetTop ?? 0;
      const width = visual?.width ?? window.innerWidth;
      const bottom = top + (visual?.height ?? window.innerHeight);
      const menuBottom = Math.min(rect.top - 8, bottom - 8);
      const menuWidth = Math.max(0, Math.min(rect.width, width - 16));
      const available = Math.max(0, menuBottom - top - 8);
      menu.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - menuWidth - 8))}px`;
      menu.style.width = `${menuWidth}px`;
      menu.style.bottom = `${window.innerHeight - menuBottom}px`;
      menu.style.maxHeight = `${Math.min(344, available)}px`;
      menu.style.visibility = rect.width > 0 && rect.height > 0 && available > 0
        && !input.closest('[inert], [aria-hidden="true"]') ? "visible" : "hidden";
    };
    place();
    // Ancestor sizes can move an unchanged input (diff/goal close, split
    // resize). Observe those boxes too, without a permanent animation loop.
    const resize = new ResizeObserver(place);
    const visibility = new MutationObserver(place);
    for (let node: HTMLElement | null = input; node; node = node.parentElement) {
      resize.observe(node);
      visibility.observe(node, { attributes: true, attributeFilter: ["inert", "aria-hidden", "hidden", "class", "style"] });
    }
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    visual?.addEventListener("resize", place);
    visual?.addEventListener("scroll", place);
    return () => {
      resize.disconnect();
      visibility.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      visual?.removeEventListener("resize", place);
      visual?.removeEventListener("scroll", place);
    };
  }, [active, anchor, panel]);
  if (!active) return null;
  return createPortal(
    <div ref={panel} id={id} className={`slash-palette ${className}`.trim()}
      role="listbox" aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}
