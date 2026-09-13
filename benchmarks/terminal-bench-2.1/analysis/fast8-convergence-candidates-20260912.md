# FAST8 대개념 문구 후보

## 목적

과제별 힌트·예외·정답 유도 없이, 같은 요구사항을 더 적은 탐색·구현·검증·마무리 비용으로 충족하는 문구를 비교한다.
기존 5라운드는 모두 8/8을 통과했으나 출력은 22,413~25,981토큰으로 변동하여 최소 비용으로의 수렴을 입증하지 못했다.

## 비교 원칙

- 모델·추론 수준·프리셋·과제·공식 검증 조건은 유지한다.
- 후보는 보편적 의사결정 원칙으로 작성하며, 과제명·특정 입력값·정답 패턴을 포함하지 않는다.
- 후보를 무조건 누적하지 않는다. 이번 후보가 대체하는 기존 문구와 해결할 관찰된 낭비를 명시한다.
- 매회 결과와 실제 작업 경로를 함께 확인한다. 8/8 유지, 요구사항 충족, 필요한 검증과 원본 보존이 우선이다.
- 출력·추론·모델 왕복·재작업을 함께 평가한다. 한 번의 최저값은 관측치이지 안정적인 기대 성능이 아니다.
- 실행 스냅샷의 차이를 기록한다. 다른 소스 변경이 섞인 비교는 완전한 단일 변수 실험으로 주장하지 않는다.

## 후보군

아래 영문을 `src/rules/shared/10-tool-workflow.md`의 같은 문단에서 하나씩 교체하여 A→E 순서로 비교했다. 이어서 문서 하단의 F→J를 추가 비교했다. 후보를 누적하지 않았으며, 최종적으로 E를 복원하여 잠정 유지한다.

### A. 최소 충분한 행동

```text
Choose the smallest supported action that resolves the current uncertainty
or establishes the required outcome. Do not expand the problem beyond the
user's contract.
```

관찰된 대상: 불필요한 초기 탐색, 필요 이상의 구현 범위.

### B. 근거의 재사용

```text
Reuse established evidence and documented guarantees. New work must resolve
a remaining uncertainty; equivalent evidence does not need to be obtained
again through another method.
```

관찰된 대상: 성공한 확인의 반복, 같은 성질을 다른 도구·언어로 다시 증명하는 작업.

### C. 충분성에 따른 종료

```text
Stop a workstream once its required properties are established. Continue
only the unresolved workstreams, and report settled results without reopening
their implementation choices.
```

관찰된 대상: 일부 검증이 막힌 상태에서 이미 통과한 부분까지 수정하는 작업, 최종 보고 전 재검토.

### D. 계약 우선의 표현 해석

```text
Interpret and transform data according to the authoritative contract.
Distinguish required meaning from incidental representation, and selection
criteria from validity constraints.
```

관찰된 대상: 샘플을 전체 입력 도메인으로 오해하는 파서, 정규화 누락으로 발생하는 재생성.

### E. 결정과 실행의 분리

```text
Ask the model to decide only when new evidence changes the next action.
Execute already determined work within supported tool and approval boundaries,
preserving dependency order and failure outcomes.
```

관찰된 대상: 중간 판단이 불필요한 단계마다 모델 왕복을 추가하는 작업.

## 1차 상태 (A~E)

- 기존 5라운드 결과: `fast8-convergence-20260912-5rounds.md`
- 추가 후보 5개를 각각 1회 실행하여 공식 검증 **40/40**을 통과했다.
- 이번 후보 중 E가 출력·추론·모델 요청·경과 시간에서 최저였다. 비용 최저는 A였다.
- **수렴은 미달성이다.** E의 23,028토큰은 이번 시작점보다 5.95% 적지만, 이전 5라운드 최저 22,413토큰보다 2.74% 많다. 후보별 1회 관측으로 안정적인 최소 비용이나 문구의 인과 효과를 입증하지 않는다.

