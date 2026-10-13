import Security
import UIKit
import WebKit

/// Native save sink for phone downloads (apps/desktop/src/shared/native-file-save.ts).
/// Bytes are appended to a file in an app-owned temporary directory, then the
/// finished file is handed to the system share sheet. Handles are generated
/// here (128 random bits), bound to the web view that began them, and every
/// session mutation runs on one serial background queue, which also gives the
/// strictly in-order writes. Failures are returned as `{ ok: false, error }`
/// values. Leftovers are bounded: idle sessions expire, a shared file is
/// removed shortly after the sheet completes, and the whole directory is
/// wiped at launch.
final class MixdogFileSave {
    static let shared = MixdogFileSave()
    typealias Reply = ([String: Any]) -> Void

    /// FILE_DOWNLOAD_MAX_BYTES and NATIVE_FILE_SAVE_MAX_CHUNK_BYTES in the web app.
    private static let maxBytes: Int64 = 256 * 1024 * 1024
    private static let maxChunkBytes = 1024 * 1024
    private static let maxEncodedChunk = (maxChunkBytes + 2) / 3 * 4
    private static let maxSessions = 8
    /// Idle time after which an unshared session and its file are dropped.
    private static let retention: TimeInterval = 60 * 60
    /// Grace before a shared file is deleted, so a slow share extension can finish reading it.
    private static let sharedGrace: TimeInterval = 60
    /// Free space that must remain beyond the declared size.
    private static let spaceMargin: Int64 = 64 * 1024 * 1024

