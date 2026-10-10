import UserNotifications

/// Rewrites the generic fallback alert APNs delivers (`mutable-content: 1`)
/// with the decrypted title/body from the `mx` payload. Failure leaves the
/// generic alert untouched.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        handler = contentHandler
        best = (request.content.mutableCopy() as? UNMutableNotificationContent)
        guard let content = best else { return contentHandler(request.content) }

        if let mx = request.content.userInfo["mx"] as? String,
           let key = MixdogKeychain.privateKey(),
           let message = try? NativePushCrypto.decrypt(mx: mx, privateKey: key),
           let title = message["title"] as? String,
           let body = message["body"] as? String,
           let sessionId = message["sessionId"] as? String
        {
            content.title = title
            content.body = body
            content.threadIdentifier = sessionId
            var info = content.userInfo
            info["mxSessionId"] = sessionId
            if let approvalId = message["approvalId"] as? String, !approvalId.isEmpty {
                info["mxApprovalId"] = approvalId
            }
            // The ciphertext has served its purpose; do not keep it on the notification.
            info.removeValue(forKey: "mx")
            content.userInfo = info
            if (message["reason"] as? String) == "approval-pending", info["mxApprovalId"] != nil {
                content.categoryIdentifier = "MIXDOG_APPROVAL"
            }
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        // Deliver whatever we have (the generic alert) rather than nothing.
        if let handler, let best { handler(best) }
    }
}
