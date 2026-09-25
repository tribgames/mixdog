// A Korean template writes the particle once, after the token: "{{company}}은", "{{name}}이". Which form is right
// depends on the value that lands there — 모아페이는, 한빛상사는, 서울은 — so a filled letter read "모아페이은".
// These are the literal rewrites fill_template runs before its plain token pass, on both backends: the token
// with the particle as authored and the boundary after it, to the value with the particle its last syllable
// takes. A value that does not end in a Hangul syllable (a figure, a Latin name) keeps the particle as written.
const PAIRS = Object.freeze([
  ['으로', '로'],
  ['이며', '며'],
  ['이고', '고'],
  ['은', '는'],
  ['이', '가'],
  ['을', '를'],
  ['과', '와'],
  ['아', '야'],
]);
// The particle ends the word only when a space or punctuation follows; "{{name}}이사" is a noun, not 이.
const BOUNDARIES = Object.freeze([' ', ',', '.', '\u00B7', ')', '!', '?']);

function finalConsonant(value) {
  const last = [...String(value ?? '').trim()].at(-1) || '';
  const code = last.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return null;
  return (code - 0xac00) % 28;
}

export function koreanParticleReplacements(tokens) {
  const replacements = [];
  for (const [key, raw] of Object.entries(tokens && typeof tokens === 'object' ? tokens : {})) {
    const value = String(raw ?? '');
    const jong = finalConsonant(value);
    if (jong === null) continue;
    for (const [withFinal, withoutFinal] of PAIRS) {
      // 으로 takes 로 after a vowel and after ㄹ (final index 8): 서울로, 부산으로.
      const right = withFinal === '으로' ? (jong === 0 || jong === 8 ? withoutFinal : withFinal) : jong ? withFinal : withoutFinal;
      for (const authored of [withFinal, withoutFinal]) {
        for (const boundary of BOUNDARIES) {
          replacements.push({ key, find: `{{${key}}}${authored}${boundary}`, replace: `${value}${right}${boundary}` });
        }
      }
    }
  }
  return replacements;
}
