/** The attached displays as the inspection surface reports them. */
import { screen } from 'electron';
import { nativeDisplayGeometry } from '../shared/native-coordinates';

function origin(display: Electron.Display): { x: number; y: number } {
  const { x, y } = nativeDisplayGeometry(display);
  return { x, y };
}

export function readDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    index,
    id: String(display.id),
    primary: display.id === primaryId,
    scale_factor: display.scaleFactor,
    width: display.size.width,
    height: display.size.height,
    // The origin in native desktop coordinates: the core's desktop bounds and display-frame layout checks.
    ...origin(display),
  }));
}
