# Web fetch architecture

`web_fetch` keeps its URL-array and character-pagination interface. It now uses
a document pipeline rather than treating every successful response as an HTML
article. No hosted reader, proxy subscription or Python service is required.

## Request flow

1. Try bounded HTTP first. Validate and pin public DNS results on every hop.
   Public cross-host redirects are allowed; private targets, URL credentials,
   non-HTTP schemes and oversized bodies remain blocked.
2. Preserve Markdown, text, JSON and XML without interpreting embedded HTML.
   For HTML, prefer semantic document containers, then article extraction on
   a clone, then a cleaned body. Output keeps headings, code, links and tables.
3. Retry transient HTTP failures at most once. Honor `Retry-After` within the
   total deadline. Serialize document attempts for the same hostname, leaving
   unrelated sites independent.
4. Escalate empty documents, explicit challenge responses and HTTP 403 to the
   existing isolated Chromium pool. Do not escalate security failures, HTTP
   401, 404, rate limits or ordinary upstream server failures.
5. Both HTTP and browser paths recognize the documented `cf-mitigated:
   challenge` response header, even with HTTP 200. Page titles, prose and text
   length are not used to guess authentication or challenge status.

Each document has one overall deadline covering queueing, retries and rendering.
The HTTP stage uses a fraction of the remaining budget to leave room for rendering.
Results carry the final `url`, `requestedUrl`, format, attempted stages and
failure details. The final tool text includes error codes and failed stages.
Pagination and final formatting preserve source whitespace, including empty
and whitespace-only slices.

## Browser and privacy

Chromium reuses a process but gets an isolated context per document. The HTTP
path uses an ephemeral, domain-scoped cookie jar for redirects and meta refresh.
Neither path imports the user's signed-in profile or shares cookies between
calls. Paused browser requests receive a single pinned response; Chromium owns
redirect URLs, method changes and cookie updates, with every next hop gated.

The public-IP transport remains Node-based even for Chromium. This retains
DNS-rebinding protection, but does **not** reproduce native browser TLS
fingerprints. CAPTCHA, authenticated content and IP blocks are not guaranteed
to work. A nonempty HTTP 200 page without explicit challenge headers may still
be a login or challenge page; the runtime does not claim semantic verification.
Explicit HTTP or challenge failures are not cached as successful page reads.

## Dependencies and reference boundary

Readability, JSDOM and puppeteer-core remain useful for article fallback, DOM
parsing/cookie scoping and the browser pool respectively. No new dependency was
needed. Crawlee was cloned under `C:\Project\refs\crawlee`; its documented session,
concurrency and blocking concepts were studied. Its implementation code was not
copied, translated or adapted into these modules.

## Focused checks

```powershell
node --test src/runtime/web-search/lib/document-content.test.mjs src/runtime/web-search/lib/http-fetch.test.mjs src/runtime/web-search/lib/fetch-pipeline.test.mjs src/runtime/web-search/lib/fetch-output.test.mjs
node --experimental-test-module-mocks --test src/runtime/web-search/lib/browser-document.test.mjs
```

The browser check uses an installed Chrome/Edge and deterministic HTTP fixtures
while exercising real JavaScript, redirects, cookies and request interception.
