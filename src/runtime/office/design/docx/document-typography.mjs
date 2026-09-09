/** Font coverage is script-specific, not a choice of document genre. Callers
 *  can name the recipient's East Asian font independently of the Latin face. */
export function documentTypography(operation, typography) {
  const text = JSON.stringify([operation.title, operation.subtitle, operation.summary, operation.sections]);
  const korean = /^ko(?:-|$)/i.test(operation.language || '') || /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(text);
  return {
    ...typography,
    eastAsia: operation.nameEastAsia || (korean ? 'Malgun Gothic' : ''),
  };
}
