function normalizedChartType(chart) {
  return String(chart?.type || chart?.chartType || 'column').trim().toLowerCase();
}

export function semanticChartSeries(chart, colors) {
  const series = Array.isArray(chart?.series) ? chart.series : [];
  const pointHighlight = ['bar', 'column'].includes(normalizedChartType(chart)) && series.length === 1;
  return series.map((entry, index) => {
    const baseColor = entry?.color || [colors.accent, colors.accent2, colors.muted][index % 3];
    const values = Array.isArray(entry?.values) ? entry.values : [];
    const explicitPointColors = Array.isArray(entry?.pointColors) ? entry.pointColors : [];
    const pointColors = explicitPointColors.length
      ? explicitPointColors
      : pointHighlight && values.length > 1
        ? values.map((_, pointIndex) => (
          pointIndex === values.length - 1 ? colors.accent2 : baseColor
        ))
        : [];
    return {
      ...entry,
      color: baseColor,
      ...(pointColors.length ? { pointColors } : {}),
    };
  });
}

export function twoTrackBranchSegments({
  left,
  top,
  width,
  headerHeight,
  gap,
  count,
}) {
  if (count !== 2) return [];
  const cardWidth = (width - gap) / 2;
  const centers = [
    left + (cardWidth / 2),
    left + cardWidth + gap + (cardWidth / 2),
  ];
  const headerBottom = top + headerHeight;
  const branchTop = headerBottom - 8;
  const branchY = headerBottom + (gap * 0.48);
  const cardsTop = headerBottom + gap;
  const center = left + (width / 2);
  return [
    {
      left: center - 1,
      top: branchTop,
      width: 2,
      height: Math.max(2, branchY - branchTop),
      colorRole: 'surface2',
    },
    {
      left: centers[0],
      top: branchY - 1,
      width: centers[1] - centers[0],
      height: 2,
      colorRole: 'surface2',
    },
    ...centers.map((cardCenter, index) => ({
      left: cardCenter - 1,
      top: branchY,
      width: 2,
      height: Math.max(2, cardsTop - branchY + 8),
      colorRole: index === 0 ? 'accent' : 'accent2',
    })),
  ];
}

export function timelineStageRole(index, count) {
  if (index === 0) return 'accent';
  if (index === count - 1) return 'accent2';
  return 'surface2';
}

export function timelineFlowSegments({
  left,
  lineTop,
  stride,
  marker,
  count,
  cardsTop,
}) {
  const output = [];
  for (let index = 0; index < count; index += 1) {
    const center = left + (stride * index) + (stride / 2);
    const role = timelineStageRole(index, count);
    output.push({
      left: center - 1,
      top: lineTop + marker,
      width: 2,
      height: Math.max(2, cardsTop - lineTop - marker),
      colorRole: role,
    });
    if (index >= count - 1) continue;
    const nextCenter = center + stride;
    output.push({
      left: center,
      top: lineTop + (marker / 2) - 1.5,
      width: nextCenter - center,
      height: 3,
      colorRole: index === 0
        ? 'accent'
        : index === count - 2
          ? 'accent2'
          : 'surface2',
    });
  }
  return output;
}
