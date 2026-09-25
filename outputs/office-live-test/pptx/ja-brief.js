// BRIEF
// subject/audience/action: 夜間配送パイロット — 交通委員会が全区への拡大を承認する
// reading mode: balanced · argument mode: pyramid
// directions: A data-journalism, hue 220, weight, bare — 日経風のチャート中心ページ · B swiss-minimal, hue 200, concord · selected: A · why: 数字で判断する委員会向け、チャートが主役
// style: data-journalism · palette: hue 220 · type: MODE balanced → body 15pt · script: ja · pairing: weight · fonts: noto
// motif: hairlines · rhythm: anchor, dense, dense
// facts: sample — 架空のパイロットで数値はすべて例示
// slide plan: 1 job: cover · relationship: none · move: 夜間配送で昼の渋滞が減ったと知る · composition: 紙面に大見出しと日付 · carriers: statement · texture: keywords · rhythm: anchor
//   2 job: evidence · relationship: evidence · move: 6週間ずっと下がり続けたと見る · composition: 本文幅の折れ線、下に読み · carriers: chart, prose · texture: prose · rhythm: dense
//   3 job: comparison · relationship: contrast · move: 区ごとの差を比べる · composition: 横棒チャートと右レール · carriers: chart, prose · texture: prose · rhythm: dense

deck({ style: 'data-journalism', hue: 220, mode: 'balanced', script: 'ja', pairing: 'weight', fonts: 'noto', chrome: 'bare' });

{
  const s = light();
  display(s, '夜が変わると、昼の道路が空いた', { kicker: '都市物流レポート', emph: '昼の道路が空いた', line: '夜間配送パイロット最初の6週間の報告。交通委員会向け資料。' });
  dateline(s, '2026年9月');
}

{
  const s = light();
  const top = head(s, '実績', '渋滞指数は6週間で7ポイント下がり、戻らなかった');
  chart(s, Z.body.x, top, Z.body.w, avail(top) - 0.9, { type: 'line', accent: 0, labels: ['1週', '2週', '3週', '4週', '5週', '6週'], series: [{ name: 'パイロット区', values: [71, 68, 66, 65, 65, 64] }, { name: 'その他の区', values: [70, 70, 71, 70, 71, 70] }] });
  source(s, '平日7時〜19時の平均。出典：市交通局（例示）');
}

{
  const s = light();
  const top = head(s, '区別', '夜間便はすべての区で速かった');
  const seam = splitAt(Z.body.x, Z.body.w, 7, 3);
  chart(s, seam.left.x, top, seam.left.w, avail(top), { type: 'bar', labels: ['中央区', '港区', '新宿区', '渋谷区', '品川区'], series: [{ name: '短縮時間（分）', values: [27, 29, 20, 19, 27] }], accent: 1 });
  reading(s, seam.right.x, top, seam.right.w, [
    { label: '最大の短縮', text: '港区では20件のルートが29分短くなった。' },
    { label: '最小でも', text: '渋谷区でも19分の短縮があった。' },
  ]);
  source(s, '20件配送ルートの所要時間の中央値。出典：市交通局（例示）');
}

await pres.writeFile({ fileName: OUTPUT });
