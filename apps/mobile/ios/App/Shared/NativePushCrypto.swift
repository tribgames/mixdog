import CryptoKit
import Foundation

/// mixdog-native-push-v1 (compiled into BOTH the app and the Notification
/// Service Extension). Cross-checked against
/// apps/mobile/test-vectors/native-push-v1.json and the TS reference
/// apps/desktop/src/shared/native-push-payload.ts.
///
/// mx = base64url(JSON { v: 1, epk, iv, ct })
/// key = HKDF-SHA256(ECDH(device private, epk), salt: empty, info: "mixdog-native-push-v1", 32 bytes)
/// ct  = AES-256-GCM ciphertext || 16-byte tag
enum NativePushCrypto {
    enum Failure: Error { case malformed, unsupportedVersion }

    private static let info = Data("mixdog-native-push-v1".utf8)

    static func base64URLDecode(_ text: String) -> Data? {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }

    static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decrypts an `mx` field to the plaintext JSON object
    /// `{ title, body, sessionId, reason, approvalId? }`.
    static func decrypt(mx: String, privateKey: P256.KeyAgreement.PrivateKey) throws -> [String: Any] {
        guard let envelopeData = base64URLDecode(mx),
              let envelope = try JSONSerialization.jsonObject(with: envelopeData) as? [String: Any]
        else { throw Failure.malformed }
        guard (envelope["v"] as? Int) == 1 else { throw Failure.unsupportedVersion }
        guard let epkText = envelope["epk"] as? String, let epk = base64URLDecode(epkText), epk.count == 65,
              let ivText = envelope["iv"] as? String, let iv = base64URLDecode(ivText), iv.count == 12,
              let ctText = envelope["ct"] as? String, let sealed = base64URLDecode(ctText), sealed.count >= 16
        else { throw Failure.malformed }

        let peer = try P256.KeyAgreement.PublicKey(x963Representation: epk)
        let secret = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        let key = secret.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: Data(), sharedInfo: info, outputByteCount: 32)
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: iv),
            ciphertext: sealed.prefix(sealed.count - 16),
            tag: sealed.suffix(16))
        let plain = try AES.GCM.open(box, using: key)
        guard let message = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else {
            throw Failure.malformed
        }
        return message
    }
}
