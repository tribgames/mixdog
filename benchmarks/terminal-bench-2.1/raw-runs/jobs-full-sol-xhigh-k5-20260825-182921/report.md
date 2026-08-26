# Terminal-Bench preset report: full-sol-xhigh-k5

- Score: **385/445** (445 completed)
- Clean: **false** (errors 9, retries 0)
- Agent total: **150883.8s** — rank n/a
- Wall: **23826.4s** — rank n/a
- Tokens: input 152411357, cached 133353728, output 4076627
- Cost: $285.04 (445 trials)
- Final context median: 18509 tokens (445 trials)
- Reduction: 136455603 bytes saved, 78 artifact reads
- Contract: rules 85ef48f37438 (18 files), tools 0cc3680e6c9e (13 catalog, 11 active, 11 provider, 1 route)

## Pair: Codex CLI · GPT-5.6 Sol xhigh

- Shared tasks: **445**
- Score: **385/445 vs 375/445**
- Outcomes: ours-only 41, baseline-only 31, both-pass 344, both-fail 29
- Agent speedup: **1.11x**
- Cost ratio (ours/baseline, 445/445 cost-comparable tasks): **0.58x**
- Input-token ratio (ours/baseline): **0.34x**
- Final-context reduction: **44.7%**

## Diagnostics

- **build-pmars**: 1 tool failure(s)
  - Trace: 15 requests, 29 tools (shell 12, read 7, grep 4, glob 2, apply_patch 1, code_graph 1, list 1, task 1)
  - Tool failures: code_graph/runtime/failure
  - Last calls: shell {"command":"ldd /usr/local/bin/pmars && readelf -d /usr/local/bin/pmars | grep NEEDED","timeout_ms":10000} → shell {"command":"printf 'list 0\\nstep\\ncontinue\\n' | /usr/local/bin/pmars -e -b -r 1 -F 4000 /app/flashpaper.red /app/rave.red","timeout_ms":10000} → shell {"command":"dpkg-source --before-build /app/pmars-0.9.4 && sha256sum /app/pmars_0.9.4-1.dsc /app/pmars_0.9.4.orig.tar.xz /app/pmars_0.9.4-1.debian.tar.xz","timeout_ms":10000}
- **configure-git-webserver**: 1 tool failure(s)
  - Trace: 28 requests, 27 tools (git 11, shell 9, apply_patch 5, list 1, task 1)
  - Tool failures: git/runtime/failure
  - Last calls: apply_patch {} → shell {"command":"rmdir /etc/ssh/git-deploy-test-keys && sshd -t && service ssh restart","timeout_ms":10000} → shell {"command":"status=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/deploy-check.txt) && printf 'cleanup status: %s\\n' \"$status\" && test \"$status\" = 404","timeout_ms":10000}
- **extract-moves-from-video**: AgentTimeoutError — Agent execution timed out after 1800.0 seconds
  - Trace: 13 requests, 15 tools (shell 10, task 3, glob 1, read 1)
  - Last calls: shell {"command":"mkdir -p [redacted] /app/.video_work/ocr && ffmpeg -hide_banner -loglevel error -i /app/video.mp4 -vf \"fps=4\" /app/.video_work/frames/%04d.png && find /app/.video_work/frames -type...","timeout_ms":0} → task {"action":"wait","task_id":"job_1787704581654_3bd549"} → task {"action":"wait","task_id":"job_1787704581654_3bd549"}
- **extract-moves-from-video**: AgentTimeoutError — Agent execution timed out after 1800.0 seconds
  - Trace: 13 requests, 16 tools (shell 8, read 3, task 3, glob 1, list 1)
  - Last calls: shell {"command":"mkdir -p [redacted] /tmp/zork_ocr && ffmpeg -hide_banner -loglevel error -i /app/video.mp4 -vf \"fps=4,format=gray,scale=1920:1080:flags=lanczos\" -compression_level 3 /tmp/zork_fram...","timeout_ms":0} → task {"action":"wait","task_id":"job_1787690475230_467038"} → task {"action":"wait","task_id":"job_1787690475230_467038"}
- **extract-moves-from-video**: AgentTimeoutError — Agent execution timed out after 1800.0 seconds
  - Trace: 37 requests, 43 tools (shell 26, task 7, glob 5, read 5)
  - Tool failures: glob/runtime/failure
  - Last calls: shell {"command":"ps -p [redacted] -o pid=,etime=,cmd=","timeout_ms":10000} → shell {"command":"while kill -0 7788 2>/dev/null; do sleep 2; done; dpkg --configure -a && apt-get install -y gocr && ffmpeg -v error -i /tmp/zork_review/frame_025.png -vf format=gray /tmp/zork_revi...","timeout_ms":600000} → task {"action":"read","task_id":"job_1787696159844_05bf48"}
