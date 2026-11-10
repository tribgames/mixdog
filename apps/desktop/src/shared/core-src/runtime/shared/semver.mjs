// SemVer 2.0.0 precedence (§11), dependency-free so both Node and the desktop
// renderer can use it. A leading `v` is tolerated, build metadata is ignored,
// and a missing or non-numeric core part reads as 0.

/** Parse a semver-ish string into { parts:[maj,min,patch], prerelease:[ids] }. */
function parseSemver(value) {
  const text = String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split('+')[0];
  const dash = text.indexOf('-');
  const core = dash === -1 ? text : text.slice(0, dash);
  const parts = core.split('.').map((n) => {
    const num = Number.parseInt(n, 10);
    return Number.isFinite(num) ? num : 0;
  });
  while (parts.length < 3) parts.push(0);
  return { parts, prerelease: dash === -1 ? [] : text.slice(dash + 1).split('.') };
}

const NUMERIC = /^\d+$/;

// Numeric identifiers compare numerically and rank below alphanumeric ones,
// which compare in ASCII order.
function compareIdentifiers(a, b) {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) {
    const diff = BigInt(a) - BigInt(b);
    return diff === 0n ? 0 : diff > 0n ? 1 : -1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Compare two semver strings: positive if `a` > `b`, negative if `a` < `b`,
 * 0 if they have equal precedence. A prerelease ranks below its release, and
 * of two prereleases sharing every identifier the shorter one is lower.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  const aPre = pa.prerelease.length;
  const bPre = pb.prerelease.length;
  if (!aPre || !bPre) return aPre === bPre ? 0 : aPre ? -1 : 1;
  for (let i = 0; i < Math.min(aPre, bPre); i++) {
    const diff = compareIdentifiers(pa.prerelease[i], pb.prerelease[i]);
    if (diff !== 0) return diff;
  }
  return Math.sign(aPre - bPre);
}
