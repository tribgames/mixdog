# 샘플 PPT 제작·검수 결과

## 전달 파일
- 편집 가능한 8장 PPT: `ai-work-proposal-delivery.pptx`
- 전체 미리보기: `ai-work-proposal-delivery.mixdog-preview.pdf`
- 한눈에 보기: `ai-work-proposal-delivery.mixdog-preview.mixdog-contact.png`

모든 수치와 운영 범위는 예시다. 실제 성과나 예측값이 아니다.
표지 이미지는 Gemini의 `gemini-3.1-flash-image`로 생성했다.
이미지 비율은 3:4이며 전체 프롬프트와 출처는 표지 발표자 노트에 있다.

## 적용·확인 결과
- 글자 역할, 색상 팔레트, 여백 규칙과 상태별 표·콜아웃을 적용했다.
- 가로 막대 차트, 표, 흐름도와 일정표는 편집 가능한 기본 개체다.
- 작성 스크립트의 측정 검사와 원고 대조를 통과했다.
- 페이지 QC는 복구 실행을 포함해 1–8장 모두 `unchanged`였다.
- 독립 리뷰는 원고의 수치·단위·제한 조건과 사람의 승인 책임을 확인했다.
- 독립 리뷰의 두 보완 사항인 7장 열 간격과 8장 대상 업무 확정 요청을 반영했다.
- PowerPoint COM 미리보기로 초안을 검수하고, 최종본은 Mixdog OOXML portable 경로의 전체 페이지 이미지로 자체 재검수했다. 실제 PowerPoint 창을 눈으로 조작한 검수가 아니다.
- 최종 `finalize`가 `finalized: true`, `saved: true`, `closed: true`, `validation.ok: true`를 반환했다.
- 원본과 비교한 마스터·레이아웃·차트 관련 보호 부품의 손실 및 변경은 없었다.

## 남은 비차단 진단
- `flat_visual_rhythm`은 정보 수준이다. 내용 페이지의 밝은 배경은 분석 자료의 일관성을 위해 유지했다.
- 원본 패키지의 `notesMasterIdLst`와 차트의 `axId`에 Open XML SDK 호환성 경고가 있다. 도구의 검증 결과는 통과이며, 경고를 없애기 위해 임의로 검증 강도를 낮추거나 원본 구조를 변경하지 않았다.

## 제작 중 발견한 도구 개선 후보 — 소스는 수정하지 않음
- 여러 페이지를 같은 프로세스에서 QC하면 첫 실행 뒤 `WS pool drained — process exiting`이 발생했다. `qc-report.json`은 개별 실행 실패가 있어도 상위 `ok: true`를 반환했다. 별도 프로세스와 복사본으로 검수를 완료했다.
- headless 종료 시 임시 `pg.log` 정리에 `EBUSY`가 반복되고 완료 출력이 늦게 보였다. 파일 결과와 검수 결과에는 영향을 주지 않는다는 런타임 진단이 있었다.
- PowerPoint COM 저장이 차트 워크북 이름과 마스터·테마를 다시 작성해 보호 부품 비교에 걸렸다. 실패한 중간 산출물을 보존하고, 원본에서 portable 편집으로 최종본을 만들어 보존 검증을 통과했다.

초안과 시험 구성, 실패·복구 보고서는 재현 근거로 남겨 두었다.
실제 전달용 파일은 위 `ai-work-proposal-delivery.pptx`다.
