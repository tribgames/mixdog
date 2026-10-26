/**
 * Whether the Computer Use pill is on screen, for the pills that stack under
 * it. "On screen" runs from the render that shows it to the end of its fade,
 * so a pill still fading is never drawn over.
 */
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
