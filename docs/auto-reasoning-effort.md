# Auto reasoning effort

Auto reasoning effort sets how much a model thinks for each message and for
each step after a batch of tool results. Simple messages run at a lower
effort, and harder work runs higher, instead of every request running at one
fixed level. It is on by default and runs entirely on your machine.

## Results on Terminal-Bench 2.1

On the same model, GPT-6.1 Sol at `xhigh`, Auto cut the cost by **35%** compared
with running every request at a fixed `xhigh`, at a near-equal score. All 89
tasks, one pass each (`k=1`), web search on, 2026-10-15, with effort judge v6
(the previous judge; v7 has not been run on the benchmark):

| Run | Score | Cost (API list rates) | vs fixed `xhigh` | vs Codex CLI | Output tokens | First-request input (median) | Final context (median) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Mixdog, Auto (judge on) | 77/89 | **$9.01** | **−35%** | **−55%** | **266K** | **5.0K** | **10.8K** |
| Mixdog, fixed `xhigh` (no judge) | 78/89 | $13.78 | — | −31% | — | — | — |
| Codex CLI 0.162.1, `xhigh` | 78/89 | $19.83 | — | — | 772K | 14.3K | 33.6K |

Token and context figures for the fixed-`xhigh` run were not recorded in the
published bench log.

