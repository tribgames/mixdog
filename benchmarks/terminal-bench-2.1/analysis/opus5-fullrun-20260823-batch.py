import json, glob, os, re
from collections import Counter, defaultdict

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'jobs-full-opus5-solo-20260823-112220')
ROOT = os.path.join(BASE, '2026-08-23__20-22-22')
rows, other = [], defaultdict(list)
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
        (rows if o.get('kind') == 'tool' else other[o.get('kind')]).append(o)

print('=== batch size distribution (tool calls per assistant turn) ===')
c = Counter((b.get('payload') or {}).get('tool_call_count') for b in other['batch'])
tot = sum(c.values())
acc = 0
for k in sorted(x for x in c if x is not None):
    acc += c[k] * k
    print('%2d tools: %4d turns (%4.1f%%)' % (k, c[k], c[k] / tot * 100))
print('batches', tot, 'tool calls in batches', acc, 'avg', round(acc / tot, 2))

print()
print('=== background promotion vs task wait ===')
promo = [e for e in other['shell_output'] if (e['payload'].get('command_output_bytes') is not None)]
bg = 0
for r in rows:
    if r['tool_name'] == 'shell' and (r.get('tool_ms') or 0) >= 9800:
        bg += 1
waits = [r for r in rows if r['tool_name'] == 'task' and (r.get('tool_args') or {}).get('action') == 'wait']
acts = Counter((r.get('tool_args') or {}).get('action') for r in rows if r['tool_name'] == 'task')
print('shell calls >=9.8s (promoted):', bg, ' task actions:', dict(acts))
w = sorted((r.get('tool_ms') or 0) / 1000.0 for r in waits)
if w:
    print('task wait n=%d  p50=%.0fs p90=%.0fs max=%.0fs total=%.0fs' % (len(w), w[len(w) // 2], w[int(len(w) * .9)], w[-1], sum(w)))
    print('waits <5s (round-trip only):', sum(1 for x in w if x < 5))

print()
print('=== shell spill / large-output handling ===')
sp = [e for e in other['shell_output'] if e['payload'].get('spilled')]
print('spilled', len(sp), 'of', len(other['shell_output']))
print('spill tasks:', Counter(e['_task'] for e in sp).most_common(8))
print('spill visible bytes p50:', sorted(e['payload'].get('model_visible_bytes') or 0 for e in sp)[len(sp) // 2] if sp else 0)

print()
print('=== nonzero exits by task ===')
nz = [e for e in other['shell_output'] if e['payload'].get('exit_code')]
print(len(nz), Counter(e['_task'] for e in nz).most_common(10))

print()
print('=== steer injections ===')
for p in glob.glob(os.path.join(ROOT, '*', 'agent', 'mixdog.stderr')):
    task = os.path.basename(os.path.dirname(os.path.dirname(p))).rsplit('__', 1)[0]
    for line in open(p, encoding='utf-8', errors='replace'):
        if 'steer' in line:
            print(task, line.strip()[:160])

print()
print('=== requests vs tools per task (top idle-request ratios) ===')
rep = json.load(open(os.path.join(BASE, 'report.json'), encoding='utf-8'))
out = []
for t in rep['tasks']:
    a = t['activity']
    if a['providerRequests']:
        out.append((a['toolCalls'] / a['providerRequests'], t['task'], a['providerRequests'], a['toolCalls'], t['passed']))
out.sort()
for r, t, req, tc, ok in out[:10]:
    print('%-30s ratio=%.2f req=%3d tools=%3d pass=%s' % (t, r, req, tc, ok))
print('overall ratio', round(sum(x[3] for x in out) / sum(x[2] for x in out), 2))
