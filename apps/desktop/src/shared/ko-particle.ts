// Korean particles after a name the copy cannot know in advance ("나비" vs
// "Mixy"): chosen by the final consonant (받침) of the last Hangul syllable. A
// final digit counts as its Korean reading; any other non-Hangul end reads as
// having no 받침 (Mixy를). 으로/로 treats a ㄹ 받침 as none (서울로).

export type KoParticle = '이/가' | '을/를' | '은/는' | '과/와' | '으로/로';

const DIGIT_JONG = [21, 8, 0, 16, 0, 0, 1, 8, 8, 0]; // 영 일 이 삼 사 오 육 칠 팔 구
const RIEUL = 8;

function finalConsonant(name: string): number {
  const last = [...name.trim()].pop() ?? '';
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28;
  if (code >= 48 && code <= 57) return DIGIT_JONG[code - 48];
  return 0;
}

/** The particle that follows `name`, from a 받침/no-받침 pair ('이/가' → 이 or 가). */
export function koParticle(name: string, pair: KoParticle): string {
  const [withFinal, without] = pair.split('/');
  const jong = finalConsonant(name);
  if (pair === '으로/로') return jong === 0 || jong === RIEUL ? without : withFinal;
  return jong === 0 ? without : withFinal;
}

// The copy's dual forms ("{{name}}을(를)") and the pair each stands for.
const DUAL_FORMS: Record<string, KoParticle> = {
  '이(가)': '이/가',
  '을(를)': '을/를',
  '은(는)': '은/는',
  '과(와)': '과/와',
  '와(과)': '과/와',
  '(으)로': '으로/로',
};
const OPEN = '\u0001';
const CLOSE = '\u0002';
// A closing quote or bracket may stand between the name and its particle
// ('"나비"를').
const MARKED = new RegExp(
  `${OPEN}([^${CLOSE}]*)${CLOSE}(["'”’」』)\\]]*)(이\\(가\\)|을\\(를\\)|은\\(는\\)|과\\(와\\)|와\\(과\\)|\\(으\\)로)?`,
  'g'
);

/** Marks an interpolated value so `resolveKoParticles` can find what follows it. */
export const markKoValue = (value: string): string => `${OPEN}${value}${CLOSE}`;

/** Replaces each dual form right after a marked value with its one particle,
 *  and drops the marks. */
export function resolveKoParticles(text: string): string {
  return text.replace(MARKED, (_, value: string, closing: string, dual?: string) =>
    dual ? value + closing + koParticle(value, DUAL_FORMS[dual]) : value + closing
  );
}
