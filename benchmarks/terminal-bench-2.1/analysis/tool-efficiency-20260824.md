# Tool efficiency report

## jobs-full-sol-xhigh-20260823-182305

- trials: 89, tool calls: 1609, total output: 3409.5k chars
- wasted output (failed+skipped): 8894 chars (0.3%)
- failure chains: recovered 6, abandoned 30, chain waste 8803 chars

| tool | calls | ok | fail | skip | fail% | exec p50/p95 ms | total p50/p95 ms | out p50/p95 ch | ok-out p50 | wasted ch | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| shell | 756 | 755 | 1 | 0 | 0.1 | 465/10006 | 695/10012 | 509/10942 | 509 | 256 | timeout:1 |
| read | 296 | 285 | 10 | 1 | 3.4 | 3/94 | 44/1412 | 1348/12240 | 1499 | 2079 | not-found:10 |
| grep | 118 | 118 | 0 | 0 | 0 | 12/185 | 54/3783 | 2999/4912 | 2999 | 0 | - |
| apply_patch | 111 | 110 | 1 | 0 | 0.9 | 11/32 | 35/68 | 64/373 | 64 | 762 | invalid-args:1 |
| task | 105 | 105 | 0 | 0 | 0 | 27790/504946 | 27792/504948 | 901/23410 | 901 | 0 | - |
| git | 88 | 66 | 22 | 0 | 25 | 6/1373 | 40/1850 | 165/1749 | 251 | 4671 | other:7 non-repo:15 |
| list | 75 | 71 | 4 | 0 | 5.3 | 3/7 | 44/3784 | 111/1332 | 101 | 893 | not-found:4 |
| glob | 45 | 44 | 1 | 0 | 2.2 | 7/51 | 38/502 | 153/11296 | 131 | 233 | not-found:1 |
| code_graph | 7 | 7 | 0 | 0 | 0 | 5/105 | 50/106 | 3011/10593 | 3011 | 0 | - |
| find | 6 | 6 | 0 | 0 | 0 | 712/18512 | 778/18514 | 32/151 | 32 | 0 | - |
| load_tool | 1 | 1 | 0 | 0 | 0 | 1/1 | 16/16 | 26/26 | 26 | 0 | - |
| cwd | 1 | 1 | 0 | 0 | 0 | 1/1 | 14/14 | 81/81 | 81 | 0 | - |

## jobs-full-opus5-solo-20260823-144706

- trials: 89, tool calls: 1877, total output: 2117.3k chars
- wasted output (failed+skipped): 2940 chars (0.1%)
- failure chains: recovered 1, abandoned 14, chain waste 2940 chars

| tool | calls | ok | fail | skip | fail% | exec p50/p95 ms | total p50/p95 ms | out p50/p95 ch | ok-out p50 | wasted ch | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| shell | 970 | 969 | 1 | 0 | 0.1 | 255/10058 | 543/10148 | 496/2880 | 499 | 92 | timeout:1 |
| edit | 302 | 301 | 1 | 0 | 0.3 | 5/22 | 48/17866 | 43/72 | 43 | 93 | other:1 |
| read | 257 | 256 | 1 | 0 | 0.4 | 4/93 | 42/3438 | 1354/14688 | 1354 | 271 | not-found:1 |
| task | 157 | 157 | 0 | 0 | 0 | 16005/599976 | 16006/599987 | 924/3355 | 924 | 0 | - |
| list | 77 | 75 | 2 | 0 | 2.6 | 6/29 | 50/1940 | 48/3218 | 48 | 341 | not-found:2 |
| grep | 77 | 75 | 2 | 0 | 2.6 | 9/66 | 34/2461 | 2928/4974 | 2973 | 454 | not-found:2 |
| git | 21 | 16 | 5 | 0 | 23.8 | 4/90 | 160/991 | 259/1558 | 308 | 1160 | other:2 non-repo:3 |
| find | 9 | 7 | 2 | 0 | 22.2 | 26/1502 | 173/20576 | 15/185 | 14 | 370 | timeout:2 |
| glob | 6 | 5 | 1 | 0 | 16.7 | 24/20001 | 33/20004 | 121/600 | 121 | 159 | timeout:1 |
| code_graph | 1 | 1 | 0 | 0 | 0 | 3/3 | 37/37 | 244/244 | 244 | 0 | - |

## Findings (2026-08-24 review)

Speed. Exploration tools execute at 3–27ms p50. All p95 tails (find 18.5s, 3
find/glob timeouts) trace to container-root `/` scans — addressed the same day
by /proc·/sys·/dev pruning + deadline changes (pending next-run validation).
shell p95 ~10s is the foreground window; task waits are by design.

Context efficiency. Median chars per successful call: find 14–32 < list
~50–100 < glob ~130 < git ~250 < shell ~500 < read ~1,350 < grep ~2,970 ≈
code_graph outline ~3,000 (find_symbol body:true up to 10.6k, replacing a
read). Wasted output (failed+skipped) is 0.1–0.3% of total — error messages
are short recovery hints, so failures do not pollute context.

grep budget check. The tight p50≈3.0k/p95≈4.9k distribution is the
5,000-char context budget (GREP_CONTEXT_CHAR_BUDGET_DEFAULT) working as
designed: 25-line auto context, progressive disclosure (raw for ≤2 clusters,
focused radius 12 then anchor compaction over budget). The budget value was
itself bench-tuned (20260805 tool-budget bench: anchors cut below ~100 chars
push models into re-read loops). No change; A/B via
MIXDOG_GREP_CONTEXT_CHAR_BUDGET if ever revisited.

code_graph check. All 8 bench calls succeeded across C/C++/Python. symbols
outlines are the densest structural view (218–5,230 chars); low call volume
reflects TB task mix, not routing. Mode caps confirmed (references
NON_CALL_CAP 40, callers pageSize 100/hardMax 1000, list cap 200).

Stability. Failures converge on two root causes, both fixed same day: git
non-repo in nested-repo tasks (Sol 15 + Opus 3; live re-run showed 18→1) and
find/glob root-scan timeouts (3). grep and code_graph had zero failures.

shell exit codes. Non-zero exits are 14.0% (Sol 106/756) and 4.1% (Opus
40/970) but are the work itself, not tool instability: red-test reproduction
and environment probes (exit 1), missing tools (127), iterative make loops
(2), dead external archives (curl 22), and the bug under study segfaulting
(139). Tool-level shell failure: 1 timeout per run.

Mistake scan. Signature scan (bash syntax, quoting, inline py/node syntax,
sed/awk, bad options, heredoc EOF) over all 1,726 shell calls found 2 genuine
mistakes (~0.1%): one bash quoting collision around an inline triple-quoted
python -c (Sol, recovered next call) and one `--version` flag unsupported by
the john binary (Opus). Zero typos among exit-127 command names. The only
recurring mistake class is quote-nesting inside inline shell scripts —
mitigated by writing a script file; no rule change warranted (heuristic-free
harness principle).

