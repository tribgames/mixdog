/**
 * The native Computer Use backend for macOS and Linux: `mixdog-computer`, one
 * resident process per session speaking the Windows host's line protocol.
 * The action lists and limits it enforces come from the same definitions the
 * Windows host is built from, handed over through its environment.
 */
import { computerActionsWith } from '../../../../../../src/runtime/computer-bridge/actions.mjs';
import { MAX_COMPUTER_FOREGROUND_TEXT_CHARS } from '../../../../../../src/runtime/computer-bridge/limits.mjs';
import { DEFAULT_CAPTURE_AFTER_DELAY_MS } from '../shared/common';

export function computerNativeBinary(): string {
  const binary = process.env.MIXDOG_COMPUTER_BIN;
  if (!binary) {
    throw new Error(
      `computer_backend_unavailable: this build ships no mixdog-computer backend for ${process.platform}-${process.arch}`
    );
  }
  return binary;
}

export function computerNativeEnvironment(
  inputMarker: string | undefined,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MIXDOG_COMPUTER_INPUT_MARKER: inputMarker,
    MIXDOG_COMPUTER_READ_ACTIONS: computerActionsWith('nativeRead').join(','),
    MIXDOG_COMPUTER_RETAIN_REF_ACTIONS: computerActionsWith('retainNativeRefs').join(','),
    MIXDOG_COMPUTER_SEQUENCE_SETTLE_MS: String(DEFAULT_CAPTURE_AFTER_DELAY_MS),
    MIXDOG_COMPUTER_MAX_FOREGROUND_TEXT: String(MAX_COMPUTER_FOREGROUND_TEXT_CHARS),
    ...extra,
  };
}
