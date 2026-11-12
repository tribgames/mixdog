// Folds a core `thread/read` answer (JSON on stdin) into the transcript rows a client holds, with the product's own fold
// (packages/protocol-client/src/rows.ts: `rowOf` for each item, then `mergeToolRows`), and prints the rows as one JSON line.
// Run by mixdog-core run_host/restart_prefix_tests.rs, which compares them with Node's cold read of the same session.
import { readFileSync } from 'node:fs';
import { mergeToolRows, rowOf } from '../../../packages/protocol-client/src/rows.ts';

const read = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(`${JSON.stringify(mergeToolRows(read.items.map(rowOf).filter((row) => row !== null)))}\n`);
