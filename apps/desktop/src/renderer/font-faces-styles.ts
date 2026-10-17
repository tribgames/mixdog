// Font faces, icon fonts and @property registrations: built into a stylesheet
// of their own (manualChunks 'font-faces'), never into the app sheet with its
// @media/@container rules — see font-faces.css. bootstrap.tsx imports this
// right before bootstrap-styles, so the cascade order is unchanged.
import '@fontsource-variable/jetbrains-mono';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '@vscode/codicons/dist/codicon.css';
import './font-faces.css';
