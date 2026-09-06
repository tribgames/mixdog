# Office 검증 실행

변경한 기능을 소유한 테스트만 실행합니다. 일반 코드 수정 때문에 실제 Office 전체 검증을 반복하지 않습니다.

| 명령 | 범위 |
| --- | --- |
| `npm run test:office` | 일반 계약·파일 편집·품질 계산 검증. Microsoft Office를 열지 않습니다. |
| `npm run test:office:render` | 별도 PPTX 렌더 검증. LibreOffice 등 렌더 의존성이 필요합니다. |
| `npm run test:office:live -- excel` | Excel 세션·편집·트랜잭션 |
| `npm run test:office:live -- word` | Word 세션·편집 |
| `npm run test:office:live -- powerpoint` | PowerPoint 편집·저장·다시 열기·슬라이드 가져오기 |
| `npm run test:office:live -- author` | PPTX 재작성 시 세션 재사용 |
| `npm run test:office:live -- attach` | 열린 Excel 문서의 정확한 연결 |
| `npm run test:office:live -- contract` | 실제 Office와 portable 백엔드의 스냅샷 호환성 |
| `npm run test:office:compat` | 매크로·서식 9종 전체 호환성 |
| `npm run test:office:live:all` | 모든 라이브 검증. 전체 검증이 필요한 경우에만 선택합니다. |

라이브 명령에 범위를 주지 않으면 도움말만 표시하고 Office를 실행하지 않습니다.
라이브 검증에는 Windows와 Microsoft Office가 필요하며, 일부 검증은 실제 창을 사용합니다.
여러 라이브 검증을 동시에 실행하지 않습니다. 출력은 완료 때까지 모으지 않고 즉시 전달합니다.

기존 파일·테스트 이름 지정 방식도 지원합니다.

```powershell
npm run test:office:live -- src/runtime/office/office-live-runtime.test.mjs 're-authoring a deck'
```

`compat`은 `docm`, `dotm`, `dotx`, `xltx`, `xltm`, `xlsm`, `pptm`, `potx`, `potm`을 모두 검사합니다.
각 형식의 결과가 별도로 표시됩니다. 검사 자체를 삭제하거나 임의 표본으로 대체하지 않습니다.

실패한 검사는 전체 로그를 보존하고 원인을 확인한 뒤, 수정한 범위만 다시 실행합니다.
이미 통과한 검사는 관련 변경이 없는 한 반복하지 않습니다.
