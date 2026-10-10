# Effort 판단기 개선 실험 종료 보고서

## 1. 요약

- 사용자가 개선 루프를 약속한 5시간 중 **2시간 15분** 시점에 중단했고, 보고서를 남기고 실험용 모델·체크포인트·ZIP·데이터셋·라벨·캐시·학습 환경을 삭제하는 것을 승인했다. 앱 소스, 서비스 v2 최적화, 작은 작성 스크립트(`C:/Project/mixdog-effort-judge/checkpoint_io.py`, `C:/Project/mixdog-effort-judge/train3.py` 등)와 앱 코드 복제본은 유지한다(7.4).
- **최종 채택 후보는 없다.** 서비스 변경, 커밋, 푸시, 배포는 하지 않았다. 앱의 `src/runtime/effort-judge/model-manifest.json`은 계속 `effort-judge-v2`를 가리킨다.
- 이 보고서가 다루는 후보 중 feature 보존과 midpoint 보간은 둘 다 짝지은 기준선보다 낮아 **기각**했다. A-GEM은 시드 1개만 평가되고 나머지가 끝나지 않아 **판단 불가**다.
- 실험 자료 정리를 완료했다(9장). 이 보고서만으로는 삭제한 모델을 복원하거나 결과를 독립적으로 재실행할 수 없다. 서비스 v2와 최적화 소스는 보존했다.

## 2. 범위와 채택 조건

서비스 기준은 v2(`b3x5`), 개발 비교 기준은 보존+근거 모델이다. 이번 루프의 채택 조건은 **완전 일치 상승과 2단계 이상 큰 오판 감소를 동시에 달성하고 기존 능력·xhigh를 보존하는 것**이었다.

기존 4,311건, native 397건, Smith 708·3,179건과 이미 평가한 외부 자료는 훈련·반복 튜닝에 사용하지 않는 제한을 유지했다. 새 개발 세트와 최종 검증용 Arena를 분리했다. 단어 규칙, 클래스 가중, 모델의 해결 성공을 난이도 정답으로 사용하는 방식은 도입하지 않았다.

이전 이력은 `C:/Project/mixdog-effort-judge/DEVLOG.md`에 남는다. 아래 수치는 이번 루프에서 확인한 개발 평가 결과이며, 과거 벤치마크 성과나 실제 서비스 성능 향상을 뜻하지 않는다.

## 3. 재현 조건

학습 실험의 공통 조건은 아래와 같다. 헤드 초기화·순서형 출력은 명시적인 개입이며, midpoint는 학습을 추가하지 않고 완료된 기준선에 보간만 적용했다. 출처는 `C:/Project/mixdog-effort-judge/out3/results.jsonl`의 `args`와 선택 메타데이터다.

| 항목 | 값 |
|---|---|
| 기반 모델 | `base/eg2-text-L12` (EmbeddingGemma 2 텍스트 12층) |
| 초기 가중치 | `b3x5` (`init_from`, 보존 기준 `preserve_from`도 `b3x5`) |
| 학습 샘플 수 | 4096 |
| 학습 갱신 수 | 384 (`training_updates` = `scheduler_total_updates` = 384, 에폭 3, 배치 32) |
| 선택 체크포인트 | 갱신 128, 256, 384 (`epoch1`/`epoch2`/`epoch3`에 대응), 선택 프로토콜 버전 2 |
| 선택 기준 | 온도 격자에서 반올림 없는 최소 CE (`soft_nll`) |
| 보조(aux) 시드 | 1234 (`aux_seed`), `aux_w` 0.25, 스키마 `{"c":4,"k":4,"r":4,"n":3}` |
| 매칭 시드 | 0, 1, 2 (`seed`) |
| 입력 형식 | `rp`, 최대 256 토큰, 학습률 5e-5, 소프트 라벨(`votes`), 헤드 `softmax` |
| 학습 데이터 | `aux_pilot/…/trainer_data/ext_labels_20261010141029_072a17be` (동일 경로를 모든 비교 팔이 공유) |
| 평가 | 학습 없는 DEV 전용 평가, 배치 32, bfloat16 autocast, 부트스트랩 시드 1234, 1000회 |

