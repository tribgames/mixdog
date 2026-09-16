// Parity fixture: declaration and import shapes the graph reports for Dart.
import 'dart:async';
import 'package:meta/meta.dart';
import './helper.dart';
export 'src/api.dart';
part 'sample.g.dart';

enum Mode { fast, slow }

mixin Loggable {
  void log(String message) => print(message);
}

extension StoreExtras on Store {
  String get label => 'store:${name}';
}

class Store with Loggable {
  Store(this.name);

  final String name;

  String read(String key) {
    String nested(String value) => value.trim();
    return nested('$name:$key');
  }

  String get upper => name.toUpperCase();

  set rename(String value) => log(value);

  bool operator ==(Object other) => other is Store && other.name == name;

  @override
  int get hashCode => name.hashCode;
}

Future<Store> build(String name) async => Store(name);
