// The seam between the recorder and the stand-ins the loader hooks put in place of Node's
// provider registry, config, session store and tool surface (see hop-hooks.mjs). One instance
// per process: the stand-ins and the recorder import this file by the same URL.
export const world = { api: {}, log: [] };
