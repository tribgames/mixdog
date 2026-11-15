# Office 검증 실행

Office 엔진은 Rust(`native/core/crates/mixdog-office*`)에 있고, 그 검증은 cargo 테스트입니다.
Node에는 PPTX 작성 스크립트(`src/runtime/office/authoring/pptx-script-entry.mjs`)와 그 import 닫힘만 남아 있으며, 그 테스트만 실행합니다.

| 명령 | 범위 |
| --- | --- |
| `npm run test:office` | PPTX 작성 스크립트(정규화·키트 색인·차트 스타일·글꼴 준비)와 데스크톱 승인 카드 검증. Microsoft Office를 열지 않습니다. |

라이브 검증(Windows와 Microsoft Office 필요)은 Rust 쪽 `mixdog-office`의 `live_com` 테스트입니다.
여러 라이브 검증을 동시에 실행하지 않습니다. 출력은 완료 때까지 모으지 않고 즉시 전달합니다.

실패한 검사는 전체 로그를 보존하고 원인을 확인한 뒤, 수정한 범위만 다시 실행합니다.
이미 통과한 검사는 관련 변경이 없는 한 반복하지 않습니다.
