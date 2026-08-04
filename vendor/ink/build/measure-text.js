// [mixdog fork] use the shared display-width policy so ink's text measurement
// matches OUR wrap/row math for circled digits / arrows. Kept in sync with
// src/tui/display-width.mjs.
import { displayWidestLine as widestLine } from './display-width.js';
const cache = new Map();
const measureText = (text) => {
    if (text.length === 0) {
        return {
            width: 0,
            height: 0,
        };
    }
    const cachedDimensions = cache.get(text);
    if (cachedDimensions) {
        return cachedDimensions;
    }
    const width = widestLine(text);
    const height = text.split('\n').length;
    const dimensions = { width, height };
    cache.set(text, dimensions);
    return dimensions;
};
export default measureText;
//# sourceMappingURL=measure-text.js.map