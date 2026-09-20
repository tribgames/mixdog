// Ordered execution of the section units: stop at the first failure and skip
// the rest, or — with continueAfterFailure — record each failure and keep
// going. The result reflects true disk state.
import { preValidateNativeBatch } from '../paths.mjs';
import { applyParsedWave } from '../wave.mjs';

export async function runPatchUnits(units, basePath, { waveOpts, abortSignal, continueAfterFailure }) {
  const applied = [];
  const skipped = [];
  const failures = [];
  let failed = null;
  let failedIndex = -1;
  let executor = 'native-patch';
  const noteFailure = (unit, index, error) => {
    const row = { displayPath: unit.displayPath, error, index };
    failures.push(row);
    if (!continueAfterFailure) {
      failed = row;
      failedIndex = index;
    }
  };
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (failed) {
      skipped.push(unit.displayPath);
      continue;
    }
    if (abortSignal?.aborted) {
      noteFailure(unit, i, 'Error: apply_patch aborted');
      continue;
    }
    if (unit.execute) {
      try {
        applied.push({ displayPath: unit.displayPath, text: await unit.execute() });
      } catch (err) {
        noteFailure(unit, i, `Error: ${err?.message || String(err)}`);
      }
      continue;
    }
    let parsed;
    try {
      parsed = await unit.buildParsed();
    } catch (err) {
      noteFailure(unit, i, `Error: ${err?.message || String(err)}`);
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      // Section produced no applicable hunks (all skipped / no-op). Nothing
      // to commit; record and continue.
      applied.push({ displayPath: unit.displayPath, text: `(no changes) ${unit.displayPath}` });
      continue;
    }
    let wave;
    try {
      const { entries, headerRewrites } = await preValidateNativeBatch(parsed, basePath);
      wave = { parsed, entries, headerRewrites };
    } catch (err) {
      noteFailure(unit, i, `Error: ${err?.message || String(err)}`);
      continue;
    }
    const res = await applyParsedWave(wave, basePath, waveOpts);
    executor = res.executor;
    if (res.error) {
      noteFailure(unit, i, res.error);
      continue;
    }
    applied.push({ displayPath: unit.displayPath, text: res.text });
  }
  return { applied, skipped, failures, failed, failedIndex, executor };
}
