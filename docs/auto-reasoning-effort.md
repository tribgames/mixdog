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
| Base | EmbeddingGemma 2 text encoder, 12 of 24 layers, with a four-level classification head |
| Format | ONNX, 4-bit weights, about 130 MB |
| Runtime | ONNX Runtime on the CPU (4 threads); no GPU, no network after download |
| Input | The cleaned request (up to 1,500 characters) and the end of the previous reply (and, in some formats, the previous request), or the step text, all packed into one shared token budget (256 by default, set by the model's calibration; the layout is format-dependent, and the pack format caps the request tokens separately). Anything beyond the budget is cut from the end |
| Speed | About 80–100 ms per judgment (median) on a desktop CPU |

The model is downloaded once from the Mixdog GitHub release named in
[`model-manifest.json`](../src/runtime/effort-judge/model-manifest.json) and
checked against its sha256 values. A newer manifest replaces the installed
files in place; a partially updated folder is never loaded. Nothing you type
is sent anywhere for this judgment.

## Accuracy

Measured through the app's own judge worker on 12,029 held-out items that
were never used for training: coding-agent prompts from held-out users, chat
prompts, SWE-bench issues, agent tool-result steps, and a final held-out set.
Reference levels come from three independent LLM votes (Claude Sonnet) per
item. Jev 1.13 (TypeSafe's general decision API) was given the same four
levels and criteria.

| | Judge v2 | Judge v4 (current) | Jev 1.13 |
|---|---:|---:|---:|
| Exact level | 69.7% | **76.8%** | 72.7% |
| Off by two or more levels | 2.2% | **0.7%** | 1.4% |
| Exact level, agent steps only | 56.2% | **70.5%** | 66.1% |
| Called lower than the reference | 12.4% | 11.5% | 22.0% |
| Called higher than the reference | 18.0% | 11.8% | 5.3% |
| Median latency | — | **98 ms** (local) | 382 ms (API) |

The 95% interval of v4's exact-level rate is 76.1–77.5%. Jev is a general
model and was not tuned for this task; the comparison shows what a small
dedicated model gains on its one job, not a general ranking of the two.

## Effect on cost

Measured with the previous judge (v1); a re-run with v4 is pending.
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
OpenAssistant oasst2 (Apache 2.0), DataClaw exports (MIT), DevGPT (CC BY 4.0)
and issue texts from the SWE-bench training split (MIT). The release notes of
each `effort-judge-v*` release list the files, hashes and attributions.

Implementation: [decision rule](../src/runtime/agent/orchestrator/providers/auto-effort.mjs),
[turn judgment](../src/runtime/agent/orchestrator/session/manager/ask-turn-auto-effort.mjs),
[step judgment](../src/runtime/agent/orchestrator/session/loop/step-auto-effort.mjs),
[judge worker](../src/runtime/effort-judge/judge-worker.mjs).
