import type { DesktopGitCliStatus, DesktopLibreOfficeStatus } from '../../shared/contract';
import { t } from '../i18n';
import { record } from '../record-utils';
import type { RecordValue } from './capability-data';
import type { BuiltInFeatureDefinition, BuiltInFeatureId } from './built-in-feature-registry';
import { ExtensionFacts, ExtensionSection } from './extension-detail';
import { localProviderFileSize as fileSize } from './local-provider-models';

export function featureRequirement(id: BuiltInFeatureId): string {
  if (id === 'git') return 'Git CLI · GitHub CLI';
  if (id === 'office') return 'LibreOffice';
  if (id === 'localProvider') return t('NVIDIA RTX GPU · 24 GB VRAM');
  return '';
}

function localProviderFacts(status: RecordValue): Array<readonly [string, string]> {
  const runtime = record(status.runtime);
  const hardware = record(status.hardware);
  const gpus = Array.isArray(hardware.gpus) ? hardware.gpus.map(record) : [];
  const gpu = gpus.find((entry) => entry.uuid === record(status.gpu).uuid) || record(hardware.gpu);
  const memory = (bytes: unknown) => (typeof bytes === 'number' ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : '');
  const free = memory(gpu.freeMemoryBytes);
  const total = memory(gpu.memoryBytes);
  const models = Array.isArray(status.models) ? status.models.map(record) : [];
  const activeModel = models.find((entry) => entry.id === status.activeModel);
  return [
    ['Engine', 'llama.cpp'],
    [
      runtime.installed ? 'Runtime' : 'Available runtime',
      [String(runtime.version || ''), fileSize(runtime.downloadBytes)].filter(Boolean).join(' · '),
    ],
    ['Acceleration', String(runtime.backend || '')],
    ['Active model', String(activeModel?.name || '')],
    ['Context window', activeModel?.contextWindow ? String(activeModel.contextWindow) : ''],
    ['GPU', String(record(status.gpu).name || gpu.name || t('Not detected'))],
    ['Available GPU memory', free && total ? `${free} / ${total}` : ''],
    ['Server', serverStateLabel(status.starting, status.running)],
    ['Source', String(runtime.source || '')],
    ['License', String(runtime.license || '')],
  ];
}

function serverStateLabel(starting: unknown, running: unknown): string {
  if (starting) return t('Loading model…');
  return running ? t('Running') : t('Stopped');
}

function dependencyStateLabel(dependency: { installed: boolean; version?: string | null } | null): string {
  if (!dependency) return t('Loading…');
  if (!dependency.installed) return t('Not installed');
  return dependency.version || t('Unknown');
}

export function BuiltInFeatureInfo({
  state,
  gitStatus,
  officeDependency,
}: {
  state: {
    feature: BuiltInFeatureDefinition;
    ready: boolean;
    installed: boolean;
    enabled: boolean;
    available: boolean;
    localProvider: RecordValue;
    info?: RecordValue;
  };
  gitStatus: DesktopGitCliStatus | null;
  officeDependency: DesktopLibreOfficeStatus | null;
}) {
  const { feature } = state;
  const info = record(state.info);
  let dependency: DesktopGitCliStatus | DesktopLibreOfficeStatus | null = null;
  if (feature.id === 'git') dependency = gitStatus;
  else if (feature.id === 'office') dependency = officeDependency;
  const facts: Array<readonly [string, string]> = [];
  if (feature.id === 'voice')
    facts.push(
      ['Engine', [String(info.engine || 'whisper.cpp'), String(info.runtimeVersion || '')].filter(Boolean).join(' · ')],
      ['Model', String(info.model || '')],
      ['Model size', info.modelBytes ? fileSize(info.modelBytes) : ''],
      ['Acceleration', String(info.acceleration || '')],
      ['FFmpeg', String(info.ffmpegVersion || '')]
    );
  if (feature.id === 'memory')
    facts.push(
      ['Embedding model', String(info.model || '')],
      ['Engine', String(info.engine || '')],
      ['Quantization', String(info.dtype || '')],
      ['Dimensions', info.dimensions ? String(info.dimensions) : ''],
      ['Device', String(info.device || '')]
    );
  if (feature.id === 'browser')
    facts.push(
      ['Engine', 'Chromium · Electron'],
      ['Control protocol', 'Chrome DevTools Protocol (CDP)'],
      ['Browser profile', t('Shared sign-ins, cookies, and site data across sessions')]
    );
  if (feature.id === 'computer')
    facts.push(
      ['Engine', 'Windows UI Automation · Win32'],
      ['Platform', 'Windows'],
      ['Input', t('Mouse, keyboard, and accessibility controls')]
    );
  if (feature.id === 'office') facts.push(['Supported formats', 'Word · Excel · PowerPoint · PDF · CSV · TSV']);
  if (feature.id === 'git' || feature.id === 'office') {
    facts.push([feature.id === 'git' ? 'Git CLI' : 'LibreOffice', dependencyStateLabel(dependency)]);
  }
  if (feature.id === 'tidy') {
    facts.push([
      'Core engines',
      t(
        'Install downloads the core engines (Biome, ruff, shfmt, shellcheck, PSScriptAnalyzer); other languages download on first use.'
      ),
    ]);
  }
  if (feature.id === 'localProvider') facts.push(...localProviderFacts(state.localProvider));
  if (!facts.some(([, value]) => value)) return null;
  return (
    <ExtensionSection title={t('Info')}>
      <ExtensionFacts facts={facts} />
    </ExtensionSection>
  );
}
