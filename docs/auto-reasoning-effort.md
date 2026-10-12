# Auto reasoning effort

Auto reasoning effort sets how much a model thinks for each message and for
each step after a batch of tool results. Simple messages run at a lower
effort, and harder work runs higher, instead of every request running at one
fixed level. It is on by default and runs entirely on your machine.

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
   answer while over-thinking only costs tokens; an unnecessary `xhigh` also
   costs extra.

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
the default effort. A judgment normally has 0.4 s; the first use after
startup waits up to about 3 s while the model loads (about 2 s on a desktop
CPU).

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
levels and criteria) on the same 12,029 held-out items, none used in
training: coding-agent prompts from held-out users, coding-agent sessions,
SWE-bench issues, agent task requests, two chat sets, a final held-out set,
and agent tool-result steps. Reference levels come from three independent
Claude Sonnet votes per item, judged on the same text the judge sees.
Differences are paired on the same items; intervals are 95% bootstrap
intervals (2,000 resamples), and McNemar's test compares items only one of
the two judged exactly right.

| All items (n = 12,029) | Judge v6 | Jev 1.13 | v6 − Jev [95% CI] |
|---|---:|---:|---:|
| Exact level agreement | **78.5%** | 72.7% | **+5.8 pts** [4.8, 6.8] |
| Quadratic weighted kappa | **0.689** | 0.626 | **+0.064** [0.047, 0.080] |
| Mean absolute error (levels) | **0.222** | 0.288 | **−0.067** [−0.077, −0.056] |
| Two or more levels off | **0.6%** | 1.4% | **−0.8 pts** [−1.0, −0.6] |
| Hard-work detection (ROC AUC) | 0.954 | 0.956 | −0.002 [−0.008, 0.005] |
| Exactly right where the other is not | **2,095** | 1,397 | McNemar p = 2.6 × 10⁻³² |
| Median latency | **~115 ms** (local CPU) | ~380 ms (API) | |

| By kind | Judge v6 | Jev 1.13 | v6 − Jev [95% CI] |
|---|---:|---:|---:|
| Requests (n = 10,532): exact | **79.7%** | 73.6% | **+6.0 pts** [5.1, 7.1] |
| Requests: weighted kappa | **0.701** | 0.635 | **+0.066** [0.049, 0.084] |
| Requests: two or more levels off | **0.5%** | 1.4% | **−0.8 pts** [−1.1, −0.6] |
| Agent steps (n = 1,497): exact | **70.2%** | 66.1% | **+4.1 pts** [1.2, 7.0] |
| Agent steps: weighted kappa | **0.621** | 0.545 | **+0.076** [0.027, 0.127] |
| Agent steps: two or more levels off | 1.2% | 1.6% | −0.4 pts [−1.1, 0.3] |

How to read it:

- **Ceiling.** The reference itself is not perfectly repeatable: one Sonnet
  vote matches the rounded mean of the other two on 85.3% of items (weighted
  kappa 0.816). That is the practical upper bound for exact agreement, so
  most of the remaining differences are one-level calls on borderline items,
  not mistakes.
- **Where v6 is better.** Higher agreement and kappa, smaller average error,
  and about half the large errors, all with intervals that exclude zero; the
  exact-level advantage is significant on requests and on agent steps.
- **Where they are even.** Separating hard work (high or above) from the rest
  is statistically indistinguishable (AUC 0.954 vs 0.956). Jev calls hard work
  less often and is more precise when it does; v6 calls it more often.
- Jev is a general model and was not tuned for this task; the comparison
  shows what a small dedicated model gains on its one job, not a general
  ranking of the two.

## Effect on cost

Measured with an earlier judge (v1); a re-run with v6 is pending.
Against a fixed `high` effort on the same tasks, with every run passing:
GPT-6.1 Sol produced 46% fewer output tokens on five hard tasks and 26% fewer
on eight Terminal-Bench tasks. Claude Opus 5.5 was about unchanged (±3%),
since it sizes its own thinking regardless of the effort setting.

## Limitations

- The judge sees only a limited, shared token budget (256 by default) holding
  the start of the request and the end of the previous reply,
  so work implied by earlier conversation can be under-rated.
- About four in ten requests rated hard or very hard by the reference are
  rated lower by the judge, almost always by one level. "Very hard" is called
  sparingly, so the hardest tasks can run at `high` instead of `xhigh`.
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
(CC BY 4.0). The release notes of
each `effort-judge-v*` release list the files, hashes and attributions.

Implementation: [decision rule](../src/runtime/agent/orchestrator/providers/auto-effort.mjs),
[turn judgment](../src/runtime/agent/orchestrator/session/manager/ask-turn-auto-effort.mjs),
[step judgment](../src/runtime/agent/orchestrator/session/loop/step-auto-effort.mjs),
[judge worker](../src/runtime/effort-judge/judge-worker.mjs).
