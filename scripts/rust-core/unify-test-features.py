#!/usr/bin/env python3
"""One feature set for every test build of the workspace, whatever packages are selected.

Cargo resolves features over the packages a command selects, dev-dependencies included. A workspace crate's test-only
feature (`mixdog-core-api/mock`, `mixdog-rt/test-support`, ...) was switched on by the dev-dependencies of only some
crates, so `nextest run -p A`, `-p B`, `-p A -p B` and `--workspace` each built the bottom crates with a different
feature set, and every crate above them again: on 2026-11-10 a target dir held 5-8 builds of `mixdog_core_api` and of
each big crate, three of them made within 20 minutes on a tree nobody edited (2-3 minutes each before a test ran).

After this script every crate names, in its dev-dependencies, each workspace crate its tests build (itself included)
with all of that crate's test-only features. A test build then has one feature set (the one `--workspace` always
had), and a product build (`cargo build -p ... --bin`), which takes no dev-dependencies, the other.

The development build of `mixdogd` has that same set: mixdog-cli's feature `dev-controls` (written here) turns on, for
every library the binary links, the features a test build gives it, and the replay controls (mixdog-cli's other
features) are test features too. cargo-gate adds `dev-controls` to a pool slot's `mixdogd` build, so a test run and a
replay build compile each library once per edit (2026-11-11: one edit of mixdog-store compiled 66 libraries across a
build, a test run and a replay build). Every control in it stays off until switched on at run time.

`codegen` (the schema and TypeScript derives of mixdog-protocol and mixdog-app-protocol) is wanted only by those two
crates' own golden tests, so only their own dev-dependency on themselves names it: everywhere else it doubled the
cost of mixdog-app-protocol (47.6 against 85.5 CPU-s, 2.3 against 3.6 GB peak) under every test build.

Usage: unify-test-features.py <native/core dir> [--write]    (without --write it prints what it would change)
"""
import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

core = Path(sys.argv[1]).resolve()
write = '--write' in sys.argv[2:]
meta = json.loads(subprocess.run(['cargo.exe' if os.name == 'nt' else 'cargo', 'metadata', '--format-version', '1'], capture_output=True, text=True, cwd=core, check=True).stdout)
# The crates built from a path: the workspace's members, and in a checkout from before o1 moved them inside the root
# (build-share: crates/mixdog-{spawn,patch,graph,secure-desktop}), the crates beside it that they name
# (`native/mixdog-spawn`).
packages = {p['name']: p for p in meta['packages'] if p['source'] is None and p['name'] != 'mixdog-workspace-hack'}
members = {p['name'] for p in meta['packages'] if p['id'] in set(meta['workspace_members'])} & set(packages)
# The crates the root's [workspace.dependencies] declares (members, and the tools' packages inside the root since
# build-share): a manifest names them with `workspace = true`, never with a path of its own.
with open(core / 'Cargo.toml', 'rb') as root_manifest:
    root = tomllib.load(root_manifest)
declared = set(root.get('workspace', {}).get('dependencies', {}))
# `[patch]` replacements (vendor/*): third-party crates with a local source. Cargo resolves their features from their
# dependents like any registry crate; none of them is "test-only" except what only a dev-dependency asks for
# (fancy-regex's `probe`). Treating their every resolved feature as a test feature made the tool add them to every
# crate's dev-dependencies and demand `optional = true` entries for them in mixdog-cli.
patched = {name for table in root.get('patch', {}).values() for name in table}

# The features of each of those crates that a member asks for, in any kind of dependency. A member's own dependencies
# ask every other member for none, so for members these are the test-only features; for a crate beside the workspace
# they are every feature some member's build has on (`mixdog-spawn`'s `core-test`, which only mixdog-tools named).
#
# They are read from Cargo's own resolution of the whole workspace with every kind of dependency (what `--workspace`
# builds), not from the manifests: a feature also arrives through another crate's feature (`mixdog-migrate/crash-hook`
# switches on `mixdog-store/crash-hook`), and a crate that asked for the first alone would leave the second to the
# selection.
by_id = {p['id']: p['name'] for p in meta['packages']}
test_features = {name: set() for name in packages}
for node in meta['resolve']['nodes']:
    name = by_id[node['id']]
    if name in packages and name not in patched:
        test_features[name] = set(node['features']) - {'default'}
# A feature a target of the crate itself requires (`[[test]] required-features = ["fake-core"]`) is a test feature even
# when no dev-dependency turns it on: without it the target is skipped, and an agent adds `--features x/fake-core` by
# hand, which is one more feature set of the crate and of everything above it.
for name, p in packages.items():
    if name not in patched:
        for target in p['targets']:
            test_features[name] |= {f for f in target.get('required-features', []) if f in p['features']}

