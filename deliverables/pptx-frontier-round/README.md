# PPTX 프론티어 라운드 — 산출물

R1–R4를 한 라운드로 압축해 런타임·스킬을 바꾸고, 그 킷으로 벤치마크 덱 한 벌을 작성해 렌더·크리틱·finalize까지 통과시킨 결과입니다.

## 열어 볼 것

| 파일 | 내용 |
| --- | --- |
| `slidesgen-brief.pptx` | 최종 덱 (9장, 한국어, PowerPoint에서 편집 가능 — 네이티브 차트 2·표 1·그라디언트 3) |
| `slidesgen-brief.mixdog-preview.pdf` | 같은 덱의 PDF |
| `slidesgen-brief.mixdog-preview-page-1..9.png` | 페이지별 미리보기 (PowerPoint COM 렌더, 1400×788) |
| `slidesgen-brief.mixdog-preview.mixdog-contact.png` | 콘택트 시트 |
| `slidesgen-brief.js` | 덱을 만든 스크립트 (brief + `deck()` + 슬라이드; 킷은 런타임 프렐류드) |
| `cover.png` | 표지·클로징의 생성 이미지 (레인 openai-oauth, 스피커 노트에 프롬프트 요지 기록) |
| `critique.json` | finalize에 넘긴 슬라이드별 크리틱 (9장, 체크 32개 전부 pass) |
| `final-result.json` | 마지막 author → qa → render → finalize 결과와 리시트 |
| `measure-2.json` → `measure-5.json` | 루프 단계별 측정 (첫 전체 렌더 → 결함 5건 수정 → 테이크어웨이 스케일 수정 → R5 킷 적용) |
| `aesthetics/` | SlidesGen-Bench 미학 지표 결과(R4·R5, 텍스트 영역 포함)와 페이지별 텍스트 영역 JSON |
| `trials/` | 방향 비교(A editorial vs B swiss-minimal) 트라이얼 2장과 그 측정 |

## 이번 라운드에 바뀐 것 (런타임·스킬)

1. **런타임 킷 프렐류드** — `src/runtime/office/authoring/pptx-kit.mjs`가 `kit.md`·`charts.md`·`pictures.md`의 코드 블록을 스크립트 앞에 실행합니다. 스크립트는 brief, `deck({ hue, accentHue?, mode, script, pairing, fonts })`, 슬라이드만 담고(이 덱 151줄), 오류 줄번호는 프렐류드 길이를 빼서 보정되며, 자체 `pres`를 선언한 옛 스크립트는 프렐류드 없이 돕니다. 결과의 `authored.kit: "runtime"`로 확인.
2. **2색 팔레트 기본값** — 시드 hue에서 보색 액센트(`accentHue`)를 유도하는 `palette()`와 `direction.md` §5. 이 덱은 hue 222 + 액센트 12(표지 사진의 코랄 마크와 같은 색).
3. **존재감 관측·루브릭** — 리시트 `observe.presence`(가장 큰 캐리어의 캔버스 점유)와 deck-bench `presence` 축, `composition.md`의 주 캐리어 Default.
4. **네이티브 그라디언트** — 킷 `gradient()`·`scrim()` 마커를 normalizer가 `<a:gradFill>`로 치환합니다. 이 덱은 3개(표지 스크림, 클로징 필드·스크림), PNG 래스터 없음.
5. **그림 기본값** — 레인이 있으면 표지(와 클로징 1장)에 생성 이미지를 쓰고, 덱당 하나의 이미지 언어와 스크림 규칙을 지킵니다(`SKILL.md` 1단계, `pictures.md` §0, `direction.md` §4).
6. **드라이버** — `scripts/office/author-deck.mjs`: 작업 트리의 런타임으로 author → qa → render → finalize를 한 번에 돌립니다(설치된 앱은 자기 런타임 사본을 쓰므로).

## 덱 검사 결과

- 측정: 매 author마다 `qa: 0 measured, 0 advisory`. finalize `ok`(크리틱 9장, 체크 32개 pass). 렌더러는 PowerPoint COM(`microsoft-office-com`).
- 눈 검사: 9장 전부를 실제 크기로 보고, 바뀐 페이지는 두 번째 렌더에서 다시 봤습니다. 루프 두 번에 고친 것:
  - 2쪽: 세로 룰을 문장 두 줄 높이에 맞추고 블록을 중앙으로, `두 축을`이 갈리지 않게 줄바꿈 지정
  - 3쪽: `Skywork` 레이블이 점선을 가로지르던 것을 점선 오른쪽으로
  - 6쪽: 표 행 높이 0.5 → 0.44in, 캡션–테이크어웨이 간격 0.08 → 0.6in
  - 8쪽: 아이콘 0.7 → 0.9in, 행을 본문 띠 가운데로, 외래어 분절·한 음절 마지막 줄 없이 줄바꿈 지정
  - 9쪽: 요청 문장 줄바꿈 지정(`받/는다` 분절 제거)
  - 6·8쪽: 테이크어웨이가 17·20pt로 줄어들던 것을 스케일 단계(22 → 18)로만 내려가게 스크립트에서 재정의 → 타입 세트 12 → 10개
