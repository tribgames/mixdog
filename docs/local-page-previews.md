# Local HTML preview permissions

Desktop chat links open HTML in the session browser pane, or in the system
browser when no pane is available. The loopback URL is a temporary read
capability, not a grant to the whole directory containing a selected file.

## Access scope

- **Selected file:** a selected-file access token authorizes only that HTML
  file. Neighboring HTML, CSS, JavaScript, images, fonts, JSON and CSV are not
  implicitly authorized, even if separately selected or inside a registered
  project. Self-contained HTML is the suitable format for this mode.
- **Registered project:** without a selected-file token, the backend requires
  a registered project. The page can load the existing web-asset types within
  that project, including JSON/CSV. Hidden paths, non-web types and symlinks
  escaping the project remain blocked. Register only a project whose web
  assets you intend its pages to access; do not register a broad personal
  directory just to make a single page's assets load.

The IPC caller cannot supply the scope. An invalid or expired selected-file
permission is rejected, not retried with broader project access. No new folder
picker or automatic grant expansion is introduced. Edit, document preview and
remote-phone APIs are unchanged.

Selected-file HTML receives `Content-Security-Policy: sandbox allow-scripts`.
Inline scripts may render the page, but it is not given the shared loopback
origin's storage/window authority. Forms, popups and downloads are not enabled
by this sandbox policy. This is not an offline mode: external network resources
remain subject to ordinary browser/CORS rules. Use the explicit project scope
for trusted pages requiring same-origin assets or storage.

## Lifetime

Each invocation issues an independent random URL. A file URL is never reused
as, or upgraded to, a project URL for the same folder. The server retains at
most **128 URLs**, evicts the least recently used when full, and expires each
after **one hour**. Only a successfully authorized GET/HEAD refreshes recency;
failed or forbidden requests do not. Recency never extends the absolute expiry. Click the original
chat link again to obtain a fresh URL.

The server rechecks the originating selected-file permission or project
registry on each permitted GET/HEAD, and pins the canonical root/page path.
An explicit denial (removed grant/project, closed owner, or changed canonical
path) invalidates that URL and returns 404. A transient authorization failure
(such as a daemon timeout or path lookup error) returns 503 without disclosing
diagnostics or revoking the lease; retry the same URL after recovery. Uncertainty
never authorizes file bytes. Expiry or revocation during an unsuccessful check
still returns 404, not a retryable response for a dead lease.
Closing the requesting desktop renderer revokes its URLs without revoking
another renderer's previews. Expiry/closure during a pending authorization
cannot revive the URL when that authorization later finishes.

Closing only a browser pane, tab or external browser is not a permission
revocation event in this API; the originating permission checks and hard lease
limit still apply. Revocation blocks subsequent responses, not bytes already
transferred or a response whose transfer has already begun. Files remain live
at their authorized paths, so an ordinary in-place editor replacement stays
visible. This is not an atomic filesystem snapshot against an uncooperative
process replacing paths during the final filesystem checks and open.

## Focused checks

```sh
npm test --prefix apps/desktop -- src/main/local-page-server.test.mjs src/main/local-page-permissions.test.mjs src/main/local-access-denied.test.mjs
```

The tests exercise real loopback HTTP and temporary files through the public
server and IPC registrar. Project/grant lookups and renderer lifecycle use the
registrar's existing dependency boundaries; the HTTP responses, path checks,
lease table, permission selection and revocation are production code.