팔 사이의 차이는 `parameter_preserve`(A-GEM 여부), `preserve_kind`(feature/kl), 헤드 초기화·`head_mode`, 그리고 midpoint의 가중치 보간이다. 기준선은 **출력 KL 보존(`preserve_w=1`)과 근거 보조 학습**을 사용한다. 동일 시드끼리 비교하고 최고 시드만 선택하지 않았다.

각 팔의 태그:

| 역할 | 시드 0 | 시드 1 | 시드 2 |
|---|---|---|---|
| 기준선 | `axes-pilot-axes-s0-uxykqf73` | `axes-loop-control-s1-4lfyvz7k` | `axes-loop-control-s2-2z095mar` |
| feature | `axes-feature-s0-xmly_cvx` | `axes-feature-s1-2ra_ypz5` | `axes-feature-s2-ugoyagu1` |
| midpoint | `fixed-midpoint50-b3x5-axes-pilot-axes-s0-uxykqf73-60392610` | `…-axes-loop-control-s1-4lfyvz7k-5f340d6d` | `…-axes-loop-control-s2-2z095mar-5326e766` |
| A-GEM | `axes-agem-s0-7paro3pe` | `axes-agem-s1-dbzegeuj` | `axes-agem-s2-vu12_lw9` |

midpoint는 `b3x5`와 해당 시드 기준선 가중치 사이의 고정 50% 지점이며 비율 탐색이나 온도 재보정을 하지 않았다. head 파일럿은 시드 0의 `axes-fresh-softmax-s0-ad4c60_r`(새 softmax 헤드)와 `axes-continuation-s0-y88e3_xo`(조건부 확률을 곱하는 continuation-ratio 헤드)다. 후자는 CORAL 구현이 아니며 CORAL의 보장을 인용하지 않는다.

## 4. 평가 데이터와 출처

개발 라벨은 구독 `claude-sonnet-5-5`(effort low, 동시성 16) 3회 투표의 반올림 평균이다(`passes` 3, 루브릭 sha256 `74bde7ea60b486009a6406dd4790e89dfe4679627a8a1e3e040b61a5aa8f5c37`). 하나라도 알 수 없음(unknown) 표가 있으면 채점에서 제외한다. OASST2와 OpenHands는 DEV, Arena는 미채점 FINAL이며 어느 세트도 학습에 쓰지 않았다. 채점자는 동결된 256토큰 입력만 봤다. 인코딩 지문(`frozen_encoding_fingerprint`)은 세 세트 모두 `5c79aaa8f9d5570f0c1e84834781a8d26c6d0ecd2b3753dc15630aac5420fd0a`이다.

### 4.1 커버리지

| 세트 | 동결 행 | 채점 | 제외 | xhigh 정답 | 상태 |
|---|---|---|---|---|---|
| OASST2 DEV | 3000 | **2847** | 153 = unknown 103 + 라벨링 실패 50 | 1 | 채점·평가 완료 |
| OpenHands DEV | 118 | **110** | 8 (unknown) | 0 | 채점·평가 완료 |
| Arena FINAL-A | 3000 | 0 | — | — | **동결만 하고 채점·평가 안 함** |

- OASST2 라벨 분포(low/medium/high/xhigh): 1100 / 1714 / 32 / 1. 라벨링 실패 50건은 pass 1에서 25, pass 2에서 25이며 모두 `invalid_reply`로 격리했다(합집합 ID 해시 `43c5341208686a3dd6b31c9b26ca9bd89e0b5ce9fbd83e714029499ed2d49bd2`). 투표된 행은 2950.
- OpenHands 라벨 분포: 48 / 53 / 9 / 0. 알 수 없음 투표 행 수(0/1/2/3표): 110 / 4 / 3 / 1.
- xhigh 정답이 OASST2에 1개, OpenHands에 0개라서 **xhigh 성능은 사실상 검증되지 않았다.**

### 4.2 출처·라이선스

