# Terminal-Bench 2.1 — per-task results

Matched-model solo runs, 2026-08-26.

- **opus5**: mixdog · Claude Opus 5 high — `jobs-full-opus5-solo-20260825-155233` — `k=1` — **79/89**
- **sol-xhigh**: mixdog · GPT-5.6 Sol xhigh — `jobs-full-sol-xhigh-k5-20260825-182921` — `k=5` — **385/445**

A `k>1` cell shows how many of that task's trials passed.

| task | opus5 | sol-xhigh |
|---|---|---|
| adaptive-rejection-sampler | pass | 5/5 |
| bn-fit-modify | pass | 5/5 |
| break-filter-js-from-html | pass | 5/5 |
| build-cython-ext | pass | 4/5 |
| build-pmars | pass | 5/5 |
| build-pov-ray | pass | 3/5 |
| caffe-cifar-10 | pass | 4/5 |
| cancel-async-tasks | pass | 5/5 |
| chess-best-move | pass | 5/5 |
| circuit-fibsqrt | pass | 5/5 |
| cobol-modernization | pass | 5/5 |
| code-from-image | pass | 5/5 |
| compile-compcert | pass | 5/5 |
| configure-git-webserver | pass | 3/5 |
| constraints-scheduling | pass | 5/5 |
| count-dataset-tokens | pass | 5/5 |
| crack-7z-hash | pass | 5/5 |
| custom-memory-heap-crash | pass | 5/5 |
| db-wal-recovery | pass | 5/5 |
| distribution-search | pass | 5/5 |
| dna-assembly | pass | 3/5 |
| dna-insert | fail | 0/5 |
| extract-elf | pass | 3/5 |
| extract-moves-from-video | fail | 0/5 |
| feal-differential-cryptanalysis | pass | 5/5 |
| feal-linear-cryptanalysis | pass | 5/5 |
| filter-js-from-html | fail | 0/5 |
| financial-document-processor | pass | 5/5 |
| fix-code-vulnerability | pass | 5/5 |
| fix-git | pass | 5/5 |
| fix-ocaml-gc | pass | 5/5 |
| gcode-to-text | pass | 5/5 |
| git-leak-recovery | pass | 5/5 |
| git-multibranch | pass | 5/5 |
| gpt2-codegolf | pass | 5/5 |
| headless-terminal | pass | 5/5 |
| hf-model-inference | pass | 5/5 |
| install-windows-3.11 | pass | 5/5 |
| kv-store-grpc | pass | 2/5 |
| large-scale-text-editing | pass | 5/5 |
| largest-eigenval | pass | 5/5 |
| llm-inference-batching-scheduler | pass | 5/5 |
| log-summary-date-ranges | pass | 5/5 |
| mailman | pass | 5/5 |
| make-doom-for-mips | fail | 1/5 |
| make-mips-interpreter | pass | 4/5 |
| mcmc-sampling-stan | pass | 5/5 |
| merge-diff-arc-agi-task | pass | 5/5 |
| model-extraction-relu-logits | pass | 3/5 |
| modernize-scientific-stack | pass | 5/5 |
| mteb-leaderboard | fail | 1/5 |
| mteb-retrieve | fail | 5/5 |
| multi-source-data-merger | pass | 5/5 |
| nginx-request-logging | pass | 5/5 |
| openssl-selfsigned-cert | pass | 5/5 |
| overfull-hbox | pass | 4/5 |
| password-recovery | pass | 5/5 |
| path-tracing | pass | 5/5 |
| path-tracing-reverse | pass | 5/5 |
| polyglot-c-py | pass | 5/5 |
| polyglot-rust-c | pass | 5/5 |
| portfolio-optimization | pass | 5/5 |
| protein-assembly | fail | 3/5 |
| prove-plus-comm | pass | 5/5 |
| pypi-server | pass | 5/5 |
| pytorch-model-cli | fail | 4/5 |
| pytorch-model-recovery | pass | 1/5 |
| qemu-alpine-ssh | pass | 5/5 |
| qemu-startup | pass | 5/5 |
| query-optimize | pass | 5/5 |
| raman-fitting | pass | 4/5 |
| regex-chess | pass | 5/5 |
| regex-log | pass | 5/5 |
| reshard-c4-data | pass | 5/5 |
| rstan-to-pystan | pass | 5/5 |
| sam-cell-seg | pass | 3/5 |
| sanitize-git-repo | pass | 1/5 |
| schemelike-metacircular-eval | pass | 5/5 |
| sparql-university | pass | 5/5 |
| sqlite-db-truncate | pass | 5/5 |
| sqlite-with-gcov | pass | 5/5 |
| torch-pipeline-parallelism | pass | 3/5 |
| torch-tensor-parallelism | pass | 4/5 |
| train-fasttext | fail | 5/5 |
| tune-mjcf | pass | 5/5 |
| video-processing | fail | 2/5 |
| vulnerable-secret | pass | 5/5 |
| winning-avg-corewars | pass | 5/5 |
| write-compressor | pass | 5/5 |

