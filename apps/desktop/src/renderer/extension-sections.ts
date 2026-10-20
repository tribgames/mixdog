// Extensions pane tabs: 익스텐션 (built-ins and plugins without MCP) and
// 커넥터 (catalog services, raw MCP servers and plugins that bring MCP).
const EXTENSION_SECTIONS = ['plugins', 'connectors'] as const;

export type ExtensionsSection = (typeof EXTENSION_SECTIONS)[number];

export function extensionSectionForSettings(section: string | null | undefined): ExtensionsSection | null {
  if (section === 'plugins' || section === 'voice' || section === 'memory' || section === 'git') {
    return 'plugins';
  }
  if (section === 'mcp' || section === 'connectors') return 'connectors';
  return null;
}
