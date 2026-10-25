import { ipcRenderer, webFrame } from 'electron';

// Every Browser Use page's own zoom (main/browser/page-zoom.ts), at each
// document start: the main process names it, and setting it from here makes
// it this page's own level, which no other page of the site shares. Nothing
// reaches the page's world.
webFrame.setZoomFactor(ipcRenderer.sendSync('mixdog-browser-page-zoom'));
