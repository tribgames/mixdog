import { createHash, randomBytes } from 'node:crypto';

const SNAPSHOT_LIMIT = 64;
const snapshots = new Map();

function digest(value) {
    return createHash('sha256').update(String(value || '')).digest('hex');
}

function displayPath(diffLine) {
    const marker = String(diffLine || '').indexOf(' b/');
    return marker >= 0
        ? String(diffLine).slice(marker + 3).replace(/^"|"$/g, '')
        : String(diffLine || '').replace(/^diff --git\s+/, '');
}

function parseHunkHeader(line) {
    const match = String(line || '').match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (!match) return null;
    return {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        tail: match[5] || '',
        entries: [],
    };
}

function finishFile(files, file) {
    if (!file) return;
    file.stageable = Boolean(
        file.diffLine
        && file.oldLine
        && file.newLine
        && !file.blocked
        && !file.oldLine.includes('/dev/null')
        && !file.newLine.includes('/dev/null')
        && file.hunks.length,
    );
    files.push(file);
}

function parseFiles(raw) {
    const files = [];
    let file = null;
    let hunk = null;
    for (const line of String(raw || '').split('\n')) {
        if (line.startsWith('diff --git ')) {
            finishFile(files, file);
            file = {
                path: displayPath(line),
                diffLine: line,
                oldLine: '',
                newLine: '',
                blocked: false,
                stageable: false,
                hunks: [],
            };
            hunk = null;
            continue;
        }
        if (!file) continue;
        if (line.startsWith('@@')) {
            hunk = parseHunkHeader(line);
            if (!hunk) {
                file.blocked = true;
                continue;
            }
            file.hunks.push(hunk);
            continue;
        }
        if (hunk) {
            if (/^[ +\-\\]/.test(line)) {
                if (line.startsWith('\\')) file.blocked = true;
                hunk.entries.push({ line, changeId: null });
            }
            continue;
        }
        if (line.startsWith('--- ')) file.oldLine = line;
        else if (line.startsWith('+++ ')) file.newLine = line;
        else if (/^(new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to |GIT binary patch|Binary files )/.test(line)) {
            file.blocked = true;
        }
    }
    finishFile(files, file);
    return files;
}

function annotateChanges(files) {
    const changes = [];
    for (const file of files) {
        if (!file.stageable) continue;
        for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex++) {
            const hunk = file.hunks[hunkIndex];
            if (hunk.oldCount === 0) continue;
            let oldLine = hunk.oldStart;
            let newLine = hunk.newStart;
            let group = null;
            const finishGroup = () => {
                if (!group) return;
                const id = `chg_${digest([
                    file.path,
                    hunkIndex,
                    group.oldStart,
                    group.newStart,
                    group.lines.join('\n'),
                ].join('\0')).slice(0, 16)}`;
                for (const entry of group.entries) entry.changeId = id;
                changes.push({
                    id,
                    path: file.path,
                    old_start: group.oldStart,
                    new_start: group.newStart,
                    additions: group.additions,
                    deletions: group.deletions,
                    preview: group.lines.slice(0, 4).map((line) =>
                        line.length <= 180 ? line : `${line.slice(0, 180)}…`),
                });
                group = null;
            };
            for (const entry of hunk.entries) {
                const prefix = entry.line[0];
                if (prefix === '+' || prefix === '-') {
                    if (!group) {
                        group = {
                            oldStart: oldLine,
                            newStart: newLine,
                            additions: 0,
                            deletions: 0,
                            lines: [],
                            entries: [],
                        };
                    }
                    group.lines.push(entry.line);
                    group.entries.push(entry);
                    if (prefix === '+') {
                        group.additions++;
                        newLine++;
                    } else {
                        group.deletions++;
                        oldLine++;
                    }
                    continue;
                }
                finishGroup();
                if (prefix === ' ') {
                    oldLine++;
                    newLine++;
                }
            }
            finishGroup();
        }
    }
    return changes;
}

