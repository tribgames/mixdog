/** The DTLS transport's remote certificate, as RTCCertificateStats names it. */
export async function remoteCertificate(pc: RTCPeerConnection) {
  const report = await pc.getStats();
  for (const stats of report.values()) {
    if (stats.type !== 'transport' || !stats.remoteCertificateId) continue;
    const certificate = report.get(stats.remoteCertificateId);
    if (certificate) {
      return { fingerprint: certificate.fingerprint, fingerprintAlgorithm: certificate.fingerprintAlgorithm };
    }
  }
  return null;
}
