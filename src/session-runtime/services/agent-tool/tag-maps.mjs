// The live tag maps (tag -> sessionId / agent / cwd) shared by reference
// between the tag registry, the worker index and the terminal reaper. Every
// bind/unbind goes through here so the three maps never drift apart.
export function createTagMaps() {
  const tags = new Map();
  const tagAgents = new Map();
  const tagCwds = new Map();
  const unbind = (tag) => {
    tags.delete(tag);
    tagAgents.delete(tag);
    tagCwds.delete(tag);
  };
  return {
    tags,
    tagAgents,
    tagCwds,
    bind(tag, session) {
      tags.set(tag, session.id);
      if (session.agent) tagAgents.set(tag, session.agent);
      if (session.cwd) tagCwds.set(tag, session.cwd);
    },
    unbind,
    /** Drop the binding only while it still points at this session: a tag
     *  re-bound to newer work must survive the old session's cleanup. */
    unbindIfOwned(tag, sessionId) {
      if (tag && sessionId && tags.get(tag) === sessionId) unbind(tag);
    },
  };
}