def feature_closure(package, seed, default):
    """The features of `package` that `seed` (and `default`, when asked) switch on, through its own feature table."""
    table = package['features']
    todo = list(seed) + (['default'] if default and 'default' in table else [])
    done = set()
    while todo:
        f = todo.pop()
        if f in done or f not in table:
            continue
        done.add(f)
        todo.extend(i for i in table[f] if '/' not in i and not i.startswith('dep:'))
    return done

for name in sorted(patched & set(packages)):
    # Test-only = switched on by a dev-dependency edge and by no normal or build edge.
    normal, dev, normal_default, dev_default = set(), set(), False, False
    for other in meta['packages']:
        for d in other['dependencies']:
            if d['name'] != name:
                continue
            if d['kind'] == 'dev':
                dev |= set(d['features'])
                dev_default |= d['uses_default_features']
            else:
                normal |= set(d['features'])
                normal_default |= d['uses_default_features']
    test_features[name] = feature_closure(packages[name], dev, dev_default) - feature_closure(packages[name], normal, normal_default)

CLI = 'mixdog-cli'
UMBRELLA = 'dev-controls'
# A checkout from before the umbrella (a branch that has not merged it yet) keeps the rules it was written under:
# no umbrella, `codegen` everywhere, replay controls not test features. Its manifests are then left as they are.
HAS_UMBRELLA = UMBRELLA in packages[CLI]['features']
OWN_ONLY = {'codegen'} if HAS_UMBRELLA else set()
# The replay controls (mixdog-cli's features) are test features of the crates they reach.
for feature, enables in (packages[CLI]['features'].items() if HAS_UMBRELLA else []):
    if feature != UMBRELLA:
        for item in enables:
            if '/' in item and not item.startswith('dep:'):
                dep, f = item.split('/', 1)
                # A feature that reaches a third-party crate (`alloc-profile` -> windows-sys/...) is no replay control.
                if dep.rstrip('?') in test_features:
                    test_features[dep.rstrip('?')].add(f)
# What another crate's tests (or the umbrella) ask a crate for; the crate's own tests ask for `test_features`.
shared = {name: features - OWN_ONLY for name, features in test_features.items()}

def built_for_tests(name):
    """The workspace crates a test build of `name` compiles: itself, its dependencies of every kind, and theirs (not their dev ones)."""
    seen = {name}
    todo = [d['name'] for d in packages[name]['dependencies'] if d['name'] in packages]
    while todo:
        n = todo.pop()
        if n in seen:
            continue
        seen.add(n)
        todo.extend(d['name'] for d in packages[n]['dependencies'] if d['kind'] != 'dev' and d['name'] in packages)
    return seen

def umbrella(lines):
    """Writes mixdog-cli's `dev-controls`: its replay controls, and for every library `mixdogd` links the features a test
    build gives it. A library the binary reaches only through another crate must be an optional dependency of mixdog-cli."""
    cli = packages[CLI]
    direct = {d['name'] for d in cli['dependencies'] if d['kind'] is None}
    linked, todo = set(), sorted(direct & set(packages))
    while todo:
        n = todo.pop()
        if n not in linked:
            linked.add(n)
            todo.extend(d['name'] for d in packages[n]['dependencies'] if d['kind'] is None and d['name'] in packages)
    # Cargo's own feature per optional dependency (`mixdog-ai = ["dep:mixdog-ai"]`) is not a control.
    # A feature that only reaches third-party crates (`alloc-profile`: windows-sys/...) is a diagnostic build, not a
    # control, and would make every development build an allocation-profiling one.
    def reaches_workspace(enables):
        return any('/' not in i or i.split('/', 1)[0].rstrip('?') in packages for i in enables if not i.startswith('dep:'))
    items = sorted(f for f, enables in cli['features'].items() if f != UMBRELLA and enables != [f'dep:{f}'] and reaches_workspace(enables))
    notes = []
    named = []
    for dep in sorted(linked):
        if shared[dep]:
            if dep not in direct:
                # Named here (optional, so no product build links anything new) so `dev-controls` can reach it.
                if dep not in declared:
                    sys.exit(f'{cli["manifest_path"]}: `mixdogd` links {dep}, which [workspace.dependencies] does not declare; declare it, then rerun')
                named.append(f'{dep} = {{ workspace = true, optional = true }}')
                notes.append(f'  + [dependencies] {named[-1]}')
            items += [f'{dep}/{f}' for f in sorted(shared[dep])]
    if named:
        first = next(i for i, l in enumerate(lines) if l.strip() == '[dependencies]')
        last = next((i for i in range(first + 1, len(lines)) if lines[i].startswith('[')), len(lines))
        while lines[last - 1].strip() == '':
            last -= 1
        lines[last:last] = ['# Reached through another crate; named here only so `dev-controls` reaches its test features.'] + named
    line = f'{UMBRELLA} = [{", ".join(chr(34) + i + chr(34) for i in items)}]'
    start = next(i for i, l in enumerate(lines) if l.strip() == '[features]')
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('[')), len(lines))
    at = next((i for i in range(start + 1, end) if lines[i].startswith(f'{UMBRELLA} =')), None)
    if at is not None:
        if lines[at] == line:
            return notes
        lines[at] = line
    else:
        while lines[end - 1].strip() == '':
            end -= 1
        lines[end:end] = ['# Every replay control, and for every library `mixdogd` links the features a test build gives it, so a test run and', '# this build compile each library once (<build-tools>\\unify-test-features.py writes it; cargo-gate adds it).', line]
    return notes + [f'  = {line}']