## 실행 조건과 원시 결과

- 기존 FAST8 `sol-xhigh-fast`, `openai-oauth/gpt-5.6-sol`, `xhigh`, Fast 유지.
- 동시 과제 8개, 반복 1회. 벤치 실행은 하나씩 순차 진행했다.
- 공통 preset fingerprint: `sha256:e01b9c1979b9a0d450c3cc435afba7da6d7380d2f529d0f6b420ba1010cd5593`.
- 이번 변경은 공통 작업 원칙의 후보 문구 교체다. 과제별 분기·정답 힌트·모델별 예외를 추가하거나 공식 검증 조건을 변경하지 않았다.
- 기존 안전·승인 경계, 원본 보존, 요구사항 정합성, 독립적인 근거에 따른 검증 원칙을 유지했다.

아래 경로는 `benchmarks/terminal-bench-2.1/` 기준이다. 각 폴더의 `report.json`과 `report.md`에 원시 대시보드가 있으며, `report.json`의 `paths.runDir` 아래에 과제별 `agent/agent-trace.jsonl`, `agent/mixdog.txt`, `result.json`이 있다.

| 구분 | 실행 폴더 |
|---|---|
| R0: 이번 시작점 | `jobs-sol-xhigh-fast-20260912-113559` |
| A | `jobs-sol-xhigh-fast-20260912-115117` |
| B | `jobs-sol-xhigh-fast-20260912-115518` |
| C | `jobs-sol-xhigh-fast-20260912-120126` |
| D | `jobs-sol-xhigh-fast-20260912-120504` |
| E | `jobs-sol-xhigh-fast-20260912-120901` |

## 대시보드

출력은 추론을 포함한 API `output_tokens`다. 추론을 출력에 다시 더하지 않는다. 경과 시간은 runner의 `wallSeconds`, agent 합계는 8개 과제의 실행 시간 합이다.

| 후보 | 점수 | 출력 | 추론 | 모델 요청 | 경과 초 | agent 합계 초 | 비용 USD | USD/agent분 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| R0 | 8/8 | 24484 | 13410 | 47 | 180.179 | 498.109 | 0.9736904 | 0.1173 |
| A | 8/8 | 23871 | 13622 | 50 | 159.985 | 499.125 | 0.9257176 | 0.1113 |
| B | 8/8 | 25385 | 15182 | 49 | 206.280 | 573.739 | 1.0814712 | 0.1131 |
| C | 8/8 | 23798 | 13769 | 44 | 176.965 | 591.454 | 0.9940240 | 0.1008 |
| D | 8/8 | 25415 | 15719 | 46 | 184.225 | 556.871 | 0.9586864 | 0.1033 |
| E | 8/8 | 23028 | 13056 | 43 | 142.331 | 471.470 | 0.9420744 | 0.1199 |

| 후보 | 입력 | 캐시 입력 | 최종 컨텍스트 중앙값 | 출력 절감 bytes | 도구 호출 | 도구 batch | 복수 도구 batch | 마지막 응답 추론 합 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 445348 | 370304 | 10930.5 | 25736 | 54 | 42 | 8 | 778 |
| B | 543878 | 444928 | 11563.5 | 65702 | 59 | 41 | 9 | 897 |
| C | 426732 | 330240 | 11116 | 30269 | 53 | 36 | 9 | 753 |
| D | 420411 | 342016 | 10647.5 | 44733 | 54 | 38 | 8 | 3287 |
| E | 451809 | 368256 | 11302 | 40841 | 55 | 35 | 13 | 817 |

추가 5회 합계는 출력 121,497토큰, 환산 비용 **$4.9019736**이다. 모든 실행의 인프라 오류·재시도·취소는 0이다. 이는 과제 내부 명령이 전부 성공했다는 뜻은 아니다.

### 과제별 출력

