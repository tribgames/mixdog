import type { ChildProcess } from 'node:child_process';

/** Settles once the kill was attempted (on Windows: once taskkill finished). */
export function killChildTree(child: ChildProcess): Promise<void>;
