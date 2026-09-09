# Browser profile import: fidelity and authentication

## Findings (2026-09-09)

The live built-in browser contained Google authentication-cookie names and
recognized four saved accounts, but Google's account chooser marked all four
signed out. Cookie presence and an account chooser are not evidence of an
authenticated session. No live credential values were exported for this work.

The source inspection found these independent defects:

- The native decoder treated the domain-hash prefix as exclusive to v20
  encryption. Chromium cookie database schema 24 introduced that prefix for
  encrypted values independently of the encryption-envelope version.
- Native decryption failures were silently omitted from the returned array.
  The desktop could not distinguish a complete import from missing cookies.
- The native reader omitted the plaintext `value` column and partition
  identity. A partitioned cookie must not be converted into an unpartitioned
  cookie. The installed Electron cookie-set contract has no partition-key
  field.
- Lossy UTF-8 conversion could change decrypted bytes without reporting the
  failure. A past persistent expiry could also become a session cookie.
- Session-cookie restoration registered non-Secure cookies with an HTTP URL.
  A two-process Electron fixture reproduced an overlapping-cookie failure:
  three saved session cookies, only two restored.

The patch addresses those cases, reports categorized native failures, rejects
old array-only cookie reports, and distinguishes data import from verified
authentication in the import dialog. Final results also populate per-item
counts when progress events are unavailable.

## Verification evidence

These checks passed against the corrected source:

| Check | Outcome |
| --- | --- |
| `node native/mixdog-browser-import/test.mjs` | 9 native tests passed |
| Targeted cookie-report and browser-import renderer tests | 11 tests passed |
| `npm --prefix apps/desktop run test:browser-profile-import:integration` | Passed, including partial native failures and expiry handling |
| `node apps/desktop/scripts/run-browser-cookie-persistence-integration.mjs` | Separate write/read Electron processes passed after the restoration fix |
| Targeted `browser-session-store.test.mjs` | 2 tests passed |
| Desktop node and web TypeScript checks | Passed; node rechecked after the restoration change |
| `npm --prefix apps/desktop run build:fast` | Desktop and daemon build passed |

The restart fixture uses an isolated temporary profile and synthetic tokens.
It verifies both Chromium-persisted cookies and OS-encrypted session-cookie
restoration, including host-only identity and Secure/non-Secure overlap.
Passing it does not prove that Google accepts a migrated real session.

## Live verification after the approved local update

The FastDirect worker reported completion at `2026-09-09T12:10:55Z`; the app
restarted and displayed the new authentication notice. A cookie-only import
through the installed dialog produced the new native report:

- 2,996 cookies imported.
- Zero decryption, domain-integrity, or invalid-encoding failures.
- 486 partitioned cookies explicitly unsupported, so the overall result
  correctly remained partial rather than claiming every cookie was imported.

Reloading Google then changed its sign-in link into the real Google account
button. The account menu exposed account management. The foreground browser
was left on that authenticated Google page; the temporary support tab was
closed. Passwords and browsing history were excluded from this import.

The corrected desktop/native pair is therefore deployed and the live primary
Google login is recovered. The specific contribution of each fix to the
original rejection is not isolated. A further, explicitly approved app restart
is still required to prove persistence of this newly recovered real session.

For subsequent diagnostics:

1. Preserve the existing encrypted cookie backup and the exact import result.
2. Confirm the intended Chrome profile and the user's consent before closing
   Chrome or invoking the administrator-approved importer. Do not terminate a
   browser to evade an import error or an unsaved-work prompt.
3. Perform one corrected import. Inspect categorized failures before deciding
   whether any retry has a changed input and a reasonable chance of success.
4. Observe Google sign-in in the built-in browser. Cookie listings must be
   scoped to the actual Google URL; an `about:blank` cookie query says nothing
   about Google cookies.
5. Only if authentication succeeds, perform an approved app restart and check
   it again. Hand off any password, CAPTCHA, 2FA, or identity-verification step.

Do not confuse the passing synthetic restart fixture with live post-import
restart evidence. Do not classify the 486 unsupported cookies as decryption
failures, and do not broaden their partition scope to make the count succeed.

## References and design boundary

### Partition support added after the first live recovery

The 486 exclusions above describe the first deployed implementation, not
unnecessary cookies. CHIPS may support embedded payment, chat, and authenticated
content. The approved follow-up source change preserves partitioned cookies
instead of hiding those exclusions:

- Native report version 2 carries `partitionKey.topLevelSite` and
  `partitionKey.hasCrossSiteAncestor`. Invalid or unavailable partition identity
  is reported, never guessed. Expired rows are counted separately before
  decryption and are not errors.