- **extract-moves-from-video**: AgentTimeoutError — Agent execution timed out after 1800.0 seconds
  - Trace: 16 requests, 15 tools (shell 9, task 3, read 2, list 1)
  - Last calls: shell {"command":"mkdir -p [redacted] && ffmpeg -v error -ss 9 -i /app/video.mp4 -vf \"fps=5\" /tmp/zork-ocr/frame_%04d.png && printf '%s\\0' /tmp/zork-ocr/*.png | xargs -0 -n1 -P8 bash -c 'tesseract \"...","timeout_ms":0} → task {"action":"wait","task_id":"job_1787699936474_5d1ac3"} → task {"action":"wait","task_id":"job_1787699936474_5d1ac3"}
- **extract-moves-from-video**: AgentTimeoutError — Agent execution timed out after 1800.0 seconds
  - Trace: 13 requests, 16 tools (shell 7, find 4, task 3, list 1, read 1)
  - Last calls: shell {"command":"mkdir -p [redacted] /tmp/zorkocr4 && ffmpeg -i /app/video.mp4 -vf \"fps=4,crop=1088:660:96:36,scale=2176:1320:flags=neighbor,format=gray\" -compression_level 1 /tmp/zorkframes4/frame...","timeout_ms":0} → task {"action":"wait","task_id":"job_1787685999643_8c9bec"} → task {"action":"wait","task_id":"job_1787685999643_8c9bec"}
- **fix-ocaml-gc**: 2 tool failure(s)
  - Trace: 21 requests, 28 tools (grep 6, shell 6, task 6, read 3, code_graph 2, git 2, apply_patch 1, cwd 1, load_tool 1)
  - Tool failures: code_graph/runtime/failure, code_graph/runtime/failure
  - Last calls: task {"action":"wait","task_id":"job_1787688952905_6f0e72"} → shell {"command":"make -C testsuite one DIR=tests/basic","timeout_ms":0} → task {"action":"wait","task_id":"job_1787689244235_c44e08"}
- **git-multibranch**: 1 tool failure(s)
  - Trace: 37 requests, 43 tools (git 15, shell 13, apply_patch 6, list 4, glob 2, read 2, grep 1)
  - Tool failures: git/path/permission
  - Last calls: git {"command":"git --git-dir=/git/project --work-tree=/app -c safe.directory=/git/project symbolic-ref HEAD refs/heads/main","output_limit":50} → apply_patch {} → shell {"command":"rm -rf /app/verification-client","timeout_ms":10000}
- **install-windows-3.11**: 1 tool failure(s)
  - Trace: 53 requests, 56 tools (shell 29, read 14, task 8, apply_patch 2, find 1, grep 1, list 1)
  - Tool failures: shell/tool-call/failure
  - Last calls: grep {"pattern":["listen 80","proxy_pass","server_name"],"path":"/etc/nginx","glob":"*.conf","output_mode":"content_with_context","head_limit":40,"offset":0} → apply_patch {} → shell {"command":"set -e\nnginx -t\nnginx -s reload\nsleep 1\nprintf '%s\\n' '--- noVNC HTTP ---'\ncurl -sS -o /dev/null -w 'HTTP %{http_code}, %{content_type}\\n' http://127.0.0.1/vnc_auto.html\nprintf '%s...","timeout_ms":0}
- **install-windows-3.11**: 1 tool failure(s)
  - Trace: 60 requests, 60 tools (shell 34, read 13, task 11, apply_patch 1, list 1)
  - Tool failures: shell/tool-call/failure
  - Last calls: shell {"command":"python3 - <<'PY'\nimport socket,time\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(.5); s.connect('/tmp/qemu-monitor.sock'); time.sleep(.1)\ntry:s.recv(65536)\nexce...","timeout_ms":15000} → read {"path":"/tmp/win311-desktop-final.png","offset":0,"limit":20} → shell {"command":"set -e\npython3 - <<'PY'\nimport socket,time,re\nsock='/tmp/qemu-monitor.sock'\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(.5); s.connect(sock); time.sleep(.1)\nba...","timeout_ms":10000}
- **install-windows-3.11**: 1 tool failure(s)
  - Trace: 47 requests, 52 tools (shell 25, read 13, task 8, find 3, apply_patch 2, list 1)
  - Tool failures: shell/tool-call/failure
  - Last calls: read {"path":"/etc/nginx/nginx.conf","offset":0,"limit":240} → apply_patch {} → shell {"command":"nginx -t && nginx -s reload && sleep 1\ncurl -fsS -o /dev/null -w 'noVNC HTTP %{http_code} content-type=%{content_type}\\n' http://127.0.0.1/\npython3 - <<'PY'\nimport socket\nrequest=(...","timeout_ms":10000}
- **large-scale-text-editing**: 1 tool failure(s)
  - Trace: 10 requests, 11 tools (shell 4, read 3, apply_patch 2, task 2)
  - Tool failures: shell/command-exit
  - Last calls: shell {"command":"vim -Nu NONE -n -Es /app/input.csv -S /app/apply_macros.vim","timeout_ms":0} → task {"action":"wait","task_id":"job_1787704559675_cf64f4"} → shell {"command":"cmp -s /app/input.csv /app/expected.csv","timeout_ms":0}
