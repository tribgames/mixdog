const TRUNCATED = '… [diff truncated for display]';

/** Bound hunk bodies, never the inventory of changed files. Headers are kept
 * even when the inventory itself exceeds the display budget. */
export function boundReviewPatch(patch, maxChars) {
  const alreadyTruncated = patch.includes(TRUNCATED);
  if (patch.length <= maxChars) return { patch, truncated: alreadyTruncated };
  const sections = patch
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((section) => {
      const start = section.search(/^@@/m);
      return start < 0
        ? { header: section, body: '' }
        : { header: section.slice(0, start), body: section.slice(start) };
    });
  // Reserve every filename and omission notice before allocating any hunks.
  let remaining = Math.max(
    0,
    maxChars - sections.reduce((total, section) => total + section.header.length + TRUNCATED.length + 1, 0)
  );
  let truncated = alreadyTruncated;
  const bounded = sections
    .map(({ header, body }) => {
      if (body.length <= remaining) {
        remaining -= body.length;
        return header + body;
      }
      truncated = true;
      return `${header}${TRUNCATED}\n`;
    })
    .join('');
  return { patch: bounded, truncated };
}
