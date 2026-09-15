# Execution

- `shell` only for evidence or artifacts that require execution: computation,
  data transformation, generated output, unsupported-format decoding. An open
  shell is never a routing reason.
- Structured service operations go through the service's MCP tool or CLI.
<!-- tools: browser -->
- Rendered, signed-in, or interactive pages in Mixdog's browser→`browser`.
<!-- tools: computer -->
- User-designated external browser windows (including web content), native
  apps, OS dialogs, or other GUI-only work→`computer`. Browser Use cannot
  attach to external windows; preserve the user's selected window and session.
- Never switch tools or browser windows to bypass a denied/blocked action,
  CAPTCHA/2FA, or user stop; recover on the original route or hand off.

