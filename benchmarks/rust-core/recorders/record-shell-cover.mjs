#!/usr/bin/env node
// The shell tool's refusal of a command the built-in tools cover whole, as the patched Node decides it: `guardShellCall` (the guard
// the tool-exec path runs before anything else) over a table of commands, each under both shell families Node tells apart
// (`powershell`, `posix`), on one workspace the recording lists as recipes. Each entry is the call's arguments, the shell type, the
// tools the session offers (`offers`: every tool a replacement can name, all but grep, or `null` = no session information) and what
// the guard returned: the refusal text (`failure`), or the call that runs (`args`) with the notes added to its result. The workspace
// path is written `<WS>` (forward slashes) in commands and results.
//
//   node benchmarks/rust-core/recorders/record-shell-cover.mjs --tree <b6f10295a export with the patch> \
//     --patch benchmarks/rust-core/recorders/node-patches/node-change-shell-cover-tools.patch
//
// Output: native/core/fixtures/shell-cover/cases.json
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'shell-cover-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const BASE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
if (!args.get('patch')) throw new Error('record from the tree with the shell-cover-tools patch (--patch)');
const identity = nodeTreeIdentity(args, tree, BASE_COMMIT);
const importFrom = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { guardShellCall } = await importFrom('src/runtime/agent/orchestrator/tools/builtin/bash-tool/misuse-guard.mjs');

