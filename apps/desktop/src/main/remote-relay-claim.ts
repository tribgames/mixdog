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
  /** How the container reached this desktop: the QR/route, or a 6-digit code
   *  the relay redeemed for it. A relay that predates pairing v2 says nothing,
   *  which reads as the QR it always was. */
  method: 'qr' | 'code' | 'retry';
  /** When this request arrived here. */
  requestedAt: number;
  expiresAt: number;
}

/** The user's answer to a claim. */
export interface RemoteClaimDecision {
  approved: boolean;
}
