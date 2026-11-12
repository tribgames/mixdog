// What a replay states about itself beyond the generated manifest, kept in lib/replay-notes/<set>.json so that a re-recording writes it again.
// Each exclusion is a declaration in the manifest's own schema (`replay.declaredExclusions`: { case, keys, reason }) with the side whose behaviour
// the difference is on (`node`: the recording's own artefact; `rust`: how the core states it), and is checked against the recording as it is read:
// the case it names exists, and every key it names is a field the case recorded (or, for case `*`, a field some case recorded).
import { readFileSync } from 'node:fs';
import { RecorderError } from './recorder-error.mjs';

const SIDES = ['node', 'rust'];
const has = (value, path) => path.split('.').every((step) => value !== null && typeof value === 'object' && Object.hasOwn(value, step) && ((value = value[step]), true));

/** The notes of a set, checked against its recorded `cases` (`[{ case, observed }]`): `{ replayTests, fieldMap, declaredExclusions, open }`. */
export function readReplayNotes(url, cases) {
  const { _about, ...notes } = JSON.parse(readFileSync(url, 'utf8'));
  const declarations = (list, what) => {
    if (!Array.isArray(list)) throw new RecorderError(`${what} is a list of declarations`);
    for (const [index, declaration] of list.entries()) {
      const at = `${what}[${index}]`;
      if (!SIDES.includes(declaration.side)) throw new RecorderError(`${at}: side is one of ${SIDES.join(', ')}`);
      if (typeof declaration.reason !== 'string' || declaration.reason.trim().length < 20) throw new RecorderError(`${at}: a reason is stated`);
      if (!Array.isArray(declaration.keys) || !declaration.keys.length || !declaration.keys.every((key) => typeof key === 'string' && key)) throw new RecorderError(`${at}: keys name the fields it concerns`);
      const named = declaration.case === '*' ? cases : cases.filter((c) => c.case === declaration.case);
      if (!named.length) throw new RecorderError(`${at}: no recorded case is named ${JSON.stringify(declaration.case)}`);
      for (const key of declaration.keys) {
        const found = declaration.case === '*' ? named.some((c) => has(c.observed, key)) : named.every((c) => has(c.observed, key));
        if (!found) throw new RecorderError(`${at}: ${JSON.stringify(key)} is not a field the recording of ${JSON.stringify(declaration.case)} holds`);
      }
    }
  };
  declarations(notes.declaredExclusions, 'declaredExclusions');
  declarations(notes.open, 'open');
  return notes;
}
