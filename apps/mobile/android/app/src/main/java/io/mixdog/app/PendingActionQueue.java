package io.mixdog.app;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Pure queue rules for parked notification actions (pure JDK, pinned by
 * npm run test:java). An entry is a string map: id, action, sessionId,
 * approvalId?, hostId?, createdAt (epoch ms). An action with a hostId belongs
 * to that host only; one without (older payloads) is served to any host.
 * Entries are removed by acknowledgement or when their TTL passes.
 */
final class PendingActionQueue {
  static final int MAX_PENDING = 8;
  static final long TTL_MS = 6L * 60 * 60 * 1000;

  private PendingActionQueue() {}

  private static boolean fresh(Map<String, String> entry, long now) {
    try {
      return now - Long.parseLong(entry.get("createdAt")) <= TTL_MS;
    } catch (NumberFormatException e) {
      return false;
    }
  }

  static List<Map<String, String>> prune(List<Map<String, String>> queue, long now) {
    List<Map<String, String>> out = new ArrayList<>();
    for (Map<String, String> entry : queue) if (fresh(entry, now)) out.add(entry);
    return out;
  }

  /** Appends (idempotent by id), drops expired entries, keeps the newest MAX_PENDING. */
  static List<Map<String, String>> add(List<Map<String, String>> queue, Map<String, String> entry, long now) {
    List<Map<String, String>> out = prune(queue, now);
    String id = entry.get("id");
    for (Map<String, String> existing : out) if (existing.get("id").equals(id)) return out;
    out.add(entry);
    return new ArrayList<>(out.subList(Math.max(0, out.size() - MAX_PENDING), out.size()));
  }

  /** What a page connected to hostId may act on; other hosts' actions stay parked. */
  static List<Map<String, String>> forHost(List<Map<String, String>> queue, String hostId, long now) {
    List<Map<String, String>> out = new ArrayList<>();
    for (Map<String, String> entry : prune(queue, now)) {
      String owner = entry.get("hostId");
      if (owner == null || owner.isEmpty() || owner.equals(hostId)) out.add(entry);
    }
    return out;
  }

  static List<Map<String, String>> ack(List<Map<String, String>> queue, String id) {
    List<Map<String, String>> out = new ArrayList<>();
    for (Map<String, String> entry : queue) if (!entry.get("id").equals(id)) out.add(entry);
    return out;
  }
}
