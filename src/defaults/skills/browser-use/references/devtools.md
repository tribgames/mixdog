# Debugging a web app

- `console` (`level` filter) and `network` (list, then `requestId` for
  headers/bodies/timing; `resourceTypes` and `query` to narrow) are `browser`
  actions; the rest of this file is `browser_devtools`.
- `intercept` mocks or blocks matching requests (`abort`, `body`); `init_script`
  runs before page boot; `emulate` sets viewport, device, locale, timezone,
  network profile, CPU throttle, geolocation, headers. `reset:true` clears
  emulation. `performance` records metrics.
- `performance operation=start saveTrace:true`, then `operation=stop`, saves a
  bounded Chrome trace JSON under the app's browser-traces directory. Events
  retain their timing/structure; secrets are redacted and omitted events are
  counted. The directory has a storage cap and never deletes old traces silently.
- `status` reports the page and bridge state when something looks wrong.
