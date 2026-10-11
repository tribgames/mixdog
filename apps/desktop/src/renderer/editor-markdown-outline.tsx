// Table of contents and in-document anchors for a rendered Markdown surface.
// Both the Preview and the Rich editor render real h1–h6 elements, so the
// outline reads the DOM instead of parsing the source.
import { useCallback, useEffect, useState, type RefObject } from 'react';
import { t } from './i18n';

export interface OutlineHeading {
  id: string;
  level: number;
  text: string;
  element: HTMLElement;
}

/** GitHub-style anchor slug of a heading's text. */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-');
}

const GENERATED_ID_ATTRIBUTE = 'data-generated-id';

/** The headings under `root`, in document order. With `assignIds`, a heading
 *  without an id gets its (deduplicated) slug so `#anchor` links can reach it;
 *  the Rich editor owns its DOM, so its headings are read without ids. */
export function readHeadings(root: HTMLElement, assignIds: boolean): OutlineHeading[] {
  const elements = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
  // An id this function assigned earlier is regenerated, so the deduplicated
  // sequence follows live edits; only authored ids are kept and reserved.
  const isGenerated = (element: HTMLElement) => element.hasAttribute(GENERATED_ID_ATTRIBUTE);
  const used = new Set(elements.filter((element) => element.id && !isGenerated(element)).map((element) => element.id));
  const headings: OutlineHeading[] = [];
  elements.forEach((element, index) => {
    const text = (element.textContent ?? '').trim();
    if (!text) return;
    let id = isGenerated(element) ? '' : element.id;
    if (!id) {
      const base = slugifyHeading(text) || `section-${index}`;
      id = base;
      for (let suffix = 1; used.has(id); suffix += 1) id = `${base}-${suffix}`;
      if (assignIds) {
        element.id = id;
        element.setAttribute(GENERATED_ID_ATTRIBUTE, '');
      }
    }
    used.add(id);
    headings.push({ id, level: Number(element.tagName.slice(1)), text, element });
  });
  return headings;
}

/** The heading an in-document link `#target` names, if any. */
export function headingForAnchor(headings: readonly OutlineHeading[], target: string): OutlineHeading | null {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // An undecodable fragment is matched as written.
  }
  const slug = slugifyHeading(decoded);
  return (
    headings.find((heading) => heading.id === decoded || heading.id === `user-content-${decoded}`) ??
    headings.find((heading) => slugifyHeading(heading.text) === slug) ??
    null
  );
}

export function scrollToHeading(heading: OutlineHeading): void {
  heading.element.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** Live outline of the rendered surface under `rootRef`, and the heading
 *  currently at the top of its scroll viewport. */
export function useMarkdownOutline(rootRef: RefObject<HTMLElement | null>, enabled: boolean, assignIds: boolean) {
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [activeId, setActiveId] = useState('');
  const refreshActive = useCallback(
    (list: readonly OutlineHeading[]) => {
      const root = rootRef.current;
      if (!root || list.length === 0) return setActiveId('');
      const top = root.getBoundingClientRect().top + 32;
      let current = list[0];
      for (const heading of list) {
        if (heading.element.getBoundingClientRect().top <= top) current = heading;
        else break;
      }
      setActiveId(current.id);
    },
    [rootRef]
  );
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return undefined;
    let frame = 0;
    let latest: OutlineHeading[] = [];
    const scan = () => {
      frame = 0;
      latest = readHeadings(root, assignIds);
      setHeadings((current) =>
        current.length === latest.length &&
        current.every(
          (heading, index) =>
            heading.id === latest[index].id &&
            heading.text === latest[index].text &&
            heading.element === latest[index].element
        )
          ? current
          : latest
      );
      refreshActive(latest);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(scan);
    };
    scan();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    // Scroll does not bubble: the capture phase sees whichever descendant scrolls.
    const onScroll = () => refreshActive(latest);
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      root.removeEventListener('scroll', onScroll, { capture: true });
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [rootRef, enabled, assignIds, refreshActive]);
  return { headings, activeId };
}

/** Slim right-side outline; indentation follows the heading level. */
export function EditorOutline({ headings, activeId }: { headings: readonly OutlineHeading[]; activeId: string }) {
  const shallowest = headings.reduce((min, heading) => Math.min(min, heading.level), 6);
  return (
    <nav className="editor-outline" aria-label={t('Table of contents')}>
      {headings.length === 0 ? (
        <p className="editor-outline-empty">{t('No headings')}</p>
      ) : (
        <ul>
          {headings.map((heading, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: heading ids can repeat, so the index keeps keys unique
            <li key={`${heading.id}:${index}`}>
              <button
                type="button"
                className={heading.id === activeId ? 'is-active' : undefined}
                aria-current={heading.id === activeId ? 'location' : undefined}
                style={{ paddingLeft: 8 + (heading.level - shallowest) * 12 }}
                title={heading.text}
                onClick={() => scrollToHeading(heading)}
              >
                {heading.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
