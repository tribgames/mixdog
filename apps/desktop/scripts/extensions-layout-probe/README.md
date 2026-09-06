# Extensions and shared rail layout probe

Run from `apps/desktop`:

```powershell
node scripts/extensions-layout-probe/run.mjs
```

To limit a retry to affected views:

```powershell
node scripts/extensions-layout-probe/run.mjs --views=git-plain,git-custom,skill
```

Uses production side panels, extension dialogs and settings controls with an
in-memory desktop API in a hidden, offscreen Electron window. It does not start,
restart or connect to the installed app, daemon, real accounts or user profile.

Checks dark/light themes, Korean/English, a short desktop window and a narrow
mobile viewport. Geometry checks cover field/row overflow, readable settings
labels, persistent footer actions, inline form isolation, common row typography
and search controls, two-line extension descriptions, resizing a mounted panel,
and closing the actual dialogs. The fixture loads the desktop skin before the
lazy Extensions stylesheet, matching the application.

Screenshots and `report.json` are written under
`apps/desktop/artifacts/extensions-layout/run-*`. Review the rendered screenshots
alongside the geometry report; this probe does not assert source text.
