// Floating zoom control at the bottom centre of a Browser Use surface (user:
// 화면 하단 중앙에 확대축소 프로그래스): [−] slider [+], nothing else — the
// slider is the same 4px app-ink range the Studio density and route context
// controls use (user: 다른 스튜디오나 프로그래스 쓰는 데랑 맞춰). Rests
// translucent so the page stays readable; sharpens while pointed at or
// dragged. The value is voiced for assistive tech only.
import { Minus, Plus } from "lucide-react";

import {
  BROWSER_ZOOM_MAX,
  BROWSER_ZOOM_MIN,
  BROWSER_ZOOM_STEP,
  clampBrowserZoom,
  stepBrowserZoom,
} from "./browser-zoom-level";
import { t } from "./i18n";

export function BrowserZoomPill({
  level,
  onChange,
}: {
  level: number;
  onChange(level: number): void;
}) {
  const percent = Math.round(level * 100);
  return <div className="browser-zoom-pill" role="group" aria-label={t("Zoom")}
    // Pointer events on the pill must never reach the surface below: the
    // phone pane turns every press into a page gesture.
    onPointerDown={(event) => event.stopPropagation()}
    onPointerUp={(event) => event.stopPropagation()}
    onWheel={(event) => event.stopPropagation()}>
    <button type="button" className="browser-zoom-step"
      disabled={level <= BROWSER_ZOOM_MIN}
      onClick={() => onChange(stepBrowserZoom(level, -1))}
      aria-label={t("Zoom out")}>
      <Minus size={14} aria-hidden="true" />
    </button>
    <input type="range" className="browser-zoom-range"
      min={BROWSER_ZOOM_MIN} max={BROWSER_ZOOM_MAX} step={BROWSER_ZOOM_STEP}
      value={level}
      aria-label={t("Zoom")}
      aria-valuetext={`${percent}%`}
      onChange={(event) => onChange(clampBrowserZoom(event.target.valueAsNumber))} />
    <button type="button" className="browser-zoom-step"
      disabled={level >= BROWSER_ZOOM_MAX}
      onClick={() => onChange(stepBrowserZoom(level, 1))}
      aria-label={t("Zoom in")}>
      <Plus size={14} aria-hidden="true" />
    </button>
  </div>;
}
