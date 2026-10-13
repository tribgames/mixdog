// Build-time module of electron.vite.config.ts: the bundled ECharts browser
// build as a string, served to scripted inline chart pages.
declare module 'virtual:mixdog-echarts-source' {
  const source: string;
  export default source;
}
