import 'package:demo/a.dart';
import "./local.dart";
export 'package:demo/a.dart';
part 'sample.g.dart';
part of 'lib.dart';

class User {
  User(this.name);
  final String name;

  String greet() => 'hi $name';

  String get label => name;

  set label(String value) {}

  User operator +(User other) => User('$name+${other.name}');

  void _secret() {}
}

mixin Loggable {
  void log(String message) {}
}

enum Status { ready, busy }

extension StatusX on Status {
  bool get isReady => this == Status.ready;
}

class _Hidden {}

int add(int a, int b) => a + b;

void _privateTopLevel() {}

mixin _PrivateMixin {}
