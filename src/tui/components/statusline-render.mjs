/*
 * components/statusline-render.mjs — the footer text of the async render: the model, context, quota
 * (5H/7D, balance, route spend) and activity segments Node's src/ui/statusline.mjs rendered, over the
 * data files the core keeps (status-line/footer-inputs.mjs) and the session state.
 */
import { isPidAlive } from '../../runtime/shared/pid-liveness.mjs';
import { terminalColumns } from '../lib/statusline-format.mjs';
import { createFooterInputs } from './status-line/footer-inputs.mjs';
import { createFooterRenderer } from './status-line/footer-render.mjs';
import { localBootStatusLine, shellStripStatus } from './status-line/local-line.mjs';

// Readings older than this process stay hidden until it has seen a fresh one.
const PROCESS_STARTED_AT = Date.now() - Math.floor((Number(process.uptime?.()) || 0) * 1000);
const inputs = createFooterInputs();
const renderer = createFooterRenderer();

export async function renderStatusline(args) {
  try {
    const data = await inputs.read(args.provider, args.model);
    const now = Date.now();
    const shell = shellStripStatus(args.shellJobs, now);
    const text = renderer.render(
      { ...args, shellStatus: shell },
      data,
      { now, cols: terminalColumns(), processStartedAt: PROCESS_STARTED_AT, isPidAlive }
    );
    // The caches the text came from refresh after the call, as Node's footer did (setImmediate).
    setImmediate(renderer.flush);
    return text;
  } catch {
    return localBootStatusLine(args);
  }
}
