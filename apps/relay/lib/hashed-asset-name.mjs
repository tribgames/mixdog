/** Content-hashed build filenames (`name-<8+ chars>.ext`). A leaf so staging
 *  can share the pattern without fingerprinting the HTTP server. */
export const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8,}\.[^.]+$/;
