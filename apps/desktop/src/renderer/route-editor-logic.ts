export type RouteSheetPane = 'model' | 'effort' | 'speed';

export function routeSheetRows(input: {
  hasModel: boolean;
  effortCount: number;
  fastVisible: boolean;
}): RouteSheetPane[] {
  const rows: RouteSheetPane[] = ['model'];
  if (input.hasModel && input.effortCount > 0) rows.push('effort');
  if (input.hasModel && input.fastVisible) rows.push('speed');
  return rows;
}