| 과제 | R0 | A | B | C | D | E |
|---|---:|---:|---:|---:|---:|---:|
| code-from-image | 654 | 986 | 2046 | 1400 | 714 | 739 |
| db-wal-recovery | 3602 | 3420 | 5296 | 3868 | 3284 | 3760 |
| fix-code-vulnerability | 1651 | 2260 | 2158 | 1834 | 1885 | 2420 |
| git-leak-recovery | 4718 | 4673 | 3381 | 3889 | 5794 | 3518 |
| log-summary-date-ranges | 1653 | 1771 | 2406 | 2038 | 1857 | 2348 |
| multi-source-data-merger | 4589 | 3927 | 3525 | 3547 | 3656 | 4376 |
| polyglot-c-py | 7094 | 5947 | 5582 | 6654 | 6883 | 5107 |
| prove-plus-comm | 523 | 887 | 991 | 568 | 1342 | 760 |

### R0 대비 증가 과제

여기서 증가는 단순한 관측값 비교이며, 통계적으로 확정된 회귀를 뜻하지 않는다.

| 후보 | 출력 증가 | 시간 증가 |
|---|---|---|
| A | 4개: code-from-image, fix-code-vulnerability, log-summary-date-ranges, prove-plus-comm | 4개: code-from-image, db-wal-recovery, fix-code-vulnerability, prove-plus-comm |
| B | 5개: code-from-image, db-wal-recovery, fix-code-vulnerability, log-summary-date-ranges, prove-plus-comm | 6개: code-from-image, db-wal-recovery, fix-code-vulnerability, log-summary-date-ranges, polyglot-c-py, prove-plus-comm |
| C | 5개: code-from-image, db-wal-recovery, fix-code-vulnerability, log-summary-date-ranges, prove-plus-comm | 7개: code-from-image, db-wal-recovery, fix-code-vulnerability, git-leak-recovery, log-summary-date-ranges, polyglot-c-py, prove-plus-comm |
| D | 5개: code-from-image, fix-code-vulnerability, git-leak-recovery, log-summary-date-ranges, prove-plus-comm | 6개: code-from-image, db-wal-recovery, fix-code-vulnerability, git-leak-recovery, polyglot-c-py, prove-plus-comm |
| E | 5개: code-from-image, db-wal-recovery, fix-code-vulnerability, log-summary-date-ranges, prove-plus-comm | 5개: code-from-image, db-wal-recovery, fix-code-vulnerability, log-summary-date-ranges, prove-plus-comm |

## 실제 작업 경로에서 확인한 내용

