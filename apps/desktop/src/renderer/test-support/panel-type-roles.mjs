/** The type tier each role takes in the composer island's panels and in the session panel alike: one token each for
 *  its size, line height and weight (desktop/01-tokens.css). */
export const PANEL_TYPE_ROLES = {
  title: { size: '--mx-font-item', line: '--mx-line-ui', weight: '--mx-weight-label' },
  figures: { size: '--mx-font-meta', line: '--mx-line-ui', weight: '--mx-weight-regular' },
  // To-do's "Remaining 6" line (.session-rail-gl).
  kind: { size: '--mx-font-meta', line: '--mx-line-meta', weight: '--mx-weight-label' },
  // An agent's name, finished or at work: a row name, as a left sidebar session row's.
  name: { size: '--mx-font-item', line: '--mx-line-ui', weight: '--mx-weight-regular' },
  working: { size: '--mx-font-item', line: '--mx-line-ui', weight: '--mx-weight-regular' },
  // A row's name at rest: a to-do step, a context kind, a changed file.
  row: { size: '--mx-font-item', line: '--mx-line-ui', weight: '--mx-weight-regular' },
  // A row's own figures: a context kind's tokens and share, a file's line counts, an agent's steps.
  rowFigures: { size: '--mx-font-meta', line: '--mx-line-meta', weight: '--mx-weight-regular' },
  command: { size: '--mx-font-code', line: '--mx-line-ui', weight: '--mx-weight-regular' },
  state: { size: '--mx-font-supporting', line: '--mx-line-meta', weight: '--mx-weight-regular' },
  foot: { size: '--mx-font-supporting', line: '--mx-line-meta', weight: '--mx-weight-regular' },
  button: { size: '--mx-font-meta', line: '--mx-line-meta', weight: '--mx-weight-regular' },
};

/** Runs in the page (`page.evaluate(typeOffTier, PANEL_TYPE_ROLES, selectors)`): every element of each role (a selector
 *  per role) whose computed size, line height or weight is not its tier's, the tokens read where the element stands. */
export function typeOffTier(roles, selectors) {
  const read = (style) => [style.fontSize, style.lineHeight, style.fontWeight].join(' / ');
  const off = [];
  for (const [role, selector] of Object.entries(selectors)) {
    const nodes = [...document.querySelectorAll(selector)];
    if (!nodes.length) off.push(`${role}: nothing matches ${selector}`);
    for (const node of nodes) {
      const tier = roles[role];
      const probe = document.createElement('span');
      probe.style.fontSize = `var(${tier.size})`;
      probe.style.lineHeight = `var(${tier.line})`;
      probe.style.fontWeight = `var(${tier.weight})`;
      node.parentElement.append(probe);
      const want = read(getComputedStyle(probe));
      probe.remove();
      const got = read(getComputedStyle(node));
      if (got !== want) off.push(`${role} (${selector}): ${got} ≠ ${want}`);
    }
  }
  return [...new Set(off)];
}
