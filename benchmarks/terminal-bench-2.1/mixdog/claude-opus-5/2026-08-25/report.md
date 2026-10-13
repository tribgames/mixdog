# Terminal-Bench preset report: full-opus5-solo

- Score: **79/89** (89 completed)
- Clean: **false** (errors 6, retries 5)
- Agent total: **46873.0s** — rank n/a
- Wall: **9402.0s** — rank n/a
- Tokens: input 4680, cached 55934744, output 1848785
- Cost: $104.29 (89 trials)
- Final context median: 27644 tokens (89 trials)
- Reduction: 5553994 bytes saved, 0 artifact reads
- Contract: rules 85ef48f37438 (18 files), tools 7ea19a66ba6b (13 catalog, 11 active, 13 provider, 2 routes)

## Pair: Claude Code · Claude Opus 5 high

- Paired trials: **89**
- Score: **79/89 vs 77/89**
- Outcomes: ours-only 5, baseline-only 3, both-pass 74, both-fail 7
- Wall speedup: **1.16x** (agent 1.15x)
- Cost ratio (ours/baseline, 89/89 cost-comparable tasks): **0.81x**
- Input-token ratio (ours/baseline): **0.00x**
- Final-context reduction: **27.6%**

## Diagnostics

- **configure-git-webserver**: 1 tool failure(s)
  - Trace: 15 requests, 18 tools (shell 10, edit 5, list 1, read 1, task 1)
  - Tool failures: edit/runtime/failure
  - Last calls: shell {"command":"set -e\nrm -rf /tmp/work /tmp/testkey /tmp/testkey.pub\n: > /home/user/.ssh/authorized_keys\nchown user:user /home/user/.ssh/authorized_keys; chmod 600 /home/user/.ssh/authorized_keys..."} → edit {"file_path":"/git/server/hooks/post-receive"} → shell {"command":"set -e\nchmod +x /git/server/hooks/post-receive /usr/local/bin/start-services.sh\nchown -R user:user /git /var/www/html\nls -la /git/server /var/www/html /home/user/.ssh\necho \"--- ser..."}
- **extract-moves-from-video**: AgentTimeoutError — Agent execution timed out after 1800.0 seconds
  - Trace: 52 requests, 51 tools (shell 24, edit 11, task 11, read 5)
  - Last calls: shell {"command":"cd /app/work/pgm && ls *.pgm | sed 's/\\.pgm$//' | xargs -P 8 -I{} sh -c 'tesseract {}.pgm {} --psm 6 tsv >/dev/null 2>&1' && ls *.tsv | wc -l","timeout_ms":1800000} → edit {"file_path":"/app/tools/label.js"} → task {"action":"wait","task_id":"job_1787680046095_02c2fd"}
- **llm-inference-batching-scheduler**: AgentTimeoutError — Agent execution timed out after 1800.0 seconds
  - Trace: 46 requests, 48 tools (shell 27, task 9, edit 8, read 2, find 1, list 1)
  - Last calls: task {"action":"wait","task_id":"job_1787674908022_a4ec78"} → shell {"command":"cd /app/work && tail -3 p_b1.log"} → shell {"command":"cd /app/work && for i in $(seq 1 90); do if grep -q \"IMPROVED\\|no improvement\\|no feasible\" p_b1.log 2>/dev/null; then break; fi; sleep 5; done; grep -E \"IMPROVED|no improvement|ex...","timeout_ms":480000}
- **make-doom-for-mips**: AgentTimeoutError — Agent execution timed out after 900.0 seconds
  - Trace: 37 requests, 65 tools (edit 29, read 13, shell 10, grep 8, list 4, task 1)
  - Last calls: shell {"command":"cd /app && ./build.sh 2>&1 | grep -vE \"^\\[CC\\]\" | head -60","timeout_ms":600000} → edit {"file_path":"/app/build.sh"} → edit {"file_path":"/app/build.sh"}
- **pytorch-model-recovery**: AgentTimeoutError — Agent execution timed out after 900.0 seconds
  - Trace: 20 requests, 19 tools (shell 8, edit 6, task 5)
  - Last calls: shell {"command":"cd /app && PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4 python tune.py > /tmp/tune.log 2>&1; echo \"exit=$?\"; grep -v NumPy /tmp/tune.log"} → shell {"command":"cd /app && ls -la weights.pt model.pt && python -c \"\nimport torch,torch.nn as nn\nm=torch.jit.load('/app/model.pt'); m.eval()\nsd=torch.load('/app/weights.pt',map_location='cpu')\nd=t..."} → task {"action":"wait","task_id":"job_1787674618715_d38bd5"}
- **schemelike-metacircular-eval**: AgentTimeoutError — Agent execution timed out after 2400.0 seconds
  - Trace: 16 requests, 48 tools (read 35, shell 5, task 5, list 2, edit 1)
  - Last calls: task {"action":"wait","task_id":"job_1787674411558_cd525b"} → task {"action":"wait","task_id":"job_1787674411558_cd525b"} → shell {"command":"cat /tmp/lvl2.log"}
