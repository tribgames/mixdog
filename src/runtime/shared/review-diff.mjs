const TRUNCATED = '… [diff truncated for display]';

// Review replies always list every changed file with its counts. Patch text
// is carried per file within these caps (UTF-8 bytes); a file past either one
// is listed `patchOmitted` with reason PATCH_TOO_LARGE and is read on its own,
// up to the larger "show anyway" cap, when it is opened.
/** Largest single-file patch a review reply carries inline. */
export const REVIEW_FILE_PATCH_MAX_BYTES = 1024 * 1024;
/** Largest total patch text a review reply carries. */
export const REVIEW_PATCH_MAX_BYTES = 2 * 1024 * 1024;
/** Largest single-file patch a file-patch read returns. */
export const REVIEW_FILE_PATCH_SHOW_MAX_BYTES = 8 * 1024 * 1024;
export const PATCH_TOO_LARGE = 'too_large';

/** A reply file listed with its counts but without its patch, for size. */
export function patchOmittedFile(file) {
  return { ...file, patchOmitted: true, reason: PATCH_TOO_LARGE };
}

/** A `diff --git` section (string or Buffer) whose hunks boundReviewPatch cut. */
export function reviewSectionTruncated(section) {
  return section.includes(TRUNCATED);
}

/** Nothing of the reply's patch fit: no patch text, a file omitted for size. */
export function reviewDiffTooLarge(files, patch) {
  return !patch && (files || []).some((file) => file?.patchOmitted === true && file.reason === PATCH_TOO_LARGE);
}

/** The per-file and total caps of one reply. `admit(bytes)` takes a patch of
 *  that size from the remaining total, or refuses it. */
export function createReviewPatchBudget(total = REVIEW_PATCH_MAX_BYTES) {
  let remaining = total;
  return {
    get remaining() {
      return remaining;
    },
    admit(bytes) {
      if (bytes > REVIEW_FILE_PATCH_MAX_BYTES || bytes > remaining) return false;
      remaining -= bytes;
      return true;
    },
  };
}

/** One file-patch read's reply: its patch, or none when past `maxBytes`. */
export function filePatchReply(path, patch, maxBytes = REVIEW_FILE_PATCH_SHOW_MAX_BYTES) {
  const text = typeof patch === 'string' ? patch : '';
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { supported: true, path, patch: '', patchOmitted: true, reason: PATCH_TOO_LARGE };
  }
  return { supported: true, path, patch: text };
}

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