export function parseStageableDiff(raw) {
    const files = parseFiles(raw);
    const changes = annotateChanges(files);
    return { files, changes };
}

export function createDiffSnapshot({ repo, scope, plan, argv, raw }) {
    const parsed = parseStageableDiff(raw);
    if (parsed.changes.length === 0) return { diffId: null, changes: [] };
    const rawHash = digest(raw);
    const diffId = `diff_${randomBytes(10).toString('hex')}`;
    snapshots.set(diffId, {
        repo,
        scope,
        plan: {
            cwd: plan.cwd,
            globalArgs: [...(plan.globalArgs || [])],
            operation: 'diff',
            args: [...(plan.args || [])],
        },
        argv: [...(argv || [])],
        rawHash,
    });
    while (snapshots.size > SNAPSHOT_LIMIT) {
        snapshots.delete(snapshots.keys().next().value);
    }
    return { diffId, changes: parsed.changes };
}

export function getDiffSnapshot(diffId) {
    const key = String(diffId || '').trim();
    const snapshot = snapshots.get(key);
    if (!snapshot) return null;
    snapshots.delete(key);
    snapshots.set(key, snapshot);
    return {
        ...snapshot,
        plan: { ...snapshot.plan, globalArgs: [...snapshot.plan.globalArgs], args: [...snapshot.plan.args] },
        argv: [...snapshot.argv],
    };
}

export function deleteDiffSnapshot(diffId) {
    snapshots.delete(String(diffId || '').trim());
}

export function diffSnapshotMatches(snapshot, raw) {
    return Boolean(snapshot && snapshot.rawHash === digest(raw));
}

function range(start, count) {
    return count === 1 ? String(start) : `${start},${count}`;
}

export function buildSelectedStagePatch(raw, requestedIds) {
    const parsed = parseStageableDiff(raw);
    const requested = [...new Set((Array.isArray(requestedIds) ? requestedIds : [requestedIds])
        .map((value) => String(value || '').trim())
        .filter(Boolean))];
    const available = new Set(parsed.changes.map((change) => change.id));
    const missing = requested.filter((id) => !available.has(id));
    if (missing.length) return { patch: '', selected: [], missing };
    const wanted = new Set(requested);
    const parts = [];
    const selected = [];
    for (const file of parsed.files) {
        if (!file.stageable) continue;
        const fileSelected = parsed.changes.filter((change) =>
            change.path === file.path && wanted.has(change.id));
        if (!fileSelected.length) continue;
        const hunks = [];
        let selectedDelta = 0;
        for (const hunk of file.hunks) {
            const hasSelected = hunk.entries.some((entry) => entry.changeId && wanted.has(entry.changeId));
            if (!hasSelected) continue;
            const body = [];
            for (const entry of hunk.entries) {
                const prefix = entry.line[0];
                if (!entry.changeId || wanted.has(entry.changeId)) {
                    body.push(entry.line);
                } else if (prefix === '-') {
                    body.push(` ${entry.line.slice(1)}`);
                }
            }
            const oldCount = body.filter((line) => line[0] === ' ' || line[0] === '-').length;
            const newCount = body.filter((line) => line[0] === ' ' || line[0] === '+').length;
            const oldStart = hunk.oldStart;
            const newStart = hunk.oldStart + selectedDelta;
            hunks.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${hunk.tail}`);
            hunks.push(...body);
            selectedDelta += newCount - oldCount;
        }
        if (!hunks.length) continue;
        parts.push(file.diffLine, file.oldLine, file.newLine, ...hunks);
        selected.push(...fileSelected.map((change) => change.id));
    }
    return {
        patch: parts.length ? `${parts.join('\n')}\n` : '',
        selected,
        missing: requested.filter((id) => !selected.includes(id)),
    };
}

export function _resetGitDiffSnapshotsForTest() {
    snapshots.clear();
}
