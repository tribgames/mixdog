/**
 * Native desktop coordinates, as the input backends use them: physical pixels
 * on Windows and Linux, and on macOS the global display points Electron
 * already reports, so no conversion applies there.
 */
import { screen, type Display } from 'electron';

type Point = { x: number; y: number };

function rounded(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function nativeToDip(point: Point): Point {
  return process.platform === 'darwin' ? rounded(point) : screen.screenToDipPoint(rounded(point));
}

export function dipToNative(point: Point): Point {
  return process.platform === 'darwin' ? rounded(point) : screen.dipToScreenPoint(rounded(point));
}

/** A display's rectangle in native coordinates. */
export function nativeDisplayGeometry(display: Display): { x: number; y: number; width: number; height: number } {
  if (process.platform === 'darwin') return { ...display.bounds };
  const origin = display.nativeOrigin ?? { x: display.bounds.x, y: display.bounds.y };
  return {
    x: origin.x,
    y: origin.y,
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
}
