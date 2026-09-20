// Model-surface report for an ordered sequence: full success, file-level
// partial (continue mode), or ordered-stop with committed/skipped accounting.

// reject_partial=false may have skipped individual V4A hunks in ANY
// already-processed section; surface them in BOTH the success and failure
// reports so the reported disk state stays complete even when a later
// section fails.
function rejectedHunkTail(rejected) {
  if (rejected.length === 0) return '';
  return (
    '\n' +
    [
      '',
      `hunk-level rejected (rejectPartial=false, V4A): ${rejected.length}`,
      ...rejected.map(
        (r) =>
          `  REJECT ${r.file || '(unknown)'} — ${String(r.reason || '')
            .split(';')[0]
            .trim()}`
      ),
    ].join('\n')
  );
}

function partialReport({ units, applied, failures, appliedTexts, dryRun }) {
  const committedPhrase = dryRun
    ? `${applied.length}/${units.length} file section(s) validated`
    : `${applied.length}/${units.length} file(s) applied to disk (committed)`;
  const lines = [
    `Error: apply_patch file-level partial: ${committedPhrase}; ${failures.length} file(s) rejected and left unchanged.`,
    'Retry only the rejected files; do not resend committed files.',
  ];
  if (appliedTexts) {
    lines.push(`--- ${dryRun ? 'validated' : 'applied (committed to disk)'} ---`, appliedTexts);
  }
  for (const failure of failures) {
    lines.push(
      `--- rejected file ${failure.index + 1}/${units.length}: ${failure.displayPath} ---`,
      failure.error.replace(/^Error:\s*/, '')
    );
  }
  return lines.join('\n');
}

function stoppedReport({ units, applied, skipped, failed, failedIndex, appliedTexts, dryRun }) {
  const failMsg = failed.error.replace(/^Error:\s*/, '');
  const committedPhrase = dryRun
    ? `${applied.length} earlier section(s) were validated`
    : `${applied.length} earlier section(s) were applied to disk (committed) and left in place`;
  const lines = [
    `Error: apply_patch sequence stopped at section ${failedIndex + 1}/${units.length} (${failed.displayPath}); ` +
      `${committedPhrase}; ${skipped.length} later section(s) were skipped (not attempted).`,
  ];
  if (!dryRun) {
    lines.push('Retry only the failed and skipped sections; do not resend committed sections.');
  }
  if (appliedTexts) {
    lines.push(`--- ${dryRun ? 'validated' : 'applied (committed to disk)'} ---`, appliedTexts);
  }
  lines.push(`--- failed section: ${failed.displayPath} ---`, failMsg);
  if (skipped.length > 0) {
    lines.push(`--- skipped (not attempted): ${skipped.join(', ')} ---`);
  }
  return lines.join('\n');
}

export function formatSequenceReport({ units, outcome, dryRun, rejectedHunks, continueAfterFailure }) {
  const { applied, skipped, failures, failed, failedIndex } = outcome;
  const dryNote =
    dryRun && units.length > 1
      ? "\n(dry_run: each section validated against unchanged disk; a section depending on an earlier section's edits may report a false failure)"
      : '';
  const appliedTexts = applied
    .map((a) => a.text)
    .filter(Boolean)
    .join('\n');
  const rejectedTail = rejectedHunkTail(Array.isArray(rejectedHunks) ? rejectedHunks : []);
  let body;
  if (continueAfterFailure && failures.length > 0) {
    body = partialReport({ units, applied, failures, appliedTexts, dryRun });
  } else if (!failed) {
    const head = `apply_patch: ${dryRun ? 'validated' : 'applied'} ${units.length} section(s)`;
    body = appliedTexts ? `${head}\n${appliedTexts}` : head;
  } else {
    body = stoppedReport({ units, applied, skipped, failed, failedIndex, appliedTexts, dryRun });
  }
  return body + dryNote + rejectedTail;
}
