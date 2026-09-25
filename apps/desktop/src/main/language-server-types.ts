import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { MessageConnection } from 'vscode-jsonrpc';

import type { DesktopLspCapabilities } from '../shared/contract';

export interface LanguageServerSpec {
  id: string;
  name: string;
  command: string;
  args: string[];
  projectCandidates?: (root: string) => string[];
}

export interface DynamicCapabilityRegistration {
  method: string;
  registerOptions: Record<string, unknown>;
}

export interface ServerDocument {
  languageId: string;
  relPath: string;
  version: number;
}

export interface ServerSession {
  key: string;
  projectPath: string;
  root: string;
  spec: LanguageServerSpec;
  child: ChildProcessWithoutNullStreams;
  connection: MessageConnection;
  baseCapabilities: DesktopLspCapabilities;
  registrations: Map<string, DynamicCapabilityRegistration>;
  languageIds: Set<string>;
  documents: Map<string, ServerDocument>;
  idleTimer: NodeJS.Timeout | null;
  closing: boolean;
}

export type WithTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;

export type CapabilityResolver = (
  base: DesktopLspCapabilities,
  registrations: Iterable<DynamicCapabilityRegistration>,
  languageId: string,
  uri?: string
) => DesktopLspCapabilities;
