import { app } from 'electron';

type JitterProbeModule = typeof import('./jitter-probe');

// The jitter probe is a development harness: a packaged build never loads it.
// The import is dynamic so the probe and its helper files stay out of the main
// entry's static graph, and electron-builder.yml leaves their chunks
// (out/main/jitter-probe-*) out of app.asar.
export async function loadJitterProbe(): Promise<JitterProbeModule | null> {
  if (app.isPackaged) return null;
  return import('./jitter-probe');
}
