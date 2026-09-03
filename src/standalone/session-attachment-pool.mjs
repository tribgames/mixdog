export class SessionAttachmentPool {
  #attachSession;
  #createProtocolClient;
  #ensureDaemon;
  #onIdle;
  #shared = null;
  #reattachTimer = null;
  #liveViews = new Set();

  constructor({
    attachSession,
    createProtocolClient,
    ensureDaemon,
    onIdle = () => {},
  }) {
    this.#attachSession = attachSession;
    this.#createProtocolClient = createProtocolClient;
    this.#ensureDaemon = ensureDaemon;
    this.#onIdle = onIdle;
  }

  addView(attachment, sessionId, view) {
    let bucket = attachment.views.get(sessionId);
    if (!bucket) {
      bucket = new Set();
      attachment.views.set(sessionId, bucket);
    }
    bucket.add(view);
  }

  removeView(attachment, sessionId, view) {
    const bucket = attachment.views.get(sessionId);
    if (!bucket) return;
    bucket.delete(view);
    if (bucket.size === 0) attachment.views.delete(sessionId);
  }

  viewCount(attachment, sessionId) {
    return attachment.views.get(sessionId)?.size ?? 0;
  }

  track(view) {
    this.#liveViews.add(view);
  }

  untrack(view) {
    this.#liveViews.delete(view);
  }

  invalidate(attachment) {
    if (this.#shared === attachment) this.#shared = null;
  }

  idle(attachment) {
    return attachment.refs === 0 && this.#liveViews.size === 0;
  }

  releaseIdle(attachment) {
    if (!this.idle(attachment)) return false;
    this.#onIdle();
    this.invalidate(attachment);
    return true;
  }

  #scheduleReattach({ cwd, log }) {
    if (this.#reattachTimer || this.#liveViews.size === 0) return;
    this.#reattachTimer = setTimeout(() => {
      this.#reattachTimer = null;
      if (this.#liveViews.size === 0) return;
      void this.ensure({ cwd, log }).catch((error) => {
        log(`daemon re-attach failed: ${error?.message || error}`);
        this.#scheduleReattach({ cwd, log });
      });
    }, 500);
    this.#reattachTimer.unref?.();
  }

  async ensure({ cwd, log }) {
    if (this.#shared?.client) return this.#shared;
    if (this.#shared?.pending) return this.#shared.pending;
    const pending = (async () => {
      const discovery = await this.#ensureDaemon({ cwd, log });
      const views = new Map();
      const state = { client: null, views, discovery, refs: this.#liveViews.size, log, cwd };
      const rawTransport = await this.#attachSession({
        discovery,
        cwd,
        log,
        onFrame: (frame) => {
          const bucket = views.get(String(frame?.sessionId || ''));
          if (!bucket) return;
          for (const view of [...bucket]) {
            if (frame.type === 'session-state') view.applyFrame(frame, state);
            else if (frame.type === 'session-gone') view.applyGone(frame.reason || 'session unloaded');
          }
        },
        onFatal: (reason) => {
          log(`daemon attachment lost (${reason})`);
          this.invalidate(state);
          void Promise.resolve()
            .then(() => state.client?.close?.(`attachment lost: ${reason}`))
            .catch((error) => log(`daemon attachment release failed: ${error?.message || error}`));
          for (const bucket of views.values()) {
            for (const view of [...bucket]) view.applyDetached(reason);
          }
          this.#scheduleReattach({ cwd: state.cwd, log });
        },
      });
      state.client = this.#createProtocolClient(rawTransport);
      this.#shared = state;
      for (const view of this.#liveViews) {
        this.addView(state, view.sessionId(), view);
        void view.recover(state).catch((error) => {
          log(`session ${view.sessionId()} recovery failed: ${error?.message || error}`);
        });
      }
      return state;
    })();
    this.#shared = { pending };
    try {
      return await pending;
    } catch (error) {
      this.#shared = null;
      throw error;
    }
  }
}