| 세트 | 출처 | 리비전 | 라이선스 근거 |
|---|---|---|---|
| OASST2 | `OpenAssistant/oasst2` | `179dd21fc55192153d94adb0e0ce8f69e222bf75` | 데이터셋 카드 Apache-2.0. 기여자 단위 권리는 독립 검증 안 함. synthetic·deleted 표식 메시지는 요청과 부모 답변에서 제외 |
| OpenHands | `OpenHands/openhands-feedback` | `facf45600d625510b98222ec584a8c9ac59272a2` | 데이터셋 카드 MIT, 공개 제출 권한. 프롬프트에 붙은 제3자 내용의 권리는 확인 안 됨. 원문 재배포 금지 |
| Arena | `lmarena-ai/arena-human-preference-140k` | `6322995ab34d7c2693e3f47dd13fa5caa0789a74` | 사용자 프롬프트만 CC-BY-4.0. 모델 출력은 제공자 약관이라 쓰지 않음(`prev=''`) |

### 4.3 출처 해시

| 항목 | OASST2 DEV | OpenHands DEV | Arena |
|---|---|---|---|
| 동결 자료 디렉터리 | `C:/Project/mixdog-effort-judge/fresh_check/fresh_oasst2_2y_3av6v` | `C:/Project/mixdog-effort-judge/fresh_check/fresh_openhands_7tugc8qs` | `C:/Project/mixdog-effort-judge/fresh_check/fresh_arena_g23pagew` |
| `rows` sha256 | `63bc2246f7769e1f576ce432f3a2aeffccd8682c9ccb4f84fcb9bb5907aed502` | `2ae7e0c3a5d0281956bca3432db5e2457a40e77ea6b9567e1b0b4ed66b33cb76` | `955ada775086aae7eb3d8e91ee8041e5fe9b05f5f991cef84ef3af08913b090d` |
| `excluded` sha256 | `7f73af4623d302412c094e2462d51144cf7be7bc5a263d585cf9441e57387f90` | `09b820e7790ac4b611c8c85cf490aa811a3d13bcbfbffb71a8a73377711bd4ec` | `109bdacd19f4c0b7ad6f4715b6aa0c766af75f722ff7902a01eb1bc8d685e50f` |
| 입력 매니페스트 sha256 | `63c828212cf60ee59eb29dbdfe5266507fabf0fda4648296518b7e1d3df164d1` | `17e5ffe99a54caca9d8898f749a8c3868527b75aa62c24d6345796c47e1e65bb` | `31545e046f971441cf553c7b4b1400a3ae3639bb1f0dc7fdee0ebc368cfa7432` |
| 채점 라벨 sha256 | `c43403b1de77ae513b3d87e6e95f99e0bf0ba709e1f153dccd3bc6f81d3c2d7c` | `414073a115c59787d32f4260b7a795faa5b043c01d5883a8357a7be640f471f0` | 없음 |
| 미채점 라벨 sha256 | `0364f66a59c0ea138b72d2509a4c806535c9bdd302940a018edb7b02c6c038ba` | `c2af6e1a9bd1b748399458a5f6a76b3399aade5ffac728d24636ba6831f23a48` | 없음 |
| 라벨 보고서 sha256 | `96a64784660ce2c6c5d7de274c7e91685dbd657b86f6538e3b3fef7df98cef54` | `2769b73cdf79d8e970dc7bc7c633d4ff9c6fb7155949f516721c8d27b4c7cd84` | 없음 |
| 라벨 매니페스트 sha256 | `a348c1993afe856e468fdeacc257590bf61f44e01370bda977e6dea05be74236` | `cf7111ef913305692a16efb42fb9eb89cc7232a18ddfffb2b8d65aa635535b3f` | 없음 |
| 데이터셋 카드 sha256 | `52bd472cf3cae04a4b21ecd5316f929741c47d991d4763b041c3a94de072dc31` | `e7b7abb593d9f0c97bcda6e8ce689d577b5963dc20b2cfb22265cb36085f1b47` | `2960894314c63712189097b5fe731e6342ef1bdeedc16acbd52becd8dc7cf312` |

