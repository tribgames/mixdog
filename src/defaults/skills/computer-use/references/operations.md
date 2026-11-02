# Menus, windows, apps, clipboard

- `menu` invokes an exact path from the menu bar down, e.g.
  `["File","Save As"]`. Missing, ambiguous, or disabled entries fail closed;
  on "no path", use the recovery capture and target the item by OCR/frame
  instead of retrying `menu` unchanged.
- `window` — `focus`, `minimize`, `close`; `move`/`maximize`/`restore` only on
  explicit user request. `terminate` kills the process behind the window and
  loses unsaved work: it needs the user's go-ahead plus `confirm="terminate"`,
  and it is refused while the window still answers messages — close that one.
- `launch` — executable name, exact path, file, or URL; use `list` to find
  the new window only if the result did not resolve it. Reuse a successful
  returned observation; otherwise capture the resolved window. Use `verify`
  only for a condition not already established.
- `clipboard` — `read`, or `write` with `text`. Large text goes through the
  clipboard + a paste `key` rather than a long `type`.
- `diagnose` — read-only backend / OCR / accessibility readiness. Run it first
  when neither usable pixels nor semantic targets are available, or an input
  backend reports an error. An OCR error alone does not block usable vision.
- `list` (kind apps) with `query` also finds installed apps that are not
  running; `launch` accepts those names. `list` (kind history) returns this
  session's executed commands and verdicts.