- **A — 최소 충분한 행동:** 이미지에서 먼저 계산한 뒤 스크립트를 만들고 다시 실행했다. 취약점에서는 추가 확인 스크립트가 예외 처리 실수로 실패하여 다시 작성됐다. 증명은 방향이 맞지 않는 정리 적용을 수정한 뒤 컴파일에 성공했지만 결과 파일을 다시 나열했다. 로그 집계는 생성 뒤 읽기와 별도 집계를 수행했고, DB는 `file` 부재 뒤 복구·조회·출력·검증 단계로 나뉘었다. 전체 출력은 줄었어도 요청은 47→50회로 늘었다.
- **B — 근거 재사용:** 이미지의 별도 OpenSSL 검증에서 `xxd` 부재로 우회했다. DB는 실험 작업 공간을 다시 나열하고 별도의 읽기 전용 실험과 최종 검증을 수행했다. 취약점은 직접 diff 확인 전에 넓은 검색과 전체 구조 조회를 수행했고, 이후에도 여러 차례 역사·본문을 조회하여 도구 20회를 사용했다. 증명도 컴파일 성공 뒤 파일을 다시 나열했다. 근거 재사용 문구만으로 중복 작업이 없어지지는 않았다.
- **C — 충분성에 따른 종료:** 요청은 44회로 줄었지만, 이미지의 `xxd` 부재 우회와 DB의 `file` 부재가 반복됐다. 취약점은 diff 뒤에도 넓은 검색·구조 조회를 이어갔고, 증명은 성공 후 산출물을 다시 찾았다. Git은 5개 한도를 넘긴 명령 배열을 나누어 재호출했다. Polyglot에서는 컴파일 경고를 없애려고 재수정·재컴파일했고, Python 실행은 도구 부재로 막혔다.
- **D — 계약 우선 표현 해석:** 병합 결과 재생성 없이 완료했고 Polyglot도 4회 요청으로 끝났지만, 마지막 응답에서 추론 2,797토큰과 stream 56.0초를 사용했다. Git은 추가 객체·파일 검사에서 Python 부재 후 다른 구현으로 우회했다. 증명은 정리 조회와 성공 후 파일 나열, 로그 집계는 별도 집계 성공 후 다시 읽기, 이미지는 계산과 출력 생성을 나누는 경로가 남았다. 취약점 역시 여러 검색을 이어갔다.
- **E — 결정과 실행의 분리:** Polyglot은 경고 제거 재수정 없이 컴파일과 C 실행을 연결했고, 요청 4회·출력 5,107토큰이었다. 이미지는 스크립트 실행과 출력의 길이·문자·접두사 확인을 한 호출로 연결했다. 하지만 취약점의 넓은 탐색·역사 조회, 로그 검증의 awk 인용 오류 수정, DB의 `file` 부재 우회와 생성 결과 재읽기, 증명의 성공 후 파일 존재 확인은 남았다. Git에도 복구 후 추가 확인이 이어졌다.

Polyglot의 Python 검증 부재는 에이전트 작업 환경의 제한이다. 에이전트가 Python 실행을 검증했다고 보지 않는다. 별도로 공식 verifier는 모든 후보의 해당 과제를 통과시켰다. 시간 차이에는 모델 응답 및 환경 시간이 섞여 있으므로 도구 호출 감소와 동일시하지 않는다.

### JSONL 도구 효율 분석

`analysis/tool-efficiency.mjs`가 관측한 분류다. 일반적인 명령 실패와 tool 자체 실패를 구분한다.

| 후보 | 도구 출력 문자 약 | 실패·skip 출력 문자 | 비율 | shell 명령 실패 | tool 실패 |
|---|---:|---:|---:|---:|---:|
| A | 28.2k | 1335 | 4.7% | 5 | 1 |
| B | 94.2k | 392 | 0.4% | 2 | 0 |
| C | 60.6k | 403 | 0.7% | 2 | 1 |
| D | 46.6k | 786 | 1.7% | 3 | 0 |
| E | 78.7k | 1152 | 1.5% | 3 | 0 |

분석기의 동일 요청 복구 집계는 A가 1건, B~E는 0건이었다. 이는 의미가 같은 후속 우회가 없었다는 뜻이 아니다. 위 작업 경로 분석은 실제 명령 인자와 결과를 별도로 확인한 내용이다.

## 실행 스냅샷과 검증

아래는 해시 앞 12자리다. 전체 해시는 각 `report.json`에 보존되어 있다.

| 후보 | rules | prompt surface | runtime bundle |
|---|---|---|---|
| R0 | 21b39252c16a | 988d2ca6e745 | 8842f75135eb |
| A | 16b4e677315c | 93087dc85177 | 3dd54d936e95 |
| B | 9d540c8cf937 | 4f2121695da0 | bec621bf4074 |
| C | 1a0f022a4ed0 | 500a4ec17fe2 | b9c0c9dc331a |
| D | 3a4ddc7a81a6 | 6332d213a2ae | 74e7791f8ae7 |
| E | 59d520a35dec | 87f19cd32aae | 7193ab7e5203 |

