#!/usr/bin/env node
// `describeVertexAdc({ env, projectId, fetchFn })` (providers/vertex-ai-auth.mjs): the gcloud login
// the settings show, the real function over ADC files and gcloud configuration seeded in a temp
// folder (named by GOOGLE_APPLICATION_CREDENTIALS or CLOUDSDK_CONFIG), with and without a metadata
// server a probe found. Rust `DefaultProviderBuilder::adc_describe` must answer the same document,
// key order included. Paths in messages are recorded as `{dir}`.
//
//   node benchmarks/rust-core/recorders/record-vertex-adc.mjs [--tree <dir>]
//
// Output: native/core/fixtures/vertex-adc/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'vertex-adc');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-vertex-adc.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'vertex-adc-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'vertex-adc-home-'));
const auth = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/vertex-ai-auth.mjs');

// Placeholder fields only: short fake keys keep the fixture from looking like a real credential.
const USER = { type: 'authorized_user', client_id: 'cid', client_secret: 'cs', refresh_token: 'rt', account: 'ann@x.test' };
const SA = { type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com', private_key: 'k', project_id: 'sa-project' };
const IMPERSONATED = (over = {}) => ({
  type: 'impersonated_service_account',
  service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target@p.iam.gserviceaccount.com:generateAccessToken',
  source_credentials: USER,
  ...over,
});
const ADC = 'application_default_credentials.json';
const json = (value) => JSON.stringify(value);
// files: relative path -> text; adc: where the ADC env points ('explicit' | 'gcloud').
const SCENARIOS = [
  { name: 'gcloud login of a user, no project anywhere', mode: 'gcloud', files: { [ADC]: json(USER) } },
  { name: 'user login with a quota project', mode: 'gcloud', files: { [ADC]: json({ ...USER, quota_project_id: 'quota-p' }) } },
  { name: 'service account login names its project', mode: 'gcloud', files: { [ADC]: json(SA) } },
  { name: 'quota project beats the key project', mode: 'gcloud', files: { [ADC]: json({ ...SA, quota_project_id: 'quota-p' }) } },
  { name: 'the environment beats the file', mode: 'gcloud', env: { GOOGLE_CLOUD_PROJECT: ' env-p ' }, files: { [ADC]: json(SA) } },
  { name: 'project variables in precedence order', mode: 'gcloud', env: { GCP_PROJECT: 'third', GOOGLE_VERTEX_PROJECT: 'first' }, files: { [ADC]: json(USER) } },
  { name: 'an override beats everything', mode: 'gcloud', override: '  override-p ', env: { GOOGLE_CLOUD_PROJECT: 'env-p' }, files: { [ADC]: json(SA) } },
  { name: 'gcloud configured project', mode: 'gcloud', files: { [ADC]: json(USER), active_config: 'work\n', 'configurations/config_work': '[compute]\nproject = not-this\n[core]\naccount = a\n  project =  conf-p  \n' } },
  { name: 'gcloud default configuration', mode: 'gcloud', files: { [ADC]: json(USER), 'configurations/config_default': '[core]\nproject=default-p\r\n' } },
  { name: 'gcloud active configuration by variable', mode: 'gcloud', env: { CLOUDSDK_ACTIVE_CONFIG_NAME: 'named' }, files: { [ADC]: json(USER), 'configurations/config_named': '[core]\nproject = named-p\n' } },
  { name: 'impersonated service account', mode: 'gcloud', files: { [ADC]: json(IMPERSONATED()) } },
  { name: 'impersonation url without a target', mode: 'gcloud', files: { [ADC]: json(IMPERSONATED({ service_account_impersonation_url: 'https://x.test/nothing' })) } },
  { name: 'impersonation source that is unsupported', mode: 'gcloud', files: { [ADC]: json(IMPERSONATED({ source_credentials: { type: 'external_account' } })) } },
  { name: 'an unsupported credential type', mode: 'gcloud', files: { [ADC]: json({ type: 'external_account' }) } },
  { name: 'a credential with no type', mode: 'gcloud', files: { [ADC]: json({}) } },
  { name: 'a user login missing fields', mode: 'gcloud', files: { [ADC]: json({ type: 'authorized_user', client_id: 'cid' }) } },
  { name: 'a service account missing fields', mode: 'gcloud', files: { [ADC]: json({ type: 'service_account', client_email: 'a@b' }) } },
  { name: 'text that is not JSON', mode: 'gcloud', files: { [ADC]: 'not json' } },
  { name: 'a document that is an array', mode: 'gcloud', files: { [ADC]: '[1]' } },
  { name: 'no gcloud login', mode: 'gcloud', files: {} },
  { name: 'no gcloud login, a metadata server found earlier', mode: 'gcloud', files: {}, metadata: 'meta-project' },
  { name: 'no gcloud login, metadata, environment project', mode: 'gcloud', files: {}, metadata: 'meta-project', env: { GOOGLE_CLOUD_PROJECT: 'env-p' } },
  { name: 'no gcloud login, metadata, override', mode: 'gcloud', files: {}, metadata: 'meta-project', override: 'over-p' },
  { name: 'no gcloud login, a metadata probe that found nothing', mode: 'gcloud', files: {}, metadata: null },
  { name: 'an explicit file', mode: 'explicit', files: { 'creds/key.json': json(SA) } },
  { name: 'an explicit file that does not exist', mode: 'explicit', files: {} },
  { name: 'an explicit file, a metadata server never replaces it', mode: 'explicit', files: {}, metadata: 'meta-project' },
  { name: 'an explicit file that is not JSON', mode: 'explicit', files: { 'creds/key.json': '{' } },
];

const reply = (projectId) => ({
  ok: Boolean(projectId),
  headers: { get: (name) => (name.toLowerCase() === 'metadata-flavor' ? 'Google' : null) },
  text: async () => projectId ?? '',
});
const results = [];
for (const scenario of SCENARIOS) {
  const dir = mkdtempSync(join(tmpdir(), 'vertex-adc-case-'));
  for (const [rel, text] of Object.entries(scenario.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const env = { ...(scenario.env ?? {}) };
  if (scenario.mode === 'explicit') env.GOOGLE_APPLICATION_CREDENTIALS = join(dir, 'creds', 'key.json');
  else env.CLOUDSDK_CONFIG = dir;
  const fetchFn = async () => reply(scenario.metadata ?? null);
  if ('metadata' in scenario) await auth.probeVertexMetadata(fetchFn);
  const described = auth.describeVertexAdc({ env, projectId: scenario.override ?? '', fetchFn });
  const norm = (value) => JSON.parse(JSON.stringify(value).split(JSON.stringify(dir).slice(1, -1)).join('{dir}').replace(/\\\\/g, '/'));
  results.push({
    name: scenario.name,
    mode: scenario.mode,
    files: scenario.files,
    env: Object.fromEntries(Object.entries(scenario.env ?? {})),
    override: scenario.override ?? '',
    metadata: 'metadata' in scenario ? scenario.metadata : undefined,
    described: norm(described),
  });
}
writeJson(join(stage, 'golden.json'), { scenarios: results });
writeSetManifest(stage, { set: 'vertex-adc', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
