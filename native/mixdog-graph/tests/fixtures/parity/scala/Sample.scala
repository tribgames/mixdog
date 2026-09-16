// Parity fixture: declaration and import shapes the graph reports for Scala.
package com.acme.sample

import scala.collection.mutable
import scala.concurrent.{Future, ExecutionContext}
import java.nio.file._

trait Storage {
  def read(key: String): Option[String]
}

class Store(val name: String) extends Storage {
  private val cache = mutable.Map.empty[String, String]

  def read(key: String): Option[String] = cache.get(key)

  def write(key: String, value: String): Unit = cache.update(key, value)
}

object Store {
  def build(name: String): Store = new Store(name)

  def async(name: String)(implicit ec: ExecutionContext): Future[Store] =
    Future(build(name))
}

object Paths2 {
  def here: Path = Paths.get(".")
}
