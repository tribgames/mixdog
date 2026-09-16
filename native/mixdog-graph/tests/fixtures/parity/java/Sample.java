// Parity fixture: declaration and import shapes the graph reports for Java.
package com.acme.sample;

import java.util.List;
import java.util.concurrent.*;
import static java.util.Collections.emptyList;

public class Sample {
  private final String name;

  public Sample(String name) {
    this.name = name;
  }

  public String read(String key) {
    return name + key;
  }

  static List<String> empty() {
    return emptyList();
  }

  interface Listener {
    void onEvent(String event);
  }

  enum Mode {
    FAST,
    SLOW;

    boolean isFast() {
      return this == FAST;
    }
  }

  record Pair(String left, String right) {
    String joined() {
      return left + right;
    }
  }

  static class Inner {
    Callable<String> task() {
      return () -> "inner";
    }
  }
}

interface TopLevelListener {
  void handle();
}

enum TopLevelMode {
  ON,
  OFF
}