- A~E의 tool contract hash는 `64ecc26631b1…`로 같았다. runner는 모두 source `f0badbcc4501…`, dirty 상태, `src/` 또는 `native/`의 HEAD 대비 변경 50개를 보고했다. 같은 HEAD 및 변경 개수만으로 다른 소스가 완전히 같았다고 주장하지 않는다.
- 모든 후보는 미커밋 실행 번들이므로 공개된 커밋의 성능으로 귀속하지 않는다. 후보별 1회 결과이며 반복 재현이나 완전한 단일 변수 실험으로 주장하지 않는다.
- `analysis/round-metrics.mjs <jobs> <R0>`에서 같은 preset fingerprint, 과제별 공식 reward/report, trace 출력 토큰/report 일치를 확인했다.
- `analysis/trace-cost.mjs <jobs>`에서 각 후보 8개 trial의 원시 trace와 `usage.json` 비용 대조가 모두 일치했다. 총 40개 중 불일치 0이다.
- 최종 E 상태에서 아래 프롬프트 조립 관련 테스트는 **3/3 통과**했다.

```powershell
node --test src/lib/rules-builder-language.test.mjs src/runtime/agent/orchestrator/context/compose-system-prompt.test.mjs
```

## 1차 잠정 선택과 남은 문제

**E만 유지한다.** R0 대비 출력 -5.95%, 추론 -2.64%, 모델 요청 -8.51%, 경과 시간 -21.01%, 비용 -3.25%였다. E는 이번 후보 중 출력·추론·요청·경과 시간이 가장 적지만, 도구 호출·컨텍스트·비용까지 모두 최소인 후보는 아니다.

다만 이번 출력 범위는 **23,028~25,415**이고 이전 최저 22,413을 갱신하지 못했다. **추가 5후보 비교는 완료했지만 최소 수렴 목표는 미완료다.** 남은 관측 문제는 이미 결정된 작업의 분절, 해결된 부분의 재확인, 알려진 근거 이후에도 계속되는 탐색이다. 이 문제들을 과제별 예외로 해결하거나 미검증 문구를 누적하지 않는다.

수동 삭제·정리·커밋·배포는 하지 않았다. 실행 결과와 trace는 보존했고, 모델·프리셋·공식 verifier는 변경하지 않았다.

## 추가 5라운드 (F~J)

사용자의 추가 5라운드 요청에 따라 E를 시작점으로 F→J를 순차 실행했다. 같은 문단의 후보만 교체했으며, 각 후보는 바로 앞 후보에 누적하지 않았다. 비교 기준은 E의 `jobs-sol-xhigh-fast-20260912-120901`이다. 프리셋·모델·추론 수준·Fast·8개 과제·공식 verifier 조건은 앞선 비교와 같다.

### 추가 후보 문구

#### F. 행동의 의사결정 관련성

```text
Tie each action to a concrete gap between the required outcome and
established evidence. Omit actions whose results cannot change a necessary
decision, the verification verdict, or the required report.
```

대상: 필요한 결과나 다음 결정과 무관한 넓은 탐색, 성공 후 재확인.

#### G. 연산의 보장을 함께 활용

```text
Use the guarantees of trusted operations to establish required properties
together. Check only the task-specific assumptions and gaps those guarantees
do not cover; do not reconstruct evidence the operation already provides.
```

대상: DB 구조 확인과 복구·검증의 과도한 분절, 성공한 연산이 이미 보장하는 사실의 재확인.

#### H. 요구사항을 직접 충족하는 최소 구성

```text
Choose the simplest construction that satisfies the contract. Introduce
additional state, abstractions, or intermediate artifacts only to satisfy
a concrete requirement, not to make a working solution more general.
```

대상: 필요 이상의 중간 상태·보조 구현, 요구사항과 무관한 일반화.

#### I. 충분한 선택의 확정

```text
Commit to a supported approach once it meets the requirements. Compare
alternatives only when evidence exposes a deficiency or a trade-off that
matters to the user; equivalent outcomes do not justify further optimization.
```

대상: 이미 충분한 선택의 재검토와 대안 비교, 동등한 결과를 위한 추가 수정.