주요 모델 가중치 sha256(평가 시점, `summary.json`): 기준선 s0 `dedb183bb1f85a82e43144a8a5566e95a841afdf6720bd268714b8c56714fc7b`, `b3x5` `7aed599b9287…` (앞 12자리는 아래 표 참고). 모델 파일은 삭제 대상이므로 이 해시는 기록용일 뿐 복원 수단이 아니다.

데이터 범위 한계:

- OASST2: 자원봉사자가 쓴 채팅 프롬프트(2023, 다국어, 롤플레이·지시형 많음)이며 코딩 에이전트 트래픽이 아니다. 후속 요청은 부모 어시스턴트 답변 하나만 문맥으로 유지한다. 같은 대화 트리의 행은 독립이 아니다(군집 1203개 동결).
- OpenHands: 최대 150개로 상한을 정했고 적격 118개만 얻었다(보충 없음). 피드백 버튼을 누른 자기 선택 표본이며 근사 중복은 걸러내지 못한다. 규모가 작다.
- Arena: 행 그룹 해시로 고른 부분집합(20분의 1)이며 전체를 스캔하지 않았다. 첫 프롬프트만 쓴다. 채점된 적이 없으므로 이 세트로 얻은 결과는 없다.
- 입력은 256 토큰에서 잘린다. 라벨은 Sonnet low 3표이므로 라벨 잡음과 학습 시드 분산은 신뢰구간에 반영되지 않는다.
- 평가는 모두 채점된 부분집합에 조건부이며, 각 태그를 개별 보고하고 최고 시드 선택이나 팔 평균을 공식 지표로 쓰지 않는다고 평가기 자체가 명시한다. 아래의 평균은 이 보고서가 계산한 요약이다.

## 5. 결과

큰 오판(severe)은 정답과 예측이 2단계 이상 다른 건수다. 퍼센트는 완전 일치(exact) 비율이다.

### 5.1 OASST2 DEV (n = 2847)

출처: `C:/Project/mixdog-effort-judge/fresh_dev_eval/fresh_dev_eval_ogr5x290/summary.json`(기준선·feature·A-GEM·head), `C:/Project/mixdog-effort-judge/fresh_dev_eval/fresh_dev_eval_ahxiu95r/summary.json`(midpoint).

| 모델 | 시드 | 정답 수 | exact | severe | 가중치 sha256 앞 12자 |
|---|---|---|---|---|---|
| 기준선 | 0 | 2174 | 76.3611% | 20 | `dedb183bb1f8` |
| 기준선 | 1 | 2183 | 76.6772% | 23 | `5d623bcf7b18` |
| 기준선 | 2 | 2185 | 76.7475% | 20 | `d54d6a331c99` |
| **기준선 평균** | 0–2 | 2180.667 | **76.59525%** | **21.000** | |
| feature | 0 | 2170 | 76.2206% | 23 | `2f47cce96bb1` |
| feature | 1 | 2173 | 76.3260% | 28 | `d0c54767ea6f` |
| feature | 2 | 2163 | 75.9747% | 22 | `56da39b9bd1e` |
| **feature 평균** | 0–2 | 2168.667 | **76.17375%** | **24.333** | |
| midpoint | 0 | 2163 | 75.9747% | 24 | `f22d65649d66` |
| midpoint | 1 | 2177 | 76.4665% | 23 | `61d5c9e2ba6f` |
| midpoint | 2 | 2172 | 76.2908% | 23 | `6d4825988c60` |
| **midpoint 평균** | 0–2 | 2170.667 | **76.244%** | **23.333** | |
| A-GEM | 0 | 2178 | 76.5016% | 21 | `1a835ab8f14f` |
| A-GEM | 1 | (학습 완료, 평가 안 함) | — | — | — |
| A-GEM | 2 | (취소, 미완료) | — | — | — |
| 초기 `b3x5` | — | 2158 | 75.7991% | 24 | `7aed599b9287` |
| head: 새 softmax | 0 | 2163 | 75.9747% | 24 | `33b3671844fd` |
| head: continuation | 0 | 2081 | 73.0945% | 46 | `9d806eb7dd47` |

