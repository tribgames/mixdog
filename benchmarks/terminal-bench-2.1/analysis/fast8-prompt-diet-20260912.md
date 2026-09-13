# 공통 규칙 프롬프트 축약 — 2026-09-12

## 결론

조립된 headless 규칙 프롬프트를 **16,702→12,051바이트(-27.85%)**로 줄였다. 도구 명세는 변경하지 않았다. 관련 테스트는 최종 **19/19**, 기존 Sol FAST8 공식 검증은 **8/8** 통과했다.

그러나 단일 FAST8 비교에서 출력 **23,028→25,926토큰(+12.58%)**, 모델 요청 **43→51회**, 경과 시간 **142.331→160.557초**로 증가했다. **프롬프트 크기 축소는 확인했지만, 실행 효율 개선이나 최소 수렴은 입증하지 못했다.** 축약본을 유지하며 추가 재실행은 하지 않았다.

## 수정 범위와 의미 대조

모델에 전달하는 규칙은 영문으로 작성했다. 과제별 예외·정답 힌트·모델별 휴리스틱을 추가하지 않았으며, builder·하네스·모델·프리셋·공식 verifier는 변경하지 않았다.

| 파일 | 통합·축약한 내용 | 유지한 조건 |
|---|---|---|
| `src/rules/shared/10-tool-workflow.md` | 범위·근거 재사용·완료 경계 통합, 실패/재시도/복구를 한곳에 정리, 스킬 절차 축약 | 파괴 작업 승인·명시 경로·복구 가능성, 요구사항과 증거 구분, 유효 근거 재사용, 의존성·부작용 직렬화, 실패 상태 보존, 제한된 재시도, 거부·취소 우회 금지, 스킬 우선 로딩 |
| `src/rules/shared/30-exploration.md` | 탐색의 단일 담당 도구와 경로 규칙 통합, 중복 설명 제거 | 원본과 작업 사본 분리, 읽기 전용 접근, 근거별 단일 도구, 원인별 실패 처리, 알려진 경로 직접 접근, 원본 샘플 확인, 선택 조건과 유효성 구분 |
| `src/rules/shared/35-implementation.md` | 범위·재시도 중복을 작업 흐름으로 통합 | 기존 함수 재사용, 계약에 따른 정규화, 동등 표현 구분, 원인 수정, 불필요한 추상화·휴리스틱 금지 |
| `src/rules/shared/40-editing.md` | 편집 도구별 조건부 문단 병합 | 편집기와 shell 쓰기 경계, Add File 원자적 부재 검사, 정확한 현재 문맥, 고유한 수정 위치, 파일별 패치 묶음, 비중첩 편집, 결과 의존 변경만 지연 |
| `src/rules/shared/60-verification.md` | 요구사항·검증·보고 기준을 짧게 통합 | 구현 전 수용 기준, 정확한 경로·이름·타입·값, 독립적인 기대값/불변조건, 라이브러리 보장과 작업별 검증 구분, 필수 검사와 실패의 차단성, 임의 엄격화 금지, 환경 제약의 정직한 보고, 영향받은 검사만 재실행, Goal 생명주기 |

개별 스킬 파일과 `75-goal.md`·`80-memory.md`, 프로필·언어 설정, 도구 구현은 수정하지 않았다. 이 대조는 규칙에 남긴 조건을 확인한 것이며, 모든 모델 실행에서 완전히 동일한 행동을 보장한다는 뜻은 아니다.

추가로 `src/session-runtime/tool-policy-surface.test.mjs`의 축약 전 문장 기대값을 갱신했다. 편집 도구별 제외 조건이나 승인·검증 경계를 제거하지 않았다.

## 검증

### 프롬프트와 도구 명세

수정 전후 같은 명령으로 실제 조립 결과를 측정했다.

```powershell
node benchmarks/terminal-bench-2.1/analysis/contract-hash.mjs --provider openai-oauth --model gpt-5.6-sol
```

| 항목 | 수정 전 E | 축약 후 |
|---|---:|---:|
| 조립 프롬프트 bytes | 16702 | 12051 |
| 전체 규칙 digest payload bytes | 24988 | 20035 |
| 규칙 파일 수 | 20 | 20 |
| 활성 도구 수 | 11 | 11 |
| provider tool payload bytes | 14390 | 14390 |

| 구분 | rules hash | prompt surface hash |
|---|---|---|
| E | `59d520a35deccd57d83fb130d298729131f2f6c75c507cd4164d6dcbf62c12f9` | `87f19cd32aaef89135b3aa043df54ebf90544c9925b19698dab2e7efe7615d6f` |
| 축약 후 | `29b0b863a98683e407c976278aa1ad35464a6db4a887fb795684d0343d4921cb` | `88fd373b45490cb1f2eb99eaa8d7811cca6a6816443171faa3d64728b379cff6` |

공통 tool contract hash는 `64ecc26631b13208790e1aeed281aa441c2d2f545e20b5410b2c1ae2e0bc7145`다.

### 관련 테스트

```powershell
node --test src/lib/rules-builder-language.test.mjs src/runtime/agent/orchestrator/context/compose-system-prompt.test.mjs
node --test src/session-runtime/tool-policy-surface.test.mjs
```

- 언어·프롬프트 조립: **3/3 통과**.
- 도구별 규칙 필터링: 최초 **14/16**. 옛 `Placement:` 문장과 작업 흐름 문장을 기대하던 두 테스트가 실패했다. 의도적인 문구 변경을 반영한 뒤 **16/16 통과**.
- 변경한 규칙 및 테스트 파일의 `git diff --check` 통과.
- 최초 실패를 성공으로 간주한 것이 아니라, 기대값 변경 후 영향받은 검사를 다시 실행했다.

## FAST8 비교

