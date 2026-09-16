// Parity fixture: declaration and import shapes the graph reports for Swift.
import Foundation
import class UIKit.UIView
@preconcurrency import Dispatch

public protocol Storage {
    func read(key: String) -> String?
}

public struct Point {
    public var x: Int
    public var y: Int

    public func sum() -> Int {
        return x + y
    }
}

public enum Mode {
    case fast
    case slow

    func label() -> String {
        return "\(self)"
    }
}

public class Store: Storage {
    let name: String

    public init(name: String) {
        self.name = name
    }

    public func read(key: String) -> String? {
        func nested(_ value: String) -> String {
            return value.trimmingCharacters(in: .whitespaces)
        }
        return nested("\(name):\(key)")
    }
}

public actor Coordinator {
    private var stores: [Store] = []

    func add(_ store: Store) {
        stores.append(store)
    }
}

func topLevel(view: UIView, queue: DispatchQueue) -> String {
    _ = (view, queue)
    return Date().description
}