## GPT-5.6 Sol xhigh — mixdog vs Codex CLI, per task

Each row sums the paired trials of one task. Tokens are input (cached
included) plus output; requests are model requests per trial. Sorted by
token change, largest saving first.

| task | mixdog pass | Codex CLI pass | mixdog tokens | Codex CLI tokens | change | requests per trial |
|---|---|---|---|---|---|---|
| torch-pipeline-parallelism | 3/5 | 3/5 | 0.25M | 5.19M | 95% fewer | 4 vs 21 |
| extract-moves-from-video | 0/5 | 5/5 | 1.33M | 26.82M | 95% fewer | 18 vs 95 |
| qemu-alpine-ssh | 5/5 | 2/5 | 1.06M | 8.10M | 87% fewer | 19 vs 58 |
| db-wal-recovery | 5/5 | 5/5 | 0.23M | 1.78M | 87% fewer | 6 vs 13 |
| adaptive-rejection-sampler | 5/5 | 5/5 | 0.71M | 4.83M | 85% fewer | 6 vs 20 |
| sam-cell-seg | 3/5 | 5/5 | 0.65M | 4.10M | 84% fewer | 6 vs 20 |
| caffe-cifar-10 | 4/5 | 5/5 | 6.26M | 38.70M | 84% fewer | 32 vs 70 |
| large-scale-text-editing | 5/5 | 5/5 | 0.25M | 1.44M | 83% fewer | 6 vs 13 |
| cancel-async-tasks | 5/5 | 5/5 | 0.10M | 0.53M | 82% fewer | 3 vs 6 |
| protein-assembly | 3/5 | 5/5 | 1.43M | 7.61M | 81% fewer | 13 vs 25 |
| polyglot-c-py | 5/5 | 5/5 | 0.29M | 1.55M | 81% fewer | 6 vs 15 |
| mcmc-sampling-stan | 5/5 | 5/5 | 2.67M | 13.75M | 81% fewer | 23 vs 42 |
| fix-code-vulnerability | 5/5 | 5/5 | 0.32M | 1.64M | 80% fewer | 7 vs 11 |
| sqlite-with-gcov | 5/5 | 4/5 | 0.66M | 3.25M | 80% fewer | 11 vs 22 |
| pypi-server | 5/5 | 0/5 | 0.27M | 1.30M | 79% fewer | 8 vs 14 |
| compile-compcert | 5/5 | 5/5 | 3.54M | 16.63M | 79% fewer | 29 vs 58 |
| torch-tensor-parallelism | 4/5 | 5/5 | 0.16M | 0.74M | 79% fewer | 3 vs 8 |
| code-from-image | 5/5 | 5/5 | 0.10M | 0.47M | 79% fewer | 3 vs 6 |
| circuit-fibsqrt | 5/5 | 5/5 | 0.49M | 2.30M | 79% fewer | 6 vs 17 |
| headless-terminal | 5/5 | 5/5 | 0.26M | 1.20M | 78% fewer | 6 vs 11 |
| gpt2-codegolf | 5/5 | 5/5 | 1.14M | 5.16M | 78% fewer | 14 vs 26 |
| query-optimize | 5/5 | 5/5 | 1.36M | 5.71M | 76% fewer | 16 vs 35 |
| openssl-selfsigned-cert | 5/5 | 5/5 | 0.16M | 0.64M | 76% fewer | 4 vs 7 |
| hf-model-inference | 5/5 | 0/5 | 0.36M | 1.47M | 76% fewer | 8 vs 16 |
| rstan-to-pystan | 5/5 | 5/5 | 1.95M | 7.43M | 74% fewer | 19 vs 31 |
| filter-js-from-html | 0/5 | 1/5 | 0.84M | 3.17M | 73% fewer | 6 vs 18 |
| polyglot-rust-c | 5/5 | 4/5 | 0.27M | 0.98M | 73% fewer | 5 vs 10 |
| cobol-modernization | 5/5 | 5/5 | 0.66M | 2.41M | 72% fewer | 10 vs 17 |
| overfull-hbox | 4/5 | 4/5 | 0.66M | 2.38M | 72% fewer | 9 vs 17 |
| prove-plus-comm | 5/5 | 5/5 | 0.16M | 0.56M | 72% fewer | 5 vs 7 |
| largest-eigenval | 5/5 | 5/5 | 0.46M | 1.63M | 71% fewer | 10 vs 15 |
| train-fasttext | 5/5 | 3/5 | 7.09M | 24.83M | 71% fewer | 44 vs 72 |
| fix-ocaml-gc | 5/5 | 5/5 | 2.98M | 10.38M | 71% fewer | 22 vs 32 |
| kv-store-grpc | 2/5 | 1/5 | 0.28M | 0.97M | 71% fewer | 8 vs 11 |
| portfolio-optimization | 5/5 | 5/5 | 0.45M | 1.53M | 70% fewer | 8 vs 14 |
| schemelike-metacircular-eval | 5/5 | 5/5 | 1.55M | 5.23M | 70% fewer | 11 vs 24 |
| count-dataset-tokens | 5/5 | 5/5 | 0.48M | 1.61M | 70% fewer | 10 vs 13 |
| fix-git | 5/5 | 5/5 | 0.38M | 1.27M | 70% fewer | 10 vs 13 |
| multi-source-data-merger | 5/5 | 5/5 | 0.16M | 0.53M | 70% fewer | 4 vs 6 |
| distribution-search | 5/5 | 5/5 | 0.17M | 0.55M | 70% fewer | 4 vs 6 |
| sqlite-db-truncate | 5/5 | 5/5 | 0.21M | 0.68M | 69% fewer | 6 vs 8 |
| tune-mjcf | 5/5 | 5/5 | 0.61M | 1.94M | 69% fewer | 11 vs 17 |
| llm-inference-batching-scheduler | 5/5 | 5/5 | 0.83M | 2.62M | 68% fewer | 8 vs 16 |
| write-compressor | 5/5 | 5/5 | 0.47M | 1.47M | 68% fewer | 8 vs 13 |
| bn-fit-modify | 5/5 | 5/5 | 0.32M | 1.00M | 68% fewer | 7 vs 10 |
| dna-assembly | 3/5 | 3/5 | 1.71M | 5.22M | 67% fewer | 17 vs 23 |
| pytorch-model-recovery | 1/5 | 0/5 | 0.51M | 1.55M | 67% fewer | 9 vs 13 |
| make-mips-interpreter | 4/5 | 5/5 | 4.45M | 13.40M | 67% fewer | 15 vs 31 |
| chess-best-move | 5/5 | 5/5 | 0.41M | 1.23M | 67% fewer | 9 vs 11 |
| regex-log | 5/5 | 5/5 | 0.22M | 0.67M | 67% fewer | 5 vs 7 |
| custom-memory-heap-crash | 5/5 | 5/5 | 1.01M | 3.00M | 66% fewer | 15 vs 17 |
| git-leak-recovery | 5/5 | 5/5 | 0.36M | 1.05M | 66% fewer | 10 vs 11 |
| pytorch-model-cli | 4/5 | 5/5 | 0.90M | 2.60M | 65% fewer | 13 vs 20 |
| reshard-c4-data | 5/5 | 5/5 | 1.19M | 3.43M | 65% fewer | 10 vs 21 |
| log-summary-date-ranges | 5/5 | 5/5 | 0.22M | 0.63M | 65% fewer | 5 vs 6 |
| configure-git-webserver | 3/5 | 1/5 | 0.78M | 2.21M | 65% fewer | 13 vs 18 |
| model-extraction-relu-logits | 3/5 | 4/5 | 0.44M | 1.23M | 64% fewer | 7 vs 10 |
| feal-differential-cryptanalysis | 5/5 | 5/5 | 0.33M | 0.91M | 64% fewer | 7 vs 9 |
| sanitize-git-repo | 1/5 | 1/5 | 3.25M | 8.83M | 63% fewer | 20 vs 37 |
| modernize-scientific-stack | 5/5 | 5/5 | 0.14M | 0.37M | 62% fewer | 4 vs 4 |
| path-tracing | 5/5 | 5/5 | 5.13M | 12.78M | 60% fewer | 36 vs 51 |
| mteb-retrieve | 5/5 | 4/5 | 0.50M | 1.20M | 58% fewer | 11 vs 13 |
| nginx-request-logging | 5/5 | 5/5 | 0.35M | 0.83M | 58% fewer | 8 vs 9 |
| vulnerable-secret | 5/5 | 5/5 | 0.35M | 0.75M | 53% fewer | 8 vs 7 |
| extract-elf | 3/5 | 5/5 | 0.69M | 1.45M | 52% fewer | 9 vs 11 |
| raman-fitting | 4/5 | 1/5 | 1.34M | 2.69M | 50% fewer | 15 vs 20 |
| path-tracing-reverse | 5/5 | 5/5 | 5.63M | 11.19M | 50% fewer | 22 vs 29 |
| dna-insert | 0/5 | 0/5 | 0.64M | 1.26M | 50% fewer | 11 vs 11 |
| make-doom-for-mips | 1/5 | 2/5 | 16.40M | 31.81M | 48% fewer | 42 vs 55 |
| qemu-startup | 5/5 | 5/5 | 1.77M | 3.32M | 47% fewer | 18 vs 23 |
| install-windows-3.11 | 5/5 | 5/5 | 8.99M | 16.80M | 47% fewer | 51 vs 51 |
| financial-document-processor | 5/5 | 5/5 | 2.10M | 3.88M | 46% fewer | 9 vs 17 |
| constraints-scheduling | 5/5 | 5/5 | 0.26M | 0.48M | 45% fewer | 6 vs 5 |
| regex-chess | 5/5 | 5/5 | 1.44M | 2.54M | 43% fewer | 13 vs 15 |
| build-pov-ray | 3/5 | 5/5 | 6.22M | 10.88M | 43% fewer | 36 vs 33 |
| build-pmars | 5/5 | 5/5 | 1.92M | 3.20M | 40% fewer | 17 vs 17 |
| sparql-university | 5/5 | 4/5 | 0.99M | 1.62M | 39% fewer | 12 vs 14 |
| gcode-to-text | 5/5 | 3/5 | 1.68M | 2.72M | 38% fewer | 14 vs 19 |
| video-processing | 2/5 | 4/5 | 2.59M | 4.12M | 37% fewer | 20 vs 21 |
| git-multibranch | 5/5 | 5/5 | 1.85M | 2.85M | 35% fewer | 23 vs 22 |
| build-cython-ext | 4/5 | 5/5 | 4.42M | 6.68M | 34% fewer | 32 vs 33 |
| break-filter-js-from-html | 5/5 | 5/5 | 0.61M | 0.93M | 34% fewer | 12 vs 10 |
| feal-linear-cryptanalysis | 5/5 | 5/5 | 2.55M | 3.75M | 32% fewer | 16 vs 19 |
| mailman | 5/5 | 5/5 | 4.09M | 5.83M | 30% fewer | 24 vs 24 |
| merge-diff-arc-agi-task | 5/5 | 5/5 | 1.93M | 2.60M | 26% fewer | 19 vs 21 |
| winning-avg-corewars | 5/5 | 5/5 | 4.14M | 5.48M | 24% fewer | 31 vs 28 |
| password-recovery | 5/5 | 5/5 | 1.24M | 1.30M | 5% fewer | 16 vs 11 |
| crack-7z-hash | 5/5 | 4/5 | 3.13M | 2.20M | 42% more | 30 vs 19 |
| mteb-leaderboard | 1/5 | 5/5 | 12.56M | 1.85M | 579% more | 46 vs 11 |
