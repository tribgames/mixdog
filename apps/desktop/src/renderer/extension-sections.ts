export const EXTENSION_SECTIONS = ['plugins', 'skills'] as const;

export type ExtensionsSection = typeof EXTENSION_SECTIONS[number];

export function extensionSectionForSettings(
  section: string | null | undefined,
): ExtensionsSection | null {
  if (section === 'plugins' || section === 'voice' || section === 'memory') {
    return 'plugins';
  }
  if (section === 'skills' || section === 'mcp') return 'skills';
  return null;
}