#### J. 불확실성의 범위 제한

```text
Keep uncertainty local to the property that lacks evidence. Preserve
established properties while resolving that gap; uncertainty elsewhere does
not invalidate successful work or justify expanding the solution.
```

대상: 한 속성의 검증 부재가 다른 정상 속성의 재설계·재검증으로 번지는 작업.

### 추가 실행 대시보드

| 추가 후보 | 점수 | 출력 | 추론 | 모델 요청 | 경과 초 | agent 합계 초 | 비용 USD | USD/agent분 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| E | 8/8 | 23028 | 13056 | 43 | 142.331 | 471.470 | 0.9420744 | 0.1199 |
| F | 8/8 | 24596 | 12958 | 43 | 148.197 | 505.755 | 0.9874808 | 0.1171 |
| G | 8/8 | 24404 | 14294 | 41 | 158.208 | 483.786 | 0.9116560 | 0.1131 |
| H | 8/8 | 23137 | 13308 | 45 | 167.169 | 494.135 | 0.9366384 | 0.1137 |
| I | 8/8 | 28534 | 16678 | 47 | 178.103 | 546.201 | 1.0921824 | 0.1200 |
| J | 8/8 | 25152 | 14041 | 50 | 159.763 | 518.382 | 0.9580504 | 0.1109 |

| 추가 후보 | 입력 | 캐시 입력 | 최종 컨텍스트 중앙값 | 출력 절감 bytes | 도구 호출 | 도구 batch | 복수 도구 batch | 마지막 응답 추론 합 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| F | 445759 | 357632 | 11439.5 | 28677 | 52 | 35 | 11 | 1510 |
| G | 400230 | 327040 | 11020.5 | 40031 | 54 | 33 | 9 | 987 |
| H | 470641 | 391296 | 10460 | 58268 | 63 | 37 | 12 | 1219 |
| I | 464686 | 371456 | 11374 | 25736 | 59 | 39 | 11 | 1578 |
| J | 454975 | 379136 | 11364.5 | 31064 | 58 | 42 | 9 | 3695 |

추가 5회 합계: 공식 검증 **40/40**, 출력 **125,823토큰**, 비용 **$4.8860080**. 인프라 오류·재시도·취소는 모두 0이다.

### 추가 후보 과제별 출력

| 과제 | E | F | G | H | I | J |
|---|---:|---:|---:|---:|---:|---:|
| code-from-image | 739 | 514 | 518 | 722 | 859 | 556 |
| db-wal-recovery | 3760 | 4613 | 3802 | 2602 | 3589 | 4585 |
| fix-code-vulnerability | 2420 | 1692 | 2201 | 2541 | 2635 | 2075 |
| git-leak-recovery | 3518 | 5217 | 4313 | 3505 | 7774 | 3393 |
| log-summary-date-ranges | 2348 | 2623 | 1973 | 2028 | 2116 | 2988 |
| multi-source-data-merger | 4376 | 3521 | 3660 | 3638 | 4652 | 4114 |
| polyglot-c-py | 5107 | 5253 | 6141 | 6896 | 5956 | 6311 |
| prove-plus-comm | 760 | 1163 | 1796 | 1205 | 953 | 1130 |

### E 대비 증가 과제

