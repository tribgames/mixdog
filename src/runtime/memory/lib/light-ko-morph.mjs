// Model-free Korean query normalization for recall search. This intentionally
// handles only high-confidence particles and common predicate endings; hybrid
// embedding and substring retrieval cover expressions outside this small set.

const MIXED_SCRIPT_KOREAN_PARTICLES = [
  '으로부터',
  '에게서',
  '한테서',
  '께서는',
  '에서는',
  '으로는',
  '에게는',
  '한테는',
  '께서',
  '에서',
  '으로',
  '에게',
  '한테',
  '처럼',
  '보다',
  '부터',
  '까지',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '에',
  '로',
  '와',
  '과',
  '의',
  '도',
  '만',
];

const HADA_ENDINGS = [
  '하셨었던',
  '하셨던',
  '하였던',
  '했었던',
  '했습니다',
  '하였다',
  '했는데',
  '했지만',
  '했으며',
  '했던',
  '해서',
  '하고',
  '하면',
  '하는',
  '했다',
  '했음',
];

// Particles stripped whenever at least two syllables remain.
const UNCONDITIONAL_PARTICLES = [
  '으로부터',
  '에게서',
  '한테서',
  '께서는',
  '에서는',
  '에게는',
  '한테는',
  '께서',
  '에서',
  '에게',
  '한테',
  '부터',
  '까지',
];

// Particles whose form depends on the stem's final consonant (batchim).
const BATCHIM_PARTICLES = [
  ['으로', (jong) => jong !== 0 && jong !== 8],
  ['은', (jong) => jong !== 0],
  ['는', (jong) => jong === 0],
  ['이', (jong) => jong !== 0],
  ['가', (jong) => jong === 0],
  ['을', (jong) => jong !== 0],
  ['를', (jong) => jong === 0],
  ['과', (jong) => jong !== 0],
  ['와', (jong) => jong === 0],
];

// Past-attributive endings and the syllable that restores the stem.
const PAST_ATTRIBUTIVE_ENDINGS = [
  ['되었던', ''],
  ['됐던', ''],
  ['왔던', '오'],
  ['겼던', '기'],
];

function hangulFinalConsonantIndex(text) {
  const point = text.codePointAt(text.length - 1);
  if (!Number.isFinite(point) || point < 0xac00 || point > 0xd7a3) return null;
  return (point - 0xac00) % 28;
}

export function stripLightKoreanParticle(token) {
  const value = String(token ?? '').trim();
  if (!value) return '';

  const mixed = value.match(/^([a-z0-9_./:-]{2,})([\p{Script=Hangul}]+)$/iu);
  if (mixed && MIXED_SCRIPT_KOREAN_PARTICLES.includes(mixed[2])) return mixed[1];
  if (!/^[\p{Script=Hangul}]+$/u.test(value)) return value;

  for (const suffix of UNCONDITIONAL_PARTICLES) {
    const stem = value.slice(0, -suffix.length);
    if (stem.length >= 2 && value.endsWith(suffix)) return stem;
  }

  for (const [suffix, accepts] of BATCHIM_PARTICLES) {
    if (!value.endsWith(suffix)) continue;
    const stem = value.slice(0, -suffix.length);
    if (stem.length < 2) continue;
    const jong = hangulFinalConsonantIndex(stem);
    if (jong != null && accepts(jong)) return stem;
  }
  return value;
}

export function normalizeLightKoreanToken(token) {
  const value = stripLightKoreanParticle(
    String(token ?? '')
      .trim()
      .toLowerCase()
  );
  if (!/^[\p{Script=Hangul}]+$/u.test(value)) return value;

  for (const ending of HADA_ENDINGS) {
    if (!value.endsWith(ending)) continue;
    const stem = value.slice(0, -ending.length);
    if (stem.length >= 2) return stem;
  }

  for (const [ending, restored] of PAST_ATTRIBUTIVE_ENDINGS) {
    if (!value.endsWith(ending)) continue;
    const stem = `${value.slice(0, -ending.length)}${restored}`;
    if (stem.length >= 2) return stem;
  }
  return value;
}

export function lightKoMorphStems(text) {
  const raw = String(text ?? '').match(/-{0,2}[\p{L}\p{N}_][\p{L}\p{N}_./:-]*/gu) || [];
  return [...new Set(raw.map(normalizeLightKoreanToken).filter(Boolean))];
}