- **largest-eigenval**: 1 tool failure(s)
  - Trace: 10 requests, 12 tools (shell 6, read 3, apply_patch 1, code_graph 1, grep 1)
  - Tool failures: code_graph/runtime/failure
  - Last calls: apply_patch {} → shell {"command":"python eval.py","timeout_ms":120000} → shell {"command":"python -c $'import numpy as np\\nfrom eigen import find_dominant_eigenvalue_and_eigenvector as f\\nrng=np.random.default_rng(12345)\\ncount=0\\nfor n in range(1,11):\\n for _ in range(1...","timeout_ms":120000}
- **make-doom-for-mips**: AgentTimeoutError — Agent execution timed out after 900.0 seconds
  - Trace: 50 requests, 75 tools (grep 25, shell 17, read 12, code_graph 8, apply_patch 4, glob 4, list 3, find 1, task 1)
  - Last calls: shell {"command":"node -e 'const fs=require(\"fs\");let s=fs.readFileSync(\"vm.js\",\"utf8\");s=s.replace(\"          const oldPc = this.pc;\",\"          const oldPc = this.pc;\\n          if (oldPc === 0x42...","timeout_ms":180000} → apply_patch {} → shell {"command":"node vm.js","timeout_ms":180000}
- **make-doom-for-mips**: AgentTimeoutError — Agent execution timed out after 900.0 seconds
  - Trace: 45 requests, 84 tools (read 27, shell 25, grep 12, apply_patch 10, list 4, glob 2, code_graph 1, find 1, git 1, task 1)
  - Tool failures: apply_patch/patch/stale-context
  - Last calls: apply_patch {} → apply_patch {} → shell {"command":"node vm.js","timeout_ms":0}
- **make-doom-for-mips**: AgentTimeoutError — Agent execution timed out after 900.0 seconds
  - Trace: 36 requests, 60 tools (shell 16, read 11, grep 10, apply_patch 8, code_graph 4, glob 4, list 3, git 2, find 1, task 1)
  - Tool failures: apply_patch/patch/stale-context
  - Last calls: read {"path":"/tmp/frame.bmp","offset":0,"limit":25} → git {"command":"git -C doomgeneric status --short","output_limit":100} → shell {"command":"python3 - <<'PY'\nimport os, struct\np='/tmp/frame.bmp'\nwith open(p,'rb') as f:\n    h=f.read(54)\nmagic=h[:2]\nsize=struct.unpack_from('<I',h,2)[0]\noffset=struct.unpack_from('<I',h,10)...","timeout_ms":10000}
- **mteb-leaderboard**: 1 tool failure(s)
  - Trace: 50 requests, 60 tools (shell 35, read 11, code_graph 7, task 3, grep 2, apply_patch 1, git 1)
  - Tool failures: git/timeout/abort
  - Last calls: shell {"command":"python - <<'PY'\nimport io, requests, tarfile\nurl='https://codeload.github.com/embeddings-benchmark/mteb/tar.gz/9586697f82b6c80a8abd6eea8607495810df3e9e'\nr=requests.get(url,timeout=...","timeout_ms":120000} → shell {"command":"PYTHONPATH=/tmp/mteb-exact-aug2025 python - <<'PY'\nimport json, os, statistics\nfrom pathlib import Path\nfrom collections import defaultdict\nimport mteb\nfrom mteb.load_results impor...","timeout_ms":120000} → apply_patch {}
- **password-recovery**: 1 tool failure(s)
  - Trace: 18 requests, 19 tools (shell 12, grep 2, list 2, apply_patch 1, glob 1, read 1)
  - Tool failures: shell/tool-call/failure
  - Last calls: shell {"command":"od -Ax -tx1z -j 1048576 -N 256 /app/varsea/disks/sub1/subA/subAlpha/ae3f4c.dat","timeout_ms":10000} → shell {"command":"node -e 'const s=\"PASSWORD=[redacted] t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);t[n]=c>>>0}let c=0xffffffff;for(const b of Buffer...","timeout_ms":10000} → apply_patch {}
- **path-tracing-reverse**: 1 tool failure(s)
  - Trace: 31 requests, 48 tools (shell 31, read 8, apply_patch 7, grep 1, list 1)
  - Tool failures: read/cache-hit
  - Last calls: shell {"command":"gcc -static -o /tmp/reversed /app/mystery.c -lm && cd /tmp/mystery-rev && /tmp/reversed >stdout 2>stderr && sha256sum image.ppm stdout stderr && cmp -s image.ppm /app/image.ppm; pr...","timeout_ms":0} → apply_patch {} → shell {"command":"rm -f /app/image.ppm","timeout_ms":5000}
- **qemu-startup**: 1 tool failure(s)
  - Trace: 28 requests, 27 tools (shell 18, task 4, read 2, apply_patch 1, grep 1, list 1)
  - Tool failures: grep/schema/args
  - Last calls: shell {"command":"python3 -c 'import socket,time,sys\nend=time.time()+240\ns=None\nwhile time.time()<end:\n try:\n  s=socket.create_connection((\"127.0.0.1\",6665),2); break\n except OSError:\n  time.sleep(....","timeout_ms":300000} → task {"action":"wait","task_id":"job_1787685151569_48ea78"} → shell {"command":"python3 -c 'import socket,sys\ns=socket.create_connection((\"127.0.0.1\",6665),2); s.settimeout(8); b=b\"\"\ntry:\n while b\"login:\" not in b.lower():\n  d=s.recv(4096)\n  if not d: break\n  ...","timeout_ms":10000}