| 추가 후보 | 출력 증가 | 시간 증가 |
|---|---|---|
| F | 5개: db-wal-recovery, git-leak-recovery, log-summary-date-ranges, polyglot-c-py, prove-plus-comm | 5개: db-wal-recovery, git-leak-recovery, log-summary-date-ranges, polyglot-c-py, prove-plus-comm |
| G | 4개: db-wal-recovery, git-leak-recovery, polyglot-c-py, prove-plus-comm | 3개: git-leak-recovery, polyglot-c-py, prove-plus-comm |
| H | 3개: fix-code-vulnerability, polyglot-c-py, prove-plus-comm | 4개: code-from-image, fix-code-vulnerability, polyglot-c-py, prove-plus-comm |
| I | 6개: code-from-image, fix-code-vulnerability, git-leak-recovery, multi-source-data-merger, polyglot-c-py, prove-plus-comm | 6개: code-from-image, fix-code-vulnerability, git-leak-recovery, multi-source-data-merger, polyglot-c-py, prove-plus-comm |
| J | 4개: db-wal-recovery, log-summary-date-ranges, polyglot-c-py, prove-plus-comm | 5개: db-wal-recovery, fix-code-vulnerability, log-summary-date-ranges, polyglot-c-py, prove-plus-comm |

증가 과제의 실제 호출 경로를 확인했다. 시간 증가만 있고 작업 경로는 같은 경우도 있으므로, 이 표 자체를 문구 때문에 발생한 확정 회귀로 해석하지 않는다.

### 추가 JSONL 분석과 관찰

| 추가 후보 | 도구 출력 문자 약 | 실패·skip 출력 문자 | 비율 | shell 명령 실패 | tool 실패 | 동일 요청 복구 |
|---|---:|---:|---:|---:|---:|---:|
| F | 76.9k | 534 | 0.7% | 3 | 0 | 0 |
| G | 55.2k | 835 | 1.5% | 3 | 0 | 0 |
| H | 97.8k | 1103 | 1.1% | 4 | 0 | 1 |
| I | 44.3k | 616 | 1.4% | 3 | 0 | 0 |
| J | 39.4k | 877 | 2.2% | 3 | 2 | 1 |

- **F:** DB는 프레임 조회·작업 사본 복구·DB와 JSON 검증이 여러 단계로 나뉘어 도구 8회를 사용했다. Git은 Python 부재 뒤 셸 객체 검사로 우회했다. 로그는 생성과 별도 집계를 수행했고, 증명은 컴파일 성공 후 파일을 나열했다. Polyglot은 컴파일 뒤 따옴표 대안 실험을 시도했으나 Python 부재로 막혔다.
- **G:** DB는 조회와 복구·출력·검증을 묶어 도구 4회로 끝났다. 증명도 읽기→수정→컴파일의 3회 호출로 끝났지만 추론은 1,524토큰으로 E의 484보다 많았다. Polyglot은 203줄 생성 후 누락한 중괄호를 추가했고, Python 부재 뒤 C 검증을 따로 수행했다. Git은 여러 조회와 Python 부재 우회가 남았다.
- **H:** 이미지 작업은 E와 같은 읽기→스크립트 작성→실행·검증 경로였으나 더 오래 걸렸다. Polyglot은 Python 부재 뒤 C 컴파일 경고를 없애려고 수정·재컴파일했다. 증명은 정리의 방향 오류를 고친 후 성공했고, 산출물을 다시 나열했다. 취약점은 넓은 검색을 이어갔고 추가 검증의 이스케이프 오류를 수정했다.
- **H의 DB 비교 한계:** 로그상 작업 사본을 복구하여 `/app/recovered.json`을 만들었고, `/app/main.db-wal`을 다시 쓰는 명령은 없었다. 다른 실행의 원래 경로 WAL 복구와 동일한 작업 범위라고 단정하지 않는다. 이 trial의 `agent/session-transcript.json`이 없어 원문 요구사항과의 추가 대조를 완료하지 못했다. 따라서 2,602토큰을 동일 복구 범위의 효율 개선 근거로 사용하지 않았다. 공식 reward 1.0은 별개의 관측 사실이다.
- **I:** 전체 증가 5,506토큰 중 Git 증가가 4,256토큰이었다. 파일 상태 보존용 프로그램을 시도한 뒤 Python 부재에 대응하여 Perl로 객체·파일 검사를 수행했고, grep 검사도 추가했다. Polyglot은 경고 제거 수정·재읽기·재컴파일과 검증 재작성이 이어졌다. 이미지는 문자열 해석 후보 계산 후 최종 계산을 했고, 취약점은 추가 검증의 이스케이프 오류를 수정했다. 병합은 원본 검증까지 5회 호출로 끝났으며, 증명은 성공 후 파일을 다시 나열했다.
- **J:** Polyglot은 도구 3회·모델 요청 3회로 끝났지만 마지막 응답에서 추론 3,106토큰과 stream 62.6초를 사용했다. DB는 공유 메모리 파일 상태를 추가 실험한 뒤 복구·검증했다. 로그는 선택 대상이 아닌 수준을 오류로 거부하여 다시 작성했다. 증명은 잘못된 정리 적용을 조회·수정하고 성공 후 파일을 나열했다. 취약점의 regex 오류와 Git 명령 배열 한도 초과도 발생했다.

