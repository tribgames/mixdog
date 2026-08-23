import json, glob, os, re
from collections import Counter, defaultdict

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                    'jobs-full-opus5-solo-20260823-112220', '2026-08-23__20-22-22')
rows = []
for p in glob.glob(os.path.join(ROOT, '*', 'agent', 'agent-trace.jsonl')):
    task = os.path.basename(os.path.dirname(os.path.dirname(p))).rsplit('__', 1)[0]
    for line in open(p, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get('kind') == 'tool':
            o['_task'] = task
            rows.append(o)

CODE = ('.py', '.c', '.h', '.cc', '.cpp', '.js', '.ts', '.tsx', '.mjs', '.rs', '.go', '.java', '.rb', '.ml', '.scm', '.sh')
reads = [r for r in rows if r['tool_name'] == 'read']
print('=== read calls: code files vs other ===')
codereads = []
for r in reads:
    a = r.get('tool_args') or {}
    path = str(a.get('path') or a.get('file_path') or '')
    if path.lower().endswith(CODE):
        codereads.append((r, a, path))
print('total read %d  code-file read %d (%.0f%%)' % (len(reads), len(codereads), len(codereads) / len(reads) * 100))
whole = [x for x in codereads if not (x[1].get('offset'))]
print('whole-file code reads (no offset): %d  bytes=%d' % (len(whole), sum(x[0].get('result_bytes_est') or 0 for x in whole)))
big = [x for x in codereads if (x[0].get('result_bytes_est') or 0) >= 8000]
print('code reads >=8KB: %d  bytes=%d' % (len(big), sum(x[0].get('result_bytes_est') or 0 for x in big)))
for r, a, path in sorted(big, key=lambda x: -(x[0].get('result_bytes_est') or 0))[:10]:
    print('   %-28s %7d B  %s' % (r['_task'], r.get('result_bytes_est') or 0, json.dumps(a)[:80]))

print()
print('=== repeated reads of the SAME file (structure hunting) ===')
c = Counter()
for r, a, path in codereads:
    c[(r['_task'], path)] += 1
for k, v in c.most_common(10):
    if v > 1:
        print('%2d x  %-28s %s' % (v, k[0], k[1]))

print()
print('=== grep calls that are symbol lookups ===')
SYM = re.compile(r'\b(def |class |function |func |struct |fn |void |static |impl |interface )|^\^?\s*(def|class)\b')
greps = [r for r in rows if r['tool_name'] == 'grep']
hits = []
for r in greps:
    a = r.get('tool_args') or {}
    pat = str(a.get('pattern') or '')
    if SYM.search(pat):
        hits.append((r, pat))
print('grep total %d, symbol-shaped patterns %d (%.0f%%)' % (len(greps), len(hits), len(hits) / len(greps) * 100 if greps else 0))
for r, pat in hits[:12]:
    print('   %-28s %s' % (r['_task'], pat[:90]))

print()
print('=== path style used by read/grep (absolute vs relative) ===')
absn = rel = 0
for r in rows:
    a = r.get('tool_args') or {}
    for key in ('path', 'file_path'):
        v = a.get(key)
        if isinstance(v, str) and v:
            if v.startswith('/') or re.match(r'^[A-Za-z]:', v):
                absn += 1
            else:
                rel += 1
print('absolute %d  relative %d' % (absn, rel))