The judge made 825 decisions in the Auto run: 591 `medium`, 127 `high`, 105
`low`, 2 `xhigh`. This is a single pass, so one or two tasks either way is
within run-to-run variance; the fixed-`xhigh` run also had web search off. Raw
records and method: [Bench log](../benchmarks/terminal-bench-2.1/README.md#bench-log).

## How a decision is made

1. A small local model, the **effort judge**, reads the request (or the step:
   the task request, the agent's text for this round, and up to three tool
   calls with their results). It returns probabilities for four levels:
   easy, normal, hard and very hard.
2. Auto starts from `medium` on every turn and moves along the model's
   supported efforts: easy → `low`, normal → `medium`, hard → `high`, very
   hard → `xhigh`. A run of hard turns never ratchets the effort upward, and
   auto never chooses `none`, `minimal`, `max` or `ultra`. If you pick `max` or
   `ultra` yourself, that choice is left alone.
3. The level is chosen by minimising expected cost under the judge's
   probabilities, not by taking the most likely level. Calling a hard request
   easy costs more than the reverse, because under-thinking degrades the
   answer while over-thinking only costs tokens.

After each tool batch the step judgment is stored on that batch's last tool
result, so later requests rebuild the same history and the prompt cache keeps
hitting.

## When it applies

Auto changes effort only where doing so does not invalidate the provider's
prompt cache:

- Anthropic models that accept a mid-conversation effort change: Claude Opus
  5+, Sonnet 5.5+, Haiku 5.5+, Fable 5.1+ and Mythos 5.1+.
- OpenAI GPT-6 and later through the Responses API.
- Custom Chat/Responses routes whose model declares effort levels (the effort
  is sent with each request).

It judges user-written prompts and agent briefs, not runtime-injected turns. A
model that turns out to reject the change is switched off for auto at runtime.

If the judge is missing, still loading, slow, or fails, the turn simply uses
the default effort. A judgment normally has 0.4 s. The model starts loading in
the background when a session is created or opened (about 2.3 s on a desktop
CPU), so the first turn normally finds it ready; if it does not, that turn
waits up to about 3 s for the load.

## The judge model

| | |
|---|---|
| Base | EmbeddingGemma 2 text encoder, 18 of 24 layers, with a four-level classification head |
| Format | ONNX, 4-bit weights, about 150 MB |
| Runtime | ONNX Runtime on the CPU (4 threads); no GPU, no network after download |
| Input | The cleaned request (up to 1,500 characters) and the end of the previous reply (and, in some formats, the previous request), or the step text, all packed into one shared token budget (256 by default, set by the model's calibration; the layout is format-dependent, and the pack format caps the request tokens separately). Anything beyond the budget is cut from the end |
| Speed | About 115 ms per judgment (median), under 200 ms at the slowest, on a desktop CPU; the first load takes about 2.5 s |

The model is downloaded once from the Mixdog GitHub release named in
[`model-manifest.json`](../src/runtime/effort-judge/model-manifest.json) and
checked against its sha256 values. A newer manifest replaces the installed
files in place; a partially updated folder is never loaded. Nothing you type
is sent anywhere for this judgment.

## Accuracy

Compared with Jev 1.13 (TypeSafe's general decision API, given the same four
levels and criteria) on held-out items, none used in training:
coding-agent prompts from held-out users, coding-agent sessions, SWE-bench
issues, agent task requests, two chat sets, a final held-out set, and agent
tool-result steps. The reference is three GPT-6.1 Sol votes per item (low
effort), judged on the same text the judge sees; the level is the rounded
mean of the known votes, and items where all three votes were undecidable
are left out. That leaves 12,067 labelled items, of which 11,649 also have a
Jev answer; the tables use those 11,649 (418 items have no Jev answer). On
all 12,067 items, v7 agrees exactly on 77.9% and v6 on 71.0%.
Differences are paired on the same items; intervals are 95% bootstrap
intervals (2,000 resamples), and McNemar's test compares items only one of
the two judged exactly right.

| All items (n = 11,649) | Judge v7 | Judge v6 | Jev 1.13 | v7 − Jev [95% CI] |
|---|---:|---:|---:|---:|
| Exact level agreement | **78.1%** | 71.1% | 69.6% | **+8.6 pts** [7.6, 9.4] |
| Quadratic weighted kappa | **0.693** | 0.586 | 0.574 | **+0.119** [0.101, 0.138] |
| Mean absolute error (levels) | **0.249** | 0.317 | 0.345 | **−0.096** [−0.106, −0.085] |
| Two or more levels off | **2.5%** | 2.5% | 3.4% | **−0.9 pts** [−1.2, −0.5] |
| Hard-work detection (ROC AUC) | **0.960** | 0.935 | 0.946 | **+0.014** [0.008, 0.020] |
| Exactly right where the other is not (v7 vs Jev) | **2,138** | | 1,141 | McNemar p = 8 × 10⁻⁶⁹ |
| Median latency | **~115 ms** (local CPU) | | ~380 ms (API) | |

| By kind | Judge v7 | Judge v6 | Jev 1.13 | v7 − Jev [95% CI] |
|---|---:|---:|---:|---:|
| Requests (n = 10,278): exact | **79.7%** | 72.9% | 71.2% | **+8.5 pts** [7.5, 9.5] |
| Requests: weighted kappa | **0.720** | 0.619 | 0.599 | **+0.121** [0.102, 0.139] |
| Requests: two or more levels off | **2.0%** | 1.9% | 3.0% | **−1.0 pts** [−1.3, −0.7] |
| Agent steps (n = 1,371): exact | **66.5%** | 58.1% | 57.4% | **+9.1 pts** [5.8, 12.1] |
| Agent steps: weighted kappa | **0.543** | 0.398 | 0.404 | **+0.139** [0.071, 0.211] |
| Agent steps: two or more levels off | 6.4% | 7.0% | 6.4% | 0.0 pts [−1.5, 1.5] |

Judge v7 is also ahead of the previous judge, v6: +7.0 pts exact agreement
[6.2, 7.8] on the same items.

How to read it:

- **Ceiling.** The reference itself is not perfectly repeatable: one GPT
  vote matches the rounded mean of the other two on 91.2% of items with three
  known votes (weighted kappa 0.907). That is the practical upper bound for
  exact agreement, so most of the remaining differences are one-level calls
  on borderline items, not mistakes.
- **Where v7 is better.** Higher agreement and kappa, smaller average error,
  and better hard-work detection, all with intervals that exclude zero; the
  exact-level advantage is significant on requests and on agent steps.
- **Where they are even.** Large errors on agent steps are equally common
  (6.4% for both), and agent steps are the weakest case for every judge. The
  share of two-or-more-level errors is also the same for v7 and v6 overall
  (2.5%).
- Jev is a general model and was not tuned for this task; the comparison
  shows what a small dedicated model gains on its one job, not a general
  ranking of the two.

## Effect on cost

Measured with an earlier judge (v1); a re-run with v7 is pending.
Against a fixed `high` effort on the same tasks, with every run passing:
GPT-6.1 Sol produced 46% fewer output tokens on five hard tasks and 26% fewer
on eight Terminal-Bench tasks. Claude Opus 5.5 was about unchanged (±3%),
since it sizes its own thinking regardless of the effort setting.

## Limitations

- The judge sees only a limited, shared token budget (256 by default) holding
  the start of the request and the end of the previous reply,
  so work implied by earlier conversation can be under-rated.
- On 43% of the requests the reference rates hard or very hard, Auto picks a
  lower effort, mostly one level lower (82% of those). `xhigh` is picked on
  1.5% of items against 3.3% in the reference, so the hardest tasks can still
  run at `high`.
- Reference levels are LLM judgments, not measured task outcomes.

## Turning it off

Auto reasoning effort is a built-in under **Extensions → Built-in**. For
diagnostics, `MIXDOG_AUTO_EFFORT=off|observe|on` overrides it (`observe`
judges and logs without applying), and `MIXDOG_AUTO_EFFORT_STEPS=off` keeps
auto to the first request of each turn.

## Training data

The judge is fine-tuned from EmbeddingGemma 2 (Apache License 2.0). Its
training data includes requests and agent steps from SWE-chat (ODC-BY 1.0),
OpenAssistant oasst2 (Apache 2.0), WildChat (ODC-BY 1.0), DataClaw exports
(MIT), DevGPT (CC BY 4.0), issue texts from the SWE-bench training split
(MIT), and agent steps from NVIDIA's SWE-Hero OpenHands trajectories
(CC BY 4.0). Judge v7 adds Stack Exchange posts (CC BY-SA 2.5/3.0/4.0, via
HuggingFaceTB/stackexchange_2025_md); GitHub issues and pull requests of
permissively licensed repositories (via common-pile/github_archive); Nebius
SWE-rebench-V2 and SWE-rebench-V2-PRs (CC BY 4.0); and agent trajectories
from nebius/SWE-agent-trajectories and
nebius/SWE-rebench-openhands-trajectories (CC BY 4.0), Kwai-Klear SWE-smith
mini-swe-agent-plus, SWE-Factory DeepSWE-Agent Kimi-K2, SWE-Gym
OpenHands-SFT and TIGER-Lab SWE-Next-SFT (MIT), and AlienKevin SWE-ZERO-12M
and Lego-X SWE-Lego real and synthetic (Apache 2.0). The release notes of
each `effort-judge-v*` release list the files, hashes and attributions.

Implementation: [decision rule](../src/runtime/agent/orchestrator/providers/auto-effort.mjs),
[turn judgment](../src/runtime/agent/orchestrator/session/manager/ask-turn-auto-effort.mjs),
[step judgment](../src/runtime/agent/orchestrator/session/loop/step-auto-effort.mjs),
[judge worker](../src/runtime/effort-judge/judge-worker.mjs).