const numbered = (count, suffix = '', prefix = 'row') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}${suffix}`).join('\n') + '\n';
const files = {
  'small.txt': { text: 'alpha\nFoo bar\nomega foo\n' },
  'sub/nested.txt': { text: 'nested foo\n' },
  'sub/data.txt': { text: 'file-body-marker\n' },
  'dir/one.txt': { text: '1\n' },
  'dir/inner/deep.txt': { text: 'd\n' },
  'dir/two.log': { text: '2\n' },
  'long.log': { text: numbered(40, ' foo') },
  'a.log': { text: Array.from({ length: 12 }, (_, i) => `line ${i + 1} boom`).join('\n') + '\n' },
  'a.txt': { text: 'alpha\nfoo bar\nomega\n' },
  'b.txt': { text: 'beta\n' },
  'nofinal.txt': { text: 'first\nsecond\nlast' },
  'crlf.txt': { text: 'a1\r\nb2 foo\r\nc3\r\n' },
  'many.txt': { text: numbered(300, ' foo') },
  'edge500.txt': { text: numbered(500) },
  'edge501.txt': { text: `${numbered(500)}last` },
  'big.txt': { text: numbered(600) },
  'edge16k.txt': { text: `${'x'.repeat(127)}\n`, repeat: 128 },
  'edge16k1.txt': { text: `${'x'.repeat(127)}\n`, repeat: 128, tail: 'y' },
  'bin.dat': { hex: '00010203' },
  'bom.txt': { text: '\ufeffone\ntwo\n' },
  'utf16.txt': { text: 'one foo\ntwo\n', enc: 'utf16le' },
  'latin1.txt': { hex: '63616bE90a666f6f0a' },
  'empty.txt': { text: '' },
  'my file.txt': { text: 'spaced foo\n' },
  'deps/node_modules/x.txt': { text: 'x\n' },
  'deps/a.txt': { text: 'a\n' },
  'hid/.dot': { text: 'd\n' },
  'hid/shown.txt': { text: 's\n' },
  'onlyhidden/.dot': { text: 'd\n' },
  'emptydir/.keep': { remove: true },
};
for (let i = 1; i <= 101; i += 1) files[`many/f${String(i).padStart(3, '0')}.txt`] = { text: `${i}\n` };
for (let i = 1; i <= 100; i += 1) files[`hundred/f${String(i).padStart(3, '0')}.txt`] = { text: `${i}\n` };

const both = ['powershell', 'posix'];
// Commands run under both shell families.
const commands = [
  // reads
  'cat small.txt', 'cat nofinal.txt', 'cat crlf.txt', 'cat empty.txt', 'cat bom.txt', 'cat utf16.txt', 'cat latin1.txt', 'cat bin.dat',
  'cat edge16k.txt', 'cat edge16k1.txt', 'cat edge500.txt', 'cat edge501.txt', 'cat big.txt', 'cat "my file.txt"', "cat 'my file.txt'", 'cat my\\ file.txt',
  'cat "small.txt"', "cat './small.txt'", 'cat ./small.txt', 'cat sub/nested.txt', 'cat sub\\nested.txt', 'cat .\\small.txt', 'cat sub/../small.txt', 'cat ../small.txt',
  'cat  small.txt', 'CAT small.txt', '/bin/cat small.txt', 'cat.exe small.txt', 'cat <WS>/small.txt',
  'cat small.txt:2', 'cat "small.txt#L2"', 'cat small.txt#L2', 'cat ~/small.txt', 'cat ~', 'cat sm*.txt', 'cat sm?ll.txt', 'cat [s]mall.txt', 'cat {small,a}.txt',
  'cat small.txt a.txt', 'cat a.txt b.txt', 'cat -n small.txt', 'cat -- small.txt', 'cat nofile.txt', 'cat sub', 'cat dir/', 'cat .', 'cat',
  'cat /dev/zero', 'cat /dev/stdin', 'cat /dev/null', 'cat CON', 'cat NUL', 'cat COM1', 'cat small.txt.', 'cat "small.txt "', 'cat small.txt::$DATA', 'cat \\\\server\\share\\x', 'cat C:\\Windows\\win.ini', 'cat //server/share/x',
  'cat $HOME/x', 'cat "$FILE"', 'cat $(echo small.txt)', 'cat `echo small.txt`', 'cat small.txt &', 'cat small.txt # comment', 'cat <small.txt', 'cat (small.txt)', 'cat {small.txt}', 'cat small.txt,a.txt', 'cat small.txt;', 'cat small.txt &&', 'cat small.txt |', 'cat small.txt ||', 'cat small.txt | head -n 2 |',
  'cat small.txt\n', 'cat small.txt\ncat a.txt', 'cat small.txt; cat a.txt', 'cat small.txt && cat a.txt', 'cat small.txt || cat a.txt',
  'head small.txt', 'head -n 5 long.log', 'head -n5 long.log', 'head -5 long.log', 'head -3 long.log', 'head -n 0 long.log', 'head -n 500 long.log', 'head -n 501 long.log', 'head -n 03 long.log', 'head -n +5 long.log', 'head -c 5 long.log',
  'head --lines=5 long.log', 'head -q long.log', 'head -n 5 -n 6 long.log', 'head -n 5 long.log a.log', 'head -n 5 bin.dat', 'head -n 5 big.txt', 'head -n 5 bom.txt', 'head -n 5 utf16.txt',
  'tail small.txt', 'tail long.log', 'tail -n 4 long.log', 'tail -n4 long.log', 'tail -4 long.log', 'tail -n 2 nofinal.txt', 'tail -n 400 crlf.txt', 'tail -n 500 long.log', 'tail -n 501 long.log', 'tail -n 100000 long.log', 'tail -n 0 long.log', 'tail -n 03 long.log',
  'tail -n +2 small.txt', 'tail -n+2 small.txt', 'tail -n +5 a.log', 'tail -n +0 a.log', 'tail -n +2 big.txt', 'tail -n +2 -n 3 small.txt', 'tail -f a.log', 'tail -F a.log', 'tail -c 5 a.log', 'tail --lines=3 a.log', 'tail -n 3 big.txt', 'tail -n 3 bin.dat', 'tail -n 3 bom.txt', 'tail -n 3 utf16.txt', 'tail -n 3 latin1.txt', 'tail -n 3 empty.txt',
  'less a.txt', 'more a.txt',
  'cat long.log | head -n 6', 'cat long.log | tail -n 6', 'cat long.log | head', 'cat long.log | tail', 'cat long.log | head -5', 'cat long.log | head -n 6 | tail -n 2', 'cat long.log | head -n 6 | tail -n 2 | cat', 'cat long.log | head -n 6 -n 7', 'cat long.log | head -n 6 long.log', 'cat long.log | tail -n +3',
  'cat small.txt | python3 x.py', 'cat small.txt | sort', 'cat small.txt | sort -o b.txt', 'cat small.txt | wc -l', 'cat small.txt | uniq', 'cat small.txt | cut -c1-3', 'head -n 3 long.log | tail -n 2', 'head -n 3 long.log | grep row', 'tail -n 3 long.log | grep row',
  // searches
  'grep foo small.txt', 'grep -i foo small.txt', 'grep -n foo long.log', 'grep -in foo small.txt', 'grep -ni foo small.txt', 'grep -nii foo small.txt', 'grep -in "foo bar" a.txt', 'grep "Foo bar" small.txt', "grep 'Foo bar' small.txt", 'grep foo ./small.txt', 'grep foo sub/nested.txt', 'grep -- foo small.txt',
  'grep foo many.txt', 'grep foo crlf.txt', 'grep foo nofinal.txt', 'grep foo empty.txt', 'grep foo bin.dat', 'grep foo bom.txt', 'grep foo utf16.txt', 'grep foo latin1.txt', 'grep foo edge16k.txt', 'grep foo big.txt', 'grep foo edge501.txt', 'grep foo nofile.txt', 'grep foo sub', 'grep foo "my file.txt"',
  'grep foo.bar small.txt', 'grep "a|b" small.txt', 'grep "fo+" small.txt', 'grep "foo*" small.txt', 'grep ^alpha small.txt', 'grep foo$ small.txt', 'grep "[a]" small.txt', 'grep -e foo small.txt', 'grep -E foo small.txt', 'grep -F foo small.txt', 'grep -w foo small.txt', 'grep -v foo small.txt', 'grep -c foo small.txt', 'grep -l foo small.txt', 'grep -r foo sub', 'grep -rn foo sub', 'grep -C 5 foo small.txt', 'grep -C 201 foo small.txt', 'grep -A 2 foo small.txt', 'grep -m 1 foo small.txt', 'grep -q foo small.txt', 'grep -s foo small.txt',
  'grep .foo small.txt', 'grep @foo small.txt', 'grep foo:bar small.txt', 'grep a=b small.txt', 'grep 50% small.txt', 'grep a/b small.txt', 'grep a-b small.txt', 'grep -foo small.txt', 'grep "caf\u00e9" small.txt', 'grep "" small.txt', 'grep " foo" small.txt', 'grep foo', 'grep', 'grep foo small.txt a.txt', 'grep foo a.txt b.txt',
  'grep foo small.txt | head', 'grep foo small.txt | wc -l', 'grep foo small.txt | xargs rm', 'cat small.txt | grep foo', 'cat crlf.txt | grep foo', 'cat small.txt | grep -i foo', 'cat small.txt | grep foo.bar', 'cat small.txt | grep foo | head', 'cat many.txt | grep foo', 'cat big.txt | grep foo', 'tail -n 3 long.log | grep foo', 'cat small.txt | grep',
  'rg foo small.txt', 'rg -i foo small.txt', 'rg -n foo crlf.txt', 'rg foo', 'rg -g "*.txt" foo .', 'rg foo small.txt a.txt', 'rg --files', 'rg -l foo small.txt',
  'Get-Content small.txt', 'gc nofinal.txt', 'type crlf.txt', 'Get-Content -Path long.log -TotalCount 5', 'Get-Content -Path long.log', 'Get-Content -LiteralPath long.log', 'Get-Content long.log -First 3', 'Get-Content long.log -Head 3', 'Get-Content -LiteralPath long.log -Tail 4', 'Get-Content long.log -Last 4', 'Get-Content long.log -TotalCount 500', 'Get-Content long.log -TotalCount 501', 'Get-Content long.log -TotalCount 0', 'Get-Content long.log -Tail 0', 'Get-Content long.log -Tail 3.5', 'Get-Content long.log -Tail 03', 'Get-Content long.log -Tail -3', 'Get-Content long.log -Tail x', 'Get-Content long.log -Tail', 'Get-Content long.log -Tail 3 -First 2', 'Get-Content long.log -Tail 3 -Tail 4', 'get-content LONG.LOG -tail 2', 'GET-CONTENT small.txt', 'Get-Content small.txt -Wait', 'Get-Content small.txt -Raw', 'Get-Content small.txt -Encoding Unicode', 'Get-Content small.txt -ReadCount 2', 'Get-Content -Path small.txt -Path a.txt', 'Get-Content small.txt a.txt', 'Get-Content small.txt,a.txt', 'Get-Content', 'Get-Content -Path', 'Get-Content *.txt', 'Get-Content .\\small.txt', 'Get-Content sub\\nested.txt', 'Get-Content sub\\*.txt', 'Get-Content $env:LOG', 'Get-Content $env:LOG -Tail 3', 'Get-Content "my file.txt"', "Get-Content 'my file.txt'", 'Get-Content (Get-Item small.txt)', 'Get-Content @(small.txt)', "Get-Content @'\na.txt\n'@",
  'cat long.log | Select-Object -First 6', 'gc long.log | Select-Object -Last 6', 'cat long.log | select -First 2', 'cat long.log | Select-Object -First 0', 'cat long.log | Select-Object -First 6 -Skip 2', 'cat long.log | Select-Object -Skip 2', 'cat long.log | Select-Object -Last 6 -First 2', 'cat long.log | Select-Object -Property x', 'cat long.log | Sort-Object', 'cat long.log | Sort-Object -Unique', 'cat long.log | Measure-Object -Line', 'cat long.log | ForEach-Object { $_ }', 'cat long.log | Where-Object { $_ -match "x" }', 'cat long.log | node x.js', 'Get-Content long.log -Tail 3 | Select-Object -First 1', 'Get-Content long.log -First 3 | Select-String foo',
  'Select-String foo small.txt', 'Select-String -Pattern foo -Path long.log', 'Select-String -Path long.log -Pattern foo', 'Select-String -CaseSensitive foo small.txt', 'Select-String foo small.txt -CaseSensitive', 'sls foo small.txt', 'SELECT-STRING foo small.txt', "Select-String 'foo bar' small.txt", 'Select-String "foo bar" small.txt', 'Select-String -Pattern "foo bar" -Path small.txt', 'Select-String -SimpleMatch foo small.txt', 'Select-String -NotMatch foo small.txt', 'Select-String -List foo small.txt', 'Select-String -AllMatches foo small.txt', 'Select-String -Context 1 foo small.txt', 'Select-String foo many.txt', 'Select-String foo', 'Select-String', 'Select-String foo *.txt', 'Select-String foo sub\\*.txt', 'Select-String -Pattern foo -Pattern bar small.txt', 'Select-String -Pattern foo -Path small.txt a.txt', 'Select-String foo small.txt a.txt', 'Select-String foo,bar small.txt', 'Select-String "a|b" small.txt', 'Select-String foo.bar small.txt',
  'gc crlf.txt | Select-String foo', 'Get-Content small.txt | Select-String foo', 'Get-Content small.txt | sls foo', 'Get-Content small.txt | Select-String -Pattern foo', 'Get-Content small.txt | Select-String -CaseSensitive foo', 'Get-Content long.log -Tail 3 | Select-String foo', 'Get-Content many.txt | Select-String foo', 'Get-Process | Select-String node', 'Get-Content a.log | Select-String boom',
  // listings
  'ls dir', 'ls dir/inner', 'ls dir/', 'ls ./dir', 'ls "dir"', "ls 'dir'", 'ls .\\dir', 'ls dir\\inner', 'ls LS', 'LS dir', 'ls sub', 'ls hundred', 'ls many', 'ls emptydir', 'ls hid', 'ls onlyhidden', 'ls deps', 'ls deps/node_modules', 'ls long.log', 'ls nofile', 'ls', 'ls .', 'ls ..', 'ls <WS>/dir', 'ls dir sub', 'ls -la sub', 'ls -a sub', 'ls -l sub', 'ls -1 sub', 'ls -R sub', 'ls sub | head', 'ls sub | wc -l', 'ls sub > out.txt', 'ls "my file.txt"', 'ls ~', 'ls dir*', 'ls *',
  'Get-ChildItem sub', 'Get-ChildItem sub -Recurse', 'Get-ChildItem sub -Force', 'Get-ChildItem sub -Directory', 'Get-ChildItem sub -Recurse -Force', 'Get-ChildItem', 'gci sub', 'dir sub', 'Get-ChildItem sub | Measure-Object', 'Get-ChildItem sub -Recurse | Measure-Object -Property Length -Sum', 'find . -name x', 'find . -name x -type f', 'find . -name "*.tmp" -delete', 'find sub', 'tree sub', 'wc -l small.txt', 'stat small.txt', 'file small.txt', 'du -sh sub', 'sort small.txt', 'diff a.txt b.txt', 'awk "{print}" small.txt', 'sed -n 1,3p small.txt', 'nl small.txt', 'xxd small.txt', 'od small.txt',
  // other
  'git status', 'git status --short', 'git log --oneline -5', 'git diff --stat', 'git ls-files', 'git diff --quiet', 'git diff --exit-code', 'git status 2>&1', 'git status || git log', 'git status > out.txt', 'git log | grep fix', 'git log | wc -l', 'git log | Select-Object -First 5', 'git diff $(git merge-base a b)', 'git stash', 'git add -p', 'git worktree prune', 'git config --get user.name', 'git --no-pager log', 'git -C ../other diff --stat', 'git commit -m "a $(x)"',
  'cat small.txt > /dev/null', 'cat small.txt 2>/dev/null', 'head -n 2 long.log 2>&1', 'cat small.txt > out.txt', 'Get-Content small.txt 2>$null', 'Get-Content small.txt > $null', 'gc small.txt *> out.txt', 'cat small.txt >> out.txt',
  'echo "cat small.txt"', "echo 'cat small.txt'", 'echo "git status"', 'Write-Host "git status"', 'echo cat small.txt', 'printf "%s" a', 'ls; ls', 'npm test', 'node -e "1"',
  'grep NOMATCH small.txt && head -n 2 long.log', 'head -n 2 long.log && ls dir', 'head -n 2 long.log; ls dir', 'head -n 2 long.log\nls dir', 'head -n 2 long.log || ls dir', 'head -n 2 long.log; sort long.log', 'tail -n 3 a.log; ls sub', 'grep NOMATCH a.txt && tail -n 3 a.log', 'Get-Content a.log -Tail 3; npm run build', 'Get-Content a.log | node x.js', 'Get-Content a.log -Tail 3 & sleep 1', 'tail -n 3 a.log; npm test',
  'cd sub; tail -n 3 data.txt', 'cd sub && cat data.txt', 'sleep 5; cat small.txt', 'sleep 1; cat small.txt',
  'sleep 5', 'git worktree add ../x', 'cat small.txt\n git worktree add ../x',
];

const OFFERS = { all: ['read', 'grep', 'list'], noGrep: ['read', 'list'], noRead: ['grep', 'list'], noList: ['read', 'grep'], none: [] };
const matrix = [];
for (const command of commands) {
  for (const shellType of both) matrix.push({ shellType, command, offers: 'all' });
}
// Which replacement a session lacks, and a call with no session information at all, on the covered forms.
const covered = [
  'tail -n 3 a.log', 'head -n 5 a.txt', 'cat a.txt', 'rg foo a.txt', 'grep -in "foo bar" a.txt', 'ls sub', 'cat a.log | head -3', 'cat a.txt | grep foo', 'Get-Content a.log -Tail 3', 'Get-Content a.log -TotalCount 5', 'cat a.txt',
  'gc a.log | Select-Object -Last 4', 'Get-Content a.log | Select-String boom', 'Select-String -Path sub\\data.txt -Pattern marker', 'Get-Content a.log -Tail 3; npm run build', 'cat nofile.txt',
];
for (const command of covered) {
  for (const shellType of both) for (const offers of ['noGrep', 'noRead', 'noList', 'none', null]) matrix.push({ shellType, command, offers });
}
// A call that names its own cwd runs there, so the session directory's files are never the ones judged.
for (const shellType of both) {
  matrix.push({ shellType, command: 'tail -n 3 a.log', offers: 'all', cwd: 'sub' });
  matrix.push({ shellType, command: 'Get-Content a.log -Tail 3', offers: 'all', cwd: 'sub' });
  matrix.push({ shellType, command: 'cat data.txt', offers: 'all', cwd: 'sub' });
  matrix.push({ shellType, command: 'cat data.txt', offers: null, cwd: 'sub' });
}

const work = mkdtempSync(join(tmpdir(), 'shell-cover-ws-'));
const root = realpathSync(work);
const results = [];
try {
  for (const [rel, f] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    if (f.remove) continue;
    let bytes;
    if (f.hex) bytes = Buffer.from(f.hex, 'hex');
    else {
      const text = (f.repeat ? f.text.repeat(f.repeat) : f.text) + (f.tail ?? '');
      bytes = f.enc === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text);
    }
    writeFileSync(join(root, rel), bytes);
  }
  // emptydir holds nothing: the recipe above made it through a file that is removed here.
  rmSync(join(root, 'emptydir', '.keep'), { force: true });
  const forward = root.replaceAll('\\', '/');
  const fix = (text) => text.split(forward).join('<WS>').split(root).join('<WS>');
  const cwdOf = (rel) => (rel === undefined ? undefined : `${forward}/${rel}`);
  for (const entry of matrix) {
    const command = entry.command.replaceAll('<WS>', forward);
    const callArgs = { command, ...(entry.cwd === undefined ? {} : { cwd: cwdOf(entry.cwd) }) };
    const offered = entry.offers === null ? null : OFFERS[entry.offers];
    const guarded = guardShellCall(callArgs, {
      shellType: entry.shellType,
      cwd: root,
      ...(offered === null ? {} : { offers: (tool) => offered.includes(tool) }),
    });
    const result = guarded.failure !== undefined
      ? { failure: fix(guarded.failure) }
      : { args: { command: fix(guarded.args.command), cwd: guarded.args.cwd === undefined ? null : fix(guarded.args.cwd) }, notes: guarded.notes.map(fix) };
    results.push({ shellType: entry.shellType, args: { command: entry.command, ...(entry.cwd === undefined ? {} : { cwd: `<WS>/${entry.cwd}` }) }, offers: offered, result });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
}

const refused = results.filter((c) => c.result.failure?.includes('the built-in tools cover this command')).length;
const finalDir = join(FIXTURES_ROOT, 'shell-cover');
const stage = stageSet(finalDir);
writeJson(join(stage, 'cases.json'), {
  note: "Node's guardShellCall on the patched tree, over the workspace `files` lists (recipes): args as handed in (`<WS>` = the workspace directory, also the session cwd), the tools the session offers, and what the guard returned.",
  platform: process.platform,
  files,
  cases: results,
});
writeSetManifest(stage, {
  set: 'shell-cover',
  recorder: 'benchmarks/rust-core/recorders/record-shell-cover.mjs',
  command: `node benchmarks/rust-core/recorders/record-shell-cover.mjs --tree <tree> --patch ${identity.patch.file}`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    exclusions: {
      telemetry: "guardShellCall's `telemetry` argument (the shellMisuse counters of the host) is not passed: it records, it does not decide",
      platform: 'the table is recorded on one platform (`platform` in cases.json); path rules differ per platform, so it is replayed on that one only',
    },
  },
});
commitStage(stage, finalDir);
console.log(`shell-cover: ${results.length} cases, ${refused} refused as covered`);
