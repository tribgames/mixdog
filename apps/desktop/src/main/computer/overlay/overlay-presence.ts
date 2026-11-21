const listeners = new Set<() => void>();
/** Each surface that can draw the pill owns its own flag, so one finishing
 *  never clears the other's presence. */
export type ComputerUsePillOwner = 'electron' | 'shell';
const owners: Record<ComputerUsePillOwner, boolean> = { electron: false, shell: false };

export function computerUsePillShown(): boolean {
  return owners.electron || owners.shell;
}

export function setComputerUsePillShown(next: boolean, owner: ComputerUsePillOwner = 'electron'): void {
  const before = computerUsePillShown();
  owners[owner] = next;
  if (before === computerUsePillShown()) return;
  for (const listener of [...listeners]) listener();
}

export function onComputerUsePillShownChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