- 남긴 것: 4·5·7쪽 본문의 글자 단위 줄바꿈은 PowerPoint의 한국어 기본 동작이고 고아 줄이 없어 그대로 뒀습니다.

## deck-bench 점수

같은 덱의 라운드 내 변화가 기준입니다(다른 덱과의 절대 비교는 의미가 약합니다).

| 시점 | 점수 | 바뀐 축 |
| --- | --- | --- |
| 결함 5건 수정 후 | 66 | fit 1.00, rhythm 1.00, carriers 1.00, presence 0.82 |
| 테이크어웨이 스케일 수정 후 (R4 최종) | **69** | type_scale 0.29 → 0.57 |
| R5 킷·루브릭 적용 후 (최종) | **71** | spacing_vocabulary 0 → 0.13 (간격 18 → 11종), alignment 0 → 0.41 (미정렬 4.8 → 2.8) |

낮게 남은 축 — `spacing_vocabulary` 0(간격 18종), `alignment` 0(오른쪽 미정렬 4.8), `body_line` 0.22 — 은 V-E 매트릭스·덤벨의 노드 레이블과 히어로 숫자가 제목 아래 오는 페이지를 세는 값이라, 도표 중심 덱에서는 읽기 자료이지 결함이 아니라고 판단해 쫓지 않았습니다. 이력은 `.tmp/pptx-deck-bench.json`.

## 검증

- 단위 테스트 49건 통과: `authoring/pptx-receipt`, `pptx-script-normalize`, `pptx-brief`, `quality/pptx-deck-rubric`, `render-air`, `office-authoring`, `office-runtime-design`
- 킷 slow 테스트(`test:office:render`) 7건 통과 — 킷 덱 author·검증·측정 리뷰, 한국어 safe 페어링, 그림 킷
- 커밋하지 않았습니다(오전 세션의 미커밋 변경 위에 있습니다).

## R5 — 어절 줄바꿈, 스케일 스텝, 루브릭 소음 제거, 외부 척도

### 바뀐 것

1. **킷 어절 줄바꿈** — `kit.md` §3 `wrapKo`·`wrapRuns`. `text`·`title`·`head`·`emphasis`·`bullets`·`prose`·`takeaway`·`flow`·`stack`·히어로 레이블이 한글을 어절 경계에서 미리 끊어 소프트 줄바꿈(`a:br`)으로 한 단락 안에 넣습니다. 작성자의 `\n`은 그대로 두고, 측정은 영역의 98%에서 합니다. 이 덱의 4·5·7·8쪽은 수동 줄바꿈 없이 어절 단위로 감기고, 수동 줄바꿈은 수사가 요구하는 세 곳(2쪽 문장 경계, 3쪽 네 줄 스탠자, 9쪽 파일명 줄)에만 남았습니다.
2. **스케일 스텝 축소** — `fitSize`와 `title`이 1pt씩이 아니라 타입 스케일·도표 크기 단계(22 → 18 → 14 → 13)로만 내려갑니다. 스크립트의 `takeaway` 재정의를 지웠고 타입 세트는 10개(17·20 없음)를 유지합니다.
3. **루브릭 소음 제거** — 리시트가 도형·연결선(두께 0인 hairline·rule 포함)에서 0.3in 안에 붙은 작은 텍스트(≤ 2.5 × 0.4in)를 도표 레이블로 읽어 정렬·간격 축에서 빼고 `textColumns.labels`로 셉니다. 이 덱: 간격 어휘 18 → 11종, 3·5쪽 오른쪽 미정렬 11·12 → 3·3, deck-bench 69 → 71.
4. **외부 척도** — `scripts/office/aesthetics-probe.mjs`가 페이지 PNG와 덱 자체의 텍스트 상자 좌표(폭은 측정된 글자 폭으로 좁혀 탐지기 상자에 가깝게)를 벤치의 PaddleOCR 레이아웃 형식(`detection/*.json`)으로 스테이징하고, `refs/slidesgen-bench/eval/aesthetics_metrics.py`(venv `.tmp/slidesgen-venv`: numpy·opencv·scipy·scikit-image·pyrtools, 설정 `eval/aesthetics_config.json`)를 9장 파일 목록으로 돌립니다. 디렉터리 입력은 Windows에서 이미지를 두 번 세고, `pyrtools`가 없으면 리듬 축이 대체값으로 채워지므로(작업 중 나온 13.83·16.60은 그 상태의 값) 두 조건을 갖춰 다시 잰 것이 아래 표입니다.

### 외부 점수 — SlidesGen-Bench aesthetics (같은 설정, 텍스트 영역 포함)

