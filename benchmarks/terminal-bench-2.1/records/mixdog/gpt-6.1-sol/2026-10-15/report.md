# Terminal-Bench preset report: full-sol61

- Score: **77/89** (89 completed)
- Clean: **false** (errors 2, retries 6)
- Agent total: **19155.7s** — rank n/a
- Wall: **5715.0s** — rank n/a
- Tokens: input 11884599, cached 9842560, output 239181
- Cost: $7.46 (89 trials)
- Final context median: 10841 tokens (88 trials)
- Reduction: 389996 bytes saved, 0 artifact reads
- Contract: rules fd2a52c4b1df (16 files), tools e102250675b6 (10 catalog, 10 active, 10 provider, 1 route)
- Source: commit 089bfaf8f63d (dirty true), bundle 15e9a5713349 (3683 files), mixdog 1.2.2

## Pair: Codex CLI · GPT-6.1 Sol xhigh

- Paired trials: **89**
- Score: **77/89 vs 78/89**
- Outcomes: ours-only 6, baseline-only 7, both-pass 71, both-fail 5
- Wall speedup: **1.11x** (agent 1.08x)
- Cost ratio (ours/baseline, 86/89 cost-comparable tasks; partial coverage): **0.37x**
- Input-token ratio (ours/baseline): **0.21x**
- Final-context reduction: **67.7%**

## Diagnostics

- **build-pmars**: 1 tool failure(s)
  - Trace: 16 requests, 17 tools (shell 7, grep 2, read 2, web_fetch 2, apply_patch 1, glob 1, load_tool 1, task 1)
  - Tool failures: web_fetch/upstream/http
  - Last calls: grep {"pattern":"-e|quit|exit","path":"/app/pmars-0.9.4/doc/pmars.6"} → shell {"command":"set -o pipefail\npmars -b -r 50 -f flashpaper.red rave.red | tail -n 1\npython3 - <<'PY'\nimport subprocess,re,hashlib,pathlib\np=pathlib.Path('/app')\ndsc=(p/'pmars_0.9.4-1.dsc').read_...","timeout_ms":30000} → shell {"command":"python3 - <<'PY'\nimport subprocess,re\nr=subprocess.run(['pmars','-e','-r','1','-f','flashpaper.red','rave.red'],input='list pc\\nstep\\nlist pc\\ncontinue\\n',text=True,capture_output=...","timeout_ms":30000}
- **build-pov-ray**: 1 tool failure(s)
  - Trace: 12 requests, 13 tools (shell 5, apply_patch 1, glob 1, list 1, load_tool 1, read 1, task 1, web_fetch 1, web_search 1)
  - Tool failures: web_fetch/runtime/failure
  - Last calls: apply_patch {} → shell {"command":"cd /app/povray-2.2/build && make -f unix.mak -j4 CFLAGS='-c -O -std=gnu89'","timeout_ms":120000} → shell {"command":"install -m 755 /app/povray-2.2/build/povray /usr/local/bin/povray && /usr/local/bin/povray +L/app/povray-2.2/povdoc/include +I/app/deps/illum1.pov +O/dev/null +P -V","timeout_ms":120000}
- **caffe-cifar-10**: AgentTimeoutError — Agent execution timed out after 3600.0 seconds
  - Trace: 20 requests, 21 tools (task 9, shell 6, apply_patch 3, git 1, grep 1, read 1)
  - Last calls: task {"action":"wait","task_id":"job_1792042848932_c9c208"} → task {"action":"wait","task_id":"job_1792042848932_c9c208"} → task {"action":"wait","task_id":"job_1792042848932_c9c208"}
