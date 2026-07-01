import { Stream } from 'node:stream';
import process from 'node:process';
import Ink from './ink.js';
import instances from './instances.js';
/**
Mount a component and render the output.
*/
const render = (node, options) => {
    const inkOptions = {
        stdout: process.stdout,
        stdin: process.stdin,
        stderr: process.stderr,
        debug: false,
        exitOnCtrlC: true,
        patchConsole: true,
        maxFps: 30,
        incrementalRendering: false,
        concurrent: false,
        alternateScreen: false,
        ...getOptions(options),
    };
    const instance = getInstance(inkOptions.stdout, () => new Ink(inkOptions));
    instance.render(node);
    return {
        rerender: instance.render,
        unmount() {
            instance.unmount();
        },
        waitUntilExit: instance.waitUntilExit,
        waitUntilRenderFlush: instance.waitUntilRenderFlush,
        cleanup() {
            instance.unmount();
        },
        clear: instance.clear,
        // [mixdog fork] expose the mouse drag-selection setter so the app entry
        // (index.jsx) can wire it into the engine store; the App's mouse handler
        // pushes selection rectangles through it to drive the inverse highlight.
        setSelection: instance.setSelection,
        // [mixdog fork] read the text under the current selection rect (the cells
        // the highlight covers), used to copy to the clipboard on drag-release.
        getSelectionText: () => instance.selectedText,
        // [mixdog fork] resolve the word rect at a cell for double-click select.
        getWordRectAt: (x, y) => instance.getWordRectAt(x, y),
        // [mixdog fork] resolve the whole-line rect at a row for triple-click /
        // line select. Symmetric to getWordRectAt; index.jsx wires it into the
        // store as store.getLineRectAt.
        getLineRectAt: (y) => instance.getLineRectAt(y),
    };
};
export default render;
const getOptions = (stdout = {}) => {
    if (stdout instanceof Stream) {
        return {
            stdout,
            stdin: process.stdin,
        };
    }
    return stdout;
};
const getInstance = (stdout, createInstance) => {
    const instance = instances.get(stdout);
    if (instance === undefined) {
        const newInstance = createInstance();
        instances.set(stdout, newInstance);
        return newInstance;
    }
    // Ink keeps one live renderer per stdout. Reusing the same stream without
    // unmounting is unsupported, but return the existing instance so we don't
    // create two renderers that compete for the same output. Write the warning
    // directly to native stderr so an existing alternate-screen renderer cannot
    // swallow it via patchConsole.
    process.stderr.write('Warning: render() was called again for the same stdout before the previous Ink instance was unmounted. Reusing stdout across multiple render() calls is unsupported. Call unmount() first.\n');
    return instance;
};
//# sourceMappingURL=render.js.map