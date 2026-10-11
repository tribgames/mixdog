import CryptoKit
import Foundation
import Security

/// The per-install P-256 key pair for native push. The private key lives only
/// in the Keychain, in an access group shared by the app and its Notification
/// Service Extension (Info.plist `MixdogKeychainGroup` =
/// `$(AppIdentifierPrefix)io.mixdog.app.shared`), readable after first unlock
/// so the extension can decrypt while the phone is locked, and never synced
/// or migrated off this device.
enum MixdogKeychain {
    private static let service = "io.mixdog.native-push"
    private static let account = "device-key-v1"

    private static var accessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "MixdogKeychainGroup") as? String
    }

    private static func query() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group = accessGroup, !group.isEmpty { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    private static func load() -> P256.KeyAgreement.PrivateKey? {
        var request = query()
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return try? P256.KeyAgreement.PrivateKey(rawRepresentation: data)
    }

    /// Existing key, or a freshly generated one stored before it is returned.
    static func privateKey() -> P256.KeyAgreement.PrivateKey? {
        if let existing = load() { return existing }
        let key = P256.KeyAgreement.PrivateKey()
        var item = query()
        item[kSecValueData as String] = key.rawRepresentation
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecSuccess { return key }
        // Another process (the extension) may have raced us to create it.
        return load()
    }

    /// Uncompressed public key (65 bytes), base64url.
    static func publicKey() -> String {
        guard let key = privateKey() else { return "" }
        return NativePushCrypto.base64URLEncode(key.publicKey.x963Representation)
    }
}