기존 `sol-xhigh-fast`를 동시 8개·반복 1회로 실행했다. 모델은 `openai-oauth/gpt-5.6-sol`, 추론 수준 `xhigh`, Fast 유지다.

- 기준 E: `jobs-sol-xhigh-fast-20260912-120901`
- 축약 후: `jobs-sol-xhigh-fast-20260912-132437`
- 공통 preset fingerprint: `e01b9c1979b9a0d450c3cc435afba7da6d7380d2f529d0f6b420ba1010cd5593`
- 축약 후 runtime bundle: `a72ec7e02e1ee942e19a46833301b3cfc0c4b2200aafcc92cd166da04823d4d4`

두 실행의 `report.json`·`report.md`는 수정하지 않았다. 과제별 원시 기록은 각 `report.json`의 `paths.runDir` 아래 `agent/agent-trace.jsonl`, `agent/mixdog.txt`, `result.json`에 있다.

| 항목 | E | 축약 후 |
|---|---:|---:|
| 공식 검증 통과 | 8/8 | 8/8 |
| 입력 토큰 | 451809 | 485187 |
| 캐시 입력 토큰 | 368256 | 401408 |
| 출력 토큰 | 23028 | 25926 |
| 추론 토큰 | 13056 | 14359 |
| 모델 요청 | 43 | 51 |
| 도구 호출 | 55 | 68 |
| 도구 batch | 35 | 43 |
| 복수 도구 batch | 13 | 11 |
| 마지막 응답 추론 합 | 817 | 1072 |
| 최종 컨텍스트 중앙값 | 11302 | 11303 |
| 경과 초 | 142.331 | 160.557 |
| agent 합계 초 | 471.470 | 525.387 |
| 환산 비용 USD | 0.9420744 | 1.0141992 |
| USD/agent분 | 0.1199 | 0.1158 |
| 도구 출력 절감 bytes | 40841 | 30808 |

출력 토큰에는 추론이 포함된다. 추론을 출력에 다시 더하지 않는다.

### 과제별 결과와 증가 경로

| 과제 | E 출력 | 축약 후 출력 | 출력 차이 | E 초 | 축약 후 초 |
|---|---:|---:|---:|---:|---:|
| code-from-image | 739 | 980 | +241 | 27.456 | 33.266 |
| db-wal-recovery | 3760 | 4519 | +759 | 71.908 | 77.339 |
| fix-code-vulnerability | 2420 | 2038 | -382 | 52.757 | 58.933 |
| git-leak-recovery | 3518 | 3493 | -25 | 72.618 | 68.299 |
| log-summary-date-ranges | 2348 | 2642 | +294 | 52.317 | 56.441 |
| multi-source-data-merger | 4376 | 4745 | +369 | 70.583 | 82.475 |
| polyglot-c-py | 5107 | 6437 | +1330 | 95.386 | 116.675 |
| prove-plus-comm | 760 | 1072 | +312 | 28.445 | 31.959 |

- 출력 증가 **6개**: code-from-image, db-wal-recovery, log-summary-date-ranges, multi-source-data-merger, polyglot-c-py, prove-plus-comm.
- 시간 증가 **7개**: 위 6개와 fix-code-vulnerability.
- **Polyglot:** 모델 요청 4→10회. 컴파일 성공 후 따옴표 실험, 경고 제거 수정, Python 정수 출력 제한 변경, 여러 차례 재컴파일·재검증이 이어졌다. Python 실행은 환경에 실행 파일이 없어 막혔으며, 실행 검증 완료로 간주하지 않는다. 공식 verifier는 별도로 통과했다.
- **DB:** 작업 사본의 WAL이 연결 종료 후 사라지는 것을 확인한 뒤 읽기 전용 사본 실험을 추가했다. 원래 경로의 WAL 복구·백업·JSON 출력과 검증을 수행했지만, 결과 재읽기도 남았다.
- **병합:** Parquet을 먼저 `read`로 본 뒤 Python으로 해석했다. 생성한 충돌 JSON도 다시 읽어 도구 호출이 5→7회로 늘었다.
- **이미지:** 계산→파일 작성→재읽기→재계산 검증으로 나뉘어 도구 호출이 3→5회로 늘었다.
- **로그:** 원본 집계와 별도 검증은 성공했지만, 그 뒤 결과 파일을 다시 읽었다.
- **증명:** 컴파일 성공 후 파일 나열이 남았다.
- **취약점:** 출력과 도구 호출은 줄었지만, 직접 diff 확인 전 넓은 탐색·구조 조회가 있었고 경과 시간은 늘었다.

### JSONL 효율·비용·잡음

`round-metrics.mjs`에서 동일 fingerprint, 공식 reward/report, 원시 출력 토큰/report의 일치를 확인했다. `trace-cost.mjs`는 8개 trial의 원시 trace와 `usage.json` 대조에서 불일치 0을 보고했다.

축약 후 `tool-efficiency.mjs` 결과:

- 도구 호출 68회, 출력 약 73.5k 문자.
- 실패·skip 출력 179문자(0.2%).
- tool 자체 실패 0, shell 명령 실패 1(Python 실행 파일 부재).
- 동일 요청 복구 집계 0. 이 값은 다른 방식의 후속 처리가 없었다는 뜻이 아니다.

두 실행 모두 인프라 오류·재시도·취소는 0이었다. 축약 후에도 source `f0badbcc4501…`, dirty 변경 50개가 포함된 미커밋 번들이므로 공개 커밋의 성능으로 귀속하지 않는다. 후보별 단일 실행이며, 증가분 전부가 축약 때문에 발생했다고 단정하지 않는다.

수동 삭제·커밋·배포는 하지 않았으며 실행 로그와 원시 결과를 보존했다.