전체적으로 도구 호출 감소와 추론 감소가 함께 일어나지는 않았다. 기존 원칙이 있어도 잘못된 인용·정리 적용·입력 계약 해석과 성공 후 재작업이 다시 관측됐다. 특정 과제에 대한 예외나 정답 힌트로 이를 보정하지 않았다.

### 추가 실행 경로와 스냅샷

| 추가 후보 | 실행 폴더 |
|---|---|
| F | `jobs-sol-xhigh-fast-20260912-122220` |
| G | `jobs-sol-xhigh-fast-20260912-122553` |
| H | `jobs-sol-xhigh-fast-20260912-122946` |
| I | `jobs-sol-xhigh-fast-20260912-123358` |
| J | `jobs-sol-xhigh-fast-20260912-123750` |

| 추가 후보 | rules | prompt surface | runtime bundle |
|---|---|---|---|
| F | 979471fe6fb4 | 4d2f0d0f7280 | 956c31b02751 |
| G | 70dddedde3c1 | af017b64ea92 | 9925ac98c9cb |
| H | 26e5179ec59d | e6b7ef7ec15b | c03af3717f93 |
| I | bcf99461130d | 7fdf6856edc9 | 061f83f12556 |
| J | 5b206175ba48 | 6ed96f6f1cab | 6b6adbd315a7 |

- F~J도 같은 preset fingerprint와 tool contract hash였다. runner의 source 표시는 `f0badbcc4501…`, dirty 변경 50개였다. 개별 번들이 다르며, 미커밋 결과를 공개 커밋의 성능으로 주장하지 않는다.
- 각 실행의 `report.json`·`report.md`를 보존했다. `round-metrics.mjs`의 공식 reward/report·trace 출력 대조와 `trace-cost.mjs`의 원시 비용 대조는 추가 40개 trial 모두 일치했다.
- 후보마다 프롬프트 조립 관련 테스트 3/3 및 규칙 변경 형식 검사를 통과했다. 최종 E 복원 후에도 같은 테스트와 형식 검사를 통과했다.
- 수동 삭제·커밋·배포·하네스 변경은 하지 않았다. 실행은 순차 진행했으며 원시 로그를 보존했다.

### 최종 선택

**E를 복원하여 유지한다.** 추가 후보의 출력 범위는 **23,137~28,534**로, 기존 E의 23,028을 모두 넘었다. 경과 시간도 E의 142.331초보다 모두 길었다. 가장 낮은 추가 출력조차 E보다 0.47% 많았다.

부분적으로 G의 모델 요청 41회와 비용 $0.9116560은 E의 43회·$0.9420744보다 낮았다. 그러나 출력·추론·경과 시간은 증가했다. 모든 지표가 함께 개선된 후보는 없었다.

**요청한 추가 5라운드는 완료했지만, 최소 출력의 갱신이나 안정적인 수렴은 달성하지 못했다.** 이번 결과를 이유로 F~J를 누적하지 않는다. 이전 최저 22,413토큰 및 18K대 수렴 목표도 여전히 미달성이다.
