import assert from 'node:assert/strict';
import test from 'node:test';
import { runComputerProbe } from './fixtures/probe-runner.mjs';

// The probe inherits this process's environment: this live node process's
// image (node.exe, embedded-signed by its publisher, not a browser vendor) is a
// real signed process the per-fill image verification can bind to.
process.env.MIXDOG_SIGTEST_PID = String(process.pid);

// The generated Windows worker's own saved-login checks (runtime-saved-login.ps1):
// the decisions on plain facts, then a real window that is no browser. Nothing
// here takes the foreground or types: the refused window is never touched.
const PROBE = String.raw`
[Console]::Error.WriteLine('probe:saved-login')
$results = [ordered]@{}
function Facts($patch) {
    $facts = @{ Edit = $true; Focused = $true; Enabled = $true; ReadOnly = $false; Password = $false; ValueLength = 0 }
    foreach ($key in $patch.Keys) { $facts[$key] = $patch[$key] }
    return $facts
}
$results.fields = @(
    (Get-SavedLoginFieldRefusal (Facts @{ Password = $true }) 'password'),
    (Get-SavedLoginFieldRefusal (Facts @{}) 'password'),
    (Get-SavedLoginFieldRefusal (Facts @{}) 'username'),
    (Get-SavedLoginFieldRefusal (Facts @{ Password = $true }) 'username'),
    (Get-SavedLoginFieldRefusal (Facts @{ ReadOnly = $true }) 'username'),
    (Get-SavedLoginFieldRefusal (Facts @{ Enabled = $false; Password = $true }) 'password'),
    (Get-SavedLoginFieldRefusal (Facts @{ Edit = $false }) 'username'),
    (Get-SavedLoginFieldRefusal (Facts @{ Focused = $false; Password = $true }) 'password')
)
$results.pages = @(foreach ($url in @(
            'https://login.example.com/signin?x=1', 'http://login.example.com/', 'https://user:pass@login.example.com/',
            'about:blank', 'blob:https://login.example.com/1', 'file:///C:/login.html', 'https://localhost:8443/login', '')) {
        $null -ne (Get-SavedLoginPageUri $url)
    })
$www = Get-SavedLoginPageUri 'https://www.example.com/login'
$port = Get-SavedLoginPageUri 'https://example.com:8443/login'
$idn = Get-SavedLoginPageUri 'https://xn--bcher-kva.example/'
$results.bars = @(
    (Test-SavedLoginAddressBar 'example.com/login' $www),
    (Test-SavedLoginAddressBar 'www.example.com' $www),
    (Test-SavedLoginAddressBar 'https://www.example.com/login?next=1' $www),
    (Test-SavedLoginAddressBar 'http://www.example.com/login' $www),
    (Test-SavedLoginAddressBar 'evil.example.net/www.example.com' $www),
    (Test-SavedLoginAddressBar 'example.com.evil.example.net' $www),
    (Test-SavedLoginAddressBar '' $www),
    (Test-SavedLoginAddressBar 'words being typed' $www),
    (Test-SavedLoginAddressBar 'example.com:8443/login' $port),
    (Test-SavedLoginAddressBar 'example.com/login' $port),
    (Test-SavedLoginAddressBar 'bücher.example' $idn)
)
$results.origins = @(foreach ($url in @(
            'https://LOGIN.Example.com:443/a?b=1#c', 'https://login.example.com:8443/x', 'https://xn--bcher-kva.example/',
            'https://bücher.example/p')) {
        Get-SavedLoginOrigin (Get-SavedLoginPageUri $url)
    })
$expected = @{ window_id = 'hwnd:0x1'; pid = '10'; origin = 'https://login.example.com'; document_id = '42.1'; runtime_id = '42.2'; field = 'password'; value_length = 0 }
function Changed($patch) {
    $actual = @{} + $expected
    foreach ($key in $patch.Keys) { $actual[$key] = $patch[$key] }
    return Get-SavedLoginChange ([pscustomobject]$expected) $actual
}
$results.changes = @(
    (Changed @{}),
    (Changed @{ origin = 'https://login.example.com:8443' }),
    (Changed @{ pid = '11' }),
    (Changed @{ runtime_id = '42.3' }),
    (Changed @{ document_id = '42.9' }),
    (Changed @{ window_id = 'hwnd:0x2' }),
    (Changed @{ value_length = 3 })
)
$results.noCheck = Get-SavedLoginChange $null $expected
$form = New-Object System.Windows.Forms.Form
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point(-30000, -30000)
$form.Size = New-Object System.Drawing.Size(400, 200)
$form.ShowInTaskbar = $false
$form.Text = 'mixdog-saved-login-probe-' + $PID
$secretBox = New-Object System.Windows.Forms.TextBox
$secretBox.UseSystemPasswordChar = $true
$secretBox.Location = New-Object System.Drawing.Point(10, 10)
$plainBox = New-Object System.Windows.Forms.TextBox
$plainBox.Location = New-Object System.Drawing.Point(10, 50)
$form.Controls.Add($secretBox)
$form.Controls.Add($plainBox)
[void]$form.Handle
[void]$secretBox.Handle
[void]$plainBox.Handle
[void][MixWin32]::ShowWindow($form.Handle, 4)
[System.Windows.Forms.Application]::DoEvents()
$script:CurrentSession = Get-SessionState 'saved-login-probe'
$windowId = [MixWin32]::WindowId($form.Handle)
$foregroundBefore = [MixWin32]::Foreground()
try {
    [void](Do-SavedLoginCheck ([pscustomobject]@{ window_id = $windowId; window = $null; field = 'password' }))
    $results.check = 'accepted'
}
catch { $results.check = "$($_.Exception.Message)" }
try {
    [void](Do-SavedLoginType ([pscustomobject]@{
                window_id = $windowId; window = $null; field = 'password'; delivery = 'foreground'
                text = 'probe-secret-value'; expected = [pscustomobject]$expected
            }))
    $results.typed = 'accepted'
}
catch { $results.typed = "$($_.Exception.Message)" }
[System.Windows.Forms.Application]::DoEvents()
$results.window = @{
    secretText     = $secretBox.Text
    plainText      = $plainBox.Text
    foregroundKept = [MixWin32]::Foreground() -eq $foregroundBefore
}
try {
    [void](Get-SavedLoginDocument ($AE::FromHandle($plainBox.Handle)) ([MixWin32]::Info($form.Handle)))
    $results.document = 'accepted'
}
catch { $results.document = "$($_.Exception.Message)" }
# The live process's own image, verified on every call and bound to that
# process by its creation time: the test's node process verifies (signed by its
# own publisher) twice, each time afresh, and is refused as Chrome; pid 0 and a
# gone process refuse. The trust call never touches the network.
$sigPid = [uint32]$env:MIXDOG_SIGTEST_PID
$first = [MixWin32]::VerifiedProcessImage($sigPid)
$second = [MixWin32]::VerifiedProcessImage($sigPid)
function SignedAs($app, $processId) {
    try { [void](Assert-SavedLoginSignedImage ([pscustomobject]@{ App = $app; Pid = $processId })); return 'accepted' }
    catch { return "$($_.Exception.Message)" }
}
$results.sig = @{
    publisher  = [string]$first.Publisher
    path       = [System.IO.Path]::GetFileName([string]$first.Path)
    bound      = [long]$first.StartTime -ne 0 -and [long]$first.StartTime -eq [long][MixWin32]::ProcessStartTime($sigPid)
    again      = [string]$second.Publisher -ceq [string]$first.Publisher -and [long]$second.StartTime -eq [long]$first.StartTime
    flags      = [MixWin32]::SavedLoginTrustFlags
    asChrome   = SignedAs 'chrome' $sigPid
    zero       = SignedAs 'msedge' 0
    gone       = [string]([MixWin32]::VerifiedProcessImage([uint32]4294967292).Publisher)
}
# Owner death proof (Do-ProcessFate): a real child process, bound while it
# runs, then proven ended once it exited; another creation time is another
# process; an id the OS will not open for us (System) is unknown, never ended.
$child = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/k' -PassThru -WindowStyle Hidden
$bound = Do-ProcessFate ([pscustomobject]@{ pid = [string]$child.Id; created = '' })
$wrongTime = Do-ProcessFate ([pscustomobject]@{ pid = [string]$child.Id; created = '1' })
$child.Kill()
$child.WaitForExit()
$whileHeld = Do-ProcessFate ([pscustomobject]@{ pid = [string]$child.Id; created = $bound.created })
$childId = $child.Id
$child.Dispose()
[GC]::Collect(); [GC]::WaitForPendingFinalizers()
$released = Do-ProcessFate ([pscustomobject]@{ pid = [string]$childId; created = $bound.created })
$results.fate = @{
    running   = $bound.state
    created   = [bool]$bound.created
    wrongTime = $wrongTime.state
    whileHeld = $whileHeld.state
    released  = $released.state
    self      = (Do-ProcessFate ([pscustomobject]@{ pid = [string]$PID; created = '' })).state
    system    = (Do-ProcessFate ([pscustomobject]@{ pid = '4'; created = '' })).state
    bad       = (Do-ProcessFate ([pscustomobject]@{ pid = 'x'; created = '' })).state
}
# M1: a window with no readable omnibox cannot prove its page and is refused.
try {
    Assert-SavedLoginAddressBars $form.Handle $www
    $results.addressBars = 'accepted'
}
catch { $results.addressBars = "$($_.Exception.Message)" }
$form.Close()
$form.Dispose()
[Console]::Out.WriteLine('@@MIXCU@@' + ($results | ConvertTo-Json -Compress -Depth 5))
exit
`;

