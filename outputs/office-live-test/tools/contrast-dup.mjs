// Reproduces the portable low-contrast test and prints every low_contrast issue with its source.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const cwd = resolve('.');
const dir = await mkdtemp(join(tmpdir(), 'contrast-'));
const value = (r) => JSON.parse(r.content[0].text);
const created = value(
  await executeOfficeTool(
    {
      action: 'create',
      path: join(dir, 'c.pptx'),
      mode: 'portable',
      operations: [
        { op: 'add_slide' },
        { op: 'add_shape', slide: 1, shapeType: 'rectangle', text: 'Hard to read', properties: { left: 60, top: 60, width: 400, height: 120, fillColor: 'F4F6F8', color: 'E7E9EC', fontSize: 14 } },
      ],
    },
    { cwd }
  )
);
const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
console.log(JSON.stringify((issues.issues || []).filter((i) => i.code === 'low_contrast'), null, 1));
await executeOfficeTool({ action: 'close', session: created.session }, { cwd });
