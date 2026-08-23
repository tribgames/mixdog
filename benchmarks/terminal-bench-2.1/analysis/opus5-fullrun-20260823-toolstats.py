import json, glob, os, sys
from collections import Counter, defaultdict

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                    'jobs-full-opus5-solo-20260823-112220', '2026-08-23__20-22-22')
rows = []
other = defaultdict(list)
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
        o['_task'] = task
        if o.get('kind') == 'tool':
            rows.append(o)
        else:
            other[o.get('kind')].append(o)

print('tool events', len(rows), 'tasks', len(set(r['_task'] for r in rows)))
per = defaultdict(list)
for r in rows:
    per[r['tool_name']].append(r)

print()
print('%-12s %5s %5s %8s %7s %8s %8s %11s' % ('tool', 'n', 'fail', 'tot_s', 'p50ms', 'p90ms', 'max_s', 'bytes'))
for t, rs in sorted(per.items(), key=lambda kv: -len(kv[1])):
    ms = sorted(x.get('tool_ms') or 0 for x in rs)
    fails = sum(1 for x in rs if x.get('result_kind') != 'normal')
    by = sum(x.get('result_bytes_est') or 0 for x in rs)
    pick = lambda q: ms[min(len(ms) - 1, int(len(ms) * q))]
    print('%-12s %5d %5d %8.0f %7d %8d %8.0f %11d' % (t, len(rs), fails, sum(ms) / 1000.0, pick(.5), pick(.9), max(ms) / 1000.0, by))

print()
print('=== non-normal results ===')
for k, v in Counter((r['tool_name'], r.get('result_kind'), r.get('result_error_category')) for r in rows if r.get('result_kind') != 'normal').most_common():
    print(k, v)

print()
print('=== error first lines ===')
for r in rows:
    if r.get('result_kind') != 'normal':
        print('%-30s %-10s %s' % (r['_task'], r['tool_name'], (r.get('result_error_first_line') or '')[:170]))

print()
print('=== long tool calls (>120s) ===')
longs = sorted([r for r in rows if (r.get('tool_ms') or 0) > 120000], key=lambda r: -r['tool_ms'])
for r in longs:
    a = json.dumps(r.get('tool_args_summary') or r.get('tool_args'))[:150]
    print('%-30s %-6s %7.0fs %s' % (r['_task'], r['tool_name'], r['tool_ms'] / 1000.0, a))
print('long calls', len(longs), 'total_s', sum(r['tool_ms'] for r in longs) / 1000.0)

print()
print('=== shell timeout_ms usage ===')
tos = Counter()
for r in rows:
    if r['tool_name'] == 'shell':
        t = (r.get('tool_args') or {}).get('timeout_ms')
        tos[t] += 1
for k, v in sorted(tos.items(), key=lambda kv: (kv[0] is None, -(kv[0] or 0))):
    print(k, v)

print()
print('=== other kinds ===')
for k in other:
    print(k, len(other[k]))
for k in ('shell_output', 'tool_output', 'evidence_union'):
    if other.get(k):
        print()
        print(k, json.dumps(other[k][0])[:800])
