/**
 * Shared Computer Use host types. Kept apart from the host implementation so
 * the observation and program modules can speak the same shapes without
 * depending on a live host.
 */
import type { ChromeUiaElement } from './browser-chrome-uia';

export interface ComputerCommand {
  action: string;
  steps?: Array<Partial<ComputerCommand> & { action: string }>;
  window?: string;
  window_id?: string;
  frame_id?: string;
  ref?: string;
  element?: number;
  text?: string;
  keys?: string;
  dy?: number;
  amount?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  app?: string;
  /** drag destination ref. */
  to?: string;
  to_element?: number;
  /** click family without ref: frame pixels; move_window: physical coordinates. */
  x?: number;
  y?: number;
  /** drag destination in frame pixels. */
  to_x?: number;
  to_y?: number;
  /** move_window size in physical pixels. */
  width?: number;
  height?: number;
  /** click family: modifier keys held during the click, e.g. "ctrl+shift". */
  modifiers?: string;
  delivery?: 'background' | 'foreground';
  read_only?: boolean;
  /** wait: seconds to pause (0..30). */
  duration?: number;
  /** verify: predicates, bounded wait, and consecutive satisfied samples. */
  expect?: Array<Record<string, unknown>>;
  timeout_ms?: number;
  stable_samples?: number;
  /** invoke_menu: exact menu labels from the bar down. */
  path?: string[];
  /** zoom: [x0, y0, x1, y1] region in frame pixels. */
  region?: number[];
  /** screenshot display index (0-based) for multi-monitor setups. */
  screen?: number;
  quality?: number;
  maxWidth?: number;
  query?: string;
  role?: string;
  visible_only?: boolean;
  include_noninteractive?: boolean;
  include_structure?: boolean;
  max_elements?: number;
  continuation?: string;
  mode?: 'state' | 'som' | 'vision' | 'ax';
  include_ocr?: boolean;
  ocr_language?: string;
  max_ocr_words?: number;
  state?: 'minimize' | 'maximize' | 'restore';
  session_id?: string;
  capture_after?: boolean;
  capture_delay_ms?: number;
  capture_after_mode?: 'state' | 'som' | 'vision' | 'ax';
  capture_after_max_elements?: number;
  capture_after_include_ocr?: boolean;
  capture_after_ocr_language?: string;
  capture_after_max_ocr_words?: number;
  /** inline keeps the frame in the reply; file writes it beside the run. */
  image_output?: string;
  capture_after_image_output?: string;
}

/** One response line from the resident PowerShell host. */
export interface PowerShellResponse {
  id: number;
  ok: boolean;
  result?: {
    text?: string;
    title?: string;
    window_id?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    [key: string]: unknown;
  };
  error?: string;
}

export interface ComputerCommandResult {
  text: string;
  image?: { mimeType: string; data: string };
}

export interface CaptureFrame {
  id: string;
  sessionId: string;
  kind: 'screen' | 'window';
  sourceId: string;
  windowId?: string;
  displayId?: string;
  originX: number;
  originY: number;
  physicalWidth: number;
  physicalHeight: number;
  captureWidth: number;
  captureHeight: number;
  windowX?: number;
  windowY?: number;
  windowWidth?: number;
  windowHeight?: number;
  targetWindowX?: number;
  targetWindowY?: number;
  targetWindowWidth?: number;
  targetWindowHeight?: number;
  relatedWindowIds?: string[];
  displayX?: number;
  displayY?: number;
  displayWidth?: number;
  displayHeight?: number;
}

export interface PixelUnavailable {
  code: 'pixel_unavailable';
  reason: 'capture_source_unavailable'
    | 'empty_frame'
    | 'blank_black_frame'
    | 'blank_white_frame'
    | 'coordinate_mismatch';
  message: string;
  sampled_pixels?: number;
  near_black_ratio?: number;
  near_white_ratio?: number;
  expected_aspect_ratio?: number;
  actual_aspect_ratio?: number;
}

export interface ComputerElementRecord extends ChromeUiaElement {
  mark: number;
  center_x: number;
  center_y: number;
  frame_id?: string;
  window_id?: string;
}

export interface OcrWordRecord {
  text: string;
  line: number;
  x: number;
  y: number;
  width: number;
  height: number;
  center_x: number;
  center_y: number;
}

export interface ElementAliasTarget {
  kind: 'ref' | 'point';
  ref?: string;
  frameId?: string;
  windowId?: string;
  x?: number;
  y?: number;
}

export interface ObservedWindowScope {
  primaryWindowId: string;
  relatedWindowIds: string[];
}

export interface ScreenshotCapture {
  /** Where the pixels came from: the window's own render, a direct grab of the
   *  screen region it occupies, or the compositor's window thumbnail. Only the
   *  first is independent of what is physically on screen. */
  route?: 'app_owned' | 'window_region' | 'composited';
  image?: { mimeType: string; data: string };
  description: string;
  frameId?: string;
  windowId?: string;
  frame?: CaptureFrame;
  pixelUnavailable?: PixelUnavailable;
}