기준선 s0에 대한 xhigh 재현은 1/1(모든 모델 동일)이다.

### 5.2 OpenHands DEV (n = 110)

출처: `C:/Project/mixdog-effort-judge/fresh_dev_eval/fresh_dev_eval_aij1cfng/summary.json`. xhigh 정답 0개.

| 모델 | 시드 | 정답 수 | exact | severe |
|---|---|---|---|---|
| 기준선 | 0 / 1 / 2 | 77 / 77 / 75 | 70.0000% / 70.0000% / 68.1818% | 1 / 0 / 1 |
| **기준선 평균** | | 76.333 | 69.39% | 0.667 |
| feature | 0 / 1 / 2 | 74 / 78 / 75 | 67.2727% / 70.9091% / 68.1818% | 0 / 0 / 0 |
| **feature 평균** | | 75.667 | 68.79% | 0.000 |
| midpoint | 0 / 1 / 2 | 78 / 78 / 78 | 70.9091% ×3 | 1 / 0 / 1 |
| **midpoint 평균** | | 78.000 | 70.91% | 0.667 |
| A-GEM | 0 | 78 | 70.9091% | 1 |
| `b3x5` | — | 79 | 71.8182% | 0 |
| head: 새 softmax | 0 | 77 | 70.0000% | 1 |
| head: continuation | 0 | 82 | 74.5455% | 1 |

OpenHands는 표본이 110개라 정답 1건이 약 0.91%p를 움직인다. xhigh도 없으므로 이 세트만으로 일반화나 보존을 입증하지 않는다.

### 5.3 기준선 대비 짝 비교 (OASST2)

같은 입력과 같은 시드의 기준선을 짝지었다. 수치는 후보에서 기준선을 뺀 값이다.

| 후보 | 시드 | 정답 증감 | 큰 오판 증감 |
|---|---|---:|---:|
| feature | 0 / 1 / 2 | −4 / −10 / −22 | +3 / +5 / +2 |
| midpoint | 0 / 1 / 2 | −11 / −6 / −13 | +4 / 0 / +3 |
| A-GEM | 0 | +4 | +1 |

평가기가 저장한 기본 짝 비교는 시드 0 기준선에 대한 비교다. 위의 매칭 시드 차이는 저장된 각 시드 예측과 정답을 다시 대조해 확인했다. 채점된 OASST2의 대화 트리는 1190개다. 군집 부트스트랩은 라벨 잡음이나 학습 시드 자체의 불확실성을 추정하지 않는다.

## 6. 후보별 판단과 기각 사유

| 후보 | exact 평균 | severe 평균 | 기준선 대비 | 판단 |
|---|---|---|---|---|
| feature 보존 | 76.17375% | 24.333 | exact −0.4215%p, severe +3.333 | **기각** |
| midpoint 50% | 76.244% | 23.333 | exact −0.3513%p, severe +2.333 | **기각** |
| A-GEM | 시드 0만 | 21 (기준선 s0 20) | 시드 0: 정답 +4(2178 대 2174), severe +1 | **판단 불가** (시드 1 미평가, 시드 2 미완료) |
| 새 softmax 헤드 | 75.9747% (시드 0) | 24 | s0 기준선보다 낮음 | 개선 증거 없음 |
| continuation 헤드 | 73.0945% (시드 0) | 46 | 크게 나쁨 | 기각 |

- **feature:** 매칭 시드 3개의 평균 exact가 기준선보다 낮고 severe가 늘었다(24.333 대 21). 시드 0과 2는 기준선보다 낮고 시드 1은 비슷하지만 severe는 28로 가장 나쁘다. 개선 근거 없음.
- **midpoint:** 시드별 exact 편차가 있으나(75.9747%~76.4665%) 평균이 기준선보다 낮고 severe가 증가했다.
- **A-GEM:** 시드 0은 기준선과 거의 같다(2178 대 2174, severe 21 대 20). 한 시드의 +4 정답은 시드 분산 안에 있으며(기준선 시드 간 정답 수 범위 2174~2185), severe도 1 늘었다. 시드 1(`axes-agem-s1-dbzegeuj`)은 학습이 끝났지만 평가하지 않았고, 시드 2(`axes-agem-s2-vu12_lw9`)는 종료 코드 137로 취소돼 미완료다. 따라서 채택도 기각도 하지 않는다.
- 어떤 후보도 사전에 정한 **완전 일치 상승과 큰 오판 감소의 동시 달성, 기존 능력·xhigh 보존**을 입증하지 못했다.

