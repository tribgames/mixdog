#!/usr/bin/env node
// Gives a dev-built `mixdogd` the install layout a product install has: the `js-runtime.json` that
// mixdog-app-server-daemon's js_runtime resolver reads beside the binary, naming the interpreter, the
// JS package root and the ONNX Runtime library (`ortLibrary`). Nothing is searched for: every path is an
// argument, and each must exist.
//
//   node apps/desktop/scripts/dev-core-install.mjs --exe=<cargo-target>/debug/mixdogd.exe \
//     --ort-library=<.../onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll> [--package-root=<repo>] [--program=<node>]
//
// The library is the file the shipped app loads: onnxruntime-node 1.30.0's (package.json pins it), the
// one stage-core.mjs's `ortLibraryPath` names. `--package-root` defaults to this checkout, `--program` to
// the Node running this script.
import { access, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { JS_RUNTIME_MANIFEST } from './stage-core.mjs';

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export async function writeDevInstall({ exe, ortLibrary, packageRoot = checkoutRoot, program = process.execPath }) {
  const paths = { exe: resolve(exe), ortLibrary: resolve(ortLibrary), packageRoot: resolve(packageRoot), program: resolve(program) };
  for (const [name, file] of Object.entries({
    exe: paths.exe,
    ortLibrary: paths.ortLibrary,
    program: paths.program,
    packageRoot: join(paths.packageRoot, 'src', 'skill-script-entry.mjs'),
  })) {
    await access(file).catch(() => {
      throw new Error(`--${name === 'ortLibrary' ? 'ort-library' : name === 'packageRoot' ? 'package-root' : name}: ${file} does not exist`);
    });
  }
  const manifest = { program: paths.program, packageRoot: paths.packageRoot, electron: false, ortLibrary: paths.ortLibrary };
  const file = join(dirname(paths.exe), JS_RUNTIME_MANIFEST);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return { file, manifest };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    const exe = argument('exe');
    const ortLibrary = argument('ort-library');
    if (!exe || !ortLibrary) throw new Error('usage: --exe=<mixdogd> --ort-library=<onnxruntime library> [--package-root=<dir>] [--program=<node>]');
    const { file } = await writeDevInstall({ exe, ortLibrary, packageRoot: argument('package-root'), program: argument('program') });
    console.log(`[dev-core-install] wrote ${file}`);
  } catch (error) {
    console.error(`[dev-core-install] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
