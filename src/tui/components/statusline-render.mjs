/*
 * components/statusline-render.mjs — the footer text of the async render.
 *
 * Node rendered this from provider quota and gateway state it read on the Node core's
 * side (src/ui/statusline.mjs: the 5H/7D usage, balance and route-spend segments of L1, the
 * memory-cycle segment of L2). mixdogd has no protocol call that answers them, so the footer is
 * the line built from the session state the core publishes: model, effort, context, agents,
 * shells and web search.
 */
import { localBootStatusLine } from './status-line/local-line.mjs';

export async function renderStatusline(args) {
  return localBootStatusLine(args);
}
