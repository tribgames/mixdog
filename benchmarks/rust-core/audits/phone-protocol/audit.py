#!/usr/bin/env python3
"""Phone-protocol audit: what the paired phone sends to the PC at the Node baseline, what served it
there, and what serves it in `mixdogd` on the current tree.

Re-run from the repository root (needs git and python3 only, no builds):

    python benchmarks/rust-core/audits/phone-protocol/audit.py [--base b6f10295a] [--out DIR]

Inputs
  * baseline phone source: `git show <base>:apps/desktop/src/{renderer,shared}` (the relay web app the phone
    loads) and `apps/mobile` (the native shell), read straight from git, never from a working copy;
  * baseline PC side: `apps/desktop/src/main/**` at the same revision;
  * `mixdogd` side: `native/core/crates/mixdog-app-protocol/schema/{method_table,operations_map}.json`
    (the generated method table and the DS 18 inventory) and the Rust sources under `native/core/crates`;
  * the current phone source (`apps/mobile/src`, renderer shim) in the working tree, to say which side changed;
  * Node recordings: `native/core/fixtures/**` and their `MANIFEST.json`.

Outputs (in --out, default next to this script)
  * `phone-protocol-table.md`  the table, the counts and the port units;
  * `phone-protocol-table.json` the same rows with every field.

What is extracted and what is curated: the call list, the inbound event list, the push payload fields, the
Node handler lines, the Rust method table, handler lines and recordings are all computed from the sources
above. Only four small tables are written by hand, each at the top of this file with the reason next to it
and each checked against the sources on every run (a stale entry fails the run): EVENT_MAP, MECHANICS,
PHONE_O1, FEATURE_RULES (and UNITS near the end, the port-unit deliverables).
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
CRATES = ROOT / 'native/core/crates'
FIXTURES = ROOT / 'native/core/fixtures'
SCHEMA = CRATES / 'mixdog-app-protocol/schema'
DESKTOP = 'apps/desktop/src'

# --------------------------------------------------------------------------------------------------
# Hand-written tables (each entry is verified against the sources by `verify_tables`)
# --------------------------------------------------------------------------------------------------

# Node push/event name -> (Rust notification or section, why). Source of the pairs: spec-v2/desktop-services.md
# section 2.4 "Replaces" column and protocol.md section 6.2; the Rust names are asserted against
# method_table.json (serverNotifications) and mixdog-protocol/src/section.rs.
EVENT_MAP = {
    'relayRoutingCaps': ([], 'relay-level ceilings: the relay talks to the desktop leg (mixdog-remote leg/caps.rs), not to the core'),
    'state': (['app/snapshot'], 'getSnapshot is by design replaced by thread feeds + app snapshot (inventory byDesign)'),
    'sessions': (['thread/started', 'thread/summary/updated', 'thread/deleted', 'thread/archived', 'thread/unarchived'], 'catalog rows are app-feed notifications'),
    'agentPool': (['agent/pool/updated'], 'section agentPool'),
    'sessionState': (['thread/snapshot', 'turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta'], 'per-thread feed folded by packages/protocol-client session-state.ts'),
    'activity-rail-pins-changed': (['config/updated'], 'section config (activity-rail-pins-changed)'),
    'provider-models-changed': (['model/catalog/updated'], 'section modelCatalog'),
    'desktop-notice': (['notice/updated'], 'section notice (desktop-notice)'),
    'settings-changed': (['config/updated'], 'section config (settings-changed)'),
    'turn-review-changed': (['review/diff/updated'], 'section reviewDiff (turn-review-changed)'),
    'orchestration-mode-changed': (['config/updated'], 'section config (orchestration-mode-changed)'),
    'updater-state-changed': (['update/status/updated'], 'section update'),
    'browserApprovalSessions': (['host/state/updated'], 'section hostState (publishBrowserApprovalSessions)'),
    'browserRemoteFrame': (['host/browser/viewFrames'], 'X17 binary frames, purpose browserView (SPEC In-app browser view)'),
    'browserRemoteWebrtc': (['host/state/updated'], 'WebRTC signalling stays in Electron/core carrier (mixdog-remote webrtc); no phone-visible notification of this name'),
    'browserRemoteTabs': (['host/state/updated'], 'section hostState key browserTabs'),
    'browserProfileImportProgress': (['host/state/updated'], 'section hostState key browserImport'),
    'browserOpenRequested': (['ui/openRequested'], 'ui/openRequested'),
    'terminalRunRequested': (['ui/openRequested'], 'ui/openRequested (terminal-run request) + ui/terminalRun/claimed'),
    'visualizeChanged': (['host/state/updated'], 'section hostState key visualize'),
    'termData': (['terminal/activity/updated'], 'terminal output is the terminal/* method family + X17 frames; activity is the section'),
    'termSizeOwner': (['terminal/tabs/updated'], 'terminal-size-owner is replaced by the terminalTabs section (desktop-services 2.4)'),
    'termActivity': (['terminal/activity/updated'], 'section terminalActivity'),
    'folderChanged': (['git/status/updated'], 'folder-changed -> gitStatus re-read (desktop-services 2.4); file watch is git/watch'),
    'lspDiagnostics': (['lsp/diagnostics/updated'], 'section lspDiagnostics'),
    'lspStatus': (['lsp/status/updated'], 'section lspStatus'),
}

# Phone request names that the DS inventory (operations_map.json) does not list, with the Rust side they ride on.
# Each `evidence` is (file, regex) checked in the tree.
MECHANICS = {
    'browserRemoteTabs': dict(rust=['host/state/updated'], kind='section',
                              evidence=('native/core/crates/mixdog-core-domains/src/domains/host.rs', r'host/state/set')),
    'setScreenSessions': dict(rust=['ui/screenSessions/changed'], kind='clientNotification',
                              evidence=('native/core/crates/mixdog-core-domains/src/notify/screen.rs', r'ui/screenSessions/changed|screenSessions')),
    'setVisualizePanels': dict(rust=['ui/screenSessions/changed'], kind='clientNotification',
                               evidence=('native/core/crates/mixdog-core-domains/src/notify/screen.rs', r'visualize')),
    'synchronizeViews': dict(rust=['app/subscribe', 'thread/resume'], kind='methods',
                             evidence=('native/core/crates/mixdog-app-server/src/server.rs', r'AppSubscribe')),
    'reportConnectionTimeline': dict(rust=['client/perfLog'], kind='clientNotification',
                                     evidence=('native/core/crates/mixdog-core-domains/src/domains/client.rs', r'client/perfLog')),
    'remotePerfPaint': dict(rust=['client/perfLog'], kind='clientNotification',
                            evidence=('native/core/crates/mixdog-core-domains/src/domains/client.rs', r'client/perfLog')),
    'setRemoteLanes': dict(rust=['feed/subscribe'], kind='methods',
                           evidence=('native/core/crates/mixdog-app-server/src/server.rs', r'FeedSubscribe')),
    'setForeground': dict(rust=['ui/screenSessions/changed'], kind='clientNotification',
                          evidence=('native/core/crates/mixdog-core-domains/src/notify/screen.rs', r'foreground')),
    'stateResync': dict(rust=['thread/resume'], kind='methods',
                        evidence=('native/core/crates/mixdog-app-server/src/server.rs', r'ThreadUnsubscribe')),
}

# Names whose o1 phone source replaces the Node call (file in the working tree, token that must be in it).
PHONE_O1 = {
    'setScreenSessions': ('apps/mobile/src/screen-reporter.ts', 'SCREEN_SESSIONS_CHANGED'),
    'setVisualizePanels': ('apps/mobile/src/screen-reporter.ts', 'visualizeSessionIds'),
    'setVisibleSessions': ('packages/protocol-client/src/client.ts', "'thread/resume'"),
    'synchronizeViews': ('packages/protocol-client/src/client.ts', "'app/subscribe'"),
    'getSnapshot': ('packages/protocol-client/src/client.ts', "'app/subscribe'"),
    'setForeground': ('apps/mobile/src/screen-reporter.ts', 'foreground'),
    'stateResync': ('packages/protocol-client/src/client.ts', "'thread/resume'"),
    'setRemoteLanes': ('packages/protocol-client/src/client.ts', "'app/subscribe'"),
}

# Surfaces whose calls are not made to the PC (phone-native host, same process).
NATIVE_HOST_FILES = {f'{DESKTOP}/renderer/file-download-transfer.ts'}

# User-visible feature per phone name (first matching rule wins). Only used for exists-unproven/missing rows.
FEATURE_RULES = [
    (r'^(submit|abort|resolveToolApproval|answerApproval|provideSecret|markSessionRead|prefetchSession|readTranscript|setVisibleSessions|reportScreen|synchronizeViews|getSnapshot|listSessions|searchSessionContent|rename(Session)|deleteSession|setSession|inheritSession|continueSession|scheduleQuota|cancelQuota|getQuota|setQuota|stopShell|releaseShell|openAgentHome|resetAgentHome|agentRoomAction|listAgentPool|startProject|startTask|startProjectTask|viewerDevice|getTaskWorkspace|listProviderModels|setModelRoute|setFast|invokeCapability|readCapabilities)', 'Chat: open, read, send, stop, approve, rename, archive, delete, route/model, agent rooms'),
    (r'^(git|gh|githubCli|githubRequest|githubStar|starGithub|installGit|installGithub|installLibre|libreOffice|setGitGlobal)', 'Source control: git panel, commits, branches, pull requests, GitHub login'),
    (r'^(term|subscribeTerm|folderWatch|folderUnwatch|subscribeFolder)', 'Terminal tabs (output, input, resize) and folder watching'),
    (r'(ProjectFile|ProjectDir|ProjectEntry|EditorBackup|EditorSettings|searchWorkspaceText|replaceWorkspaceText|searchProjectFiles|saveWorkspace|codeGraph|lsp|LspDiagnostics|LspStatus|listHostDirectories|trashProjectEntry|localPage|previewProjectFile|previewDocument|captureFileSnapshot)', 'Files and editor: browse, open, edit, search, language server'),
    (r'^(fileDownload|resolveLocalPaths|readLocalFile|attachmentOpen|openSessionAttachment|readAttachmentThumbnail|mediaUrl|visualizeExport)', 'File and media transfer: downloads, attachments, previews'),
    (r'^(push|registerPush|removePush|registerNativePush|removeNativePush|getNotification|setNotification|sendTest|listConversationNotif|setConversationNotif)', 'Notifications: Web Push / native push registration and preferences'),
    (r'(visualize|Visualize)', 'Visualize panel (agent canvases) on the phone'),
    (r'(browser|Browser|remoteBrowser|RemoteBrowser|remoteScreen)', 'Remote browser live view and tabs on the phone'),
    (r'^(readSettings|updateSetting|readActivityRail|updateActivityRail|readHostDisplay|subscribeSettings|subscribeActivity|subscribeProviderModels|notifyProviderModels|subscribeDesktopNotices|subscribeOrchestration|subscribeTurnReview|getUpdaterState|checkForDesktopUpdate|showDesktopUpdate|subscribeUpdater|submitFeedback|projectRecovery)', 'Settings, desktop update and feedback'),
    (r'^(listProjects|addProject|renameProject|removeProject)', 'Project list'),
    (r'^(subscribeSessions|subscribeAgentPool|subscribeState|subscribeSessionState|setScreenSessions|setVisualizePanels)', 'Live session list / chat updates on the phone'),
]

# --------------------------------------------------------------------------------------------------
# git access
# --------------------------------------------------------------------------------------------------


class Base:
    """Reads blobs of one revision through a single `git cat-file --batch` process."""

    def __init__(self, repo: Path, rev: str):
        self.repo = repo
        self.rev = subprocess.run(['git', '-C', str(repo), 'rev-parse', rev], capture_output=True, check=True, text=True).stdout.strip()
        listing = subprocess.run(['git', '-C', str(repo), 'ls-tree', '-r', '--name-only', self.rev, 'apps', 'docs'], capture_output=True, check=True, text=True).stdout
        self.paths = [p for p in listing.split('\n') if p]
        self.proc = subprocess.Popen(['git', '-C', str(repo), 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.cache: dict[str, str] = {}

    def text(self, path: str) -> str:
        if path in self.cache:
            return self.cache[path]
        self.proc.stdin.write(f'{self.rev}:{path}\n'.encode())
        self.proc.stdin.flush()
        header = self.proc.stdout.readline().decode().split()
        if len(header) != 3 or header[1] != 'blob':
            raise SystemExit(f'{path} is not a blob at {self.rev}')
        data = self.proc.stdout.read(int(header[2]))
        self.proc.stdout.read(1)
        self.cache[path] = data.decode('utf8', 'replace')
        return self.cache[path]

    def files(self, prefix: str, suffixes=('.ts', '.tsx')):
        for p in self.paths:
            if p.startswith(prefix) and p.endswith(suffixes) and not re.search(r'\.(test|slow)\.|\.d\.ts$|test-harness', p):
                yield p


class WorkTree(Base):
    """The same reader over the working tree (the current phone source)."""

    def __init__(self, repo: Path):
        self.repo = repo
        self.rev = 'worktree'
        listing = subprocess.run(['git', '-C', str(repo), 'ls-files', 'apps', 'packages'], capture_output=True, check=True, text=True).stdout
        self.paths = [p for p in listing.split('\n') if p]
        self.cache = {}

    def text(self, path: str) -> str:
        if path not in self.cache:
            self.cache[path] = (self.repo / path).read_text('utf8', 'replace')
        return self.cache[path]


def short(rel: str) -> str:
    return rel.replace('native/core/crates/', '', 1) if rel.startswith('native/core/crates/') else rel


def line_of(text: str, index: int) -> int:
    return text.count('\n', 0, index) + 1


def squash(text: str, limit: int = 140) -> str:
    text = re.sub(r'\s+', ' ', text).strip()
    return text if len(text) <= limit else text[: limit - 1] + '…'


# --------------------------------------------------------------------------------------------------
# 1. The phone's requests (baseline)
# --------------------------------------------------------------------------------------------------

CALL_RE = re.compile(r'(?<![\w$.])(?P<ctx>ctx\.)?(?P<fn>call|fire|fireHanded|invoke|relayCall|downloadCall)(?:<[^>()]*>)?\(\s*(?P<arg>[\'"`][\w./-]+[\'"`]|[A-Z_]+(?:\.\w+)?|[A-Z_]+_METHODS?\.\w+)')
CONST_RE = re.compile(r"export const (\w+)(?::[^=]+)?\s*=\s*'([^']*)'")
OBJ_RE = re.compile(r'export const (\w+)\s*=\s*\{([^}]*)\}', re.S)
KEY_RE = re.compile(r'^    (\w+)(?:\??:|\()', re.M)


def shared_consts(base: Base) -> dict[str, str]:
    consts: dict[str, str] = {}
    for path in base.files(f'{DESKTOP}/shared'):
        text = base.text(path)
        for m in CONST_RE.finditer(text):
            consts[m.group(1)] = m.group(2)
        for m in OBJ_RE.finditer(text):
            for k, v in re.findall(r"(\w+):\s*'([^']*)'", m.group(2)):
                consts[f'{m.group(1)}.{k}'] = v
    return consts


def matching_paren(text: str, open_index: int) -> int:
    depth = 0
    quote = ''
    i = open_index
    while i < len(text):
        c = text[i]
        if quote:
            if c == '\\':
                i += 1
            elif c == quote:
                quote = ''
        elif c in '\'"`':
            quote = c
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return len(text) - 1


def extract_calls(base: Base) -> dict:
    consts = shared_consts(base)
    calls: dict[str, dict] = {}
    native_host: list[dict] = []
    for path in base.files(f'{DESKTOP}/renderer'):
        text = base.text(path)
        api_key = None
        api_key_at = {}
        if path.endswith('remote-shim-api.ts'):
            for m in re.finditer(r"^    (\w+)(?:\??:|\()|Object\.defineProperty\(api, '(\w+)'", text, re.M):
                api_key_at[m.start()] = m.group(1) or m.group(2)
        for m in CALL_RE.finditer(text):
            fn, ctx, arg = m.group('fn'), bool(m.group('ctx')), m.group('arg')
            if fn in ('invoke', 'fireHanded') and not ctx:
                continue
            at = line_of(text, m.start())
            if arg[0] in '\'"`':
                name = arg[1:-1]
            elif arg in consts:
                name = consts[arg]
            else:
                continue
            if path in NATIVE_HOST_FILES or (path.endswith('native-push-bridge.ts') and not ctx):
                native_host.append(dict(name=name, file=path, line=at))
                continue
            if fn == 'call' and not ctx and not re.search(r'remote-(shim|file-preview)', path):
                continue
            open_paren = text.index('(', m.start() + len(m.group('ctx') or '') + len(fn))
            close = matching_paren(text, open_paren)
            argtext = text[open_paren + 1 : close]
            rest = argtext.split(',', 1)[1] if ',' in argtext else ''
            if path.endswith('remote-shim-api.ts'):
                keys = [k for pos, k in api_key_at.items() if pos < m.start()]
                api_key = keys[-1] if keys else None
            row = calls.setdefault(name, dict(name=name, kind=fn, sites=[], args=[], api_key=None))
            row['sites'].append(f'{path}:{at}')
            if rest.strip():
                row['args'].append(squash(rest.strip().rstrip(','), 110))
            if api_key and not row['api_key']:
                row['api_key'] = api_key
            if fn in ('fire', 'fireHanded'):
                row['kind'] = 'fire' if row['kind'] != 'call' else 'call'
    # boot-time prefetch tuples ['name', []]
    text = base.text(f'{DESKTOP}/renderer/remote-shim.ts')
    for m in re.finditer(r"\[\s*'(\w+)'\s*,\s*\[\s*\]\s*\]", text):
        row = calls.setdefault(m.group(1), dict(name=m.group(1), kind='call', sites=[], args=[], api_key=None))
        row['sites'].append(f'{DESKTOP}/renderer/remote-shim.ts:{line_of(text, m.start())}')
    return dict(calls=calls, native_host=native_host)


# Declared reply type of each DesktopApi member (contract.ts), for "reply fields the phone reads".
def contract_signatures(base: Base) -> dict[str, str]:
    sigs: dict[str, str] = {}
    for path in base.files(f'{DESKTOP}/shared'):
        if not re.search(r'contract[\w-]*\.ts$', path) or path.endswith('contract-ipc.ts'):
            continue
        text = base.text(path)
        for m in re.finditer(r'^  (\w+)\??(?:<[^>]*>)?\(', text, re.M):
            name = m.group(1)
            if name in sigs:
                continue
            end = m.start()
            depth = 0
            while end < len(text):
                c = text[end]
                depth += c in '({[<' and 1 or (c in ')}]>' and -1 or 0)
                if c == ';' and depth <= 0:
                    break
                end += 1
            sigs[name] = squash(text[m.start() : end], 400)
    return sigs


def interface_fields(base: Base) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for path in base.files(f'{DESKTOP}/shared'):
        text = base.text(path)
        for m in re.finditer(r'export interface (\w+)(?:<[^>]*>)?(?: extends [^{]+)? \{', text):
            start = m.end()
            depth, i = 1, start
            while i < len(text) and depth:
                depth += text[i] == '{' and 1 or (text[i] == '}' and -1 or 0)
                i += 1
            body = text[start : i - 1]
            fields, d = [], 0
            for line in body.split('\n'):
                if d == 0:
                    f = re.match(r'\s{2}(\w+)\??:', line)
                    if f:
                        fields.append(f.group(1))
                d += line.count('{') - line.count('}')
            out.setdefault(m.group(1), fields)
    return out


def reply_of(signature: str, ifaces: dict[str, list[str]]) -> str:
    if not signature:
        return ''
    ret = signature.split('=>')[-1] if '=>' in signature and not re.search(r'\)\s*:', signature) else re.split(r'\)\s*:\s*', signature, maxsplit=1)[-1]
    ret = squash(ret, 90)
    names = [n for n in re.findall(r'\b([A-Z]\w+)\b', ret) if n in ifaces and ifaces[n]]
    if names:
        fields = ifaces[names[0]]
        return f'{ret} {{{", ".join(fields[:10])}{"…" if len(fields) > 10 else ""}}}'
    return ret


# --------------------------------------------------------------------------------------------------
# 2. Inbound events (baseline)
# --------------------------------------------------------------------------------------------------


def extract_events(base: Base) -> list[dict]:
    consts = shared_consts(base)
    path = f'{DESKTOP}/renderer/remote-shim-dispatch.ts'
    text = base.text(path)
    events = []
    for m in re.finditer(r"message\.event === (\w+|'[^']+')", text):
        raw = m.group(1)
        value = raw.strip("'") if raw.startswith("'") else consts.get(raw, raw)
        nxt = re.search(r'message\.event === ', text[m.end():]); reader = re.search(r'\b(read\w+)\(', text[m.end() : m.end() + (nxt.start() if nxt else 400)])
        events.append(dict(event=value, const=None if raw.startswith("'") else raw, site=f'{path}:{line_of(text, m.start())}',
                           reader=reader.group(1) if reader else ''))
    return events


# Frame kinds that are not named events, with the dispatch line that reads them.
def extract_frames(base: Base) -> list[dict]:
    path = f'{DESKTOP}/renderer/remote-shim-dispatch.ts'
    text = base.text(path)
    probes = [
        ('call reply {id, ok, value|error, errorCode}', r"typeof message\.id === 'number'"),
        ('compact app-state push {e:"S"}', r"frame\.e === 'S'"),
        ('compact transcript push {e:"T"}', r"frame\.e === 'T'"),
        ('view baseline restore', r'frame\.event === VIEW_BASELINE_EVENT'),
        ('pong', r"'pong' in frame"),
        ('resync hint', r"'resync' in message"),
        ('relay payload rejection', r'readRelayPayloadRejection\(message'),
        ('relay routing caps', r'RELAY_ROUTING_CAPS_EVENT'),
        ('desktop-gone notice', r'REMOTE_DESKTOP_GONE_NOTICE'),
    ]
    out = []
    for label, pattern in probes:
        m = re.search(pattern, text)
        if not m:
            raise SystemExit(f'dispatch frame probe not found: {label}')
        out.append(dict(frame=label, site=f'{path}:{line_of(text, m.start())}'))
    sock = base.text(f'{DESKTOP}/renderer/remote-shim-liveness.ts')
    out.append(dict(frame='ping {"ping":1} (phone -> PC)', site=f'{DESKTOP}/renderer/remote-shim-liveness.ts:{line_of(sock, sock.index("ping"))}'))
    return out


# --------------------------------------------------------------------------------------------------
# 3. Node PC side (baseline main process)
# --------------------------------------------------------------------------------------------------


def node_index(base: Base) -> dict[str, list[tuple[int, str, int, str]]]:
    """name -> [(rank, path, line, form)] over apps/desktop/src/main (definition form beats literal form)."""
    index: dict[str, list] = collections.defaultdict(list)
    for path in base.files(f'{DESKTOP}/main'):
        file = path.rsplit('/', 1)[-1]
        rank = 0 if file == 'remote-methods.ts' else 1 if file.startswith('remote-') else 2 if re.match(r'(push|web-push|file-downloads|native-push|server-file|desktop-session|agent-rooms)', file) else 3
        for n, line in enumerate(base.text(path).split('\n'), 1):
            stripped = line.strip()
            if stripped.startswith(('//', '*', '/*')):
                continue
            d = re.match(r"\s*(?:async\s+)?['\"]?(\w+)['\"]?\s*(?:\??:|\()", line)
            if d:
                index[d.group(1)].append((rank, path, n, 'def'))
            for lit in re.findall(r"'(\w+)'", line):
                index[lit].append((rank + 4, path, n, 'literal'))
    return index


def node_handlers(index, name: str, limit: int = 2) -> list[str]:
    hits = sorted(index.get(name, []))
    preferred = [h for h in hits if h[0] % 4 != 3]
    hits = preferred or hits
    seen, out = set(), []
    for rank, path, n, form in hits:
        if path in seen:
            continue
        seen.add(path)
        out.append(f'{path}:{n}')
        if len(out) == limit:
            break
    return out


# --------------------------------------------------------------------------------------------------
# 4. mixdogd side
# --------------------------------------------------------------------------------------------------

LITERAL_RE = re.compile(r'"([A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)+|initialize)"')


def is_test_path(rel: str) -> bool:
    return bool(re.search(r'/tests?/|(^|/)(\w+_)?tests?\.rs$|_tests?\.rs$|/tests\.rs$|/testing\.rs$|test_support|/interop\.rs$', rel))


class RustTree:
    def __init__(self):
        self.files: dict[str, list[str]] = {}
        for p in sorted(list(CRATES.glob('*/**/*.rs')) + [q for d in (ROOT / 'native').glob('mixdog-*') for sub in ('src', 'tests') for q in (d / sub).glob('**/*.rs')]):
            rel = p.relative_to(ROOT).as_posix()
            if '/target/' in rel:
                continue
            self.files[rel] = p.read_text('utf8', 'replace').split('\n')
        # First line of the file's `#[cfg(test)] mod ...` block (a lone `#[cfg(test)]` item is not a test region).
        self.test_from: dict[str, int] = {}
        for rel, lines in self.files.items():
            for n, line in enumerate(lines):
                if line.startswith('#[cfg(test)]') and n + 1 < len(lines) and re.match(r'(pub(\(\w+\))? )?mod \w+', lines[n + 1]):
                    self.test_from[rel] = n + 1
                    break
        self.literals: dict[str, list[tuple[str, int, bool]]] = collections.defaultdict(list)
        for rel, lines in self.files.items():
            in_test = is_test_path(rel)
            for n, line in enumerate(lines, 1):
                if n >= self.test_from.get(rel, 10**9):
                    in_test = True
                for lit in LITERAL_RE.findall(line):
                    self.literals[lit].append((rel, n, in_test))
        self.fixture_refs: dict[str, list[tuple[str, int]]] = collections.defaultdict(list)

    @staticmethod
    def crate(rel: str) -> str:
        return rel.split('/')[3] if rel.startswith('native/core/crates/') else rel.split('/')[1]

    def handler_sites(self, method: str) -> list[tuple[str, int, bool]]:
        sites = [s for s in self.literals.get(method, []) if not s[2] and self.crate(s[0]) not in ('mixdog-app-protocol', 'mixdog-app-server-client', 'mixdog-protocol')
                 and '/mock/' not in s[0]]

        def score(site):
            line = self.files[site[0]][site[1] - 1]
            return (0 if re.search(r'"\s*(\||=>)', line) or '=>' in line else 1 if re.search(r'const \w+\s*:\s*&', line) else 2, site[0], site[1])

        return sorted(sites, key=score)

    def service_of(self, rel: str, line: int) -> str | None:
        owner = None
        for n, text in enumerate(self.files[rel], 1):
            if n > line:
                break
            m = re.search(r'impl(?:<[^>]*>)?\s+(?:\w+::)*DomainService\s+for\s+(\w+)', text)
            if m:
                owner = m.group(1)
        if owner:
            return owner
        impls = [m.group(1) for text in self.files[rel] for m in [re.search(r'impl(?:<[^>]*>)?\s+(?:\w+::)*DomainService\s+for\s+(\w+)', text)] if m]
        return impls[0] if len(impls) == 1 else None

    def publishers(self, variant: str, limit: int = 2) -> list[str]:
        name = variant[0].lower() + variant[1:]
        rx = re.compile(rf'\bSectionName::{variant}\b|"{name}"')
        out = []
        for rel, lines in self.files.items():
            if self.crate(rel) in ('mixdog-protocol', 'mixdog-app-protocol', 'mixdog-app-server-client') or is_test_path(rel):
                continue
            for n, text in enumerate(lines, 1):
                if n >= self.test_from.get(rel, 10**9):
                    break
                if rx.search(text) and not text.strip().startswith('//'):
                    out.append(f'{short(rel)}:{n}')
                    break
            if len(out) == limit:
                break
        return out

    def composed(self, service: str) -> str | None:
        for rel, lines in self.files.items():
            if not rel.startswith('native/core/crates/mixdog-app-server-daemon/src/') or is_test_path(rel) or 'draft' in rel.rsplit('/', 1)[-1]:
                continue
            for n, text in enumerate(lines, 1):
                if re.search(rf'\b{re.escape(service)}\b', text) and not text.strip().startswith('//'):
                    return f'{short(rel)}:{n}'
        return None

    def find(self, pattern: str, under: str) -> str | None:
        rx = re.compile(pattern)
        for rel, lines in self.files.items():
            if rel.startswith(under):
                for n, text in enumerate(lines, 1):
                    if rx.search(text):
                        return f'{short(rel)}:{n}'
        return None


def load_tables():
    methods = json.loads((SCHEMA / 'method_table.json').read_text('utf8'))
    inventory = json.loads((SCHEMA / 'operations_map.json').read_text('utf8'))['inventory']
    by_name: dict[str, dict] = {}
    for item in inventory:
        if item['list'] == 'remote':
            by_name[item['name']] = item
    for item in inventory:  # names the phone sends that only the desktop lists know
        if item['name'] not in by_name and item['list'] in ('services', 'operations', 'actions'):
            by_name[item['name']] = dict(item, via=item['list'])
    sections = {}
    section_rs = (CRATES / 'mixdog-protocol/src/section.rs').read_text('utf8')
    for m in re.finditer(r'^\s+(\w+) => "(\w+)", "([\w/]+)"', section_rs, re.M):
        sections[m.group(2)] = dict(variant=m.group(1), notification=m.group(3))
    return dict(
        methods={m['method']: m for m in methods['clientMethods']},
        client_notifications={m['method'] for m in methods['clientNotifications']},
        server_notifications={m['method']: m for m in methods['serverNotifications']},
        server_requests={m['method'] for m in methods['serverRequests']},
        inventory=by_name,
        sections=sections,
    )


# --------------------------------------------------------------------------------------------------
# 5. Recordings
# --------------------------------------------------------------------------------------------------


# Skips only the 100 MB transcript-display corpus; every operation twin is below 30 MB.
MAX_FIXTURE_BYTES = 30_000_000


class Recordings:
    # `name`/`action` keys are case or step labels in many recordings, not operation names.
    NAME_KEYS = r'(?:op|method|operation|call|capability)'

    def __init__(self, rust: RustTree):
        self.rust = rust
        self.by_name: dict[str, list[str]] = collections.defaultdict(list)
        self.exact: dict[str, object] = {}
        rx = re.compile(rf'"{self.NAME_KEYS}"\s*:\s*"([A-Za-z0-9_/.-]+)"')
        manifests: dict[Path, dict] = {}
        for p in sorted(FIXTURES.rglob('*.json')):
            if p.name == 'MANIFEST.json' or p.stat().st_size > MAX_FIXTURE_BYTES:
                continue
            rel = p.relative_to(FIXTURES).as_posix()
            for name in set(rx.findall(p.read_text('utf8', 'replace'))):
                self.by_name[name].append(rel)
            self.exact[rel] = self._exact(p, manifests)
        self.refs: dict[str, list[tuple[str, int]]] = {}

    def _exact(self, path: Path, manifests):
        d = path.parent
        while d != FIXTURES.parent:
            m = d / 'MANIFEST.json'
            if m.exists():
                if m not in manifests:
                    manifests[m] = json.loads(m.read_text('utf8'))
                data = manifests[m]
                rel = path.relative_to(d).as_posix()
                for entry in data.get('files', []):
                    if entry.get('path') == rel:
                        return entry.get('exact', data.get('exact'))
                return data.get('exact')
            d = d.parent
        return None

    def rust_refs(self, rel: str) -> list[tuple[str, int]]:
        if rel not in self.refs:
            tail = '/'.join(rel.split('/')[-2:])
            hits = []
            for r, lines in self.rust.files.items():
                for n, text in enumerate(lines, 1):
                    if rel in text or (f'fixtures/{tail}' in text):
                        hits.append((r, n))
                        break
            self.refs[rel] = hits
        return self.refs[rel]

    def proof(self, names: list[str], methods: list[str], handler_crates: set[str]):
        """Returns (level, evidence). Level: recording+test | recording | test | none."""
        recordings = [(n, f) for n in names for f in self.by_name.get(n, [])]
        linked, loose = [], []
        for n, f in recordings:
            for r, line in self.rust_refs(f):
                text = '\n'.join(self.rust.files[r])
                wire = any(f'"{m}"' in text for m in methods)
                if self.rust.crate(r) in handler_crates and (wire or f'"{n}"' in text):
                    linked.append(f'{f} (exact={self.exact.get(f)}; {"names the wire method" if wire else "names the Node op only"}) <- {short(r)}:{line}')
                else:
                    loose.append(f'{f} <- {short(r)}:{line}')
        if linked:
            return 'recording+test', sorted(set(linked))[:3]
        tests = [f'{short(r)}:{n}' for m in methods for r, n, t in self.rust.literals.get(m, []) if t][:2]
        if recordings:
            return 'recording', [f'{f} (exact={self.exact.get(f)})' for _, f in recordings[:2]] + [f'unlinked: {x}' for x in loose[:1]]
        if tests:
            return 'test', tests
        return 'none', []


# --------------------------------------------------------------------------------------------------
# 6. Classification
# --------------------------------------------------------------------------------------------------


def feature_of(name: str, api_key: str | None) -> str:
    for rx, feature in FEATURE_RULES:
        if re.search(rx, name) or (api_key and re.search(rx, api_key)):
            return feature
    return 'Phone session plumbing'


def method_check(tables, method):
    row = tables['methods'].get(method)
    if not row:
        return 'no such method in method_table.json'
    if 'relay' not in row['origins']:
        return f'origins {row["origins"]} exclude relay: a phone is refused'
    return ''


def rust_side(tables, rust: RustTree, target: dict | None, mech: dict | None):
    """Returns dict(kind, targets, problems, sites, composed)."""
    out = dict(kind='none', targets=[], problems=[], sites=[], composed=[], shape=[])
    if mech:
        out.update(kind=mech['kind'], targets=mech['rust'])
        for t in mech['rust']:
            if t not in tables['methods'] and t not in tables['client_notifications'] and t not in tables['server_notifications']:
                raise SystemExit(f'MECHANICS target {t} is not in the method table')
            if t in tables['methods'] and 'relay' not in tables['methods'][t]['origins']:
                out['problems'].append(f'{t}: origins exclude relay')
        file, rx = mech['evidence']
        hit = rust.find(rx, file.replace('native/core/', 'native/core/'))
        if not hit:
            raise SystemExit(f'MECHANICS evidence not found: {mech}')
        out['sites'] = [hit]
        return out
    if target is None:
        out['problems'].append('not in the DS inventory (operations_map.json)')
        return out
    kind, tg = target['target']['kind'], target['target']['target']
    out['kind'] = kind
    if kind in ('method', 'methods'):
        ms = [tg] if kind == 'method' else list(tg)
        out['targets'] = ms
        for m in ms:
            problem = method_check(tables, m)
            if problem:
                out['problems'].append(f'{m}: {problem}')
                continue
            row = tables['methods'][m]
            out['shape'].append(f'{m}({row["params"]}) -> {row["result"]}')
            sites = rust.handler_sites(m)
            if not sites:
                # An app-server built-in: a `ClientRequest::<Variant>` arm in server.rs (turn/interrupt -> TurnInterrupt).
                variant = ''.join(part[:1].upper() + part[1:] for part in m.split('/'))
                hit = rust.find(rf'ClientRequest::{variant}\b', 'native/core/crates/mixdog-app-server/src/server.rs')
                if hit:
                    out['sites'].append(hit)
                    out['composed'].append('app-server built-in (Server::dispatch)')
                    continue
            if not sites:
                out['problems'].append(f'{m}: no non-test string literal of the method in any handler crate')
                continue
            rel, n, _ = sites[0]
            out['sites'].append(f'{short(rel)}:{n}')
            service = rust.service_of(rel, n)
            if service:
                comp = rust.composed(service)
                out['composed'].append(f'{service} @ {comp}' if comp else f'{service} @ NOT referenced by the daemon')
                if not comp:
                    out['problems'].append(f'{m}: {service} is not built by mixdog-app-server-daemon')
            else:
                out['composed'].append('core path (session actor / app-server built-in)')
    elif kind == 'section':
        info = tables['sections'].get(tg)
        out['targets'] = [info['notification'] if info else tg]
        if not info:
            out['problems'].append(f'section {tg} is not in mixdog-protocol section.rs')
        else:
            out['sites'] = rust.publishers(info['variant'])
            if not out['sites']:
                out['problems'].append(f'section {tg}: no `SectionName::{info["variant"]}` publisher outside the protocol crates')
    elif kind == 'clientNotification':
        out['targets'] = [tg]
        sites = [s for s in rust.literals.get(tg, []) if not s[2] and rust.crate(s[0]) not in ('mixdog-app-protocol', 'mixdog-app-server-client', 'mixdog-protocol')]
        out['sites'] = [f'{short(sites[0][0])}:{sites[0][1]}'] if sites else []
        if tg not in tables['client_notifications']:
            out['problems'].append(f'{tg} not in clientNotifications')
        elif not sites:
            out['problems'].append(f'{tg}: nobody handles it')
    elif kind == 'serverRequestResponse':
        out['targets'] = [tg]
        if tg not in tables['server_requests']:
            out['problems'].append(f'{tg} not in serverRequests')
        sites = [s for s in rust.literals.get(tg, []) if not s[2] and rust.crate(s[0]) not in ('mixdog-app-protocol', 'mixdog-app-server-client', 'mixdog-protocol')]
        out['sites'] = [f'{short(sites[0][0])}:{sites[0][1]}'] if sites else []
    elif kind in ('byDesign', 'deleted'):
        out['targets'] = []
        out['problems'].append(f'removed by design: {tg}')
    elif kind == 'initializeField':
        out['targets'] = [f'initialize.{tg}']
        hit = rust.find(r'\bdevice\b', 'native/core/crates/mixdog-app-protocol/src/v1.rs')
        out['sites'] = [hit] if hit else []
        if not hit:
            out['problems'].append('initialize result has no device field')
    else:
        out['targets'] = []
        out['problems'].append(f'inventory target kind {kind}: {tg}')
    return out


def classify(row, rust_info, proof_level):
    name = row['name']
    if name in PHONE_O1:
        return 'phone-changed'
    kind = rust_info['kind']
    if kind in ('byDesign', 'deleted'):
        return 'missing'
    if rust_info['problems']:
        return 'missing'
    if proof_level == 'recording+test':
        return 'same'
    return 'exists-unproven'


def verify_tables(rust: RustTree, tables):
    for name, (files, why) in {k: (v[0], v[1]) for k, v in EVENT_MAP.items()}.items():
        for target in files:
            if target not in tables['server_notifications'] and target not in tables['client_notifications']:
                raise SystemExit(f'EVENT_MAP[{name}] names {target}, not in method_table.json notifications')
    for name, (path, token) in PHONE_O1.items():
        if token not in (ROOT / path).read_text('utf8'):
            raise SystemExit(f'PHONE_O1[{name}]: {token!r} not in {path}')


# --------------------------------------------------------------------------------------------------
# 7. Push, transfer and transport surfaces
# --------------------------------------------------------------------------------------------------


def push_rows(base: Base, rust: RustTree) -> list[dict]:
    sw = base.text(f'{DESKTOP}/renderer/public/sw.js')
    notifier = base.text(f'{DESKTOP}/main/push-notifier.ts')
    crypto = base.text(f'{DESKTOP}/shared/native-push-crypto.ts')
    rows = []

    def at(text, pattern, path):
        m = re.search(pattern, text)
        if not m:
            raise SystemExit(f'push probe not found: {pattern} in {path}')
        return f'{path}:{line_of(text, m.start())}'

    # Web Push: what the service worker reads, what the PC wrote.
    payload_literal = re.search(r"const payload = JSON\.stringify\(\{(.*?)\n  \}\);", notifier, re.S).group(1)
    web_fields = re.findall(r'^\s*(?:\.\.\.\(hostId \? \{ (\w+)|(\w+)[,:])', payload_literal, re.M)
    web_fields = sorted({a or b for a, b in web_fields} | {'data'})
    sw_reads = sorted(set(re.findall(r'payload\??\.(?:data\??\.)?(\w+)', sw)))
    rows.append(dict(
        surface='push', name='Web Push payload (service worker `push` event)', direction='PC -> phone',
        phone=f'sw.js reads payload.{{{", ".join(sw_reads)}}} -> notification title/body/tag/data{{sessionId,hostId}}',
        phone_site=at(sw, r"addEventListener\('push'", f'{DESKTOP}/renderer/public/sw.js'),
        node=[at(notifier, r'const payload = JSON\.stringify', f'{DESKTOP}/main/push-notifier.ts')],
        node_shape=f'JSON {{{", ".join(web_fields)}}}; data{{sessionId,reason,hostId?}}; RFC 8291 encrypted per subscription (web-push.ts)',
        rust_fields=['title', 'body', 'sessionId', 'reason', 'hostId', 'data'],
        rust_files=['native/core/crates/mixdog-core-domains/src/notify/', 'native/core/crates/mixdog-remote/src/push/web.rs', 'native/core/crates/mixdog-remote/src/access/runtime.rs'],
        proof_fixture='native/core/crates/mixdog-remote/tests/it/web_push_kat.rs'))
    # Native push.
    content = re.search(r'export interface NativePushContent \{(.*?)\n\}', crypto, re.S).group(1)
    native_fields = re.findall(r'^\s{2}(\w+)\??:', content, re.M)
    rows.append(dict(
        surface='push', name='Native push `mx` envelope (APNs / FCM)', direction='PC -> relay -> phone',
        phone=f'Android MixdogMessagingService / iOS NotificationService decrypt `mx` -> {{{", ".join(native_fields)}}}',
        phone_site='apps/mobile/android/app/src/main/java/io/mixdog/app/MixdogMessagingService.java:22',
        node=[at(crypto, r'export function encryptNativePush', f'{DESKTOP}/shared/native-push-crypto.ts'), at(notifier, r'const content: NativePushContent', f'{DESKTOP}/main/push-notifier.ts')],
        node_shape=f'relay frame {{platform, token, sandbox, mx, reason(turn-failed sent as turn-finished), collapseKey}}; content {{{", ".join(native_fields)}}}; ECDH P-256 + HKDF-SHA256 + AES-256-GCM (mixdog-native-push-v1)',
        rust_fields=native_fields + ['mx', 'collapseKey'],
        rust_files=['native/core/crates/mixdog-remote/src/push/native_crypto.rs', 'native/core/crates/mixdog-remote/src/push/native.rs', 'native/core/crates/mixdog-remote/src/access/runtime.rs'],
        proof_fixture='native/core/crates/mixdog-remote/tests/it/native_push_kat.rs'))
    rows.append(dict(
        surface='push', name='Notification actions Allow / Deny (approval push)', direction='phone -> PC',
        phone='MixdogNotifications.java (allow/deny extras mx_action_id, session, approval, host) / iOS categories MIXDOG_APPROVAL(_DENY) -> web app -> answerApprovalNotification(sessionId, approvalId, action)',
        phone_site=f'{DESKTOP}/renderer/native-push-bridge.ts:57',
        node=[f'{DESKTOP}/main/push-notifier.ts:607', f'{DESKTOP}/main/remote-relay-device-methods.ts'],
        node_shape='approvalAllowsOnce / approvalAllowDecision / approvalPointerOnly checks, then resolves the pending tool approval',
        rust_fields=['allowOnce', 'approvalId'],
        rust_files=['native/core/crates/mixdog-core-domains/src/notify/'],
        proof_fixture=None, via_inventory='answerApprovalNotification'))
    return rows


def transport_rows(base: Base, rust: RustTree) -> list[dict]:
    return [
        dict(surface='transport', name='Relay E2EE handshake (challenge -> hello -> e2ee-ready)', direction='both',
             phone=f'{DESKTOP}/shared/remote-e2ee.ts createRelayE2EEClientHandshake (reused unchanged by apps/mobile/src/relay-connector.ts)',
             node=[f'{DESKTOP}/main/remote-e2ee.ts', f'{DESKTOP}/main/remote-relay-session-wiring.ts'],
             rust_files=['native/core/crates/mixdog-remote/src/e2ee/handshake.rs'],
             proof='native/core/fixtures/remote-e2ee/session.json', proof_test='native/core/crates/mixdog-remote/tests/it/e2ee_fixture.rs',
             o1_phone='apps/mobile/src/relay-connector.ts'),
        dict(surface='transport', name='MXT transport / WebRTC data-channel carrier', direction='both',
             phone=f'{DESKTOP}/renderer/remote-transport-peer.ts (reused by relay-connector.ts)',
             node=[f'{DESKTOP}/main/remote-relay-session-wiring.ts'],
             rust_files=['native/core/crates/mixdog-remote/src/transport/', 'native/core/crates/mixdog-remote/src/webrtc/carrier.rs'],
             proof='native/core/fixtures/remote-transport/vectors.json', proof_test='native/core/crates/mixdog-remote/tests/it/transport_vectors.rs',
             o1_phone='apps/mobile/src/relay-connector.ts'),
        dict(surface='transport', name='Relay redial / desktop leg replacement', direction='PC <-> relay',
             phone=f'{DESKTOP}/renderer/remote-shim-socket.ts (desktop-gone notice, challenge after ready)',
             node=[f'{DESKTOP}/main/remote-relay-connection.ts'],
             rust_files=['native/core/crates/mixdog-remote/src/leg/redial.rs'],
             proof='native/core/fixtures/remote-relay-redial/golden.json', proof_test='native/core/crates/mixdog-remote/tests/it/relay_redial.rs',
             o1_phone='apps/mobile/src/relay-connector.ts'),
        dict(surface='transport', name='Encrypted media lane (service worker sw-media.js, `/m/<asset>?sid&enc=e2ee1`, ranged)', direction='phone -> PC',
             phone=f'{DESKTOP}/renderer/public/sw-media.js + remote-media-lane.ts',
             node=[f'{DESKTOP}/main/remote-relay-media.ts'],
             rust_files=['native/core/crates/mixdog-remote/src/media/mod.rs', 'native/core/crates/mixdog-remote/src/media/range.rs'],
             proof=None, proof_test=None, o1_phone=None),
        dict(surface='transport', name='Native file save (fileSaveBegin/Write/Finish/Abort, getNativeCapabilities)', direction='phone-local',
             phone='apps/desktop/src/renderer/file-download-transfer.ts -> MixdogFileSave.java / MixdogFileSave.swift (not sent to the PC)',
             node=[], rust_files=[], proof=None, proof_test=None, o1_phone=None),
    ]


def module_wired(rust: RustTree, crate: str, module: str) -> str | None:
    """First non-test use of `<module>` from outside its own directory, in the crate or elsewhere."""
    own = f'native/core/crates/{crate}/src/'
    outer = re.compile(rf'\b{crate.replace("-", "_")}::(?:\w+::)*{module}\b')
    inner = re.compile(rf'\b(?:crate|super)::(?:\w+::)*{module}\b')
    for rel, lines in rust.files.items():
        if rel.startswith(own + module) or is_test_path(rel):
            continue
        rx = inner if rel.startswith(own) else outer
        for n, text in enumerate(lines, 1):
            if rx.search(text) and not text.strip().startswith('//'):
                return f'{short(rel)}:{n}'
    return None


def symbol_wired(rust: RustTree, symbol: str, defined_in: str) -> str | None:
    """First non-test reference to `symbol` outside the file that defines it."""
    rx = re.compile(rf'\b{symbol}\b')
    for rel, lines in rust.files.items():
        if rel.endswith(defined_in) or is_test_path(rel):
            continue
        for n, text in enumerate(lines, 1):
            if n >= rust.test_from.get(rel, 10**9):
                break
            if rx.search(text) and not text.strip().startswith('//'):
                return f'{short(rel)}:{n}'
    return None


TRANSFER_RX = r'^(fileDownload|resolveLocalPaths|readLocalFile|attachmentOpen|readAttachmentThumbnail|previewProjectFileRange|previewDocumentPages|visualizePane|visualizeExport|captureFileSnapshot)'

# Live-view names: the Rust live view exists only if something outside tests builds it.
LIVE_VIEW = {'browserRemoteStream', 'browserRemoteStreamAck', 'browserRemoteScreenDisplays', 'browserRemoteWebrtcSignal'}


def build_rows(args):
    base = Base(Path(args.repo), args.base)
    now = WorkTree(Path(args.repo))
    rust = RustTree()
    tables = load_tables()
    verify_tables(rust, tables)
    rec = Recordings(rust)
    node = node_index(base)
    sigs = contract_signatures(base)
    ifaces = interface_fields(base)
    phone = extract_calls(base)
    now_calls = extract_calls(now)['calls']
    live_view_site = symbol_wired(rust, 'LiveViewConnection', 'webrtc/liveview.rs')

    rows = []
    for name in sorted(phone['calls']):
        call = phone['calls'][name]
        mech = MECHANICS.get(name)
        item = tables['inventory'].get(name)
        info = rust_side(tables, rust, None if mech else item, mech)
        if name in LIVE_VIEW:
            info = dict(kind='none', targets=[], problems=[], sites=[], composed=[], shape=[])
            if not live_view_site:
                info['problems'].append('the Rust live view (mixdog-remote webrtc/liveview.rs LiveViewConnection) is built only by interop tests; nothing in the daemon starts it for a phone')
        crates = {RustTree.crate(s.split(':')[0] if s.startswith('native') else 'native/core/crates/' + s.split(':')[0]) for s in info['sites']}
        api_key = call['api_key'] if call['api_key'] in sigs else (name if name in sigs else '')
        level, evidence = rec.proof([name], info['targets'], crates)
        sig = sigs.get(api_key, '')
        phone_o1 = 'replaced: ' + PHONE_O1[name][0] if name in PHONE_O1 else ('unchanged' if name in now_calls else 'removed')
        row = dict(
            surface='transfer' if re.search(TRANSFER_RX, name) else 'request', name=name, api_key=api_key, kind=call['kind'],
            phone_sites=call['sites'][:3], phone_args=sorted(set(call['args']))[:2], phone_reply=reply_of(sig, ifaces),
            node=node_handlers(node, name), inventory=(item or {}).get('list', 'mechanics' if mech else ''),
            rust_kind=info['kind'], rust_targets=info['targets'], rust_shape=info['shape'], rust_sites=info['sites'], rust_composed=info['composed'],
            problems=info['problems'], proof=level, proof_evidence=evidence, phone_o1=phone_o1,
        )
        row['server'] = server_state(row)
        row['class'] = classify(row, info, level)
        row['feature'] = feature_of(name, api_key) if row['class'] in ('exists-unproven', 'missing') or row['server'] != 'served' else ''
        rows.append(row)
    return dict(rows=rows, rust=rust, rec=rec, tables=tables, base=base, node=node, phone=phone, now=now, live_view_site=live_view_site)


def server_state(row) -> str:
    if row['rust_kind'] in ('byDesign', 'deleted'):
        return 'by-design'
    if row['problems']:
        return 'unserved'
    return 'served'


FOLDED_NOTIFICATIONS = {'app/snapshot', 'thread/started', 'thread/summary/updated', 'thread/deleted', 'thread/archived', 'thread/unarchived'}
# Nodes recordings that cover an inbound stream, checked for a Rust consumer.
EVENT_PROOF = {'sessionState': 'session-state/stream.json'}
PROTOCOL_CLIENT_TOKEN = ('packages/protocol-client/src/method-table.ts', 'SectionUpdate')


def node_event_sites(base: Base, name: str, const: str | None, limit: int = 2) -> list[str]:
    """Where the baseline PC emits the event: remote-*/push files that name the wire string or its constant on an emitting line."""
    emit = re.compile(r'event|broadcast|emit|publish|send|push|fanOut', re.I)
    out = []
    for path in base.files(f'{DESKTOP}/main'):
        file = path.rsplit('/', 1)[-1]
        if not re.match(r'(remote-|push-|desktop-session|web-push)', file):
            continue
        for n, line in enumerate(base.text(path).split('\n'), 1):
            if (f"'{name}'" in line or (const and re.search(rf'\b{const}\b', line))) and emit.search(line) and not line.strip().startswith(('//', '*', 'import')):
                out.append(f'{path}:{n}')
                break
        if len(out) == limit:
            break
    return out


def event_rows(data) -> list[dict]:
    base, rust, tables, rec, node = data['base'], data['rust'], data['tables'], data['rec'], data['node']
    sections_by_notification = {v['notification']: v for v in tables['sections'].values()}
    rows = []
    seen = set()
    for e in extract_events(base):
        name = e['event']
        if name in seen:
            continue
        seen.add(name)
        if name not in EVENT_MAP:
            raise SystemExit(f'inbound event {name!r} ({e["site"]}) has no EVENT_MAP entry')
        targets, why = EVENT_MAP[name]
        sites, problems, folded = [], [], bool(targets)
        for t in targets:
            note = tables['server_notifications'][t]
            folded = folded and (note['params'] == 'SectionUpdate' or note['delivery'] == 'thread' or t in FOLDED_NOTIFICATIONS)
            sec = sections_by_notification.get(t)
            if sec:
                found = rust.publishers(sec['variant'])
            else:
                found = [f'{short(s[0])}:{s[1]}' for s in rust.literals.get(t, []) if not s[2] and rust.crate(s[0]) not in ('mixdog-app-protocol', 'mixdog-protocol', 'mixdog-app-server-client')][:1]
            if not found and not sec:
                variant = ''.join(part[:1].upper() + part[1:] for part in re.split(r'[/]', t))
                rx = re.compile(rf'\b{variant}\b')
                found = [f'{short(rel)}:{n}' for rel, lines in rust.files.items() if rust.crate(rel) not in ('mixdog-app-protocol', 'mixdog-protocol', 'mixdog-app-server-client') and not is_test_path(rel)
                         for n, text in enumerate(lines, 1) if rx.search(text) and not text.strip().startswith('//')][:1]
            if t == 'host/state/updated':
                found = found + rust.publishers('HostState')
            if found:
                sites.append(f'{t} <- {found[0]}')
            else:
                problems.append(f'{t}: static search found no publisher outside the protocol crates')
        if name == 'relayRoutingCaps':
            hit = rust.find(r'routing|Routing', 'native/core/crates/mixdog-remote/src/leg')
            sites = [hit] if hit else []
            if not hit:
                problems.append('mixdog-remote/leg has no routing-caps handling')
        proof, ev = 'none', []
        if name in EVENT_PROOF:
            refs = rec.rust_refs(EVENT_PROOF[name])
            if refs:
                proof, ev = 'recording+test', [f'{EVENT_PROOF[name]} <- {short(refs[0][0])}:{refs[0][1]}']
        replaced = 'replaced: ' + PROTOCOL_CLIENT_TOKEN[0] if folded else 'unchanged'
        if folded and PROTOCOL_CLIENT_TOKEN[1] not in (ROOT / PROTOCOL_CLIENT_TOKEN[0]).read_text('utf8'):
            raise SystemExit('protocol-client no longer folds section updates')
        cls = 'phone-changed' if folded else ('missing' if problems else ('same' if proof == 'recording+test' else 'exists-unproven'))
        const_nodes = node_handlers(node, e['const'] or name) if e['const'] else []
        rows.append(dict(surface='event', name=name, kind='inbound', phone_sites=[e['site']], phone_args=[], phone_reply=e['reader'] or '(payload used as is)',
                         node=node_event_sites(base, name, e['const']), inventory='EVENT_MAP', rust_kind='notification', rust_targets=targets, rust_shape=[why],
                         rust_sites=sites, rust_composed=[], problems=problems, proof=proof, proof_evidence=ev, phone_o1=replaced,
                         server='unserved' if problems else 'served', **{'class': cls}, feature='' if cls in ('same', 'phone-changed') and not problems else EVENT_FEATURE.get(name, 'Live updates on the phone')))
    return rows


EVENT_FEATURE = {
    'browserRemoteFrame': 'Remote browser live view on the phone', 'browserRemoteWebrtc': 'Remote browser live view on the phone',
    'browserRemoteTabs': 'Remote browser tabs on the phone', 'browserProfileImportProgress': 'Browser profile import progress',
    'browserOpenRequested': 'A PC-side link opens the browser pane on the phone', 'terminalRunRequested': 'Agent terminal commands open a terminal tab on the phone',
    'termData': 'Terminal tabs (output)', 'termSizeOwner': 'Terminal tabs (size owner)', 'termActivity': 'Terminal tab activity dots',
    'folderChanged': 'File tree refresh when files change on the PC', 'lspDiagnostics': 'Editor diagnostics', 'lspStatus': 'Editor language-server status',
    'visualizeChanged': 'Visualize panel (agent canvases) on the phone', 'relayRoutingCaps': 'Large replies / payload limits on the relay leg',
}


def push_and_transport_rows(data) -> list[dict]:
    base, rust, rows_by_name = data['base'], data['rust'], {r['name']: r for r in data['rows']}
    out = []
    for p in push_rows(base, rust):
        problems = []
        text = ''
        for f in p['rust_files']:
            path = ROOT / f
            files = [x for x in path.rglob('*.rs')] if path.is_dir() else [path]
            text += '\n'.join(x.read_text('utf8') for x in files if not is_test_path(x.relative_to(ROOT).as_posix()))
        for field in p['rust_fields']:
            snake = re.sub(r'(?<!^)([A-Z])', lambda m: '_' + m.group(1).lower(), field)
            if not re.search(rf'\b({re.escape(field)}|{snake})\b', text):
                problems.append(f'`{field}` appears in none of {p["rust_files"]}')
        proof, ev = 'none', []
        fx = p.get('proof_fixture')
        if fx:
            t = (ROOT / fx).read_text('utf8')
            kat = re.search(r'fn (\w*equals?_(?:the_)?node\w*)|const NODE_\w+', t)
            if kat:
                proof, ev = 'known-answer', [f'{short(fx)}: {kat.group(0)} (cipher output vs a Node-computed vector; payload assembly in access/runtime.rs is not compared with Node)']
        inv = p.get('via_inventory')
        cls = rows_by_name[inv]['class'] if inv else ('missing' if problems else 'exists-unproven')
        server = 'unserved' if problems else 'served'
        out.append(dict(surface=p['surface'], name=p['name'], kind=p['direction'], phone_sites=[p['phone_site']], phone_args=[], phone_reply=p['phone'],
                        node=p['node'], inventory='push', rust_kind='push', rust_targets=[], rust_shape=[p['node_shape']], rust_sites=p['rust_files'], rust_composed=[],
                        problems=problems, proof=proof, proof_evidence=ev, phone_o1='unchanged (apps/mobile native decryptors untouched; test vector shared)',
                        server=server, feature='Push notifications when a turn finishes, needs input or approval' if cls != 'same' else '', **{'class': cls}))
    for t in transport_rows(base, rust):
        if t['direction'] == 'phone-local':
            continue
        problems, sites = [], []
        modules = {'Relay E2EE': 'e2ee', 'MXT': 'transport', 'Relay redial': 'leg', 'Encrypted media': 'media'}
        mod = next(v for k, v in modules.items() if t['name'].startswith(k))
        wired = module_wired(rust, 'mixdog-remote', mod)
        if wired:
            sites.append(wired)
        else:
            problems.append(f'mixdog-remote `{mod}` module is not used by any non-test code outside its own directory (access/runtime.rs does not reach it)')
        proof, ev = 'none', []
        if t['proof'] and (ROOT / t['proof']).exists():
            if t['proof'].split('/')[-2] in (ROOT / t['proof_test']).read_text('utf8') or t['proof'].split('/')[-1] in (ROOT / t['proof_test']).read_text('utf8'):
                proof, ev = 'recording+test', [f'{t["proof"]} <- {short(t["proof_test"])}']
        cls = 'missing' if problems else ('same' if proof == 'recording+test' else 'exists-unproven')
        if mod == 'transport':
            t['name'] += ' [relay carrier still works: the challenge simply does not offer it]'
        out.append(dict(surface='transport', name=t['name'], kind=t['direction'], phone_sites=[t['phone']], phone_args=[], phone_reply='', node=t['node'], inventory='transport',
                        rust_kind='module', rust_targets=[], rust_shape=[], rust_sites=sites + t['rust_files'], rust_composed=[], problems=problems, proof=proof, proof_evidence=ev,
                        phone_o1='reused: ' + t['o1_phone'] if t['o1_phone'] else 'unchanged', server='unserved' if problems else 'served', **{'class': cls},
                        feature={'transport': 'Direct phone-to-PC data channel (lower latency, less relay load)', 'media': 'Inline image / video / audio previews and ranged downloads on the phone'}.get(mod, '') if cls != 'same' else ''))
    return out


def unit_of(row) -> str:
    cls, surface, name = row['class'], row['surface'], row['name']
    if row['server'] == 'unserved':
        if re.search(r'live view|browserRemote|viewFrames', ' '.join(row['problems']) + name):
            return 'RS-2 live view and remote screen'
        if row['surface'] == 'transport':
            return 'RS-1 transport and media lane wiring'
        if row['surface'] == 'event':
            return 'RS-5 event publishers'
        return 'RS-6 other served gaps'
    if row['surface'] == 'push' and cls != 'same':
        return 'RS-3 push payload parity'
    if cls == 'phone-changed' and row['phone_o1'].startswith('replaced') and row['surface'] in ('request',):
        return 'PH-1 connect the phone UI to phone-client'
    if cls in ('exists-unproven', 'missing', 'same', 'phone-changed') and row['phone_o1'].startswith('unchanged'):
        return 'PH-2 phone UI calls -> protocol methods'
    return ''


# Units: name -> (deliverable, crates / paths, depends)
UNITS = {
    'PH-1 connect the phone UI to phone-client': ('apps/mobile main.ts + renderer boot call `connectPhone` and report screen/foreground/visible threads through `screen-reporter`; drop remote-shim socket, pairing frames, view sync',
                                                  'apps/mobile/src, apps/desktop/src/renderer/remote-shim*.ts (no Rust)'),
    'PH-2 phone UI calls -> protocol methods': ('a DesktopApi adapter over `client.store` + typed methods, one new file per feature group so groups do not overlap',
                                                'apps/desktop/src/renderer/remote-protocol-<group>.ts, packages/protocol-client (no Rust)'),
    'RS-1 transport and media lane wiring': ('construct the MXT transport, ICE servers and encrypted media lane from `access/runtime.rs` and offer them in the challenge flags',
                                             'mixdog-remote (access, leg, transport, media, ice), mixdog-app-server-daemon (compose_flip registration)'),
    'RS-2 live view and remote screen': ('start `LiveViewConnection` for a phone: signalling method, display list, input channel, frame sources from host/browser/viewFrames',
                                         'mixdog-remote (webrtc, and access/runtime.rs only to hand over the signalling: do after RS-1), mixdog-app-server-daemon (media.rs), mixdog-app-protocol (host.rs, schema)'),
    'RS-3 push payload parity': ('record Node push payload assembly (title/body/data/reason, suppress rules) and compare with notify/ output',
                                 'mixdog-core-domains (notify), mixdog-remote (push); recorder under benchmarks/rust-core/recorders'),
    'RS-5 event publishers': ('publish the notifications the static search found no publisher for (`thread/started` for the session list, `model/catalog/updated`) and answer the phone-visible events they feed', 'mixdog-core-session (thread started), mixdog-core-domains (ai_admin model catalog section)'),
    'RS-6 other served gaps': ('rows with no handler or no relay origin', 'by row'),
}


def counts(rows):
    c = collections.Counter(r['class'] for r in rows)
    return {k: c.get(k, 0) for k in ('same', 'exists-unproven', 'missing', 'phone-changed')}


def md_cell(x) -> str:
    if isinstance(x, list):
        x = '<br>'.join(str(i) for i in x)
    return str(x).replace('|', '\\|').replace('\n', ' ')


def which_side(data) -> list[str]:
    repo, rev = str(ROOT), data['base'].rev
    def git(*a):
        return subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True, check=True).stdout
    out = []
    changed = git('diff', '--name-status', rev, 'HEAD', '--', 'apps/mobile', 'apps/relay', 'packages/protocol-client', ':(glob)apps/desktop/src/renderer/remote-*', ':(glob)apps/desktop/src/renderer/native-push-bridge.ts',
                  ':(glob)apps/desktop/src/renderer/public/*', 'apps/desktop/src/shared/remote-e2ee.ts', 'apps/desktop/src/shared/native-push-crypto.ts').strip().split('\n')
    changed = [c for c in changed if c]
    added = [c.split('\t')[1] for c in changed if c[0] == 'A' and '.test.' not in c]
    other = [c for c in changed if c[0] != 'A']
    apps_added = [a for a in added if a.startswith('apps/')]
    lib_added = [a for a in added if a.startswith('packages/protocol-client/')]
    out.append(f'- Phone-side paths diffed against the baseline: apps/mobile, apps/relay, renderer remote-*/sw*/native-push-bridge, shared remote-e2ee/native-push-crypto, packages/protocol-client. Modified or deleted: {len(other)} ({", ".join(c.split(chr(9))[1] for c in other) or "none"}); added non-test files: {len(apps_added)} under apps/ and {len(lib_added)} under packages/protocol-client (the client library).')
    out.append('  - added under apps/: ' + ', '.join(f'`{a}`' for a in apps_added))
    users = []
    adapter_users = []
    for path in git('ls-files', 'apps', 'packages').split('\n'):
        if path.endswith(('.ts', '.tsx', '.mjs')) and '.test.' not in path:
            try:
                text = (ROOT / path).read_text('utf8')
            except OSError:
                continue
            if re.search(r"from '[^']*phone-client(\.ts)?'", text) and not path.endswith('phone-client.ts'):
                users.append(path)
            if 'sectionsSourceFromFoldStore' in text and not path.endswith('section-store.ts'):
                adapter_users.append(path)
    out.append('- Non-test importers of `apps/mobile/src/phone-client.ts`: ' + (', '.join(f'`{u}`' for u in users) or '**none**: the protocol-client connector is not wired into the pairing screen or the relay web app.'))
    out.append('- Non-test callers of `sectionsSourceFromFoldStore` (renderer/section-store.ts, the phone-store adapter): ' + (', '.join(f'`{u}`' for u in adapter_users) or '**none**.'))
    shim = (ROOT / f'{DESKTOP}/renderer/remote-shim-calls.ts').read_text('utf8')
    out.append('- The relay web app the phone loads still builds Node call frames (`remote-shim-calls.ts` sends `{id, method, params: [...]}` with Node method names); `mixdog-remote` bridges frames byte for byte (`bridge/mod.rs` header), so those frames reach the core as unknown JSON-RPC methods. ' + ('(frame shape confirmed in remote-shim-calls.ts)' if 'params' in shim else ''))
    return out


def write(rows, rust: RustTree, args, data):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for r in rows:
        r['unit'] = unit_of(r)
        r['area'] = feature_of(r['name'], r.get('api_key')) if r['surface'] in ('request', 'transfer') else (r['feature'] or 'Live updates on the phone')
    (out / 'phone-protocol-table.json').write_text(json.dumps(rows, indent=1, ensure_ascii=False) + '\n', 'utf8', newline='\n')
    lines = []
    w = lines.append
    base_rev = data['base'].rev
    w('# Phone protocol audit')
    w('')
    w(f'Baseline `{base_rev[:9]}` (Node). Tree audited: `{subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short=9", "HEAD"], capture_output=True, text=True).stdout.strip()}`. Generated by `audit.py`; do not edit by hand.')
    w('')
    w('## Counts')
    w('')
    w('| surface | same | exists-unproven | missing | phone-changed | total |')
    w('|---|---|---|---|---|---|')
    by_surface = collections.defaultdict(list)
    for r in rows:
        by_surface[r['surface']].append(r)
    for s, rs in by_surface.items():
        c = counts(rs)
        w(f'| {s} | {c["same"]} | {c["exists-unproven"]} | {c["missing"]} | {c["phone-changed"]} | {len(rs)} |')
    c = counts(rows)
    w(f'| **all** | **{c["same"]}** | **{c["exists-unproven"]}** | **{c["missing"]}** | **{c["phone-changed"]}** | **{len(rows)}** |')
    w('')
    sv = collections.Counter(r['server'] for r in rows)
    w(f'Server side (independent of class): served {sv["served"]}, unserved {sv["unserved"]}, removed by design {sv["by-design"]}.')
    uc = collections.Counter(r['phone_o1'].split(':')[0].split(' ')[0] for r in rows)
    w(f'Phone side at the audited tree: {dict(uc)}.')
    w('')
    w('## Port units')
    w('')
    w('| unit | deliverable | crates / paths | rows | classes |')
    w('|---|---|---|---|---|')
    grouped = collections.defaultdict(list)
    for r in rows:
        if r['unit']:
            grouped[r['unit']].append(r)
    for u, (what, crates) in UNITS.items():
        rs = grouped.get(u, [])
        if rs:
            cc = counts(rs)
            w(f'| {u} | {what} | {crates} | {len(rs)} | {", ".join(f"{k} {v}" for k, v in cc.items() if v)} |')
    w('')
    w('### PH-2 groups (one new adapter file per group, so workers do not overlap)')
    w('')
    w('| group | calls | names |')
    w('|---|---|---|')
    groups = collections.defaultdict(list)
    for r in grouped.get('PH-2 phone UI calls -> protocol methods', []):
        groups[r['area']].append(r['name'])
    for g, names in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        w(f'| {g} | {len(names)} | {", ".join(sorted(names))} |')
    w('')
    w('## Which side changed')
    w('')
    for line in which_side(data):
        w(line)
    w('')
    w('### Recorded-parity units (exists-unproven rows, by handler crate)')
    w('')
    w('Each is one crate: write the Node recorder (if missing) and the Rust test that replays it against the relay-origin method. Crates are disjoint, so these run in parallel.')
    w('')
    w('| crate | rows | phone names |')
    w('|---|---|---|')
    per_crate = collections.defaultdict(list)
    for r in rows:
        if r['class'] == 'exists-unproven' and r['surface'] in ('request', 'transfer'):
            site = (r['rust_sites'] or [''])[0]
            crate = site.split('/')[0] if site else '(core path)'
            per_crate[crate].append(r['name'])
    for crate, names in sorted(per_crate.items(), key=lambda kv: -len(kv[1])):
        w(f'| {crate} | {len(names)} | {", ".join(sorted(names))} |')
    w('')
    w('## Table')
    w('')
    w('Columns: `phone` = where the baseline phone sends/reads it; `args` = params shape the phone sends (positional array); `reply` = declared reply type in `shared/contract*.ts`; `node` = serving module at the baseline; `rust` = method(s) and shape in `method_table.json`; `handler` = Rust handler line; `proof` = Node recording / Rust test; `phone o1` = which side changed.')
    w('')
    for surface in ('request', 'transfer', 'event', 'push', 'transport'):
        rs = by_surface.get(surface, [])
        if not rs:
            continue
        w(f'### {surface} ({len(rs)})')
        w('')
        w('| name | class | server | phone | args | reply | node | rust | handler | proof | phone o1 | feature (gaps) | unit |')
        w('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
        for r in rs:
            rust_cell = r['rust_shape'] or r['rust_targets'] or ([r['rust_kind']] if r['rust_kind'] != 'none' else [])
            if r['problems']:
                rust_cell = list(rust_cell) + ['**' + p + '**' for p in r['problems']]
            w('| ' + ' | '.join(md_cell(x) for x in (
                f'`{r["name"]}`' if surface in ('request', 'transfer', 'event') else r['name'], r['class'], r['server'], r['phone_sites'][:2], r['phone_args'], r['phone_reply'], r['node'],
                rust_cell, (r['rust_sites'] + r['rust_composed'])[:3], [r['proof']] + r['proof_evidence'][:2], r['phone_o1'], r['feature'], r['unit'])) + ' |')
        w('')
    w('## Frames the phone also reads or sends (not methods)')
    w('')
    for f in extract_frames(data['base']):
        w(f'- {f["frame"]} - `{f["site"]}`')
    w('')
    w('## Phone-native host calls (never sent to the PC; excluded from counts)')
    w('')
    nh = collections.defaultdict(list)
    for x in data['phone']['native_host']:
        nh[x['name']].append(f'{x["file"]}:{x["line"]}')
    for n, sites in sorted(nh.items()):
        w(f'- `{n}` - {sites[0]}')
    w('- Native file save (fileSaveBegin/Write/Finish/Abort, getNativeCapabilities): `file-download-transfer.ts` -> `MixdogFileSave.java` / `.swift`.')
    w('')
    (out / 'phone-protocol-table.md').write_text('\n'.join(lines) + '\n', 'utf8', newline='\n')


def run(args):
    data = build_rows(args)
    rows = data['rows'] + event_rows(data) + push_and_transport_rows(data)
    write(rows, data['rust'], args, data)
    print(json.dumps(counts(rows)), len(rows))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='b6f10295a')
    ap.add_argument('--repo', default=str(ROOT))
    ap.add_argument('--out', default=str(HERE))
    args = ap.parse_args()
    return run(args)


if __name__ == '__main__':
    main()
