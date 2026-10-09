// The serif Latin faces the presets set their display role in.
export const SERIF_FACE =
  /^(?:cambria|georgia|bookman old style|times new roman|garamond|book antiqua|palatino linotype|constantia)$/i;
export const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;

// The Latin faces the presets assign that carry no Hangul. Set beside Hangul,
// their digits print smaller than the Korean face the reader substitutes
// ("20시", "1% 미만"), so a Korean sheet sets each such role in the Korean face
// of its class. A sheet cell holds one face, so a serif role takes Batang. Any
// other face is the author's and stays. Word never goes through here: it pairs
// a Korean face per run and keeps the Latin face as given (see documentTypography).
const LATIN_OFFICE_FACE =
  /^(?:calibri|arial|cambria|bookman old style|courier new|times new roman|georgia|segoe ui|aptos)$/i;
export function koreanDesign(design, text) {
  const typography = design?.tokens?.typography;
  if (!typography || !HANGUL.test(text)) return design;
  const faces = Object.fromEntries(
    Object.entries(typography).map(([role, face]) => {
      const name = String(face || '').trim();
      if (!LATIN_OFFICE_FACE.test(name)) return [role, face];
      if (SERIF_FACE.test(name)) return [role, 'Batang'];
      return [role, 'Malgun Gothic'];
    })
  );
  return { ...design, tokens: { ...design.tokens, typography: faces } };
}

/** Font coverage is script-specific, not a choice of document genre. Callers
 *  can name the recipient's East Asian font independently of the Latin face.
 *  Unnamed, the Korean face follows the class of the Latin one beside it: Cambria
 *  digits beside Malgun Gothic Hangul read as two typefaces in one heading, so a
 *  serif role takes Batang (바탕), the serif Korean Windows and Office carry. */
/** Pairs the East Asian face with the table faces the presets set by `fontName`
 *  alone, so Hangul in a cell takes the same face as the prose, never a stand-in.
 *  A face the operation already names for the East Asian script stays. */
export function pairTableEastAsia(output, type) {
  for (const entry of output) {
    const properties = entry.properties;
    if (!properties?.fontName || properties.fontNameEastAsia) continue;
    if (entry.op !== 'add_table' && entry.op !== 'set_table_cell_style') continue;
    const eastAsia = type.eastAsiaFor(properties.fontName);
    if (eastAsia) properties.fontNameEastAsia = eastAsia;
  }
  return output;
}

export function documentTypography(operation, typography) {
  const text = JSON.stringify([operation.title, operation.subtitle, operation.summary, operation.sections]);
  const korean = /^ko(?:-|$)/i.test(operation.language || '') || HANGUL.test(text);
  const eastAsia = operation.nameEastAsia || (korean ? 'Malgun Gothic' : '');
  return {
    ...typography,
    eastAsia,
    eastAsiaFor: (latin) =>
      !operation.nameEastAsia && korean && SERIF_FACE.test(String(latin || '').trim()) ? 'Batang' : eastAsia,
  };
}