test('the Windows worker refuses every saved-login target it cannot prove, before any key', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 200_000,
}, async () => {
  const result = await runComputerProbe(PROBE);
  assert.deepEqual(result.fields, [
    '',
    'the focused field is not a password field',
    '',
    'the focused field is a password field, not a username field',
    'the focused field is disabled or read-only',
    'the focused field is disabled or read-only',
    'the focused element is not a text field',
    'the field does not hold keyboard focus',
  ]);
  // Only an https page with a host and no credentials in its address.
  assert.deepEqual(result.pages, [true, false, false, false, false, false, true, false]);
  // The address bar must name the page's own site: full, or Chromium's short form.
  assert.deepEqual(result.bars, [true, true, true, false, false, false, false, false, true, false, true]);
  // Origins as URL.origin spells them: scheme, lower-case ASCII host, port only when not 443.
  assert.deepEqual(result.origins, [
    'https://login.example.com',
    'https://login.example.com:8443',
    'https://xn--bcher-kva.example',
    'https://xn--bcher-kva.example',
  ]);
  for (const url of [
    'https://LOGIN.Example.com:443/a?b=1#c',
    'https://login.example.com:8443/x',
    'https://bücher.example/p',
  ]) {
    assert.ok(result.origins.includes(new URL(url).origin), `matches URL.origin for ${url}`);
  }
  assert.deepEqual(result.changes, [
    '',
    'the page origin changed',
    'the browser process changed',
    'focus moved to another element',
    'the page was replaced',
    'the browser window changed',
    'the field content changed',
  ]);
  assert.equal(result.noCheck, 'the browser window changed');
  // A window that is not a browser is refused before it is touched.
  for (const outcome of [result.check, result.typed]) {
    assert.match(outcome, /^saved_login_refused: the window belongs to 'powershell', not a Chrome or Edge/);
    assert.match(outcome, /no input was sent$/);
  }
  // No key reached either box and the foreground never moved.
  assert.deepEqual(result.window, { secretText: '', plainText: '', foregroundKept: true });
  assert.equal(
    result.document,
    'saved_login_refused: focus is not on a web page of this browser window; no input was sent'
  );
  // The live process image, verified per call (cache-only chain, no revocation
  // fetch), bound to that process; its signer, not the basename, decides trust.
  assert.equal(result.sig.flags, 0x10 | 0x1000, 'WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL');
  assert.equal(
    result.sig.zero,
    "saved_login_refused: the 'msedge' window's program could not be verified as a signed browser; no input was sent"
  );
  assert.equal(result.sig.gone, '');
  if (result.sig.publisher) {
    assert.equal(result.sig.path.toLowerCase(), 'node.exe');
    assert.equal(result.sig.bound, true);
    assert.equal(result.sig.again, true);
    assert.equal(
      result.sig.asChrome,
      "saved_login_refused: the 'chrome' window's program is not signed by Google LLC; no input was sent"
    );
  } else {
    // An unsigned test node refuses as unverifiable, never silently trusted.
    assert.match(result.sig.asChrome, /could not be verified as a signed browser/);
  }
  // No readable address bar, no proof of the page.
  assert.match(result.addressBars, /no readable address bar/);
  // A saved-login owner's death is proven by the OS, never guessed: a running
  // process is running; once it exited it is ended, whether a handle to it is
  // still held (signaled) or not (the id no longer opens); another creation
  // time is another process; an id we may not open is unknown.
  assert.deepEqual(result.fate, {
    running: 'running',
    created: true,
    wrongTime: 'ended',
    whileHeld: 'ended',
    released: 'ended',
    self: 'running',
    system: 'unknown',
    bad: 'unknown',
  });
});
