// BRIEF
// subject/audience/action: 夜间配送试点 — 城市交通委员会批准扩大到全市
// reading mode: balanced · argument mode: pyramid
// directions: A soft-rounded, hue 200, concord — 财新风格的数据简报 · B swiss-minimal, hue 210 · selected: A · why: 委员会成员阅读简报，圆角卡片和单一蓝色适合
// style: soft-rounded · palette: hue 200 · type: MODE balanced → body 15pt · script: zh · pairing: concord · fonts: noto
// motif: rings · rhythm: anchor, dense, dense
// facts: sample — 虚构试点，所有数字均为示例
// slide plan: 1 job: claim · relationship: focal claim · move: 知道白天拥堵下降 · composition: 大标题与三个数字 · carriers: statement · texture: keywords · rhythm: anchor
//   2 job: evidence · relationship: evidence · move: 看到六周持续下降 · composition: 左侧柱状图，右侧解读 · carriers: chart, prose · texture: prose · rhythm: dense
//   3 job: evidence · relationship: evidence · move: 看到单位经济 · composition: 四张指标卡片 · carriers: hero · texture: keywords · rhythm: dense

deck({ style: 'soft-rounded', hue: 200, mode: 'balanced', script: 'zh', pairing: 'concord', fonts: 'noto' });

{
  const s = light();
  const b = display(s, '夜间配送后，白天拥堵指数下降了六点', { kicker: '试点摘要', emph: '下降了六点', line: '三个试点区连续六周下降，噪音投诉没有增加。' });
  statBand(s, M, b + GAP.between * 1.5, (W - 2 * M) * 0.7, [
    { value: '−6', unit: '点', label: '白天拥堵指数' },
    { value: '+2', unit: '单', label: '每车每日配送' },
    { value: '0', unit: '件', label: '新增噪音投诉' },
  ]);
  source(s, '来源：市交通局，2026年8–9月（示例数据）');
}

{
  const s = light();
  const top = head(s, '证据', '拥堵指数六周持续下降，没有反弹');
  const seam = splitAt(Z.body.x, Z.body.w, 7, 3);
  chart(s, seam.left.x, top, seam.left.w, avail(top), { type: 'col', labels: ['第1周', '第2周', '第3周', '第4周', '第5周', '第6周'], series: [{ name: '拥堵指数', values: [71, 68, 66, 65, 65, 64] }] });
  reading(s, seam.right.x, top, seam.right.w, [
    { label: '试点区', text: '指数从71降到64，第二周之后没有回升。' },
    { label: '其他区', text: '保持在70左右，排除了季节因素。' },
  ]);
  source(s, '工作日7–19时平均。来源：市交通局（示例）');
}

{
  const s = light();
  const top = head(s, '经济性', '每辆车每天多送两单，成本没有增加');
  await cards(s, M, top, W - 2 * M, [
    { value: '2', unit: '单', label: '每车每日增量', detail: '夜间路况畅通', icon: 'truck', accent: true },
    { value: '31', unit: '分钟', label: '平均节省时间', detail: '20单路线', icon: 'clock' },
    { value: '0', unit: '元', label: '新增人力成本', detail: '同一批司机', icon: 'users' },
    { value: '12', unit: '家', label: '参与企业', detail: '三个试点区', icon: 'building-2' },
  ], { columns: 4, h: 2.6 });
  source(s, '来源：参与企业调度记录（示例数据）');
}

await pres.writeFile({ fileName: OUTPUT });