ENTRY = re.compile(r'^(?P<name>[A-Za-z0-9_-]+)\s*=\s*\{(?P<body>.*)\}\s*(?P<comment>#.*)?$')
FEATURES = re.compile(r'features\s*=\s*\[(?P<list>[^\]]*)\]')
changed = 0
for name in sorted(members):
    p = packages[name]
    wanted = {f: sorted(test_features[f] if f == name else shared[f]) for f in sorted(built_for_tests(name))}
    wanted = {f: features for f, features in wanted.items() if features}
    manifest = Path(p['manifest_path'])
    lines = manifest.read_text(encoding='utf-8').split('\n')
    start = next((i for i, line in enumerate(lines) if line.strip() == '[dev-dependencies]'), None)
    if start is None:
        if not wanted:
            continue
        while lines and lines[-1] == '':
            lines.pop()
        lines += ['', '[dev-dependencies]', '']
        start = len(lines) - 2
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('[')), len(lines))
    while end > start + 1 and lines[end - 1].strip() == '':
        end -= 1
    notes = []
    present = {}
    for i in range(start + 1, end):
        m = ENTRY.match(lines[i])
        f = FEATURES.search(lines[i]) if m and m['name'] != name else None
        own = set(re.findall(r'"([^"]+)"', f['list'])) & OWN_ONLY if f else set()
        if own:
            kept = [x for x in re.findall(r'"([^"]+)"', f['list']) if x not in OWN_ONLY]
            lines[i] = FEATURES.sub(f'features = [{", ".join(chr(34) + x + chr(34) for x in kept)}]', lines[i]) if kept else re.sub(r',\s*features\s*=\s*\[[^\]]*\]', '', lines[i])
            notes.append(f'  - {m["name"]}: {sorted(own)}')
        if m and m['name'] in wanted:
            present[m['name']] = i
        elif lines[i].split('=')[0].split('.')[0].strip() in wanted and not m:
            sys.exit(f'{manifest}:{i + 1}: a form of dependency this script does not edit: {lines[i]}')
    added = []
    for dep, features in wanted.items():
        quoted = ', '.join(f'"{f}"' for f in features)
        if dep in present:
            i = present[dep]
            m = FEATURES.search(lines[i])
            have = set(re.findall(r'"([^"]+)"', m['list'])) if m else set()
            if set(features) <= have:
                continue
            merged = ', '.join(f'"{f}"' for f in sorted(have | set(features)))
            lines[i] = FEATURES.sub(f'features = [{merged}]', lines[i]) if m else re.sub(r'\s*\}', f', features = [{merged}] }}', lines[i], count=1)
            notes.append(f'  ~ {dep}: {sorted(have)} -> {sorted(have | set(features))}')
        else:
            if dep == name:
                source = 'path = "."'
            elif dep in members or dep in declared:
                source = 'workspace = true'
            else:
                # Only in a checkout from before build-share: a tool's package beside the root, by its path.
                beside = os.path.relpath(Path(packages[dep]['manifest_path']).parent, manifest.parent).replace('\\', '/')
                source = f'path = "{beside}"'
            added.append(f'{dep} = {{ {source}, features = [{quoted}] }}')
            notes.append(f'  + {dep}: {features}')
    if name == CLI and HAS_UMBRELLA:
        notes += umbrella(lines)
    if not notes:
        continue
    if added:
        # The tool's own path is machine-specific and the repository refuses those: `<build-tools>` stands for it.
        note = ['# Every workspace crate this crate\'s tests build, with its test-only features, so a test build has one feature set', '# whatever packages are selected (<build-tools>\\unify-test-features.py).']
        lines[end:end] = ([] if note[0] in lines[start:end] else note) + added
    changed += 1
    print(f'{name} ({manifest.parent.name}/Cargo.toml)')
    print('\n'.join(notes))
    if write:
        manifest.write_text('\n'.join(lines), encoding='utf-8', newline='\n')
print(f'{changed} manifest(s) {"changed" if write else "would change"}')
