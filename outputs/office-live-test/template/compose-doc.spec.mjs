// compose_document preset (opt-in) on a Korean brief: how the built-in structure reads.
export default {
  path: 'outputs/office-live-test/template/compose-brief.docx',
  operations: [
    {
      op: 'compose_document',
      title: '야간 출고 지연을 없애는 도크 분리안',
      subtitle: '물류센터 운영위원회 결정 요청 · 2026년 9월',
      eyebrow: '결정 요청',
      summary: '22시 이후 3번 도크 적재 대기가 평균 38분이다. 도크를 방향별로 나누면 대기가 사라지고 추가 인력 없이 출고 마감을 40분 앞당길 수 있다.',
      metrics: [
        { value: '38분', label: '평균 적재 대기' },
        { value: '0분', label: '분리 후 시뮬레이션' },
        { value: '40분', label: '마감 단축' },
      ],
      sections: [
        { heading: '1. 원인', paragraphs: ['22시 이후 수도권과 영남 물량이 3번 도크 한 곳에 몰린다. 셔틀 두 대가 서로를 기다리며 적재가 멈춘다.'] },
        { heading: '2. 대안 비교', table: { headers: ['안', '대기 (분)', '추가 비용', '판단'], rows: [['현행 유지', '38', '없음', '기각'], ['인력 2명 증원', '21', '월 740만 원', '보류'], ['도크 방향별 분리', '0', '없음', '채택']] } },
        { heading: '3. 실행 계획', steps: [{ label: '1주차', title: '도크 표지와 동선 변경' }, { label: '2주차', title: '셔틀 배차표 분리' }, { label: '3주차', title: '효과 측정과 보고' }] },
        { heading: '4. 요청', callout: '10월 첫 주부터 도크 분리를 시범 운영하도록 승인해 주십시오.' },
      ],
      pageNumbers: true,
    },
  ],
};
