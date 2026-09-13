# 도구 설명·공통 편집 규칙 축약 — 2026-09-12

## 결론

규칙 축약에 이어 도구 설명의 중복을 줄였다. Sol에 전달하는 **provider tool payload는 14,390→11,904바이트(-17.28%)**, 조립 규칙 프롬프트와의 합은 **26,441→23,725바이트(-10.27%)**로 감소했다.

16개 도구 정의의 이름·인자·제한값·enum·annotation·문법은 그대로이며 설명만 달라졌음을 대조했다. 관련 테스트는 최초 44/45, 문구 기대값 수정 후 영향받은 27/27이 통과했다. 나머지 18개는 최초 통과 결과를 유지했다. FAST8 공식 검증도 **8/8**이다.

그러나 출력은 **25,926→28,832토큰(+11.21%)**, 경과 시간은 **160.557→197.054초(+22.73%)**로 늘었다. **설명 크기 축소는 확인했지만 실행 효율 개선이나 최소 수렴은 확인하지 못했다.** 실행 스냅샷에 별도 작업도 섞여 있어 이 차이를 설명 축약의 인과효과로 단정하지 않는다.

## 변경 범위와 유지한 계약

공통 규칙에는 행동 원칙을, 도구 설명에는 기능·인자·한도·실패 의미를 남겼다. 모델용 설명은 영문이다. 과제별 예외·힌트·휴리스틱은 추가하지 않았다.

- `src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs`
- `src/runtime/agent/orchestrator/tools/builtin/git-command-tool.mjs`
- `src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs`
- `src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs`
- `src/session-runtime/tool-defs.mjs`
- `src/rules/shared/40-editing.md`

도구의 API·문법·실행 로직은 이 작업에서 바꾸지 않았다. 정확한 수정 문맥, 원자적 새 파일 생성, 실패 상태 보존, 도구별 기능·제약은 유지했다. 편집 규칙과 도구 설명의 역할 변경에 맞춰 아래 두 테스트 파일의 문구 기대값도 갱신했다.

- `scripts/tool-contracts/tool-schema-contracts.test.mjs`
- `src/session-runtime/tool-policy-surface.test.mjs`

### 명세 크기와 검증

| 항목 | 직전 규칙 축약본 | 도구 설명 축약 후 |
|---|---:|---:|
| 조립 규칙 프롬프트 bytes | 12051 | 11821 |
| provider tool payload bytes | 14390 | 11904 |
| 두 payload 합 bytes | 26441 | 23725 |
| 활성 도구 수 | 11 | 11 |

위 규칙 크기는 `contract.promptSurfaceBytes` 기준이다. 이번 lead route의 개별 `promptSurfaceBytes`는 11816으로, 공통 조립 값과 구분한다.

설명을 제외한 16개 정의의 계약 SHA-256은 `8c74b37934756d023681ea1c1c439e46f035b8379c8623eef6483e461571c9a5`로 수정 전후 동일했다. description을 포함하는 전체 tool contract hash가 바뀐 것은 예상된 결과다.

```powershell
node --test scripts/tool-contracts/tool-schema-contracts.test.mjs scripts/tool-contracts/read-tool.test.mjs scripts/tool-contracts/search-tools.test.mjs scripts/tool-contracts/patch-edit.test.mjs src/session-runtime/tool-policy-surface.test.mjs
node --test scripts/tool-contracts/tool-schema-contracts.test.mjs src/session-runtime/tool-policy-surface.test.mjs
```

첫 실행은 44/45였다. `apply_patch`의 원자적 생성 문구가 freeform 설명 자체에 있어야 한다던 기대값을, 문법과 생성·배치 계약을 두 설명 면에서 나누어 확인하도록 수정했다. 그 뒤 영향받은 두 파일의 27/27이 통과했다. 최초 실패를 성공으로 처리하지 않았으며, 변경 파일의 `git diff --check`도 통과했다.

## FAST8 비교

- 기준: `jobs-sol-xhigh-fast-20260912-132437`
- 이번: `jobs-sol-xhigh-fast-20260912-141315`
- 동일 preset fingerprint: `e01b9c1979b9a0d450c3cc435afba7da6d7380d2f529d0f6b420ba1010cd5593`
- 모델: `openai-oauth/gpt-5.6-sol`, `xhigh`, Fast 유지, 동시 8개·반복 1회.
- 실행 명령: `Set-Location benchmarks/terminal-bench-2.1; .\run.ps1 -Preset sol-xhigh-fast`

| 항목 | 기준 | 이번 |
|---|---:|---:|
| 공식 검증 통과 | 8/8 | 8/8 |
| 입력 토큰 | 485187 | 496200 |
| 캐시 입력 토큰 | 401408 | 371712 |
| 출력 토큰 | 25926 | 28832 |
| 추론 토큰 | 14359 | 16409 |
| 모델 요청 | 51 | 50 |
| 도구 호출 | 68 | 64 |
| 도구 batch | 43 | 42 |
| 복수 도구 batch | 11 | 10 |
| 마지막 응답 추론 합 | 1072 | 1127 |
| 최종 컨텍스트 중앙값 | 11303 | 10156 |
| 경과 초 | 160.557 | 197.054 |
| agent 합계 초 | 525.387 | 607.015 |
| 환산 비용 USD | 1.0141992 | 1.2232768 |
| USD/agent분 | 0.1158 | 0.1209 |
| 도구 출력 절감 bytes | 30808 | 37615 |
| 인프라 오류 / 재시도 | 0 / 0 | 0 / 0 |