- **custom-memory-heap-crash**: 1 tool failure(s)
  - Trace: 13 requests, 21 tools (shell 9, grep 3, read 3, apply_patch 2, task 2, glob 1, list 1)
  - Tool failures: shell/timeout/abort
  - Last calls: apply_patch {} → shell {"command":"g++ -std=c++17 -o /app/release /app/main.cpp /app/user.cpp -O2 -DNDEBUG -L/usr/local/gcc-custom-release/lib64 -Wl,-Bstatic -lstdc++ -Wl,-Bdynamic -lm && /app/release && valgrind --...","timeout_ms":30000} → shell {"command":"g++ -std=c++17 -o /app/debug /app/main.cpp /app/user.cpp -g -O0 -L/usr/local/gcc-custom-debug/lib64 -Wl,-Bstatic -lstdc++ -Wl,-Bdynamic -lm && /app/debug && valgrind --leak-check=f...","timeout_ms":30000}
- **dna-assembly**: 1 tool failure(s)
  - Trace: 13 requests, 11 tools (shell 5, web_search 2, apply_patch 1, load_tool 1, read 1, web_fetch 1)
  - Tool failures: web_fetch/runtime/failure
  - Last calls: shell {"command":"node <<'NODE'\nconst fs=require('fs'),cp=require('child_process');const s={};for(const e of fs.readFileSync('/app/sequences.fasta','utf8').trim().split(/\\n>/)){const [h,...r]=e.repl...","timeout_ms":120000} → apply_patch {} → shell {"command":"node <<'NODE'\nconst fs=require('fs'),cp=require('child_process'),assert=require('assert');function parse(path){const t=fs.readFileSync(path,'utf8');assert(!/\\n\\s*\\n/.test(t));const...","timeout_ms":120000}
- **dna-insert**: 1 tool failure(s)
  - Trace: 9 requests, 9 tools (shell 4, apply_patch 1, load_tool 1, read 1, web_fetch 1, web_search 1)
  - Tool failures: web_fetch/runtime/failure
  - Last calls: shell {"command":"node <<'NODE'\nconst fs=require('fs'),{execFileSync}=require('child_process');\nconst [s,t]=fs.readFileSync('sequences.fasta','utf8').trim().split(/(?=^>)/m).map(x=>x.split(/\\r?\\n/)....","timeout_ms":120000} → apply_patch {} → shell {"command":"node <<'NODE'\nconst fs=require('fs'),assert=require('assert/strict'),{execFileSync}=require('child_process');\nconst parse=p=>fs.readFileSync(p,'utf8').trim().split(/(?=^>)/m).map(x...","timeout_ms":10000}
- **mcmc-sampling-stan**: 1 tool failure(s)
  - Trace: 15 requests, 17 tools (shell 8, task 3, apply_patch 2, load_tool 1, read 1, web_fetch 1, web_search 1)
  - Tool failures: web_fetch/upstream/http
  - Last calls: apply_patch {} → shell {"command":"Rscript /app/analysis.R","timeout_ms":1800000} → task {"action":"wait","task_id":"job_1792043197806_3f9dcd"}
- **protein-assembly**: 1 tool failure(s)
  - Trace: 25 requests, 18 tools (web_fetch 6, shell 5, web_search 4, apply_patch 1, load_tool 1, read 1)
  - Tool failures: web_fetch/runtime/failure
  - Last calls: apply_patch {} → shell {"command":"python - <<'PY'\nimport urllib.request,json,re,itertools,concurrent.futures\nurls={p:'https://www.ebi.ac.uk/pdbe/api/pdb/entry/molecules/'+p for p in ['5wj2','2h5q','3kzy']}\nurls.upd...","timeout_ms":90000} → shell {"command":"python - <<'PY'\nimport re,itertools\n# Reference sequences from the previously retrieved PDBe and FPbase API responses.\nclover='MVSKGEELFTGVVPILVELDGDVNGHKFSVRGEGEGDATNGKLTLKFICTTGK...","timeout_ms":10000}