- A private blank `WebContentsView` is explicitly owned by the destination
  Electron `Session`. Its target-scoped CDP cookie operations retain partition
  identity without attaching to external Chrome or exposing a debugging port.
- Real Electron tests found that `Storage.getCookies` selected the wrong
  default context, and passing the target's `browserContextId` failed because
  Electron-owned contexts were not registered in that API. The implementation
  therefore uses target-scoped `Network.getAllCookies`, not a silent default-
  context fallback. This method is deprecated upstream, so its behavior is
  covered by the actual Electron isolation fixture.
- Cookie identity, recovery snapshots, and session-cookie persistence include
  both partition-key components. An Electron-only setter explicitly refuses
  partition metadata rather than dropping it.

Follow-up checks passed: 10 native tests, 5 targeted JS tests, profile-import
integration including destination-session isolation and encrypted recovery,
the extended two-process persistence fixture (five session cookies and two
persistent cookies), and the node TypeScript check.

The partition-aware desktop/native pair was subsequently deployed. Its live
cookie-only import accepted 3,459 cookies, with zero native decoding, domain,
encoding, or partition-identity failures. Four destination rejections remained.
A read-only query of the selected Chrome profile's cookie metadata identified
exactly four non-HTTPS partition keys, all `chrome://whats-new`; the remaining
partition keys were web contexts. No cookie values were queried.

These four cookies belong to Chrome's own internal UI, not a portable website
session. The final source patch normally excludes valid `chrome:` and
`chrome-untrusted:` partition contexts. It does not ignore ordinary web
partitions, extensions, malformed keys, or actual decryption/storage failures.
Unit and actual Electron integration checks cover that distinction.

The approved post-import restart changed the main app process from PID 87964
to PID 99548. Google still displayed the real account button afterward. The
initial graceful exit request did not terminate the old background process;
the encrypted session snapshot was observed updated at `2026-09-09T12:50:10Z`
before the app process was terminated and relaunched. User data was not removed.
This verifies recovery after a process restart, not a successful graceful-exit
path.

The final approved FastDirect invocation reported unchanged inputs and did not
perform another install or restart. Verification used the installed app's
actual behavior rather than inferring success from that no-op: a cookie-only
import displayed `브라우저 데이터를 가져왔습니다` and `3,452개 가져옴`,
without the previous partial-import error. Google remained authenticated after
the page was reloaded. The internal-context error display is therefore resolved
in the installed app. Counts are from distinct imports and are not a claim
that the source profile stayed unchanged between them.

Local references were consulted before external sources:

- `C:\Project\refs\browser-use\skills\open-source\references\browser.md`:
  persistent browser profiles and storage-state transfer are different
  authentication strategies.
- `C:\Project\refs\playwright\docs\src\auth.md`:
  authenticated state may include cookies, localStorage, and IndexedDB;
  authentication can be browser-specific.
- `C:\Project\refs\chrome-devtools-mcp\docs\advanced-usage.md`:
  a consented connection to an already-running browser preserves its live
  profile instead of copying credentials to another runtime.
- `C:\Project\refs\cua\libs\cua-driver\rust\Skills\cua-driver\BROWSER.md`
  and `C:\Project\refs\cua\blog\extension-free-browser-use.md`:
  existing-profile attachment is explicitly authorized and bound to an exact
  native process/window; isolation does not silently copy a personal profile.

Official evidence:

- [Chromium schema-24 domain binding](https://chromium.googlesource.com/chromium/src/+/5ea6d65c622a3d5ff75db9dc0257ea3869f31289%5E%21/)
- [Google device-bound session credentials](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/)
- [Google embedded-browser sign-in restrictions](https://developers.googleblog.com/guidance-to-developers-affected-by-our-effort-to-block-less-secure-browsers-and-applications/)
- [Chrome user-approved auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)
- [Chrome remote-debugging switch restrictions](https://developer.chrome.com/blog/remote-debugging-port)

App-bound encryption protects stored cookie data. Device-bound session
credentials concern proving possession of a session key during server-side
session renewal. Correctly decoding a stored cookie does not satisfy that
second protocol. Neither mechanism should be disabled to make an import
appear successful.

If a correctly imported Google session still requires reauthentication, the
supported alternative is an explicitly authorized existing-Chrome connection
or a fresh sign-in in a supported browser. Implementing a different browser
backend is a separate approval scope. No reference implementation code was
copied or adapted for this patch.