출력 토큰에는 추론이 포함된다. 요청·도구 호출·컨텍스트는 줄었지만 출력·시간·비용은 늘었다. 두 자동 보고서의 시간 순위는 각각 1/1로, 서로 다른 계약의 단일 표본 순위이므로 전체 역대 순위가 아니다.

### 과제별 결과

모든 과제가 공식 verifier를 통과했다.

| 과제 | 기준 출력 | 이번 출력 | 출력 차이 | 기준 초 | 이번 초 |
|---|---:|---:|---:|---:|---:|
| code-from-image | 980 | 1182 | +202 | 33.266 | 37.086 |
| db-wal-recovery | 4519 | 3538 | -981 | 77.339 | 68.663 |
| fix-code-vulnerability | 2038 | 2252 | +214 | 58.933 | 62.803 |
| git-leak-recovery | 3493 | 8308 | +4815 | 68.299 | 150.374 |
| log-summary-date-ranges | 2642 | 1985 | -657 | 56.441 | 43.673 |
| multi-source-data-merger | 4745 | 4552 | -193 | 82.475 | 81.074 |
| polyglot-c-py | 6437 | 6222 | -215 | 116.675 | 134.193 |
| prove-plus-comm | 1072 | 793 | -279 | 31.959 | 29.149 |

- 출력 증가 **3개**: `code-from-image`, `fix-code-vulnerability`, `git-leak-recovery`.
- 시간 증가 **4개**: 위 3개와 `polyglot-c-py`.
- **Git 복구:** +4815토큰으로 전체 순증 +2906토큰보다 크다. Python 부재, Git 출력 형식의 `%x09`·`%20` 오해, 비밀값 부재 검사에서의 비영 종료 후 복구, 추가 저장소 검사가 관측됐다. 다른 7개 과제의 출력은 합계 1909토큰 감소했다.
- **취약점:** 직접 diff 전에 넓은 구조·본문 탐색이 있었고, `git` 도구에 `&&`로 연결한 명령을 보내 거절된 뒤 배열로 고쳤다. 이 실행 실패는 공식 최종 통과와 별개로 남긴다.
- **이미지:** 출력 +202토큰, 시간 +3.820초였다. 해시 결과 생성 후 별도 검증에서 `xxd` 부재로 실패했고, Perl을 사용한 검증은 통과했다. 실행 경로의 차이는 관측됐지만 이를 설명 축약의 인과효과로 판정할 근거는 없다.
- **Polyglot:** 출력은 줄었지만 시간은 늘었다. C 컴파일 성공 후 경고 제거 수정, 모호한 패치 문맥, 재읽기·재컴파일·재검증이 남았다. Python 실행은 실행 파일 부재로 막혔으므로 agent 자체 Python 실행 검증은 완료되지 않았다. 공식 verifier의 통과와 구분한다.

### 원시 로그·비용·잡음

`round-metrics.mjs`가 report/reward와 원시 trace를 대조했다. `trace-cost.mjs`는 8개 trial의 `usage.json`과 trace 사이 **불일치 0**, trace-only 복원 **0**을 보고했다. 환산 비용은 $1.2232768이며 agent분당 $0.1209다.

`tool-efficiency.mjs` 기준 도구 호출 64회, 출력 약 93.5K문자, 실패·skip 출력 2332문자(2.5%)였다. shell 명령 실패 5건, git 도구 실패 1건, `load_tool` 미충족 1건이 있었다. `load_tool` 미충족은 DB 과제에서 없는 `Skill`을 요청한 경우다. 인프라 오류·자동 재시도 0이 도구·명령 실패 0을 뜻하지 않는다.

### 인과 해석의 제한과 보존

두 실행의 기준 commit은 `f0badbcc4501`로 같지만 dirty 상태다. runtime bundle은 `a72ec7e02e1e…`→`192875826663…`, 파일 수는 1664→1670이다. 스냅샷 대조에서 새 파일 6개와 변경 파일 21개가 확인됐고, 이번 범위 외 스킬 선택·복원·에이전트 루프·PowerPoint 관련 수정도 포함됐다. 따라서 동일 fingerprint는 확인됐지만 설명만 달라진 통제 실험은 아니다. 단일 실행으로 안정적인 수렴도 주장하지 않는다.

두 실행의 `report.json`·`report.md`, 원시 trace, runtime manifest와 기존 소스 변경은 보존했다. 이 후속 정리에서는 벤치 재실행·파일 삭제·커밋·푸시·배포를 하지 않았다.

이전 단계: [공통 규칙 프롬프트 축약](fast8-prompt-diet-20260912.md).
