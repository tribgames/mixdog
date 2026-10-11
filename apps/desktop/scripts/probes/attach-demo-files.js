// Drops demo files (a .ts file, a .md note and a one-page PDF) onto the visible
// composer through a synthetic paste, to see the attachment cards. Nothing is sent.
(async () => {
  const area = [...document.querySelectorAll('textarea')].find((el) => el.getClientRects().length > 0 && !el.disabled);
  if (!area) return { ok: false, reason: 'no composer' };
  const code = `import { cart } from './cart';\nimport { tax } from './tax';\n\nexport async function checkout(user, items) {\n  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);\n  const discount = await cart.discountFor(user);\n  if (discount > 0) {\n    log('discount applied', discount);\n  }\n  const total = tax.apply(subtotal - discount, 'KR');\n  return { id: crypto.randomUUID(), total, status: 'pending' };\n}\n`;
  const notes = `# 결제 모듈 회의\n\n새 API 전환 일정과 웹훅 서명 검증 방식을 정리했다.\n담당자는 이번 주 안에 테스트를 보강한다.\n\n## 결정\n- 클라이언트 교체 먼저\n- 마이그레이션은 스테이징에서 확인\n`;
  // Minimal one-page PDF with a title line.
  const pdfText =
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 120>>stream\nBT /F1 28 Tf 60 760 Td (Payment Module Review) Tj ET\nBT /F1 12 Tf 60 720 Td (Migration plan, webhook signatures, test coverage.) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  const files = [
    new File([code], 'checkout.ts', { type: 'text/typescript' }),
    new File([notes], '회의_메모.md', { type: 'text/markdown' }),
    new File([pdfText], '검토보고서.pdf', { type: 'application/pdf' }),
  ];
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  area.focus();
  area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 2500));
  return {
    ok: true,
    cards: [...document.querySelectorAll('.attachment-card')].map(
      (c) => c.getAttribute('data-tooltip') || c.textContent.trim()
    ),
  };
})();
