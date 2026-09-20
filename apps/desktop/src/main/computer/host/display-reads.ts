/** The attached displays as the inspection surface reports them. */
import { screen } from 'electron';

export function readDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    index,
    id: String(display.id),
    primary: display.id === primaryId,
    scale_factor: display.scaleFactor,
    width: display.size.width,
    height: display.size.height,
  }));
}
