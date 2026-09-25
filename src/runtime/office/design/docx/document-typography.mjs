// The serif Latin faces the presets set their display role in.
const SERIF_FACE = /^(?:cambria|georgia|bookman old style|times new roman|garamond|book antiqua|palatino linotype|constantia)$/i;

/** Font coverage is script-specific, not a choice of document genre. Callers
 *  can name the recipient's East Asian font independently of the Latin face.
 *  Unnamed, the Korean face follows the class of the Latin one beside it: Cambria
 *  digits beside Malgun Gothic Hangul read as two typefaces in one heading, so a
 *  serif role takes Batang (바탕), the serif Korean Windows and Office carry. */
export function documentTypography(operation, typography) {
  const text = JSON.stringify([operation.title, operation.subtitle, operation.summary, operation.sections]);
  const korean =
    /^ko(?:-|$)/i.test(operation.language || '') || /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(text);
  const eastAsia = operation.nameEastAsia || (korean ? 'Malgun Gothic' : '');
  return {
    ...typography,
    eastAsia,
    eastAsiaFor: (latin) =>
      !operation.nameEastAsia && korean && SERIF_FACE.test(String(latin || '').trim()) ? 'Batang' : eastAsia,
  };
}
