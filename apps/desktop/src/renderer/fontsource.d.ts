// Side-effect CSS packages ship no type declarations; TS 5.9's tsconfig-based
// resolution (TS2882) needs these ambient modules for typecheck:renderer.
declare module "@fontsource-variable/geist";
declare module "@fontsource-variable/inter";
declare module "@fontsource-variable/jetbrains-mono";
declare module "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
declare module "@vscode/codicons/dist/codicon.css";
