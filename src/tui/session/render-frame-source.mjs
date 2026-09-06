// Render acknowledgements are process-local. A daemon hosting a remote view
// owns no Ink renderer and must never wait for that view's local frame clock.
const sources = new Set();
const closedListeners = new Set();

export function registerRenderFrameSource() {
    const source = {};
    sources.add(source);
    return () => {
        if (!sources.delete(source) || sources.size > 0) return;
        for (const listener of [...closedListeners]) listener();
    };
}

export function hasRenderFrameSource() {
    return sources.size > 0;
}

export function onRenderFrameSourcesClosed(listener) {
    closedListeners.add(listener);
    return () => closedListeners.delete(listener);
}
