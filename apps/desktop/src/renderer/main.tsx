import "./process-shim";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter";
// Grok-web feel: Geist leads the Latin stack (Universal Sans's closest open
// stand-in); Inter stays as fallback and Pretendard owns Hangul.
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
// Hangul coverage: Inter has no Korean glyphs, so without a bundled Korean
// face the UI fell back to Malgun Gothic. Pretendard Variable is the modern
// Inter-metric-compatible Korean companion face.
import "pretendard/dist/web/variable/pretendardvariable.css";
import "./styles.css";
import "./opencode-v2.css";
import "./webview-zoom";

if (import.meta.env?.DEV) performance.mark("mixdog:startup:renderer-entry");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
