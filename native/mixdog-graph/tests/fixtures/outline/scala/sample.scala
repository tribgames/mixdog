package com.acme.demo

import com.acme.User
import com.acme.util.{Clock, Id}
import com.acme.legacy._
import scala.concurrent.Future

trait Repository {
  def find(id: String): Option[User]
}

class UserService(repo: Repository) extends Repository {
  def find(id: String): Option[User] = repo.find(id)

  def save(user: User): Future[User] = Future.successful(user)
}

object UserService {
  def apply(repo: Repository): UserService = new UserService(repo)

  val empty: Option[User] = None
}

class Clock {}

object Id {
  def next(): String = "1"
}

def topLevelHelper(n: Int): Int = n + 1
