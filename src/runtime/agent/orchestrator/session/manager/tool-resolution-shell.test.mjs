// The session's shell tool is described for the shell the runtime resolves:
// resolveSessionTools asks resolveShellFor('default') for its shellType and
// binds the matching routing list and syntax cheat, the same bytes every call.
// The real resolver is steered by the platform it sees (win32 + a configured
// pwsh → PowerShell; anything else → POSIX bash/sh), so no other kind's text
// can come from the host's own platform.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getConfiguredShell, setConfiguredShell, resolveShellFor } from '../../tools/builtin/shell-runtime.mjs';
import { resolveSessionTools } from './tool-resolution.mjs';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const previousConfiguredShell = getConfiguredShell();
function resolverSees(platform, configuredShell = '') {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
  setConfiguredShell(configuredShell);
}
test.afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  setConfiguredShell(previousConfiguredShell);
});

const POSIX_ROUTING = 'cat/head/tail/less→read; ls/tree→list; find→glob/find; grep/rg/ag→grep';
const POWERSHELL_ROUTING = 'Get-Content/gc/cat/type→read; Get-ChildItem/dir/ls→list/glob/find; Select-String/findstr→grep';
const POSIX_CHEAT = 'Bash: chain dependent commands with &&';
const POWERSHELL_CHEAT = 'PowerShell: ; between independent commands';

const shellTool = () => resolveSessionTools('full', [], {}).find((tool) => tool.name === 'shell');
const commandText = (tool) => tool.inputSchema.properties.command.description;

test('a POSIX system shell gives the shell tool the POSIX routing list and Bash cheat', () => {
  resolverSees('linux');
  assert.equal(resolveShellFor('default').shellType, 'posix');
  const tool = shellTool();
  assert.ok(tool.description.includes(POSIX_ROUTING), tool.description);
  assert.ok(!tool.description.includes('Get-Content'));
  assert.ok(commandText(tool).includes(POSIX_CHEAT), commandText(tool));
  assert.ok(!commandText(tool).includes('PowerShell'));
});

test('a PowerShell system shell gives the shell tool the PowerShell routing list and cheat', () => {
  resolverSees('win32', 'pwsh');
  assert.equal(resolveShellFor('default').shellType, 'powershell');
  const tool = shellTool();
  assert.ok(tool.description.includes(POWERSHELL_ROUTING), tool.description);
  assert.ok(!tool.description.includes('cat/head/tail/less'));
  assert.ok(commandText(tool).includes(POWERSHELL_CHEAT), commandText(tool));
  assert.ok(!commandText(tool).includes('Bash:'));
});

test('the session follows the resolver when it changes, and two calls give identical bytes', () => {
  resolverSees('linux');
  const posix = [shellTool(), shellTool()];
  assert.equal(JSON.stringify(posix[0]), JSON.stringify(posix[1]));
  resolverSees('win32', 'pwsh');
  const powershell = [shellTool(), shellTool()];
  assert.equal(JSON.stringify(powershell[0]), JSON.stringify(powershell[1]));
  assert.notEqual(JSON.stringify(posix[0]), JSON.stringify(powershell[0]));
  resolverSees('linux');
  assert.equal(JSON.stringify(shellTool()), JSON.stringify(posix[0]));
});