- **train-fasttext**: AgentTimeoutError — Agent execution timed out after 3600.0 seconds
  - Trace: 43 requests, 47 tools (shell 30, task 15, list 2)
  - Last calls: shell {"command":"ls -la /app /opt /workspace 2>/dev/null | head -40; echo \"=== search ===\"; grep -rl --include=*.py --include=*.sh --include=*.md --include=*.yaml --include=*.yml --include=*.json -...","timeout_ms":180000} → shell {"command":"cd /app && cat > work/u1.json <<'EOF'\n[{\"name\":\"rw_mc5_b3M_lr0.5\",\"data\":\"/app/work/train_raw.txt\",\"kw\":{\"dim\":10,\"wordNgrams\":2,\"bucket\":3000000,\"epoch\":5,\"lr\":0.5,\"minCount\":5}}]..."} → shell {"command":"sleep 400; cd /app && cat work/ures*.jsonl","timeout_ms":600000}

| Task | Pass | Agent seconds |
|---|---:|---:|
| adaptive-rejection-sampler | yes | 702.7 |
| bn-fit-modify | yes | 64.0 |
| break-filter-js-from-html | yes | 108.2 |
| build-cython-ext | yes | 601.2 |
| build-pmars | yes | 146.3 |
| build-pov-ray | yes | 372.9 |
| caffe-cifar-10 | yes | 3003.9 |
| cancel-async-tasks | yes | 191.1 |
| chess-best-move | yes | 81.5 |
| circuit-fibsqrt | yes | 352.4 |
| cobol-modernization | yes | 564.3 |
| code-from-image | yes | 16.1 |
| compile-compcert | yes | 1872.9 |
| configure-git-webserver | yes | 197.8 |
| constraints-scheduling | yes | 34.1 |
| count-dataset-tokens | yes | 103.2 |
| crack-7z-hash | yes | 128.6 |
| custom-memory-heap-crash | yes | 127.7 |
| db-wal-recovery | yes | 81.5 |
| distribution-search | yes | 112.0 |
| dna-assembly | yes | 272.2 |
| dna-insert | no | 214.6 |
| extract-elf | yes | 313.1 |
| extract-moves-from-video | no | 1802.0 |
| feal-differential-cryptanalysis | yes | 902.3 |
| feal-linear-cryptanalysis | yes | 124.3 |
| filter-js-from-html | no | 858.4 |
| financial-document-processor | yes | 143.1 |
| fix-code-vulnerability | yes | 58.4 |
| fix-git | yes | 53.2 |
| fix-ocaml-gc | yes | 497.6 |
| gcode-to-text | yes | 226.8 |
| git-leak-recovery | yes | 54.1 |
| git-multibranch | yes | 182.6 |
| gpt2-codegolf | yes | 446.4 |
| headless-terminal | yes | 391.5 |
| hf-model-inference | yes | 92.0 |
| install-windows-3.11 | yes | 2249.6 |
| kv-store-grpc | yes | 90.3 |
| large-scale-text-editing | yes | 168.3 |
| largest-eigenval | yes | 645.1 |
| llm-inference-batching-scheduler | yes | 1800.3 |
| log-summary-date-ranges | yes | 24.0 |
| mailman | yes | 704.4 |
| make-doom-for-mips | no | 900.3 |
| make-mips-interpreter | yes | 686.6 |
| mcmc-sampling-stan | yes | 250.5 |
| merge-diff-arc-agi-task | yes | 148.4 |
| model-extraction-relu-logits | yes | 142.8 |
| modernize-scientific-stack | yes | 77.9 |
| mteb-leaderboard | no | 231.0 |
| mteb-retrieve | no | 126.8 |
| multi-source-data-merger | yes | 64.0 |
| nginx-request-logging | yes | 80.7 |
| openssl-selfsigned-cert | yes | 45.7 |
| overfull-hbox | yes | 222.7 |
| password-recovery | yes | 103.1 |
| path-tracing | yes | 225.2 |
| path-tracing-reverse | yes | 438.5 |
| polyglot-c-py | yes | 202.0 |
| polyglot-rust-c | yes | 131.7 |
| portfolio-optimization | yes | 209.8 |
| protein-assembly | no | 312.4 |
| prove-plus-comm | yes | 30.1 |
| pypi-server | yes | 55.4 |
| pytorch-model-cli | no | 187.6 |
| pytorch-model-recovery | yes | 900.3 |
| qemu-alpine-ssh | yes | 438.7 |
| qemu-startup | yes | 319.0 |
| query-optimize | yes | 654.7 |
| raman-fitting | yes | 675.0 |
| regex-chess | yes | 2977.7 |
| regex-log | yes | 137.2 |
| reshard-c4-data | yes | 766.1 |
| rstan-to-pystan | yes | 355.8 |
| sam-cell-seg | yes | 2963.1 |
| sanitize-git-repo | yes | 89.4 |
| schemelike-metacircular-eval | yes | 2400.4 |
| sparql-university | yes | 387.7 |
| sqlite-db-truncate | yes | 106.7 |
| sqlite-with-gcov | yes | 225.2 |
| torch-pipeline-parallelism | yes | 441.8 |
| torch-tensor-parallelism | yes | 128.1 |
| train-fasttext | no | 3604.0 |
| tune-mjcf | yes | 351.2 |
| video-processing | no | 716.2 |
| vulnerable-secret | yes | 82.3 |
| winning-avg-corewars | yes | 1870.8 |
| write-compressor | yes | 231.6 |
