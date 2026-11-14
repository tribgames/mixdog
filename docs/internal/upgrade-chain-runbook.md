# Upgrade chain runbook

What to run, and what to look at, to know that a Mixdog candidate upgrades a 1.4.5 install without losing anything.
Two parts: an automated check on a copy of a 1.4.5-shaped profile, and the manual auto-update path through the real
update feed. Both are run by a person on Windows; neither touches the owner's profile (the script works under an
isolated root, the manual path uses a throwaway Windows user or machine).

## 1. Automated check: `scripts/live/upgrade-145.mjs`

```
node scripts/live/upgrade-145.mjs --app=<unpacked folder or Mixdog.exe> --profile-vector=<dir> [--out=<dir>] [--iso-root=<dir>] [--keep]
```

- `--app` is a packaged build: the `win-unpacked` folder of the candidate (or an installed folder, or the executable).
- `--profile-vector` is a directory with
  - `profile/`: the files a 1.4.5 Electron userData holds. The synthetic set is
    `native/core/crates/mixdog-migrate/tests/vectors/profile-145-supplement/profile` (SSH hosts, port forwards, paired
    PCs, server windows; formats in that folder's README). Use it as the `profile/` of a vector directory.
  - `data/` (optional): a 1.4.5 data directory, for example the recorded one under
    `native/core/crates/mixdog-migrate/tests/vectors/migration-145`. Without it the core starts on an empty data
    directory and only the profile move is exercised.
  - `expect.json` (optional): `{ "projects": [path], "sshHosts": [id], "remoteHosts": [id], "notifications": true, "owedRevokes": [key] }`.
    SSH hosts and paired PCs default to the ids in `profile/ssh-hosts.json` and `profile/remote-hosts.json`.

The script copies the vector under an isolated root (the vector is never written), starts the app with
`MIXDOG_DESKTOP_USER_DATA` set to the copied profile and every other profile variable (`MIXDOG_DATA_DIR`,
`MIXDOG_HOME`, `MIXDOG_RUNTIME_ROOT`, `HOME`, `APPDATA`, ...) under the same root, waits for the core's `daemon.json` to
say `serving`, and then asserts, each as its own line:

| Check | Passes when |
| --- | --- |
| migration markers | `migration/complete.json` exists with no unexpectedly quarantined item and `migration/profile-gen.json` is at generation 2 (waited for up to 120 s: the migration runs while the core serves) |
| projects | `project/list` holds every path of `expect.projects` |
| SSH hosts | `connections/ssh/list` holds every expected host id |
| paired PCs | `remoteAccess/state` names every expected paired PC |
| notification preferences | with `expect.notifications`, `notify/state` returns a stored notifications object |
| owed revokes | `pcAccess/readiness` still owes every key of `expect.owedRevokes` |

It exits 0 when all pass and 1 otherwise; `<out>/summary.json` (default: a folder beside the isolated root in the system
temp directory) holds the result of every check and the core's logs. The app is started through its normal path and a
window opens; it is ended by its own process handle when the run is over (never by name). The isolated root is removed
unless `--keep` is given.

Unit test of its pure parts (starts nothing): `node --test scripts/live/upgrade-145.test.mjs`.

Read the result as: every line `ok`. A failing marker line means the migration did not finish or quarantined something;
look at `logs/` in the output first. A failing read-back line means the data moved but the core does not serve it.

## 2. Manual check: the auto-update path

The script starts the candidate on a 1.4.5-shaped copy; it does not exercise the updater, the installer or the first
start of the replaced app. That is checked by hand, once per release, on a Windows machine or user account that holds no
data you need.

### 2.1 Update from 1.4.5 to the candidate

1. Install the published 1.4.5 build. Start it once and create what the check reads back: add a project, save an SSH
   server (Connections), pair a phone or PC if you can, and change a notification preference. Close the app from its tray
   menu and confirm no `mixdogd` is left running in Task Manager.
2. Copy the profile aside (`%APPDATA%\Mixdog` and `%USERPROFILE%\.mixdog\data`) so a failed update can be compared.
3. Serve the candidate as an update: `npm run update:dev:updater` in `apps/desktop` builds a version-bumped artifact,
   serves `dist` over 127.0.0.1 and points the installed app's updater at it. For a release candidate, publish it to
   the feed (a draft release on the GitHub feed `tribgames/mixdog`, channel `latest`) and run `npm run verify:update-metadata`
   on the build first.
4. In the 1.4.5 app: the update appears, downloads, shows ready, and "install and restart" relaunches.
5. After the relaunch check, in the candidate:
   - the project, the SSH server, the paired PC and the notification preference are all there;
   - `%USERPROFILE%\.mixdog\data\migration\complete.json` exists and `migration\profile-gen.json` says generation 2;
   - `ssh-hosts.json`, `port-forwards.json`, `remote-hosts.json` and `server-windows.json` have left the profile folder
     for `<data>\desktop\` (the moves are one way; a `.superseded` file means the target already held other bytes and
     the old one was kept, not deleted);
   - the sessions of 1.4.5 open with their history;
   - exactly one `mixdogd` runs, and it is the candidate's (`daemon.json` names its path under the install folder).
6. Close and start again: nothing is migrated a second time (the markers are unchanged, no new `.superseded` files).

### 2.2 Skip a release

A user on 1.4.5 may update straight to a candidate that is two or more releases ahead. Repeat 2.1 with the intermediate
release absent from the feed (only 1.4.5 installed, only the candidate offered); the result must be the same list in
5. If an intermediate release changed a stored format, install it from its own installer over 1.4.5 first and repeat
5 after each step; the final state must equal the one reached directly.

### 2.3 Interrupted update

Kill the installer or the app at "installing" (end the Mixdog process from Task Manager) and start the installed app
again: it starts on whichever version is on disk, the profile is still intact, and a second update attempt completes.

### 2.4 What to record

Per release: the 1.4.5 build, the candidate version, whether the skip case was run, the output of the script on the
recorded vectors (`summary.json`), and for each step of 2.1 to 2.3 pass or the observed difference. A difference in
2.1 step 5 is a release blocker.