    private static var root: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("MixdogDownloads", isDirectory: true)
    }

    private final class Session {
        let owner: ObjectIdentifier
        let directory: URL
        let url: URL
        let name: String
        let size: Int64
        var file: FileHandle?
        var written: Int64 = 0
        var finished = false
        var sharing = false
        var touched = Date()

        init(owner: ObjectIdentifier, directory: URL, url: URL, name: String, size: Int64, file: FileHandle) {
            self.owner = owner
            self.directory = directory
            self.url = url
            self.name = name
            self.size = size
            self.file = file
        }
    }

    private let queue = DispatchQueue(label: "mixdog.filesave", qos: .utility)
    /// Touched on `queue` only.
    private var sessions: [String: Session] = [:]
    private var sweepPending = false

    // MARK: - Lifecycle

    /// Called at launch: downloads left by a previous run are never reused.
    func cleanStale() {
        queue.async {
            try? FileManager.default.removeItem(at: Self.root)
        }
    }

    /// The page in `webView` navigated away: its unfinished and unshared files go.
    func abortAll(for webView: WKWebView) {
        let owner = ObjectIdentifier(webView)
        queue.async {
            for (handle, session) in self.sessions where session.owner == owner && !session.sharing {
                self.discard(handle)
            }
        }
    }

    // MARK: - Calls

    func begin(owner webView: WKWebView?, args: [String: Any]?, done: @escaping Reply) {
        guard let webView, let rawName = args?["name"] as? String,
              let size = Self.integer(args?["size"]), size >= 0
        else {
            done(Self.failure("invalid"))
            return
        }
        guard size <= Self.maxBytes else {
            done(Self.failure("too-large"))
            return
        }
        let owner = ObjectIdentifier(webView)
        queue.async {
            self.sweep()
            guard self.sessions.count < Self.maxSessions, let handle = Self.newHandle() else {
                done(Self.failure("storage"))
                return
            }
            let name = Self.sanitize(rawName)
            let directory = Self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
            let url = directory.appendingPathComponent(name)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let free = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
                    .volumeAvailableCapacityForImportantUsage
                if let free, free < size + Self.spaceMargin { throw CocoaError(.fileWriteOutOfSpace) }
                guard FileManager.default.createFile(
                    atPath: url.path, contents: nil,
                    attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
                else { throw CocoaError(.fileWriteUnknown) }
                let file = try FileHandle(forWritingTo: url)
                self.sessions[handle] = Session(
                    owner: owner, directory: directory, url: url, name: name, size: size, file: file)
            } catch {
                try? FileManager.default.removeItem(at: directory)
                done(Self.failure("storage"))
                return
            }
            self.scheduleSweep()
            done(["ok": true, "handle": handle])
        }
    }

    func write(owner webView: WKWebView?, args: [String: Any]?, done: @escaping Reply) {
        guard let webView, let handle = args?["handle"] as? String,
              let offset = Self.integer(args?["offset"]), offset >= 0,
              let text = args?["data"] as? String, !text.isEmpty, text.utf8.count <= Self.maxEncodedChunk
        else {
            done(Self.failure("invalid"))
            return
        }
        let owner = ObjectIdentifier(webView)
        queue.async {
            guard let data = Data(base64Encoded: text), !data.isEmpty, data.count <= Self.maxChunkBytes else {
                done(Self.failure("invalid"))
                return
            }
            guard let session = self.session(handle, owner), !session.finished, let file = session.file else {
                done(Self.failure("unknown-handle"))
                return
            }
            guard offset == session.written else {
                done(Self.failure("offset-mismatch"))
                return
            }
            guard session.written + Int64(data.count) <= session.size else {
                done(Self.failure("too-large"))
                return
            }
            do {
                try file.write(contentsOf: data)
            } catch {
                // Disk full or I/O error: the partial file is useless.
                self.discard(handle)
                done(Self.failure("storage"))
                return
            }
            session.written += Int64(data.count)
            session.touched = Date()
            done(["ok": true, "handle": handle, "written": session.written])
        }
    }

    func finish(owner webView: WKWebView?, args: [String: Any]?, done: @escaping Reply) {
        guard let webView, let handle = args?["handle"] as? String,
              let declared = Self.integer(args?["size"]), declared >= 0
        else {
            done(Self.failure("invalid"))
            return
        }
        let owner = ObjectIdentifier(webView)
        queue.async {
            guard let session = self.session(handle, owner), !session.finished else {
                done(Self.failure("unknown-handle"))
                return
            }
            guard session.written == session.size, declared == session.size else {
                done(Self.failure("size-mismatch"))
                return
            }
            do {
                try session.file?.close()
            } catch {
                self.discard(handle)
                done(Self.failure("storage"))
                return
            }
            session.file = nil
            session.finished = true
            session.touched = Date()
            // Not persisted: the file lives only in temp staging until it is shared.
            done(["ok": true, "persisted": false, "handle": handle, "displayName": session.name, "size": session.size])
        }
    }

    func abort(owner webView: WKWebView?, args: [String: Any]?, done: @escaping Reply) {
        guard let webView, let handle = args?["handle"] as? String else {
            done(Self.failure("invalid"))
            return
        }
        let owner = ObjectIdentifier(webView)
        queue.async {
            guard let session = self.session(handle, owner), !session.sharing else {
                done(Self.failure("unknown-handle"))
                return
            }
            self.discard(handle)
            done(["ok": true, "handle": handle])
        }
    }

    func share(owner webView: WKWebView?, args: [String: Any]?, done: @escaping Reply) {
        guard let webView, let handle = args?["handle"] as? String else {
            done(Self.failure("invalid"))
            return
        }
        let owner = ObjectIdentifier(webView)
        queue.async {
            guard let session = self.session(handle, owner), session.finished else {
                done(Self.failure("unknown-handle"))
                return
            }
            guard !session.sharing else {
                done(Self.failure("invalid"))
                return
            }
            session.sharing = true
            session.touched = Date()
            DispatchQueue.main.async {
                self.present(session, handle: handle, done: done)
            }
        }
    }

    // MARK: - Share sheet

    /// Main thread. The session stays `sharing` (and so un-expirable) until the sheet completes.
    private func present(_ session: Session, handle: String, done: @escaping Reply) {
        guard let top = Self.topViewController() else {
            queue.async {
                session.sharing = false
                done(Self.failure("invalid"))
            }
            return
        }
        let sheet = UIActivityViewController(activityItems: [session.url], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        sheet.completionWithItemsHandler = { [weak self] _, completed, _, _ in
            guard let self else { return }
            self.queue.async {
                session.sharing = false
                session.touched = Date()
                if completed {
                    // Invalid now; the file lingers briefly for slow extensions.
                    self.sessions.removeValue(forKey: handle)
                    self.queue.asyncAfter(deadline: .now() + Self.sharedGrace) {
                        try? FileManager.default.removeItem(at: session.directory)
                    }
                }
                // Dismissing the sheet is a normal result; the file stays for a retry until it expires.
                done(["ok": true, "shared": completed])
            }
        }
        top.present(sheet, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.filter { $0.activationState == .foregroundActive }.flatMap { $0.windows }
            + scenes.flatMap { $0.windows }
        var top = windows.first(where: { $0.isKeyWindow })?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    // MARK: - Sessions (queue only)

    private func session(_ handle: String, _ owner: ObjectIdentifier) -> Session? {
        guard let session = sessions[handle], session.owner == owner else { return nil }
        return session
    }

    private func discard(_ handle: String) {
        guard let session = sessions.removeValue(forKey: handle) else { return }
        try? session.file?.close()
        session.file = nil
        try? FileManager.default.removeItem(at: session.directory)
    }

    private func sweep() {
        let now = Date()
        for (handle, session) in sessions where !session.sharing && now.timeIntervalSince(session.touched) > Self.retention {
            discard(handle)
        }
        scheduleSweep()
    }

    private func scheduleSweep() {
        guard !sweepPending, !sessions.isEmpty else { return }
        sweepPending = true
        queue.asyncAfter(deadline: .now() + Self.retention / 2) {
            self.sweepPending = false
            self.sweep()
        }
    }

    // MARK: - Helpers

    private static func failure(_ code: String) -> [String: Any] {
        ["ok": false, "error": code]
    }

    /// A JSON number that is a whole, exactly representable integer; nil for anything else (including booleans).
    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double == double.rounded(), abs(double) <= 9_007_199_254_740_991 else { return nil }
        return Int64(double)
    }

    /// 128 random bits, base64url.
    private static func newHandle() -> String? {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A single safe path component: no separators, control characters or leading/trailing dots, bounded length.
    static func sanitize(_ raw: String) -> String {
        let banned = CharacterSet.controlCharacters.union(.illegalCharacters)
            .union(CharacterSet(charactersIn: "/\\:*?\"<>|"))
        var scalars = String.UnicodeScalarView()
        for scalar in raw.unicodeScalars {
            scalars.append(banned.contains(scalar) ? "_" : scalar)
        }
        let edge = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "."))
        var name = String(scalars).trimmingCharacters(in: edge)
        if name.count > 100 {
            let ext = (name as NSString).pathExtension
            let stem = (name as NSString).deletingPathExtension
            name = String(stem.prefix(100)) + (!ext.isEmpty && ext.count <= 16 ? "." + ext : "")
        }
        return name.isEmpty ? "download" : name
    }
}
