# Office 검증 실행

변경한 기능을 소유한 테스트만 실행합니다. 일반 코드 수정 때문에 실제 Office 전체 검증을 반복하지 않습니다.

| 명령 | 범위 |
| --- | --- |
| `npm run test:office` | 일반 계약·파일 편집·품질 계산 검증. Microsoft Office를 열지 않습니다. |
| `npm run test:office:render` | 별도 PPTX 렌더 검증. LibreOffice 등 렌더 의존성이 필요합니다. |

라이브 검증에는 Windows와 Microsoft Office가 필요하며, 일부 검증은 실제 창을 사용합니다.
여러 라이브 검증을 동시에 실행하지 않습니다. 출력은 완료 때까지 모으지 않고 즉시 전달합니다.

라이브 검증은 파일과 테스트 이름을 지정해 실행합니다.

```powershell
node scripts/test-direct.mjs --test-name-pattern='re-authoring a deck' src/runtime/office/office-live-runtime.test.mjs
```

실패한 검사는 전체 로그를 보존하고 원인을 확인한 뒤, 수정한 범위만 다시 실행합니다.
이미 통과한 검사는 관련 변경이 없는 한 반복하지 않습니다.
