import json, glob, os
from collections import defaultdict

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'jobs-full-opus5-solo-20260823-112220')
ROOT = os.path.join(BASE, '2026-08-23__20-22-22')
rep = json.load(open(os.path.join(BASE, 'report.json'), encoding='utf-8'))
meta = {t['task']: t for t in rep['tasks']}

ev = defaultdict(list)
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
        ev[task].append(o)

print('=== trailing dead time: last trace event -> agent deadline ===')
print('%-32s %5s %8s %10s %10s %s' % ('task', 'pass', 'agent_s', 'tail_s', 'lastkind', 'last in-flight arg'))
rowsout = []
for t, es in ev.items():
    es.sort(key=lambda o: o.get('ts') or 0)
    if not es:
        continue
    first, last = es[0].get('ts'), es[-1].get('ts')
    a = meta[t].get('agentSeconds') or 0
    span = (last - first) / 1000.0
    tail = a - span
    lastkind = es[-1].get('kind')
    tools = [o for o in es if o.get('kind') == 'tool']
    lastarg = json.dumps((tools[-1].get('tool_args') if tools else {}) or {})[:90]
    rowsout.append((tail, t, meta[t]['passed'], a, span, lastkind, lastarg))
rowsout.sort(reverse=True)
for tail, t, ok, a, span, lk, la in rowsout[:16]:
    print('%-32s %5s %8.0f %10.0f %10s %s' % (t, ok, a, tail, lk, la))

print()
print('=== failed tasks: budget vs largest declared shell timeout_ms ===')
for t in sorted(meta):
    if meta[t]['passed']:
        continue
    tos = [((o.get('tool_args') or {}).get('timeout_ms') or 0) for o in ev[t] if o.get('kind') == 'tool' and o.get('tool_name') == 'shell']
    print('%-32s budget~%5.0fs  max_declared_timeout=%8.0fs  n_over_budget=%d' % (
        t, meta[t].get('agentSeconds') or 0, max(tos or [0]) / 1000.0,
        sum(1 for x in tos if x / 1000.0 > (meta[t].get('agentSeconds') or 0))))
