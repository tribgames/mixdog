// A Korean application form (reference: 정부24 민원 신청서 layout) flowed with field blocks: a cover title, notice,
// applicant rows, a radio group, checkboxes for consent, a multiline reason box, and the signature date.
export default {
  path: 'outputs/office-live-test/pdf/korean-form.pdf',
  create: {
    format: 'pdf',
    properties: { title: '야간 배송 참여 신청서', author: '도시 물류 연구소', pageSize: 'a4', margin: 56 },
    blocks: [
      { type: 'cover', eyebrow: '도시 물류 연구소', title: '야간 배송 참여 신청서', subtitle: '2027년 1분기 시범 구역 확대 · 신청 마감 2026년 12월 15일' },
      { type: 'callout', label: '작성 안내', text: '굵은 글씨 항목은 반드시 적어 주십시오. 제출한 정보는 참여 심사에만 쓰고 심사 후 3개월 안에 폐기합니다.' },
      { type: 'heading', text: '1. 신청인', level: 2 },
      { type: 'fieldRow', items: [{ name: 'company', label: '사업자명', type: 'text' }, { name: 'bizno', label: '사업자등록번호', type: 'text' }] },
      { type: 'fieldRow', items: [{ name: 'owner', label: '대표자', type: 'text' }, { name: 'phone', label: '연락처', type: 'text' }] },
      { type: 'field', name: 'address', label: '사업장 주소', fieldType: 'text' },
      { type: 'heading', text: '2. 운영 정보', level: 2 },
      { type: 'field', name: 'fleet', label: '보유 차량 규모', fieldType: 'radio', options: ['10대 미만', '10–49대', '50대 이상'] },
      { type: 'fieldRow', items: [{ name: 'ev', label: '전기 화물차 보유', type: 'checkbox' }, { name: 'lownoise', label: '저소음 인증 차량 보유', type: 'checkbox' }] },
      { type: 'field', name: 'reason', label: '참여 사유 (300자 이내)', fieldType: 'text', height: 48, multiline: true },
      { type: 'heading', text: '3. 동의', level: 2 },
      { type: 'field', name: 'consent', label: '개인정보 수집·이용에 동의합니다', fieldType: 'checkbox' },
      { type: 'fieldRow', items: [{ name: 'date', label: '신청일', type: 'text' }, { name: 'sign', label: '신청인 (서명)', type: 'text' }] },
      { type: 'caption', text: '문의: logistics@city.example · 02-1234-5678 · 이 신청서는 예시 문서입니다.' },
    ],
  },
  operations: undefined,
};
