// Mutable product and workflow specifications are reviewed explicitly and do
// not participate in blocking invariant gates.
process.env.MIXDOG_TEST_ADVISORY = '1';

await import('./release-gate-test.mjs');
await import('./runtime-turn-contract-test.mjs');
