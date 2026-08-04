# Runtime release runbook

## Build and manifest synchronization

Runtime releases are independent of application `v*` releases. Start **Build
Runtime** with a `runtime-v*` tag or its manual dispatch. The workflow builds
the five supported platform archives, uploads each archive and checksum
sidecar to that GitHub release, and records content-hash markers.

After the platform jobs finish, the aggregate job requires every supported
asset and valid checksum metadata, generates `dist/runtime-manifest.json`, and
uploads it to the release and workflow artifacts. It also writes
`src/runtime/memory/data/runtime-manifest.json` and commits that bundled copy
directly to the default branch with `GITHUB_TOKEN`.

The application Release workflow fully downloads and verifies every bundled
asset before publishing npm. **Runtime Assets Health** performs a lighter
weekly URL and size check and opens or updates one GitHub issue on failure.

## Repository migration checklist

1. Inventory every `runtime-v*` release and all attached archives, `.sha256`
   sidecars, build markers, and release manifests before moving repositories.
2. Transfer or recreate every runtime release and copy all assets to the
   destination repository. A transferred Git tag alone does not transfer
   release assets.
3. Confirm the destination URLs for every platform, then rerun **Build
   Runtime** aggregation so the bundled manifest contains destination URLs.
4. Merge or confirm the automated manifest-sync commit before cutting an
   application release.
5. Run **Runtime Assets Health** manually and perform one clean runtime
   installation before retiring the source repository or its releases.

## Recommended tag-protection ruleset

In GitHub repository settings, add a tag ruleset targeting `runtime-v*`.
Restrict tag creation to release maintainers or the designated automation,
block tag updates and deletions, and keep the bypass list minimal and audited.
Require signed tags if every supported release path can produce them. Tag
protection does not protect attached release assets, so retain the scheduled
health check and include assets explicitly in every migration or backup plan.
