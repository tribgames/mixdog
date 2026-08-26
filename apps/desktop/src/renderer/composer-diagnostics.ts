import type { DesktopRendererComposerActionDiagnostic } from '../shared/contract';

export function reportComposerAction(diagnostic: DesktopRendererComposerActionDiagnostic): void {
  try {
    window.mixdogDesktop?.rendererDiagnostic?.(diagnostic);
  } catch {
    // Diagnostics never interrupt the composer action they describe.
  }
}
