// The core reports how its one-time `desktop` defaults separation ended in the `initialize` reply (`defaultsSeparation`); a failure
// is handed on to be recorded in the desktop's diagnostics log as Node's app-ready catch recorded it (main/boot-timeline.ts), and never\n// stops the desktop.
import type { InitializeResponse } from '../../../../../packages/protocol/src/index';

export function reportDefaultsSeparation(
  reply: Pick<InitializeResponse, 'defaultsSeparation'>,
  failed: (details: { message: string }) => void
): void {
  const { defaultsSeparation } = reply;
  // A core that reports nothing is the same as one that separated: only an explicit failure is recorded.
  if (defaultsSeparation?.ok !== false) return;
  failed({ message: defaultsSeparation.message ?? '' });
}
