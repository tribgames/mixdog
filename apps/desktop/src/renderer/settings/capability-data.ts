import React, { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
  X,
} from 'lucide-react';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopReadCapability,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopRemoteAccessInfo,
  EngineSnapshot,
} from '../../shared/contract';
import type { SettingsCategory } from './settings-items';
import {
  desktopThemePreferenceForTheme,
  getDesktopThemePreference,
  setDesktopThemePreference,
  type DesktopThemePreference,
} from '../desktop-theme';
import { OpenSelect } from '../OpenSelect';
import { filterConfiguredModels, ModelPicker } from '../ModelPicker';
import { modelDisplayName, modelOptionLabel, normalizeModelOptions, providerDisplayName } from '../provider-display';


export type RecordValue = Record<string, unknown>;
export type CapabilityApi = Partial<Pick<DesktopApi,
  'invokeCapability' | 'readCapabilities' | 'listProviderModels' | 'setModelRoute' | 'setFast' | 'getSnapshot'
  | 'subscribeState'>>;

export interface CapabilitySettingsProps {
  api: CapabilityApi;
  category: SettingsCategory;
  onCompose?: (text: string) => void;
  onOpenCategory?: (category: SettingsCategory) => void;
}

export interface PanelContext {
  data: Record<string, unknown>;
  snapshot: EngineSnapshot;
  pending: string;
  run<T = unknown>(capability: DesktopCapability, args?: unknown[], key?: string, refresh?: boolean): Promise<T | undefined>;
  route(model: DesktopModelOption): Promise<void>;
  setFast(enabled: boolean): Promise<void>;
  confirm(options: SettingsConfirmation): void;
  notice(message: string, tone?: 'info' | 'warn'): void;
  compose?: (text: string) => void;
  openCategory?: (category: SettingsCategory) => void;
}

export interface SettingsConfirmation {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm(): void | Promise<void>;
}

export const SECTION_READS: ReadonlyArray<readonly [string, DesktopCapability, unknown[]?]> = [
  ['profile', 'getProfile'], ['autoClear', 'getAutoClear'], ['compaction', 'getCompactionSettings'],
  ['memory', 'getMemorySettings'], ['channels', 'getChannelSettings', [{ includeStatus: false }]],
  ['remote', 'isRemoteEnabled'], ['channelWorker', 'getChannelWorkerStatus'], ['channelSetup', 'getChannelSetup'],
  ['voice', 'getVoiceStatus'],
  ['workflows', 'listWorkflows'], ['outputStyles', 'listOutputStyles'], ['theme', 'getTheme'],
  ['searchRoute', 'getSearchRoute'], ['searchModels', 'listSearchModels', [{ quick: false }]],
  ['providerSetup', 'getProviderSetup'], ['mcp', 'mcpStatus'], ['plugins', 'pluginsStatus'],
  ['hooks', 'hooksStatus'], ['skills', 'skillsStatus'], ['disabledSkills', 'getDisabledSkills'],
  ['agents', 'listAgents'],
  ['update', 'getUpdateSettings'], ['updateStatus', 'getUpdateStatus'],
];

export interface CachedCapabilitySettings {
  data: Record<string, unknown>;
  error: string;
  loadedAt: number;
}

interface CapabilitySettingsCacheEntry {
  value?: CachedCapabilitySettings;
  inFlight?: Promise<CachedCapabilitySettings>;
}

const CAPABILITY_SETTINGS_CACHE = new WeakMap<object, CapabilitySettingsCacheEntry>();

function settingsCacheEntry(api: CapabilityApi): CapabilitySettingsCacheEntry {
  const key = api as object;
  const cached = CAPABILITY_SETTINGS_CACHE.get(key);
  if (cached) return cached;
  const created: CapabilitySettingsCacheEntry = {};
  CAPABILITY_SETTINGS_CACHE.set(key, created);
  return created;
}

export function getCachedCapabilitySettings(api: CapabilityApi): CachedCapabilitySettings | undefined {
  return CAPABILITY_SETTINGS_CACHE.get(api as object)?.value;
}