## 7. 인프라 사고와 실험 코드 최적화

### 7.1 데몬 충돌

- **첫 번째 충돌:** 호스트 커밋 메모리 부족(OOM)으로 확인했다. 할당 실패 4MiB, 사용 가능 7.3MiB였다.
- **두 번째 충돌:** Crashpad 처리기가 먼저 종료됐고 데몬은 오류 기록 서버의 무응답으로 자체 종료했다. 최초 예외가 남지 않아 **근본 원인은 미확정**이다.
- 대형 바이너리를 `apply_patch`로 다룰 때 버퍼링하는 문제는 **추가 위험 요인**으로 확인했으나 첫 충돌의 원인은 아니다.

### 7.2 완화 조치와 한계

- 체크포인트 저장에 크기 제한을 두고(bounded checkpoint save), 무거운 작업을 직렬로 실행한 뒤 이후 실행이 안정적이었다. 이는 **영구 해결의 증명이 아니다.** 충돌 원인이 둘 다 완전히 규명되지 않았기 때문이다.
- A-GEM 시드 2의 종료 코드 137은 **사용자가 중단을 요청해 작업을 취소한 결과**다. OOM이나 자연 실패의 증거로 해석하면 안 된다.
- 체크포인트 저장 제한 등 실험 코드 최적화는 작은 직접 작성 스크립트(`C:/Project/mixdog-effort-judge/checkpoint_io.py`, `C:/Project/mixdog-effort-judge/train3.py` 등)에 들어 있고, 정리 때 보존 대상이다(7.4 참고). 다만 이 스크립트만으로 모델이나 결과가 복원되지는 않는다.

### 7.3 유지되는 것

- 앱 소스와 서비스 v2 런타임 최적화는 유지한다. 이 최적화는 앱 실행 효율(경량 토크나이저, 스레드·입력 길이 제한, 단일 큐 처리 등 DEVLOG에 기록된 항목)에 관한 것이며 **이번 실험에서 얻은 모델 성능 향상이 아니다.** 이번 실험의 후보 모델은 어느 것도 앱에 들어가지 않았다.
- 앱 모델 목록(`src/runtime/effort-judge/model-manifest.json`)의 `effort-judge-v2` 파일 해시: `model.onnx` `87bc3eee48585aa77a4130e673ac2a757120aabc49ea96003a4021acae2c4ad5`(130,798,686 B), `tokenizer.json` `22c064aaa468855d6211fe5c2ec8fdec595c97c55eb2ffd3b9fdf71a93b16292`(32,170,665 B), `calibration.json` `90b52eb22c49694ee7998a3116b4888e51131d5d22bfb34b0dee190d47a55d00`(148 B).

### 7.4 설치된 서비스 검증과 정리 범위

설치 검증(삭제 전에 확인한 사실):

- `C:/Users/tempe/.mixdog/data/models/effort-judge/`의 `model.onnx`, `tokenizer.json`, `calibration.json`이 앱 모델 목록 v2의 해시와 모두 일치한다.
- `MIXDOG_EFFORT_JUDGE_DIR` 재정의는 프로세스·사용자·머신 어디에도 없고, 기본 데이터 디렉터리는 `C:/Users/tempe/.mixdog/data`이다.
- 앱 소스는 학습 저장소를 미러 주석과 테스트에서만 언급하며 **런타임 의존성이 없다.**
- 현재 소스의 `judge-client` 타임아웃: warm 400ms, queue 1000ms, cold 3000ms. 워커는 CPU, `graphOptimizationLevel` all, `intraOpNumThreads` 4. 이 값들과 설치된 `tokenizer.bin`은 보존한다.

