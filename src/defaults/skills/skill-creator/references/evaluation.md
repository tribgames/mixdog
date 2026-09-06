# Evaluating a skill

Use this reference after a draft exists or when a current skill has a reported
defect.

## Separate the questions

A complete evaluation asks:

| Area | Question |
|---|---|
| Selection | Does the description attract relevant requests and reject close alternatives? |
| Execution | Does the loaded workflow produce the required outcome? |
| Integration | Do resources, paths, tools, and feature gates resolve? |
| Recovery | Do failures remain bounded and actionable? |
| Efficiency | Does the skill remove repeated work without adding ritual? |

Passing a frontmatter check proves none of the execution questions.

## Scenario set

Use two to five realistic requests:

1. a normal request that names the intent;
2. an implicit request that should still select the skill;
3. an important edge or failure condition;
4. a close negative request owned elsewhere;
5. a subjective artifact case when human judgement matters.

Do not use “load this skill” as a positive test. Include concrete context, files,
or constraints that a real user would provide.

An optional record shape:

```json
{
  "id": "short-purpose",
  "prompt": "Realistic user request",
  "expected_owner": "skill-name or none",
  "observable_result": "What must become true",
  "inputs": []
}
```

Keep evaluation artifacts outside the distributable directory unless the
packaging process explicitly excludes them.

## Baseline

Before improving a skill, preserve its exact prior behavior through existing
version history or a read-only evaluation snapshot. Compare identical prompts,
inputs, model class, tool availability, and environment.

For a new skill, compare against no skill only when the runner can isolate the
draft from the baseline. Otherwise report a smoke test rather than implying a
controlled A/B result.

The evaluation harness must remain uniform. Do not add task-specific routing,
timeouts, prompt clues, retries, or scoring exceptions to make one version win.

## Evidence

Use deterministic checks for mechanical outcomes:

- required files exist and open;
- structured fields and values are valid;
- references resolve;
- malformed input fails with useful guidance;
- resource and retry limits hold;
- an irreversible action waits for approval;
- prohibited side effects do not occur.

Do not test exact prose, source strings, internal algorithms, or snapshots whose
expected behavior has intentionally changed.

Use user review for clarity, visual quality, writing taste, and domain
judgement. Present the full-size persisted output rather than a description of
it.

## Diagnose before revising

Classify a failure:

- **selection** — description signal or neighboring boundary;
- **instruction** — missing decision, sequence, or completion evidence;
- **resource** — broken script, reference, asset, or path;
- **integration** — unavailable tool, feature, dependency, or platform;
- **harness** — invalid comparison or test infrastructure;
- **underlying capability** — the tool or product cannot deliver the outcome.

Edit the component that owns the failure. More prompt text does not repair a
broken tool, and body changes cannot fix a description that never selects the
skill.

## Improve without sediment

After each revision:

1. rerun affected scenarios;
2. validate structure and resource paths;
3. retain safety, recovery, and bounded execution;
4. remove rules superseded by the fix;
5. check whether the change generalizes beyond the failing example.

Look for tests that always pass, high variance, repeated helper work, excessive
token or time cost, and rules that change no outcome. Those are signals to
improve the evaluation or simplify the skill.

Stop when required behavior passes, subjective review is accepted, and further
edits no longer produce meaningful gains.

