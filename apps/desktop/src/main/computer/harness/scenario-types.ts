export interface CommandResult {
  text: string;
  image?: { mimeType?: string; data?: string };
}

export interface CapturePayload {
  ok?: boolean;
  mode?: string;
  capture_source?: string;
  requested_window_id?: string;
  capture_target_reason?: string;
  width?: number;
  height?: number;
  image_file?: { path?: string; bytes?: number; mime_type?: string };
  window_id?: string;
  frame_id?: string;
  continuation?: string;
  pixel_status?: string;
  pixel_unavailable?: { code?: string; reason?: string };
  returned_elements?: number;
  total_elements?: number;
  changes?: Record<string, unknown>;
  overlay_rendered?: boolean;
  overlay_error?: string;
  elements?: Array<{
    mark?: number;
    ref?: string;
    source?: string;
    role?: string;
    name?: string;
    value?: string;
    bounds?: number[];
    actions?: string[];
  }>;
  ocr?: {
    ok?: boolean;
    skipped?: boolean;
    error?: string;
    reason?: string;
    lines?: Array<string | { text?: string }>;
    words?: Array<{
      text?: string;
      mark?: number;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }>;
  };
}

export interface ScenarioMetrics {
  commands: number;
  cleanup_commands: number;
  observations: number;
  mutations: number;
  accepted_mutations: number;
  post_action_recaptures: number;
  retries: number;
  request_bytes: number;
  response_text_bytes: number;
  image_bytes: number;
  max_returned_elements: number;
  escalations: string[];
  false_positive: boolean;
  phase_ms: Record<string, number>;
  actions: Record<
    string,
    {
      commands: number;
      failures: number;
      durations_ms: number[];
      request_bytes: number;
      response_text_bytes: number;
      image_bytes: number;
    }
  >;
}

export interface ScenarioResult extends ScenarioMetrics {
  id: string;
  name: string;
  area: string;
  status: 'pass' | 'fail' | 'skip';
  duration_ms: number;
  failure?: string;
}

export interface BridgeDiscovery {
  port: number;
  token: string;
}

export type ActionMetrics = ScenarioMetrics['actions'][string];
