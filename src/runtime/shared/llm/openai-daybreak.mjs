// Daybreak Blue on the OpenAI OAuth (ChatGPT) route.
//
// Blue is a per-request access program on a regular model: a route turns it
// on with the `daybreak` model parameter and the Responses request then
// carries `access_programs: { cyber: "daybreak_blue" }`. The model catalog
// decides which models accept it (`available_access_programs.cyber`);
// entitlement stays with the server, the client only forwards the selection.

export const DAYBREAK_PROVIDER = 'openai-oauth';
export const DAYBREAK_PARAMETER_ID = 'daybreak';
export const DAYBREAK_ON = 'on';
export const DAYBREAK_OFF = 'off';
export const DAYBREAK_BLUE_PROGRAM = 'daybreak_blue';
const STANDARD_PROGRAM = 'standard';

export const DAYBREAK_PARAMETER_OPTION = Object.freeze({
  id: DAYBREAK_PARAMETER_ID,
  label: 'Daybreak Blue',
  kind: 'boolean',
  options: Object.freeze([
    Object.freeze({ value: DAYBREAK_OFF, label: 'Off' }),
    Object.freeze({ value: DAYBREAK_ON, label: 'On' }),
  ]),
});

const clean = (value) => String(value ?? '').trim();

/** Catalog `available_access_programs.cyber` as a string list; null when the row has none. */
export function catalogAccessPrograms(raw) {
  const cyber = raw?.cyber;
  return Array.isArray(cyber) ? cyber.map(clean).filter(Boolean) : null;
}

/**
 * Whether a model accepts Blue: only when the catalog's access-program list
 * for it names the program. A row with no list (or a bare id) is not offered
 * the toggle; the server's catalog is the only source of this entitlement.
 */
export function daybreakBlueSupported(model) {
  return Array.isArray(model?.accessPrograms) && model.accessPrograms.includes(DAYBREAK_BLUE_PROGRAM);
}

/**
 * The access program a model exists only for: its catalog list names
 * programs but not the standard one, so the model is that program's
 * standalone variant (superseded by the per-route toggle). Null otherwise,
 * including when the catalog says nothing.
 */
export function accessProgramOnly(model) {
  const programs = model?.accessPrograms;
  if (!Array.isArray(programs) || !programs.length || programs.includes(STANDARD_PROGRAM)) return null;
  return programs[0];
}

/** The model parameters that select an access program on a regular model; null when Mixdog offers no toggle for it. */
export function accessProgramModelParameters(program) {
  return program === DAYBREAK_BLUE_PROGRAM ? { [DAYBREAK_PARAMETER_ID]: DAYBREAK_ON } : null;
}

export function daybreakBlueOn(modelParameters) {
  return clean(modelParameters?.[DAYBREAK_PARAMETER_ID]).toLowerCase() === DAYBREAK_ON;
}

/** The request's `access_programs` value, or null when Blue is off or unsupported. */
export function daybreakAccessPrograms(model, modelParameters) {
  return daybreakBlueOn(modelParameters) && daybreakBlueSupported(model) ? { cyber: DAYBREAK_BLUE_PROGRAM } : null;
}
