// Parity fixture: declaration and import shapes the graph reports for Kotlin.
package com.acme.sample

import kotlin.math.max
import java.util.concurrent.TimeUnit as Unit

class Store(val name: String) {
    private var size: Int = 0

    fun read(key: String): String {
        fun nested(value: String) = value.trim()
        return nested("$name/$key")
    }

    companion object {
        fun create(name: String): Store = Store(name)
    }

    class Inner {
        fun ping(): Long = Unit.SECONDS.toMillis(1)
    }
}

interface Listener {
    fun onEvent(event: String)
}

enum class Mode {
    FAST,
    SLOW
}

object Registry {
    val all = mutableListOf<Store>()

    fun register(store: Store) {
        all.add(store)
    }
}

fun topLevel(values: List<Int>): Int = values.fold(0) { acc, value -> max(acc, value) }
