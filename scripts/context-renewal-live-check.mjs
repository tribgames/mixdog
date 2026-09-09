import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = process.argv[2] === '--child';
if (child) {
  const spec = JSON.parse(process.argv[3]);
  const { createMixdogSessionRuntime } = await import('../src/session-runtime/runtime-core.mjs');
  let runtime;
  try {
    runtime = await createMixdogSessionRuntime({
      provider: 'openai-oauth', model: 'gpt-6-astra', effort: 'medium',
      fast: true, cwd: repo, toolMode: 'full', autoWakeCompletions: false,
    });
    const calls = [];
    const before = runtime.contextStatus();
    const response = await runtime.ask(spec.prompt, {
      onAssistantToolCallObserved: (call) => calls.push({
        name: call.name || call.tool,
        arguments: call.name === 'Skill' ? call.arguments : undefined,
      }),
    });
    const text = String(response?.result?.content || response?.text || '');
    const context = runtime.contextStatus();
    const session = runtime.session;
    fs.writeFileSync(spec.output, JSON.stringify({
      name: spec.name, prompt: spec.prompt, text, chars: text.length, calls,
      provider: runtime.provider, model: runtime.model,
      initial: before, context,
      activeTools: session?.tools?.map((tool) => tool.name) || [],
      loadedTools: session?.skillLoadedTools || [],
    }, null, 2));
    console.log(JSON.stringify({ name: spec.name, chars: text.length, calls, output: spec.output }));
  } catch (error) {
    fs.writeFileSync(spec.output, JSON.stringify({ name: spec.name, error: error.message }, null, 2));
    console.error(`${spec.name}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await runtime?.stop?.('context-renewal-live-check');
  }
  process.exit(process.exitCode || 0);
}

const realData = path.join(os.homedir(), '.mixdog', 'data');
const config = JSON.parse(fs.readFileSync(path.join(realData, 'mixdog-config.json'), 'utf8'));
const artifactDir = path.join(realData, 'diagnostics', `context-renewal-${Date.now()}`);
fs.mkdirSync(artifactDir, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-context-renewal-'));
const stylePrompt = '서비스가 느려져 조사했습니다. 데이터베이스 연결 풀 20개가 모두 사용 중이었고 요청은 연결을 기다렸습니다. 느린 쿼리 하나가 연결을 평균 8초 점유했습니다. 해당 쿼리에 인덱스를 추가하자 응답시간 p95가 4.2초에서 0.6초로 줄었습니다. 스테이징 부하 테스트만 통과했고 운영 배포는 아직입니다. 이 결과의 원인과 의미, 현재 완료 범위를 설명해 주세요. 도구는 사용하지 마세요.';
const only = process.argv.slice(2);
const specs = [
  { name: 'initial-hi', style: 'simple', prompt: 'HI' },
  ...['extreme-minimal', 'minimal', 'simple', 'detailed'].map((style) => ({
    name: style, style, prompt: stylePrompt,
  })),
  { name: 'history-routing', style: 'simple', prompt: '지난 세션에서 초기 컨텍스트 절감에 관해 어떤 결정을 했는지 기록을 찾아주세요. 현재 파일 조사는 필요 없습니다.' },
  { name: 'memory-routing', style: 'simple', prompt: '이 프로젝트에 저장된 제 장기 선호와 제약 목록을 확인해 주세요. 새로 저장하거나 수정하지는 마세요.' },
].filter((spec) => only.length === 0 || only.includes(spec.name));
let failed = false;
try {
  for (const spec of specs) {
    const dataDir = path.join(sandbox, spec.name);
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'mixdog-config.json'), JSON.stringify({
      ...config, outputStyle: spec.style,
    }));
    for (const file of ['openai-oauth.json', 'openai-oauth-models.json', 'instructions.md']) {
      fs.copyFileSync(path.join(realData, file), path.join(dataDir, file));
    }
    fs.cpSync(path.join(realData, 'skills'), path.join(dataDir, 'skills'), { recursive: true });
    const output = path.join(artifactDir, `${spec.name}.json`);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify({ ...spec, output })], {
      cwd: repo, stdio: 'inherit',
      env: { ...process.env, MIXDOG_ROOT: path.join(repo, 'src'), MIXDOG_DATA_DIR: dataDir },
    });
    if (result.status !== 0) failed = true;
  }
} finally {
  // Embedded databases can outlive the per-case runtime process on Windows.
  // Stop only servers rooted in this run before removing credential copies.
  let cleanupFailed = false;
  for (const spec of specs) {
    const dataDir = path.join(sandbox, spec.name);
    const db = path.join(dataDir, 'pgdata');
    const ctl = path.join(dataDir, 'runtime', 'runtime-pg16.4+pgvector-0.8.2', 'bin', 'pg_ctl.exe');
    if (process.platform === 'win32' && fs.existsSync(ctl) && fs.existsSync(path.join(db, 'postmaster.pid'))) {
      const stopped = spawnSync(ctl, ['-D', db, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit' });
      if (stopped.status !== 0) cleanupFailed = true;
    }
    for (const file of ['openai-oauth.json', 'openai-oauth-models.json', 'mixdog-config.json']) {
      fs.rmSync(path.join(dataDir, file), { force: true });
    }
  }
  if (cleanupFailed) {
    failed = true;
    console.error(`Temporary database cleanup needs attention: ${sandbox}`);
  } else {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
console.log(`Artifacts: ${artifactDir}`);
process.exit(failed ? 1 : 0);
