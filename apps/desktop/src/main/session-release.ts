/** Runs every step that lets go of a deleted session; one step failing (throwing or rejecting) never skips the others. */
export async function releaseDeletedSession(
  steps: ReadonlyArray<() => unknown>,
  report: (error: unknown) => void = (error) => console.warn('Releasing a deleted session failed:', error)
): Promise<void> {
  await Promise.all(
    steps.map(async (step) => {
      try {
        await step();
      } catch (error) {
        report(error);
      }
    })
  );
}
