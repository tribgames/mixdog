import { createLucideIcon } from 'lucide-react';

// Visualize: an artboard with a pointer on it (mockups you point at to give
// feedback). A real lucide-style component so `svg.lucide` stroke/size tuning
// (tab-bar toggles, rail, mobile tabs) applies like every neighbouring glyph.
// Keep `CapabilityIcon` 'visualize' artwork on the same concept.
export const VisualizeIcon = createLucideIcon('Visualize', [
  ['rect', { x: '3', y: '3.5', width: '14', height: '13', rx: '2', key: 'board' }],
  ['path', { d: 'M7 8.5h6M7 11.5h3', key: 'lines' }],
  ['path', { d: 'M12.5 12.5 21 15.6l-3.6 1.5-1.5 3.6Z', key: 'cursor' }],
]);
