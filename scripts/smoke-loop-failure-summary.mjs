export function actionableFailureCount(stdout) {
  let summary;
  try {
    summary = JSON.parse(stdout);
  } catch {
    throw new Error(`tool failures returned malformed JSON:\n${stdout}`);
  }

  const matched = summary?.actionable_failures?.matched;
  if (!Number.isInteger(matched) || matched < 0) {
    throw new Error(
      `tool failures returned malformed result schema: expected actionable_failures.matched to be a non-negative integer:\n${stdout}`,
    );
  }
  return matched;
}