| | Usability | Engagement | Harmony | Rhythm | 총점 |
| --- | --- | --- | --- | --- | --- |
| R5 덱 — 텍스트 영역 = 상자 전체 | 3.17 | 6.34 | −2.20 | 2.71 (엔트로피 2.71 + RMSSD 0) | 10.02 |
| R5 덱 — 텍스트 영역 폭을 글자 폭으로 좁힘 (최종) | **4.02** | 6.34 | −2.20 | 2.71 | **10.87** |
| R4 덱 (상자 전체, 영역은 R5 좌표 재사용) | 3.13 | 6.34 | −2.20 | 2.71 | 9.98 |
| 벤치 11개 시스템 범위 | 4.13 – 5.72 | 5.93 – 8.30 | −2.15 – −0.35 | 4.57 – 15.01 | 12.63 – 27.28 |

읽기:

- **Usability 4.02 (벤치 4.13 – 5.72 바로 아래)** — 유일하게 설계와 충돌하지 않는 격차입니다. 영역을 상자 전체로 주면 3.17, 글자 폭으로 좁히면 4.02: 키커·출처 줄·히어로 레이블처럼 글보다 넓은 상자가 빈 종이를 대비로 읽히게 했던 몫이 0.85였고, 탐지기 상자는 세로로도 촘촘하므로 실제 값은 이보다 조금 높습니다. 남은 격차는 팔레트 몫입니다 — 본문색을 paperAlt 위 7:1, muted를 4.5:1에 두는 규칙이라 상위 시스템의 거의 검정 본문보다 낮게 읽힙니다. 페이지별 평균은 표지 0.68·8쪽 0.59·3쪽 0.60이 높고 2쪽 0.26·6쪽 0.27이 낮습니다(6쪽은 틴트 헤더와 얼룩 행이 든 표 프레임 전체가 한 영역).
- **Engagement 6.34** — 색채도 평균 15.9(지표의 목표 26). 중립 사다리 + 액센트 하나라는 방향의 대가이며, 이미지가 매 장 있는 시스템이 이기는 축입니다.
- **Harmony −2.20** — 슬라이드별 조화 거리는 작지만(0.001–0.024) 표지 사진(0.170)이 덱 일관성(0.31)을 깨서 페널티를 받습니다. 사진 앵커 + 흰 본문 페이지 구성이면 피하기 어렵습니다.
- **Rhythm 2.71** — 엔트로피 평균 3.04(목표 5.4: 우리 페이지가 덜 복잡함)이고, RMSSD 0.30이 목표 창 0.03 ± 0.21 밖입니다. 이 지표는 슬라이드 간 복잡도가 **고르게** 이어지는 것을 보상하므로 anchor → breathing → dense 리듬과 정반대입니다. 쫓지 않기로 합니다.
- 주의: 우리 렌더는 PowerPoint COM 1400×788, 벤치는 LibreOffice 렌더이며, 텍스트 영역은 탐지기가 아니라 덱 좌표에서 왔고, 벤치 값은 189개 과제 평균입니다. 절대값은 참고, 라운드 간 이동이 읽을 값입니다.

### 검증

- 단위 테스트 57건 + 새 킷 테스트(어절 줄바꿈·스케일 스텝 동작, MEASURE 대체로 폰트 없이 검증) 1건 통과, 킷 slow 테스트 7건 포함.
- finalize `ok`(크리틱 9장 갱신), qa 0.

## 남은 후보 (승인 후 별도 작업)

1. 팔레트 본문 대비 상향(`direction.md` §5: body 7:1 → 10:1 이상, muted 4.5:1 → 6:1) — Usability 축이 직접 오르지만 모든 덱의 본문색이 어두워지는 결정입니다.
2. 독립 아트디렉터 패스(다른 모델이 렌더를 보고 keep/fix 목록) — 자기 검토의 맹점 보완.
3. QuizBank식 내용 보존 검사(원문 문항 10개를 비전 모델이 렌더만 보고 답함).
4. deck-bench가 덱 옆에 `.mixdog-edit` 작업 사본과 미리보기를 남기는 것 — 이 폴더에서는 수동으로 지웠습니다.

## 재현

```
node scripts/office/author-deck.mjs deliverables/pptx-frontier-round/slidesgen-brief.js deliverables/pptx-frontier-round/slidesgen-brief.pptx --mode auto --critique deliverables/pptx-frontier-round/critique.json --out deliverables/pptx-frontier-round/final-result.json
node src/runtime/office/bench/deck-bench.mjs deliverables/pptx-frontier-round/slidesgen-brief.pptx
node scripts/office/aesthetics-probe.mjs deliverables/pptx-frontier-round/slidesgen-brief.pptx deliverables/pptx-frontier-round/slidesgen-brief.mixdog-preview .tmp/aesthetics/slidesgen-brief-r5
.tmp/slidesgen-venv/Scripts/python.exe C:/Project/refs/slidesgen-bench/eval/aesthetics_metrics.py (Get-ChildItem .tmp/aesthetics/slidesgen-brief-r5/slide_images/*.png | Sort-Object Name | ForEach-Object FullName) --compute-score --config C:/Project/refs/slidesgen-bench/eval/aesthetics_config.json --no-parallel -o .tmp/aesthetics/slidesgen-brief-r5.json
```
