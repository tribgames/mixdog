// electron-builder afterSign hook: notarizes the signed macOS app and staples
// its ticket before the dmg and zip are made. electron-builder's own notarize
// step gives the staple only a few seconds of retries, while Apple's ticket
// service (api.apple-cloudkit.com) drops hosted runners' connections for many
// minutes (stapler exit 68). Only that failure is retried here; every other
// failure, and a rejected submission, fails the build.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const STAPLE_ATTEMPTS = 20;
const STAPLE_PAUSE_SECONDS = 30;
const STAPLER_NO_HOST = 68;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (output) process.stdout.write(output);
  return { status: result.status, stdout: result.stdout || '', output };
}

function must(command, args) {
  const result = run(command, args);
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed with code ${result.status}`);
  return result;
}

module.exports = async function notarizeMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  // Only the CI release lane exports the notary key; local and unsigned builds skip.
  if (!APPLE_API_KEY) return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const zip = path.join(context.appOutDir, 'notarize-upload.zip');
  must('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const auth = ['--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER];
  const submitted = JSON.parse(
    must('xcrun', ['notarytool', 'submit', zip, ...auth, '--wait', '--output-format', 'json']).stdout
  );
  must('rm', ['-f', zip]);
  if (submitted.status !== 'Accepted') {
    run('xcrun', ['notarytool', 'log', submitted.id, ...auth]);
    throw new Error(`notarization ${submitted.id} ended as ${submitted.status}`);
  }

  for (let attempt = 1; ; attempt += 1) {
    const stapled = run('xcrun', ['stapler', 'staple', '-v', app]);
    if (stapled.status === 0) return;
    if (stapled.status !== STAPLER_NO_HOST || attempt === STAPLE_ATTEMPTS) {
      throw new Error(`stapler staple failed with code ${stapled.status} (attempt ${attempt})`);
    }
    console.log(`stapler could not reach Apple (attempt ${attempt}/${STAPLE_ATTEMPTS}); retrying in ${STAPLE_PAUSE_SECONDS}s`);
    await new Promise((resolve) => setTimeout(resolve, STAPLE_PAUSE_SECONDS * 1000));
  }
};
