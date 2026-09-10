import { useCallback, useEffect, useState, type HTMLAttributes } from "react";
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
} from "./ScmContextMenu";
import { t } from "./i18n";

const STORAGE_KEY = "mixdog.desktop.hidden-dock-icons.v1";
const CHANGE_EVENT = "mixdog:dock-icon-visibility";
export interface DockIconEntry { id: string; label: string }

function readHiddenIcons(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

/** Visibility is independent of layout and open panels; every pane shares it. */
export function useDockIconVisibility() {
  const [hidden, setHidden] = useState(readHiddenIcons);
  useEffect(() => {
    const changed = (event: Event) => setHidden((event as CustomEvent<string[]>).detail);
    const stored = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setHidden(readHiddenIcons());
    };
    window.addEventListener(CHANGE_EVENT, changed);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener(CHANGE_EVENT, changed);
      window.removeEventListener("storage", stored);
    };
  }, []);
  const toggle = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((value) => value !== id) : [...hidden, id];
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch (error) { console.warn("Could not persist dock icon visibility", error); }
    window.dispatchEvent(new window.CustomEvent(CHANGE_EVENT, { detail: next }));
  };
  return { isVisible: (id: string) => !hidden.includes(id), toggle };
}

export function useDockVisibilityMenu(entries: readonly DockIconEntry[], label: string) {
  const visibility = useDockIconVisibility();
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setPoint(null), []);
  const menuProps: HTMLAttributes<HTMLElement> = {
    tabIndex: 0,
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPoint(pointerMenuPoint(event));
    },
    onKeyDown: (event) => {
      if (!isContextMenuKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setPoint(elementMenuPoint(event.target as Element));
    },
  };
  return {
    ...visibility,
    menuProps,
    menu: <ScmContextMenu onClose={close} state={point && {
      ...point,
      label: t(label),
      items: entries.map(({ id, label: itemLabel }) => ({
        id,
        label: itemLabel,
        checked: visibility.isVisible(id),
        checkRole: "menuitemcheckbox",
        onSelect: () => visibility.toggle(id),
      })),
    }} />,
  };
}
