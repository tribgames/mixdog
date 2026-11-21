import { ipcRenderer, webFrame } from 'electron';

// A zoom set through webFrame is this page's own level; other pages of the site do not share it.
webFrame.setZoomFactor(ipcRenderer.sendSync('mixdog-browser-page-zoom'));