- **sanitize-git-repo**: AgentTimeoutError — Agent execution timed out after 900.0 seconds
  - Trace: 23 requests, 43 tools (shell 15, git 13, grep 10, read 2, task 2, apply_patch 1)
  - Tool failures: git/timeout/abort
  - Last calls: git {"command":"git stash push -m mixdog-secret-sanitization","output_limit":100} → git {"command":"git filter-branch --force --tree-filter 'python3 /tmp/dclm-sanitize-history.py' --tag-name-filter cat -- --all","output_limit":200} → shell {"command":"rm -rf -- /app/dclm/.git-rewrite && python3 - <<'PY'\nfrom pathlib import Path\nscript = r'''#!/usr/bin/env python3\nimport binascii\nimport io\nimport json\nimport os\nimport re\nimport s...","timeout_ms":0}
- **sanitize-git-repo**: 1 tool failure(s)
  - Trace: 12 requests, 23 tools (grep 8, shell 8, apply_patch 2, git 2, glob 2, read 1)
  - Tool failures: apply_patch/patch/stale-context
  - Last calls: git {"command":"git log --all --oneline -G'(AKIA1234567890123456|D4w8z9wKN1aVeT3BpQj6kIuN7wH8X0M9KfV5OqzF|ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789|hf_abcdefghijklmnopqrstuvwxyz123456|hf_oCfFIJsVdY...","output_limit":50} → shell {"command":"python -m py_compile ray_processing/process.py && python - <<'PY'\nimport json\nfrom pathlib import Path\npath = Path('exp_data/datasets/tokenized/rw_v2_fasttext_openhermes_vs_rw_v2_b...","timeout_ms":0} → git {"command":"git diff -- ray_processing/process.py ray_processing/ray_cluster.yaml exp_data/datasets/tokenized/rw_v2_fasttext_openhermes_vs_rw_v2_bigram_0.1_arcade100k.json","output_limit":200}
- **sqlite-with-gcov**: 1 tool failure(s)
  - Trace: 10 requests, 14 tools (shell 9, task 2, glob 1, list 1, read 1)
  - Tool failures: shell/timeout/abort
  - Last calls: task {"action":"wait","task_id":"job_1787704753164_4773d1"} → shell {"command":"ln -s /app/sqlite/sqlite3 /usr/local/bin/sqlite3 && printf 'resolved=%s\\n' \"$(command -v sqlite3)\" && sqlite3 ':memory:' 'SELECT sqlite_version(), 40+2;'","timeout_ms":10000} → glob {"pattern":["*.gcno","*.gcda"],"path":"/app/sqlite","head_limit":100,"offset":0,"sort":"natural"}