async function readAllCapabilitySettings(
  api: CapabilityApi,
  force: boolean,
  previous?: CachedCapabilitySettings,
): Promise<CachedCapabilitySettings> {
  if (!api.invokeCapability && !api.readCapabilities) {
    return { data: previous?.data || {}, error: '', loadedAt: Date.now() };
  }
  const next: Record<string, unknown> = { ...(previous?.data || {}) };
  let loadError = '';
  const prepared = SECTION_READS.map(([key, capability, args = []]) => ({
    key,
    request: {
      capability: capability as DesktopReadCapability,
      args: force && capability === 'listSearchModels'
        ? [{ ...record(args[0]), force: true }]
        : force && capability === 'getProviderSetup'
          ? [{ refresh: true }]
          : [...args],
    } satisfies DesktopCapabilityReadRequest,
  }));
  const readIndividually = async () => {
    if (!api.invokeCapability) return;
    await Promise.all(prepared.map(async ({ key, request }) => {
      try {
        next[key] = (await api.invokeCapability!({
          capability: request.capability,
          args: request.args,
        }))?.value;
      } catch (reason) {
        next[key] = { error: reason instanceof Error ? reason.message : String(reason) };
      }
    }));
  };
  const loadReads = async () => {
    if (!api.readCapabilities) {
      await readIndividually();
      return;
    }
    try {
      const results = await api.readCapabilities(prepared.map((entry) => entry.request));
      prepared.forEach((entry, index) => {
        const result = results[index];
        next[entry.key] = result?.ok
          ? result.value
          : { error: result && 'error' in result ? result.error : 'Capability read did not return a result.' };
      });
    } catch (reason) {
      if (api.invokeCapability) {
        await readIndividually();
      } else {
        loadError = reason instanceof Error ? reason.message : String(reason);
      }
    }
  };
  await Promise.all([
    loadReads(),
    (async () => {
      try {
        next.models = await api.listProviderModels?.({
          quick: false,
          ...(force ? { force: true } : {}),
        }) || [];
      } catch (reason) {
        next.models = previous?.data.models || [];
        loadError = reason instanceof Error ? reason.message : String(reason);
      }
    })(),
    api.getSnapshot?.().then((snapshot) => { next.snapshot = snapshot || null; })
      .catch(() => { next.snapshot = previous?.data.snapshot || null; }) || Promise.resolve(),
    api.invokeCapability?.({
      capability: 'memoryControl',
      args: [{ action: 'core', op: 'list', project_id: '*' }, { silent: true }],
    }).then((result) => { next.coreMemory = result.value; })
      .catch(() => { next.coreMemory = previous?.data.coreMemory; }) || Promise.resolve(),
  ]);
  return { data: next, error: loadError, loadedAt: Date.now() };
}

export function preloadCapabilitySettings(
  api: CapabilityApi,
  force = false,
): Promise<CachedCapabilitySettings> {
  const entry = settingsCacheEntry(api);
  if (entry.inFlight) return entry.inFlight;
  if (entry.value && !force) return Promise.resolve(entry.value);
  const request = readAllCapabilitySettings(api, force, entry.value);
  entry.inFlight = request;
  void request.then((value) => {
    entry.value = value;
    if (entry.inFlight === request) entry.inFlight = undefined;
  }, () => {
    if (entry.inFlight === request) entry.inFlight = undefined;
  });
  return request;
}

export function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

export function rows(value: unknown, ...keys: string[]): RecordValue[] {
  if (Array.isArray(value)) return value.map(record);
  const source = record(value);
  for (const key of keys) {
    if (Array.isArray(source[key])) return (source[key] as unknown[]).map(record);
  }
  return [];
}

export function bool(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function label(value: unknown, fallback = 'Unknown'): string {
  const item = record(value);
  return String(item.label || item.title || item.name || item.display || item.id || fallback);
}

export function providerLabel(value: unknown, fallback = 'Unknown provider'): string {
  const item = record(value);
  if (item.name || item.label) return String(item.name || item.label);
  const provider = String(item.id || item.provider || '');
  return provider ? providerDisplayName(provider) : label(item, fallback);
}

export function count(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat().format(numeric) : String(value ?? '—');
}

export function formatDuration(value: unknown): string {
  if (!Number.isFinite(Number(value))) return '';
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 60_000) {
    if (milliseconds < 1_000) return '';
    return `${Math.floor(milliseconds / 1_000)}s`;
  }
  const days = Math.floor(milliseconds / 86_400_000);
  const hours = Math.floor((milliseconds % 86_400_000) / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function durationTextInput(value: unknown): string {
  const milliseconds = Math.max(0, Math.round(Number(value) || 0));
  if (milliseconds > 0 && milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds > 0 && milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds > 0 && milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}
