import json, glob, os
from collections import Counter, defaultdict

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'jobs-full-opus5-solo-20260823-112220')
ROOT = os.path.join(BASE, '2026-08-23__20-22-22')
rep = json.load(open(os.path.join(BASE, 'report.json'), encoding='utf-8'))
meta = {t['task']: t for t in rep['tasks']}

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
        (rows if o.get('kind') == 'tool' else other[o.get('kind')]).append(o)

print('=== per-task time decomposition (blocking tool time vs agent seconds) ===')
print('%-30s %6s %8s %8s %7s %7s %6s' % ('task', 'pass', 'agent_s', 'tool_s', 'wait_s', 'tool%', 'calls'))
agg = []
for t, m in sorted(meta.items(), key=lambda kv: -(kv[1].get('agentSeconds') or 0)):
    rs = [r for r in rows if r['_task'] == t]
    if not rs:
        continue
    tool_s = sum(r.get('tool_ms') or 0 for r in rs) / 1000.0
    wait_s = sum(r.get('tool_ms') or 0 for r in rs if r['tool_name'] == 'task') / 1000.0
    a = m.get('agentSeconds') or 0
    agg.append((t, m['passed'], a, tool_s, wait_s, len(rs)))
for t, ok, a, ts, ws, n in agg[:22]:
    print('%-30s %6s %8.0f %8.0f %8.0f %6.0f%% %6d' % (t, ok, a, ts, ws, (ts / a * 100 if a else 0), n))
tot_a = sum(x[2] for x in agg); tot_t = sum(x[3] for x in agg); tot_w = sum(x[4] for x in agg)
print('TOTAL agent_s %.0f  tool_s %.0f (%.0f%%)  task-wait_s %.0f (%.0f%%)' % (tot_a, tot_t, tot_t / tot_a * 100, tot_w, tot_w / tot_a * 100))

print()
print('=== shell_output aggregate ===')
so = other['shell_output']
c = Counter()
tot = Counter()
for e in so:
    p = e['payload']
    c['n'] += 1
    for f in ('spilled', 'offloaded', 'timed_out'):
        if p.get(f):
            c[f] += 1
    if p.get('signal'):
        c['signal:' + str(p['signal'])] += 1
    if p.get('exit_code'):
        c['nonzero_exit'] += 1
    tot['command_output_bytes'] += p.get('command_output_bytes') or 0
    tot['model_visible_bytes'] += p.get('model_visible_bytes') or 0
    tot['pre_offload_bytes'] += p.get('pre_offload_bytes') or 0
print(dict(c))
print(dict(tot))
big = sorted(so, key=lambda e: -(e['payload'].get('command_output_bytes') or 0))[:10]
for e in big:
    p = e['payload']
    print('%-28s out=%8d visible=%8d off=%s spill=%s' % (e['_task'], p.get('command_output_bytes') or 0, p.get('model_visible_bytes') or 0, p.get('offloaded'), p.get('spilled')))

print()
print('=== SIGTERM shell details ===')
for r in rows:
    if r['tool_name'] == 'shell' and r.get('result_kind') != 'normal':
        print(r['_task'], r.get('tool_ms'), json.dumps(r.get('tool_args'))[:400])
        print('   ->', r.get('result_error_first_line'))

print()
print('=== transport retries / provider stalls ===')
for e in other['transport_retry']:
    print(e['_task'], 'iter', e.get('iteration'), 'attempt', e.get('attempt'), 'wait', e.get('waitMs'), e.get('code'))

print()
print('=== turn_timing slow requests (top 15 by provider_ms) ===')
tt = sorted(other['turn_timing'], key=lambda e: -(e.get('provider_ms') or 0))[:15]
for e in tt:
    print('%-28s status=%-14s ttft=%7s provider_ms=%8s' % (e['_task'], e.get('status'), e.get('ttft_ms'), e.get('provider_ms')))

print()
print('=== read/grep/list byte hogs ===')
for name in ('read', 'grep', 'shell'):
    rs = sorted([r for r in rows if r['tool_name'] == name], key=lambda r: -(r.get('result_bytes_est') or 0))[:6]
    for r in rs:
        print('%-6s %-28s %8d bytes  %s' % (name, r['_task'], r.get('result_bytes_est') or 0, json.dumps(r.get('tool_args_summary'))[:110]))

print()
print('=== duplicate tool_args_hash (same call repeated) ===')
dup = Counter((r['_task'], r['tool_name'], r.get('tool_args_hash')) for r in rows)
rep_calls = [(k, v) for k, v in dup.items() if v > 2]
print('repeat groups>2:', len(rep_calls), 'wasted calls:', sum(v - 1 for _, v in rep_calls))
for k, v in sorted(rep_calls, key=lambda kv: -kv[1])[:12]:
    print(v, k[0], k[1])
