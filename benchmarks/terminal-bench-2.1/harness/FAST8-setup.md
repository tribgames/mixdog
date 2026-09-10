# FAST8 dependency staging

Eight-task, single-attempt preset runs use a content-addressed Docker volume
for the immutable zstd agent-dependency archive and its decoder. The first run
copies them once; subsequent runs mount the cache read-only and extract into
each fresh task container. Task files, credentials, source overlays, and verifier
outputs are not cached. Package-index refresh and task resources are unchanged.

Run the normal preset:

```powershell
.\run.ps1 -Preset sol-xhigh-fast -q
```

For an uncached staging comparison:

```powershell
.\run.ps1 -Preset sol-xhigh-fast -ColdSetup -q
```

`preset-run.json` records `fastSetup`. The console prints the exact retained
`mixdog-prebake-<sha256>` Docker volume. Archive changes select a new volume;
old volumes are retained and are not removed by trial teardown. No live
container or model response is reused. The cache requires local Linux Docker
and Harbor's `--extra-docker-compose` support. Cache preparation failures stop
the run rather than silently claiming a cached measurement.

Each run also records `harness-manifest.json` with file hashes for the launcher,
presets, harness, and analysis code. Runtime provenance includes its digest,
Git commit, and harness dirty paths separately from the agent runtime bundle.
These hashes record local source identity; they do not imply a clean commit.

