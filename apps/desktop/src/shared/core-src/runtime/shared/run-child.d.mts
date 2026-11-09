import type { ChildProcess } from 'node:child_process';

/** Settles once the kill was attempted (on Windows: once the tree kill finished). */
export function killChildTree(child: ChildProcess): Promise<void>;
