# Evaluating a skill

Use after a draft exists or when a skill misbehaves. A passing validator
proves structure only, never behaviour.

## Scenarios

Two to five realistic requests, with the context a real user would give:

1. a request that names the intent;
2. an implicit request that should still select the skill;
3. an edge or failure condition that matters;
4. a near-miss negative: shares the skill's words but belongs to another
   owner;
5. a subjective artifact, when taste or domain judgement decides.

Never use "load this skill" as a positive case. Keep scenario files outside
the skill's folder.

## Baseline

Before changing a skill, keep a copy of the prior version and run the same
prompts, inputs, model and tools against both. A new skill with no runnable
baseline gets a smoke test, not a claimed comparison. Keep the harness the
same for both: no task-specific hints, retries, timeouts or scoring
exceptions.

## Evidence

- Mechanical outcomes get deterministic checks: files exist and open, fields
  are valid, references resolve, bad input fails with useful guidance, an
  irreversible step waits for approval, no forbidden side effect happens.
- Never assert exact prose or internal steps.
- Clarity, taste and domain judgement go to the user, shown the real output.

## Diagnose before revising

| Class | Where the fix goes |
|---|---|
| Selection | Trigger or the neighbour's boundary |
| Instruction | A missing decision, step order or completion result in the body |
| Resource | The broken script, reference, asset or path |
| Integration | The unavailable tool, feature or dependency |
| Harness | The test setup, not the skill |
| Capability | The tool or product; the skill cannot deliver it |

## Improve without sediment

After each revision, rerun the affected scenarios, validate, keep safety and
recovery, delete the rules the fix superseded, and check that the fix is not
tailored to one example. Stop when the required behaviour passes, the user
accepts the subjective parts, and further edits stop paying off.