정리 범위(정확히):

- **삭제 완료:** 실험용 데이터·모델·환경 디렉터리와 루트의 데이터 파일(모델, 체크포인트, ZIP, 데이터셋, 라벨, 캐시, 학습 환경).
- **보존:** 직접 작성한 작은 소스·최적화 스크립트(`C:/Project/mixdog-effort-judge/checkpoint_io.py`, `C:/Project/mixdog-effort-judge/train3.py` 포함), 앱 소스, 앱 코드 복제본 `C:/Project/mixdog-auto-effort`, 그리고 위의 설치된 서비스 파일.
- 따라서 정리 후에도 이 보고서 외에 위 스크립트와 앱 코드가 남는다. "보고서만 남는다"는 뜻이 아니다.
- 이전 승인으로 테스트 가중치 10개, midpoint 가중치 3개, 미채택 가중치 8개를 삭제했다. 이 보고서의 수치·해시 검증 후 나머지 실험 자료도 일괄 삭제했다. 상세 결과는 9장에 기록했다.

## 8. 한계와 재현 불가 범위

1. 모델, 체크포인트, 라벨, 학습 데이터, 전용 환경을 삭제했으므로 이 보고서만으로는 **모델 복원이나 결과의 독립 재실행이 불가능하다.** 위 해시는 무엇이었는지 식별하는 용도이며 복원 수단이 아니다. 문서에 적힌 실험 산출물 경로는 삭제 전 출처 기록이다.
2. 비교는 팔당 시드 3개의 DEV 평균이다. 시드 간 편차(기준선 exact 76.36~76.75%)가 후보 간 차이(0.35~0.42%p)와 비슷한 크기다.
3. 평가 세트는 채팅·피드백 프롬프트로, 실제 코딩 에이전트 트래픽 전체를 대표하지 않는다. OpenHands는 110개뿐이고 xhigh 정답은 합쳐서 1개다.
4. Arena는 동결했을 뿐 채점하지 않았다. FINAL-A는 한 번도 점수를 내지 않았다.
5. A-GEM 판정은 시드 1개 결과뿐이라 일반화할 수 없다.
6. 라벨은 Sonnet low 3표이며 라벨 잡음은 부트스트랩에 반영되지 않는다.
7. 인프라 충돌의 두 번째 원인은 미상이며 완화 조치의 효과는 관찰적이다.

## 9. 종결 상태

- 채택: 없음. 서비스 변경, 커밋, 푸시, 배포: 없음.
- 사용자 중단 요청 이후 실험을 재개하지 않았다. 보고서 작성·검증과 승인된 정리만 진행했다.
- 이 파일(`docs/effort-judge-experiment-report.md`)이 이번 실험 결과의 보존 기록이다. 소규모 작성 스크립트와 앱 코드는 7.4의 범위대로 별도로 남는다.
- 최종 정리: 실험 하위 디렉터리 54개, 루트 데이터 파일 210개, 분석 하위 데이터 파일 52개와 전용 환경 `C:/Users/tempe/AppData/Local/Temp/mixdog-effort-cache-aLTngR`를 제거했다. 총 48,828개 파일, 논리 용량 **52,078,291,949바이트(약 52.08GB)**다.
- 정리 직후 C: 여유 공간은 **62,136,815,616바이트(약 62.14GB)**였다. 파일 시스템의 여유 공간은 다른 작업에 따라 달라질 수 있다.
- 삭제 직후 서비스 파일·최적화 소스·보고서 등 보호 파일 435개의 SHA-256이 삭제 전과 같음을 확인했다. 설치된 v2 세 파일도 릴리스 매니페스트와 다시 일치했다. 이후 이 보고서에만 정리 결과를 추가했다.
- 모델·백업·라벨·데이터와 학습 환경은 휴지통이 아닌 영구 삭제다. 작은 작성 스크립트는 남지만 재실험에는 환경 설치, 자료 재수집·재채점과 재학습이 필요하다. 모델 개선 목표를 달성한 것으로 완료 처리하지 않는다.
