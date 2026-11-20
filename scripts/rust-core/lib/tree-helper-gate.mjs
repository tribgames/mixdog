// The process-tree helper (`treerun`, scripts/rust-core/tree-helper) is built by CI before the tests that need it run
// (release-gate.yml, rust-core job). Without it every such test would only throw or, worse, wait out its 30-60 s timeouts for
// a child that never reports. The absence is one named condition instead: with the helper missing the run fails with a single
// test that says how to build it, and the tests that need it are not registered. MIXDOG_TESTS_WITHOUT_TREE_HELPER=1 is the
// explicit local opt-out (they are then skipped with the same reason); no lane sets it.
import { test as nodeTest } from 'node:test';
import { helperPath } from './process-tree.mjs';

export const WITHOUT_HELPER_ENV = 'MIXDOG_TESTS_WITHOUT_TREE_HELPER';

function absence() {
  try {
    helperPath();
    return null;
  } catch (error) {
    return error.message;
  }
}

/** `test` of node:test, for a file whose every test needs the built helper. */
export function helperTest() {
  const missing = absence();
  if (missing === null) return nodeTest;
  if (process.env[WITHOUT_HELPER_ENV] === '1') {
    return (name, options, fn) =>
      nodeTest(
        name,
        { ...(typeof options === 'object' ? options : {}), skip: `${WITHOUT_HELPER_ENV}=1: ${missing}` },
        typeof options === 'function' ? options : fn
      );
  }
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    nodeTest('the process-tree helper is built', () => {
      throw new Error(`${missing} (the rust-core job builds it; ${WITHOUT_HELPER_ENV}=1 skips these tests locally)`);
    });
  };
}
