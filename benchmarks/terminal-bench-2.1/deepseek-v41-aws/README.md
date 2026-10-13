# DeepSeek V4.1 Flash — Mixdog vs DSH on Terminal-Bench 2.1 (AWS)

Model-matched run of **Mixdog 1.1.0** against the **DSH 0.2.0-rc.2** native
harness, both driving `deepseek-ai/deepseek-v4.1-flash` on all 89
Terminal-Bench 2.1 tasks, scored by the official Harbor verifier. Executed
2026-10-12 on AWS `r7i.4xlarge` (run id `hive-20261012-xewnns`), CPU-grouped
waves (1/2/4-CPU), one attempt per task, no retries, unmodified timeouts.

## Results

| Metric | Mixdog | DSH |
|---|---|---|
| Score | **76.4% (68/89)** | 72.7% (64/88 scored)¹ |
| Pass-only median time | **167s (−15%)** | 196s |
| Pass-only median model calls | **18 (−22%)** | 23 |
| Total tokens (in+out) | 95.9M | 12.5M |
| Priced cost (all trials) | $11.26 | $7.27 |

¹ DSH `rstan-to-pystan` executed but produced no verifier verdict; counting
it unsolved gives 71.9% — the ranking is unchanged.

Mixdog input is 84% prompt-cache hits (75.9M of 90.6M) against 0.94M on DSH.
At list rates (input $0.30, cached $0.006, output $1.20 per 1M) the cost per
solved task is $0.166 vs $0.080. Failed Mixdog trials burn 4.2× pass time
(median 700s vs 167s) running to task timeout — analysed in
[#38](https://github.com/tribgames/mixdog/issues/38) with the
stuck-detection judge proposal.

## Contents

- `jobs-{mixdog,dsh}-{1,2,4}cpu/` — per-trial Harbor artifacts for every
  scored trial: `result.json` (verdict, usage, timestamps), `config.json`
  (task checksum), `exception.txt` on failures, `verifier/` output,
  `agent/usage.jsonl`, `artifacts/manifest.json`
- `harness/` — the exact harness sources that ran: `run_aws.py` (wave
  orchestrator), `aws_agents.py` (Harbor installed-agent adapters),
  `routes.mjs` (Hive endpoint provider), `hive-mixdog.mjs` / `hive-dsh.mjs`
  + `hive-dsh.patch.yml` (in-container launchers)
- `tasks.csv` — per-task outcomes: group, harness, reward, duration seconds,
  input/cache/output tokens, model calls
- `status.json`, `{mixdog,dsh}-{1,2,4}cpu.log` — runner state, Harbor logs

Planted task fixtures (the dummy AWS keys and HF tokens that the
`sanitize-git-repo` task itself seeds as its test data) are redacted from
the committed logs as `[REDACTED-FIXTURE]`; token counts and verdicts are
unchanged. Every headline number recomputes from `tasks.csv` alone.