- **vulnerable-secret**: NonZeroAgentExitCodeError — Command failed (exit 1): set -u; if ! timeout --version 2>&1 | grep -q 'GNU coreutils'; then echo 'mixdog lead: GNU coreutils timeout is required' >&2; exit 125; fi; status=0; timeout --signal=TERM --kill-after=30s 10770s bash -o pipefail -c 'mkdir -p /logs/agent; export NODE_COMPILE_CACHE=/opt/mixdog-v8-cache; MIXDOG_ENTRY="$(readlink -f "$(command -v mixdog)")"; MIXDOG_PACKAGE="$(dirname "$(dirname "$MIXDOG_ENTRY")")"; export MIXDOG_GRAPH_BIN="$MIXDOG_PACKAGE/src/.bench-graph"; export MIXDOG_SEARCH_SERVER_BIN="$MIXDOG_GRAPH_BIN"; test -x "$MIXDOG_GRAPH_BIN" || exit 1; mixdog exec --json --web-search --provider openai-oauth --model gpt-6.1-sol --effort xhigh -- '"'"'Analyze the following program that contains a secret key. The goal is to extract this secret key and save it to `/app/results.txt`. The program is available as an executable. You may need to interact with it in various ways to discover how to access the secret information. The secret key is in the format `FLAG{...}` The task is complete when you have successfully extracted the secret key and written it to `/app/results.txt`. '"'"' 2> >(tee /logs/agent/mixdog.stderr >&2) | tee /logs/agent/mixdog.txt' || status=$?; if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then echo 'mixdog lead: whole-process deadline exceeded after 10770s; process group terminated before OAuth lease expiry' >&2; exit 124; fi; exit "$status" stdout: {"schema_version":1,"timestamp":"2026-10-15T05:51:11.958Z","type":"thread.started","thread_id":"exec_0a60424835974f628c37586b6139d2d0","session":{"provider":"openai-oauth","model":"gpt-6.1-sol","effort":"xhigh","fast":false,"cwd":"/app","tool_mode":"full","approval_mode":"implicit","delegation":false,"web_search":true}} {"schema_version":1,"timestamp":"2026-10-15T05:51:11.958Z","type":"turn.started","thread_id":"exec_0a60424835974f628c37586b6139d2d0","turn_id":"turn_1"} (node:319) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) [atomic-file] sync lock held 9745ms: /tmp/mixdog-headless-pristine-LzW03s/data/mixdog-config.json.lock [atomic-file] sync lock held 5690ms: /tmp/mixdog-headless-pristine-LzW03s/data/update-check-cache.json.lock [atomic-file] async lock held 6074ms: queueWaitMs=0ms osAcquireMs=2ms /tmp/mixdog-headless-pristine-LzW03s/data/agent-workers.json.lock [atomic-fil ... [truncated] stderr: None
  - Trace: 0 requests, 0 tools
- **winning-avg-corewars**: 1 tool failure(s)
  - Trace: 29 requests, 30 tools (shell 14, apply_patch 13, glob 1, list 1, read 1)
  - Tool failures: shell/timeout/abort
  - Last calls: shell {"command":"for opponent in stone vampire paper snake g2-clear; do pmars -b -r 100 -f my_warrior.red warriors/$opponent.red; done","timeout_ms":200000} → apply_patch {} → shell {"command":"for opponent in stone vampire paper snake g2-clear; do pmars -b -r 100 -f my_warrior.red warriors/$opponent.red; done","timeout_ms":200000}

| Task | Pass | Agent seconds |
|---|---:|---:|
| adaptive-rejection-sampler | yes | 154.1 |
| bn-fit-modify | yes | 129.7 |
| break-filter-js-from-html | yes | 100.6 |
| build-cython-ext | yes | 243.6 |
| build-pmars | yes | 142.5 |
| build-pov-ray | no | 128.6 |
| caffe-cifar-10 | no | 3600.3 |
| cancel-async-tasks | yes | 70.3 |
| chess-best-move | yes | 127.0 |
| circuit-fibsqrt | yes | 126.6 |
| cobol-modernization | yes | 122.8 |
| code-from-image | yes | 97.2 |
| compile-compcert | yes | 856.0 |
| configure-git-webserver | no | 136.1 |
| constraints-scheduling | yes | 89.7 |
| count-dataset-tokens | yes | 155.0 |
| crack-7z-hash | yes | 189.1 |
| custom-memory-heap-crash | yes | 212.8 |
| db-wal-recovery | yes | 72.1 |
| distribution-search | yes | 65.7 |
| dna-assembly | no | 336.0 |
| dna-insert | no | 134.7 |
| extract-elf | no | 87.1 |
| extract-moves-from-video | yes | 445.2 |
| feal-differential-cryptanalysis | yes | 110.7 |
| feal-linear-cryptanalysis | yes | 190.9 |
| filter-js-from-html | no | 161.6 |
| financial-document-processor | yes | 101.7 |
| fix-code-vulnerability | yes | 72.1 |
| fix-git | yes | 89.7 |
| fix-ocaml-gc | yes | 389.5 |
| gcode-to-text | yes | 106.7 |
| git-leak-recovery | yes | 104.1 |
| git-multibranch | yes | 207.6 |
| gpt2-codegolf | yes | 151.3 |
| headless-terminal | yes | 132.7 |
| hf-model-inference | yes | 116.9 |
| install-windows-3.11 | yes | 182.6 |
| kv-store-grpc | yes | 125.6 |
| large-scale-text-editing | yes | 102.3 |
| largest-eigenval | yes | 88.3 |
| llm-inference-batching-scheduler | yes | 92.7 |
| log-summary-date-ranges | yes | 59.8 |
| mailman | yes | 295.4 |
| make-doom-for-mips | yes | 446.4 |
| make-mips-interpreter | yes | 215.3 |
| mcmc-sampling-stan | yes | 492.2 |
| merge-diff-arc-agi-task | yes | 108.0 |
| model-extraction-relu-logits | yes | 152.4 |
| modernize-scientific-stack | yes | 64.7 |
| mteb-leaderboard | yes | 216.9 |
| mteb-retrieve | no | 106.8 |
| multi-source-data-merger | yes | 114.4 |
| nginx-request-logging | yes | 74.0 |
| openssl-selfsigned-cert | yes | 87.7 |
| overfull-hbox | yes | 300.3 |
| password-recovery | yes | 86.2 |
| path-tracing | yes | 199.6 |
| path-tracing-reverse | yes | 118.6 |
| polyglot-c-py | yes | 97.9 |
| polyglot-rust-c | yes | 107.9 |
| portfolio-optimization | yes | 141.5 |
| protein-assembly | yes | 650.3 |
| prove-plus-comm | yes | 64.7 |
| pypi-server | yes | 114.4 |
| pytorch-model-cli | yes | 118.1 |
| pytorch-model-recovery | yes | 96.6 |
| qemu-alpine-ssh | no | 241.4 |
| qemu-startup | yes | 199.3 |
| query-optimize | yes | 132.7 |
| raman-fitting | yes | 105.0 |
| regex-chess | yes | 169.3 |
| regex-log | yes | 63.0 |
| reshard-c4-data | yes | 237.0 |
| rstan-to-pystan | yes | 442.3 |
| sam-cell-seg | yes | 196.8 |
| sanitize-git-repo | yes | 172.0 |
| schemelike-metacircular-eval | no | 284.9 |
| sparql-university | yes | 63.5 |
| sqlite-db-truncate | yes | 86.9 |
| sqlite-with-gcov | yes | 149.1 |
| torch-pipeline-parallelism | no | 85.0 |
| torch-tensor-parallelism | yes | 143.5 |
| train-fasttext | yes | 793.8 |
| tune-mjcf | yes | 137.6 |
| video-processing | yes | 163.2 |
| vulnerable-secret | no | 72.0 |
| winning-avg-corewars | yes | 199.8 |
| write-compressor | yes | 137.8 |
