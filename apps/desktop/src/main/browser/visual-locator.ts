export interface BrowserVisualCandidate {
  score: number;
  tag: string;
  role: string;
  name: string;
  color: string;
  position: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserVisualLocatorPayload {
  candidates: BrowserVisualCandidate[];
  total: number;
}

export function browserVisualLocatorExpression(
  rawQuery: string,
  maxCandidates = 20,
): string {
  const query = String(rawQuery || '').trim().toLowerCase();
  const maximum = Math.min(50, Math.max(1, Math.trunc(maxCandidates)));
  return `(() => {
    const query = ${JSON.stringify(query)};
    const maximum = ${maximum};
    const compact = (value, max = 160) => String(value == null ? '' : value)
      .replace(/\\s+/g, ' ').trim().slice(0, max);
    const aliases = new Map(Object.entries({
      red: ['red','빨강','빨간'], orange: ['orange','주황'], yellow: ['yellow','노랑','노란'],
      green: ['green','초록','녹색'], blue: ['blue','파랑','파란'], purple: ['purple','보라'],
      pink: ['pink','분홍'], black: ['black','검정','검은'], white: ['white','흰색','하얀'],
      gray: ['gray','grey','회색'], top: ['top','위','상단'], bottom: ['bottom','아래','하단'],
      left: ['left','왼쪽'], right: ['right','오른쪽'], center: ['center','middle','중앙','가운데'],
    }));
    const canonical = (token) => {
      for (const [name, words] of aliases) if (words.some((word) => token.includes(word))) return name;
      return token;
    };
    const ignored = new Set(['find','locate','show','click','button','element','찾아','찾기','버튼','요소','줘','주세요']);
    const tokens = query.split(/[^\\p{L}\\p{N}_-]+/u).filter(Boolean)
      .map(canonical).filter((token) => !ignored.has(token));
    const requested = new Set(tokens);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const parseRgb = (value) => {
      const match = String(value || '').match(/rgba?\\((\\d+)[, ]+(\\d+)[, ]+(\\d+)/i);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };
    const namedColor = (value) => {
      const rgb = parseRgb(value);
      if (!rgb) return '';
      const [r, g, b] = rgb;
      const colors = {
        red:[220,45,45], orange:[235,130,25], yellow:[235,210,35], green:[45,165,70],
        blue:[45,105,220], purple:[135,70,190], pink:[225,90,155], black:[25,25,25],
        white:[245,245,245], gray:[135,135,135],
      };
      let best = '';
      let distance = Infinity;
      for (const [name, target] of Object.entries(colors)) {
        const next = (r-target[0])**2 + (g-target[1])**2 + (b-target[2])**2;
        if (next < distance) { distance = next; best = name; }
      }
      return best;
    };
    const position = (rect) => {
      const horizontal = rect.left + rect.width / 2 < viewportWidth / 3 ? 'left'
        : rect.left + rect.width / 2 > viewportWidth * 2 / 3 ? 'right' : 'center';
      const vertical = rect.top + rect.height / 2 < viewportHeight / 3 ? 'top'
        : rect.top + rect.height / 2 > viewportHeight * 2 / 3 ? 'bottom' : 'center';
      return vertical === 'center' && horizontal === 'center' ? 'center' : vertical + '-' + horizontal;
    };
    const candidates = [];
    const stack = [{ element: document.documentElement, offsetX: 0, offsetY: 0 }];
    while (stack.length && candidates.length < 2000) {
      const item = stack.pop();
      const element = item?.element;
      if (!element || element.nodeType !== 1) continue;
      const rect = element.getBoundingClientRect();
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      const visible = rect.width >= 2 && rect.height >= 2 && style
        && style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0;
      const tag = (element.tagName || '').toLowerCase();
      const role = compact(element.getAttribute?.('role') || tag, 40).toLowerCase();
      const name = compact(
        element.getAttribute?.('aria-label') || element.getAttribute?.('alt')
          || element.getAttribute?.('title') || element.innerText || element.textContent || '',
      );
      const actionable = ['a','button','input','select','textarea','summary','canvas','svg','img'].includes(tag)
        || ['button','link','tab','checkbox','radio','switch','textbox','option','menuitem'].includes(role)
        || element.hasAttribute?.('onclick') || style?.cursor === 'pointer';
      if (visible && actionable) {
        const background = namedColor(style.backgroundColor);
        const foreground = namedColor(style.color);
        const color = background && background !== 'white' ? background : foreground;
        const globalRect = {
          left: item.offsetX + rect.left,
          top: item.offsetY + rect.top,
          width: rect.width,
          height: rect.height,
        };
        const place = position(globalRect);
        const haystack = [tag, role, name.toLowerCase(), color, place].join(' ');
        let score = query && haystack.includes(query) ? 120 : 5;
        for (const token of requested) {
          if (haystack.includes(token)) score += ['top','bottom','left','right','center'].includes(token) ? 18 : 25;
        }
        if (!query || score > 5) {
          candidates.push({
            score,
            tag,
            role,
            name,
            color,
            position: place,
            x: Math.round(globalRect.left + globalRect.width / 2),
            y: Math.round(globalRect.top + globalRect.height / 2),
            width: Math.round(globalRect.width),
            height: Math.round(globalRect.height),
          });
        }
      }
      if (tag === 'iframe' || tag === 'frame') {
        try {
          const documentElement = element.contentDocument?.documentElement;
          if (documentElement) {
            stack.push({
              element: documentElement,
              offsetX: item.offsetX + rect.left,
              offsetY: item.offsetY + rect.top,
            });
          }
        } catch {}
      }
      const children = Array.from(element.children || []);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ element: children[index], offsetX: item.offsetX, offsetY: item.offsetY });
      }
      if (element.shadowRoot) {
        const shadowChildren = Array.from(element.shadowRoot.children || []);
        for (let index = shadowChildren.length - 1; index >= 0; index -= 1) {
          stack.push({ element: shadowChildren[index], offsetX: item.offsetX, offsetY: item.offsetY });
        }
      }
    }
    candidates.sort((left, right) => right.score - left.score
      || left.width * left.height - right.width * right.height);
    return { candidates: candidates.slice(0, maximum), total: candidates.length };
  })()`;
}
