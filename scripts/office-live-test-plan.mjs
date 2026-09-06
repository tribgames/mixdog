import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultTestPath = fileURLToPath(new URL('../src/runtime/office/office-live-runtime.test.mjs', import.meta.url));
export const liveProfiles = Object.freeze(['excel', 'word', 'powerpoint', 'author', 'attach', 'contract', 'compat', 'all']);

export const liveTestHelp = `실제 Office 검증은 실행 범위를 지정해 주세요.
  npm run test:office:live -- <excel|word|powerpoint|author|attach|contract>
  npm run test:office:compat     매크로·서식 9종 호환성 검증
  npm run test:office:live:all   모든 라이브 검증
  npm run test:office           Office를 실행하지 않는 일반 검증
  npm run test:office:render    별도 렌더 검증
기존 호출도 지원합니다: <테스트 파일> [테스트 이름 정규식]
`;

export function buildLiveTestPlan(argv, testPath = defaultTestPath) {
  const [selector, namePattern, ...extra] = argv;
  if (!selector || selector === '--help' || selector === '-h') return null;
  if (extra.length) throw new Error('인자가 너무 많습니다.');
  let pattern;
  if (liveProfiles.includes(selector)) {
    if (namePattern) throw new Error('기능 이름 뒤에는 추가 인자를 받지 않습니다.');
    pattern = selector === 'all' ? null : `^\\[${selector}\\]`;
  } else {
    if (!/\.(?:mjs|cjs|js)$/u.test(selector)) throw new Error(`알 수 없는 검증 범위: ${selector}`);
    testPath = resolve(selector);
    pattern = namePattern || null;
  }
  if (pattern) new RegExp(pattern); // Reject malformed filters before starting a child.
  return {
    label: selector,
    args: ['--test', '--test-reporter=tap', ...(pattern ? ['--test-name-pattern', pattern] : []), testPath],
  };
}