| Task | Pass | Agent seconds |
|---|---:|---:|
| adaptive-rejection-sampler | yes | 520.8 |
| adaptive-rejection-sampler | yes | 429.6 |
| adaptive-rejection-sampler | yes | 666.1 |
| adaptive-rejection-sampler | yes | 617.6 |
| adaptive-rejection-sampler | yes | 427.6 |
| bn-fit-modify | yes | 113.8 |
| bn-fit-modify | yes | 111.8 |
| bn-fit-modify | yes | 102.4 |
| bn-fit-modify | yes | 156.9 |
| bn-fit-modify | yes | 154.7 |
| break-filter-js-from-html | yes | 166.4 |
| break-filter-js-from-html | yes | 263.7 |
| break-filter-js-from-html | yes | 292.1 |
| break-filter-js-from-html | yes | 153.2 |
| break-filter-js-from-html | yes | 172.5 |
| build-cython-ext | yes | 329.4 |
| build-cython-ext | yes | 353.6 |
| build-cython-ext | yes | 367.3 |
| build-cython-ext | no | 275.7 |
| build-cython-ext | yes | 352.9 |
| build-pmars | yes | 208.9 |
| build-pmars | yes | 174.7 |
| build-pmars | yes | 239.6 |
| build-pmars | yes | 129.7 |
| build-pmars | yes | 176.1 |
| build-pov-ray | yes | 254.0 |
| build-pov-ray | yes | 299.6 |
| build-pov-ray | yes | 461.0 |
| build-pov-ray | no | 353.0 |
| build-pov-ray | no | 542.3 |
| caffe-cifar-10 | no | 533.2 |
| caffe-cifar-10 | yes | 2192.4 |
| caffe-cifar-10 | yes | 1438.8 |
| caffe-cifar-10 | yes | 1514.1 |
| caffe-cifar-10 | yes | 853.9 |
| cancel-async-tasks | yes | 72.0 |
| cancel-async-tasks | yes | 52.4 |
| cancel-async-tasks | yes | 62.5 |
| cancel-async-tasks | yes | 37.5 |
| cancel-async-tasks | yes | 75.6 |
| chess-best-move | yes | 194.8 |
| chess-best-move | yes | 242.0 |
| chess-best-move | yes | 189.3 |
| chess-best-move | yes | 236.5 |
| chess-best-move | yes | 252.2 |
| circuit-fibsqrt | yes | 291.7 |
| circuit-fibsqrt | yes | 489.3 |
| circuit-fibsqrt | yes | 239.6 |
| circuit-fibsqrt | yes | 324.9 |
| circuit-fibsqrt | yes | 222.2 |
| cobol-modernization | yes | 220.9 |
| cobol-modernization | yes | 214.7 |
| cobol-modernization | yes | 267.3 |
| cobol-modernization | yes | 228.5 |
| cobol-modernization | yes | 300.3 |
| code-from-image | yes | 29.5 |
| code-from-image | yes | 24.1 |
| code-from-image | yes | 24.7 |
| code-from-image | yes | 22.6 |
| code-from-image | yes | 20.3 |
| compile-compcert | yes | 809.9 |
| compile-compcert | yes | 1039.8 |
| compile-compcert | yes | 978.2 |
| compile-compcert | yes | 826.7 |
| compile-compcert | yes | 1181.0 |
| configure-git-webserver | yes | 290.8 |
| configure-git-webserver | yes | 341.7 |
| configure-git-webserver | no | 192.3 |
| configure-git-webserver | yes | 212.3 |
| configure-git-webserver | no | 216.0 |
| constraints-scheduling | yes | 146.1 |
| constraints-scheduling | yes | 115.8 |
| constraints-scheduling | yes | 70.7 |
| constraints-scheduling | yes | 86.0 |
| constraints-scheduling | yes | 72.5 |
| count-dataset-tokens | yes | 134.4 |
| count-dataset-tokens | yes | 107.3 |
| count-dataset-tokens | yes | 119.5 |
| count-dataset-tokens | yes | 106.6 |
| count-dataset-tokens | yes | 188.2 |
| crack-7z-hash | yes | 729.7 |
| crack-7z-hash | yes | 439.3 |
| crack-7z-hash | yes | 274.1 |
| crack-7z-hash | yes | 513.4 |
| crack-7z-hash | yes | 194.7 |
| custom-memory-heap-crash | yes | 137.7 |
| custom-memory-heap-crash | yes | 159.1 |
| custom-memory-heap-crash | yes | 137.8 |
| custom-memory-heap-crash | yes | 233.0 |
| custom-memory-heap-crash | yes | 128.8 |
| db-wal-recovery | yes | 90.1 |
| db-wal-recovery | yes | 94.3 |
| db-wal-recovery | yes | 91.5 |
| db-wal-recovery | yes | 112.0 |
| db-wal-recovery | yes | 77.0 |
| distribution-search | yes | 85.3 |
| distribution-search | yes | 109.7 |
| distribution-search | yes | 87.2 |
| distribution-search | yes | 106.6 |
| distribution-search | yes | 63.9 |
| dna-assembly | yes | 386.2 |
| dna-assembly | no | 302.8 |
| dna-assembly | yes | 502.9 |
| dna-assembly | no | 427.7 |
| dna-assembly | yes | 321.6 |
| dna-insert | no | 164.2 |
| dna-insert | no | 167.3 |
| dna-insert | no | 178.0 |
| dna-insert | no | 281.9 |
| dna-insert | no | 163.8 |
| extract-elf | yes | 231.2 |
| extract-elf | yes | 154.1 |
| extract-elf | yes | 217.5 |
| extract-elf | no | 295.8 |
| extract-elf | no | 174.8 |
| extract-moves-from-video | no | 1802.3 |
| extract-moves-from-video | no | 1801.2 |
| extract-moves-from-video | no | 1801.2 |
| extract-moves-from-video | no | 1801.5 |
| extract-moves-from-video | no | 1801.8 |
| feal-differential-cryptanalysis | yes | 148.9 |
| feal-differential-cryptanalysis | yes | 197.7 |
| feal-differential-cryptanalysis | yes | 141.6 |
| feal-differential-cryptanalysis | yes | 117.5 |
| feal-differential-cryptanalysis | yes | 152.2 |
| feal-linear-cryptanalysis | yes | 743.6 |
| feal-linear-cryptanalysis | yes | 159.1 |
| feal-linear-cryptanalysis | yes | 198.5 |
| feal-linear-cryptanalysis | yes | 215.0 |
| feal-linear-cryptanalysis | yes | 1473.7 |
| filter-js-from-html | no | 505.3 |
| filter-js-from-html | no | 605.7 |
| filter-js-from-html | no | 664.6 |
| filter-js-from-html | no | 710.8 |
| filter-js-from-html | no | 1000.3 |
| financial-document-processor | yes | 119.3 |
| financial-document-processor | yes | 132.4 |
| financial-document-processor | yes | 127.6 |
| financial-document-processor | yes | 173.3 |
| financial-document-processor | yes | 157.3 |
| fix-code-vulnerability | yes | 59.2 |
| fix-code-vulnerability | yes | 39.6 |
| fix-code-vulnerability | yes | 46.8 |
| fix-code-vulnerability | yes | 49.6 |
| fix-code-vulnerability | yes | 43.5 |
| fix-git | yes | 77.3 |
| fix-git | yes | 82.9 |
| fix-git | yes | 76.9 |
| fix-git | yes | 78.1 |
| fix-git | yes | 58.6 |
| fix-ocaml-gc | yes | 415.4 |
| fix-ocaml-gc | yes | 481.5 |
| fix-ocaml-gc | yes | 406.0 |
| fix-ocaml-gc | yes | 375.8 |
| fix-ocaml-gc | yes | 403.2 |
| gcode-to-text | yes | 163.7 |
| gcode-to-text | yes | 207.8 |
| gcode-to-text | yes | 126.7 |
| gcode-to-text | yes | 312.1 |
| gcode-to-text | yes | 230.4 |
| git-leak-recovery | yes | 158.0 |
| git-leak-recovery | yes | 107.6 |
| git-leak-recovery | yes | 163.0 |
| git-leak-recovery | yes | 102.3 |
| git-leak-recovery | yes | 121.0 |
| git-multibranch | yes | 303.1 |
| git-multibranch | yes | 261.9 |
| git-multibranch | yes | 398.7 |
| git-multibranch | yes | 280.2 |
| git-multibranch | yes | 354.0 |
| gpt2-codegolf | yes | 481.1 |
| gpt2-codegolf | yes | 451.7 |
| gpt2-codegolf | yes | 351.9 |
| gpt2-codegolf | yes | 458.8 |
| gpt2-codegolf | yes | 384.6 |
| headless-terminal | yes | 176.2 |
| headless-terminal | yes | 142.3 |
| headless-terminal | yes | 155.6 |
| headless-terminal | yes | 173.3 |
| headless-terminal | yes | 146.7 |
| hf-model-inference | yes | 152.1 |
| hf-model-inference | yes | 136.1 |
| hf-model-inference | yes | 112.3 |
| hf-model-inference | yes | 129.6 |
| hf-model-inference | yes | 159.6 |
| install-windows-3.11 | yes | 1299.0 |
| install-windows-3.11 | yes | 1189.1 |
| install-windows-3.11 | yes | 740.6 |
| install-windows-3.11 | yes | 806.0 |
| install-windows-3.11 | yes | 624.1 |
| kv-store-grpc | yes | 65.3 |
| kv-store-grpc | no | 73.1 |
| kv-store-grpc | no | 88.2 |
| kv-store-grpc | no | 89.2 |
| kv-store-grpc | yes | 70.1 |
| large-scale-text-editing | yes | 67.7 |
| large-scale-text-editing | yes | 89.3 |
| large-scale-text-editing | yes | 76.5 |
| large-scale-text-editing | yes | 433.1 |
| large-scale-text-editing | yes | 71.9 |
| largest-eigenval | yes | 96.4 |
| largest-eigenval | yes | 90.6 |
| largest-eigenval | yes | 88.0 |
| largest-eigenval | yes | 285.1 |
| largest-eigenval | yes | 176.4 |
| llm-inference-batching-scheduler | yes | 233.0 |
| llm-inference-batching-scheduler | yes | 222.9 |
| llm-inference-batching-scheduler | yes | 234.4 |
| llm-inference-batching-scheduler | yes | 181.2 |
| llm-inference-batching-scheduler | yes | 177.8 |
| log-summary-date-ranges | yes | 58.8 |
| log-summary-date-ranges | yes | 72.4 |
| log-summary-date-ranges | yes | 60.0 |
| log-summary-date-ranges | yes | 39.8 |
| log-summary-date-ranges | yes | 45.3 |
| mailman | yes | 287.2 |
| mailman | yes | 314.9 |
| mailman | yes | 282.3 |
| mailman | yes | 280.5 |
| mailman | yes | 384.6 |
| make-doom-for-mips | no | 637.5 |
| make-doom-for-mips | no | 900.4 |
| make-doom-for-mips | no | 900.3 |
| make-doom-for-mips | yes | 749.7 |
| make-doom-for-mips | no | 900.3 |
| make-mips-interpreter | yes | 549.4 |
| make-mips-interpreter | yes | 517.1 |
| make-mips-interpreter | yes | 567.1 |
| make-mips-interpreter | yes | 493.2 |
| make-mips-interpreter | no | 531.9 |
| mcmc-sampling-stan | yes | 429.9 |
| mcmc-sampling-stan | yes | 717.1 |
| mcmc-sampling-stan | yes | 454.4 |
| mcmc-sampling-stan | yes | 456.2 |
| mcmc-sampling-stan | yes | 645.1 |
| merge-diff-arc-agi-task | yes | 148.7 |
| merge-diff-arc-agi-task | yes | 136.4 |
| merge-diff-arc-agi-task | yes | 175.5 |
| merge-diff-arc-agi-task | yes | 161.2 |
| merge-diff-arc-agi-task | yes | 145.9 |
| model-extraction-relu-logits | no | 193.4 |
| model-extraction-relu-logits | yes | 284.2 |
| model-extraction-relu-logits | yes | 249.7 |
| model-extraction-relu-logits | no | 212.4 |
| model-extraction-relu-logits | yes | 253.7 |
| modernize-scientific-stack | yes | 54.6 |
| modernize-scientific-stack | yes | 52.6 |
| modernize-scientific-stack | yes | 38.0 |
| modernize-scientific-stack | yes | 30.0 |
| modernize-scientific-stack | yes | 36.9 |
| mteb-leaderboard | no | 747.5 |
| mteb-leaderboard | no | 332.9 |
| mteb-leaderboard | yes | 462.5 |
| mteb-leaderboard | no | 400.7 |
| mteb-leaderboard | no | 732.4 |
| mteb-retrieve | yes | 206.3 |
| mteb-retrieve | yes | 147.0 |
| mteb-retrieve | yes | 114.2 |
| mteb-retrieve | yes | 131.7 |
| mteb-retrieve | yes | 138.2 |
| multi-source-data-merger | yes | 90.1 |
| multi-source-data-merger | yes | 77.3 |
| multi-source-data-merger | yes | 73.4 |
| multi-source-data-merger | yes | 95.8 |
| multi-source-data-merger | yes | 90.7 |
| nginx-request-logging | yes | 75.0 |
| nginx-request-logging | yes | 84.5 |
| nginx-request-logging | yes | 111.9 |
| nginx-request-logging | yes | 87.2 |
| nginx-request-logging | yes | 76.6 |
| openssl-selfsigned-cert | yes | 60.5 |
| openssl-selfsigned-cert | yes | 89.7 |
| openssl-selfsigned-cert | yes | 62.9 |
| openssl-selfsigned-cert | yes | 76.0 |
| openssl-selfsigned-cert | yes | 95.0 |
| overfull-hbox | yes | 183.5 |
| overfull-hbox | yes | 163.7 |
| overfull-hbox | no | 86.2 |
| overfull-hbox | yes | 422.6 |
| overfull-hbox | yes | 160.7 |
| password-recovery | yes | 206.5 |
| password-recovery | yes | 598.4 |
| password-recovery | yes | 160.4 |
| password-recovery | yes | 111.6 |
| password-recovery | yes | 220.8 |
| path-tracing | yes | 941.8 |
| path-tracing | yes | 578.0 |
| path-tracing | yes | 792.9 |
| path-tracing | yes | 562.4 |
| path-tracing | yes | 213.5 |
| path-tracing-reverse | yes | 230.5 |
| path-tracing-reverse | yes | 670.9 |
| path-tracing-reverse | yes | 339.2 |
| path-tracing-reverse | yes | 627.0 |
| path-tracing-reverse | yes | 329.6 |
| polyglot-c-py | yes | 183.9 |
| polyglot-c-py | yes | 151.2 |
| polyglot-c-py | yes | 130.5 |
| polyglot-c-py | yes | 236.3 |
| polyglot-c-py | yes | 180.2 |
| polyglot-rust-c | yes | 279.3 |
| polyglot-rust-c | yes | 110.0 |
| polyglot-rust-c | yes | 86.0 |
| polyglot-rust-c | yes | 260.2 |
| polyglot-rust-c | yes | 200.1 |
| portfolio-optimization | yes | 139.2 |
| portfolio-optimization | yes | 150.7 |
| portfolio-optimization | yes | 153.3 |
| portfolio-optimization | yes | 154.8 |
| portfolio-optimization | yes | 131.1 |
| protein-assembly | no | 370.7 |
| protein-assembly | yes | 373.7 |
| protein-assembly | no | 375.6 |
| protein-assembly | yes | 455.1 |
| protein-assembly | yes | 387.2 |
| prove-plus-comm | yes | 52.0 |
| prove-plus-comm | yes | 29.9 |
| prove-plus-comm | yes | 42.6 |
| prove-plus-comm | yes | 47.7 |
| prove-plus-comm | yes | 30.8 |
| pypi-server | yes | 87.3 |
| pypi-server | yes | 90.8 |
| pypi-server | yes | 72.4 |
| pypi-server | yes | 73.3 |
| pypi-server | yes | 94.1 |
| pytorch-model-cli | yes | 175.6 |
| pytorch-model-cli | no | 165.1 |
| pytorch-model-cli | yes | 311.7 |
| pytorch-model-cli | yes | 265.4 |
| pytorch-model-cli | yes | 157.5 |
| pytorch-model-recovery | no | 258.0 |
| pytorch-model-recovery | no | 159.0 |
| pytorch-model-recovery | yes | 206.6 |
| pytorch-model-recovery | no | 269.6 |
| pytorch-model-recovery | no | 285.2 |
| qemu-alpine-ssh | yes | 224.5 |
| qemu-alpine-ssh | yes | 315.1 |
| qemu-alpine-ssh | yes | 131.8 |
| qemu-alpine-ssh | yes | 203.4 |
| qemu-alpine-ssh | yes | 497.5 |
| qemu-startup | yes | 153.7 |
| qemu-startup | yes | 540.5 |
| qemu-startup | yes | 255.2 |
| qemu-startup | yes | 554.1 |
| qemu-startup | yes | 459.4 |
| query-optimize | yes | 434.1 |
| query-optimize | yes | 390.9 |
| query-optimize | yes | 598.5 |
| query-optimize | yes | 500.7 |
| query-optimize | yes | 464.6 |
| raman-fitting | yes | 406.2 |
| raman-fitting | yes | 599.3 |
| raman-fitting | no | 175.7 |
| raman-fitting | yes | 385.6 |
| raman-fitting | yes | 265.5 |
| regex-chess | yes | 545.8 |
| regex-chess | yes | 579.2 |
| regex-chess | yes | 521.1 |
| regex-chess | yes | 468.0 |
| regex-chess | yes | 560.2 |
| regex-log | yes | 156.2 |
| regex-log | yes | 84.9 |
| regex-log | yes | 94.8 |
| regex-log | yes | 129.4 |
| regex-log | yes | 77.8 |
| reshard-c4-data | yes | 453.3 |
| reshard-c4-data | yes | 530.4 |
| reshard-c4-data | yes | 558.9 |
| reshard-c4-data | yes | 660.3 |
| reshard-c4-data | yes | 452.4 |
| rstan-to-pystan | yes | 409.5 |
| rstan-to-pystan | yes | 437.1 |
| rstan-to-pystan | yes | 417.5 |
| rstan-to-pystan | yes | 438.9 |
| rstan-to-pystan | yes | 431.6 |
| sam-cell-seg | yes | 502.4 |
| sam-cell-seg | yes | 539.5 |
| sam-cell-seg | no | 375.7 |
| sam-cell-seg | no | 524.2 |
| sam-cell-seg | yes | 574.8 |
| sanitize-git-repo | no | 415.4 |
| sanitize-git-repo | no | 728.7 |
| sanitize-git-repo | no | 900.3 |
| sanitize-git-repo | yes | 521.4 |
| sanitize-git-repo | no | 734.6 |
| schemelike-metacircular-eval | yes | 303.6 |
| schemelike-metacircular-eval | yes | 273.7 |
| schemelike-metacircular-eval | yes | 417.2 |
| schemelike-metacircular-eval | yes | 1558.3 |
| schemelike-metacircular-eval | yes | 466.3 |
| sparql-university | yes | 145.1 |
| sparql-university | yes | 115.8 |
| sparql-university | yes | 279.7 |
| sparql-university | yes | 136.2 |
| sparql-university | yes | 247.0 |
| sqlite-db-truncate | yes | 103.6 |
| sqlite-db-truncate | yes | 93.8 |
| sqlite-db-truncate | yes | 65.9 |
| sqlite-db-truncate | yes | 83.2 |
| sqlite-db-truncate | yes | 77.7 |
| sqlite-with-gcov | yes | 145.5 |
| sqlite-with-gcov | yes | 178.2 |
| sqlite-with-gcov | yes | 183.2 |
| sqlite-with-gcov | yes | 134.2 |
| sqlite-with-gcov | yes | 142.4 |
| torch-pipeline-parallelism | no | 351.4 |
| torch-pipeline-parallelism | yes | 294.8 |
| torch-pipeline-parallelism | yes | 291.2 |
| torch-pipeline-parallelism | yes | 255.5 |
| torch-pipeline-parallelism | no | 205.8 |
| torch-tensor-parallelism | yes | 138.6 |
| torch-tensor-parallelism | yes | 149.4 |
| torch-tensor-parallelism | yes | 150.1 |
| torch-tensor-parallelism | yes | 129.2 |
| torch-tensor-parallelism | no | 115.0 |
| train-fasttext | yes | 2927.7 |
| train-fasttext | yes | 3283.9 |
| train-fasttext | yes | 1685.7 |
| train-fasttext | yes | 2107.9 |
| train-fasttext | yes | 1213.0 |
| tune-mjcf | yes | 223.1 |
| tune-mjcf | yes | 335.6 |
| tune-mjcf | yes | 129.1 |
| tune-mjcf | yes | 184.2 |
| tune-mjcf | yes | 182.4 |
| video-processing | no | 369.7 |
| video-processing | yes | 643.2 |
| video-processing | no | 360.8 |
| video-processing | yes | 1175.3 |
| video-processing | no | 391.2 |
| vulnerable-secret | yes | 42.0 |
| vulnerable-secret | yes | 63.3 |
| vulnerable-secret | yes | 46.6 |
| vulnerable-secret | yes | 44.9 |
| vulnerable-secret | yes | 64.4 |
| winning-avg-corewars | yes | 565.8 |
| winning-avg-corewars | yes | 908.0 |
| winning-avg-corewars | yes | 1513.9 |
| winning-avg-corewars | yes | 424.9 |
| winning-avg-corewars | yes | 487.7 |
| write-compressor | yes | 229.2 |
| write-compressor | yes | 195.0 |
| write-compressor | yes | 223.0 |
| write-compressor | yes | 238.9 |
| write-compressor | yes | 195.2 |
