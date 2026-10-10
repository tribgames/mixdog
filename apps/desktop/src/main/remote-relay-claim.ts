/** One browser container asking this desktop for access. It holds no
 *  credential: the answer here is the credential. */
export interface RemoteClientClaim {
  claimId: string;
  clientId: string;
  name: string;
  platform: string;
  browser: string;
  /** The claim comes from another Mixdog desktop app's remote window. A label
   *  for the prompt only; it grants nothing. */
  desktop: boolean;
  expiresAt: number;
}

/** The user's answer to a claim. */
export interface RemoteClaimDecision {
  approved: boolean;
}
