# profile-145-supplement

Synthetic files in the formats a 1.4.5 desktop profile (Electron userData) holds, for the upgrade-chain tests
(`tests/it/upgrade_chain.rs`). Nothing here is a recording of a real profile: no real host, device or credential.

| File | Written by (1.4.5) | Format |
| --- | --- | --- |
| `ssh-hosts.json`, `.bak` | `ssh/ssh-host-store.ts` | `{version:1, hosts:[{id,name,target,lastConnectedAt,settings?}]}` |
| `port-forwards.json`, `.bak` | `connections/port-forward-store.ts` | `{version:1, hosts:{<host id>:[{remotePort,localPort}]}}` |
| `remote-hosts.json` | `remote-hosts.ts` (paired PCs: moved as a secret) | `{version:1, hosts:[{id,name,alias?,url,addedAt,lastConnectedAt}]}` |
| `server-windows.json` | `connections/window-restore.ts` | `{enabled, open:[<host id>]}` |

The `.bak` is the copy the desktop's atomic writer keeps of the previous version; the tests move it with its file.
The files carry no trailing newline, as the desktop's compact writer leaves them: the tests compare bytes.
