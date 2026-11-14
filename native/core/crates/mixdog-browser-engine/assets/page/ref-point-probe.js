async function() {
      const target = this;
      if (!target || !target.isConnected) return { error: 'stale' };
      if (target.disabled || target.getAttribute?.('aria-disabled') === 'true') return { error: 'disabled' };
      const view = target.ownerDocument?.defaultView || window;
      const hidden = (node) => {
        const style = view.getComputedStyle(node);
        return style.display === 'none' || style.visibility === 'hidden';
      };
      if (hidden(target)) return { error: 'not-actionable' };
      const targetRect = await (__MIXDOG_STABLE_RECT__)(target);
      if (!targetRect) return { error: 'moving' };
      // A transparent, pointer-events:none, or 1px control is how custom
      // checkboxes hide the native input; the label is what a person clicks,
      // and clicking it activates the control. Opacity alone never disqualifies.
      const labels = target.labels ? Array.from(target.labels) : [];
      const candidates = [target, ...labels.filter((label) => (
        label !== target && label.isConnected && !hidden(label)
      ))];
      const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      const controlSelector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"]';
      const controlFor = (value) => value?.matches?.(controlSelector)
        ? value
        : value?.closest?.(controlSelector);
      const labelControl = (value) => value?.closest?.('label')?.control || null;
      const sameDestination = (left, right) => {
        if (!left || !right || left === right
          || left.matches?.('a[href]') !== true || right.matches?.('a[href]') !== true) return false;
        try {
          return new URL(left.href, location.href).href === new URL(right.href, location.href).href;
        } catch {
          return false;
        }
      };
      let covering = null;
      let visible = false;
      for (const candidate of candidates) {
        const rect = candidate === target ? targetRect : candidate.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        visible = true;
        for (const [rx, ry] of points) {
          const localX = rect.left + rect.width * rx;
          const localY = rect.top + rect.height * ry;
          let hit = candidate.ownerDocument.elementFromPoint(localX, localY);
          while (hit?.shadowRoot) {
            const nested = hit.shadowRoot.elementFromPoint?.(localX, localY);
            if (!nested || nested === hit) break;
            hit = nested;
          }
          const targetControl = controlFor(target);
          const hitControl = controlFor(hit);
          const related = hit && (
            hit === target
            || hit === candidate
            || (candidate.contains(hit) && (!hitControl || hitControl === targetControl))
            || (targetControl && hitControl === targetControl)
            || sameDestination(targetControl, hitControl)
            || labelControl(hit) === target
          );
          if (!related) {
            covering = hit || covering;
            continue;
          }
          let frameView = view;
          let px = localX;
          let py = localY;
          for (;;) {
            let frame;
            try { frame = frameView.frameElement; } catch { break; }
            if (!frame) break;
            if ((__MIXDOG_FRAME_HAS_TRANSFORM__)(frame)) return { error: 'transformed-frame' };
            const parent = frame.ownerDocument;
            const frameRect = frame.getBoundingClientRect();
            px += frameRect.left + frame.clientLeft;
            py += frameRect.top + frame.clientTop;
            if (parent.elementFromPoint(px, py) !== frame) return { error: 'covered', covering: 'parent frame overlay' };
            frameView = parent.defaultView;
          }
          // Use the point that was actually hit-tested in the visual viewport.
          // CDP box-model quads use a different origin after mobile scrolling.
          return { x: px, y: py, via: candidate === target ? 'control' : 'label' };
        }
      }
      if (!visible) return { error: 'not-visible' };
      if (!covering) return { error: 'covered', covering: 'another element' };
      // A blocker is usually an unnamed overlay with no ref of its own, so the
      // name alone leaves nothing to act on: carry a selector that does.
      const escape = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&');
      const selector = covering.id
        ? '#' + escape(covering.id)
        : ((covering.tagName || 'element').toLowerCase()
          + Array.from(covering.classList || []).slice(0, 2).map((name) => '.' + escape(name)).join(''));
      const label = (covering.tagName || 'element').toLowerCase() + ' "'
        + String(covering.getAttribute?.('aria-label') || covering.textContent || '')
          .replace(/\s+/g, ' ').trim().slice(0, 60) + '"';
      return { error: 'covered', covering: label, coveringSelector: selector };
    }