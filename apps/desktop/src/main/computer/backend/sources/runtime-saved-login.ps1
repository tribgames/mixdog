# Saved logins filled into the user's browser window (host/saved-login.ts). A
# username or password goes only into the field holding focus on the top-level
# HTTPS page of a Chrome or Edge window whose live process image is
# Authenticode-signed by that vendor, and only after all of that was read from
# the live window: first by the check the host looks the login up with, then
# again immediately before the write, which must find the same window, process,
# origin, document, element and field content. The value is written once,
# through the validated element's own value pattern (ValuePattern.SetValue);
# there is no keystroke path. No reply ever carries the value.

# The Authenticode signer organization of each supported browser's image, as
# measured with WinVerifyTrust on the shipped binaries (msedge.exe: O=Microsoft
# Corporation; chrome.exe: O=Google LLC). Brave is not listed: its signer was
# not measured here, so it is refused until it is.
$script:SavedLoginVendors = @{
    chrome = 'Google LLC'
    msedge = 'Microsoft Corporation'
}
$script:SavedLoginWalker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$script:SavedLoginIdn = New-Object System.Globalization.IdnMapping
# The window class Chromium hosts web content in; page elements never have one.
$script:SavedLoginContentClass = 'Chrome_RenderWidgetHostHWND'

function Stop-SavedLogin([string]$reason) {
    throw "saved_login_refused: $reason; no input was sent"
}

function Stop-SavedLoginChanged([string]$reason) {
    throw "saved_login_changed: $reason since the check; nothing was written"
}

function Get-SavedLoginRuntimeId($element) {
    return (@($element.GetRuntimeId()) -join '.')
}

# The rule `field` puts on the focused element, judged on plain facts: '' when
# the value may go there, else why not.
function Get-SavedLoginFieldRefusal($facts, [string]$field) {
    if (-not $facts.Edit) { return 'the focused element is not a text field' }
    if (-not $facts.Focused) { return 'the field does not hold keyboard focus' }
    if (-not $facts.Enabled -or $facts.ReadOnly) { return 'the focused field is disabled or read-only' }
    if ($field -eq 'password') {
        if (-not $facts.Password) { return 'the focused field is not a password field' }
        return ''
    }
    if ($facts.Password) { return 'the focused field is a password field, not a username field' }
    return ''
}

# The page address a login is matched against: an absolute https URL with a
# host and no user name or password in it; $null for anything else.
function Get-SavedLoginPageUri([string]$url) {
    $uri = $null
    if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri)) { return $null }
    if ($uri.Scheme -cne 'https' -or -not $uri.Host -or $uri.UserInfo) { return $null }
    return $uri
}

# The page's origin as Browser Use's secureOrigin spells it (URL.origin):
# scheme, the lower-case ASCII host and the port only when not 443. The path,
# query and fragment never take part. The host checks it agrees with its own.
function Get-SavedLoginOrigin($uri) {
    $pageHost = $uri.IdnHost.ToLowerInvariant()
    if ($uri.HostNameType -eq [UriHostNameType]::IPv6 -and -not $pageHost.StartsWith('[')) { $pageHost = "[$pageHost]" }
    $port = if ($uri.IsDefaultPort) { '' } else { ":$($uri.Port)" }
    return "https://$pageHost$port"
}

# Whether address-bar text names the page's own site: the full address, or the
# short form Chromium shows (no scheme, no "www.", no path), by host and port.
# Text being edited, or another site, does not.
function Test-SavedLoginAddressBar([string]$text, $uri) {
    $value = $text.Trim()
    if (-not $value) { return $false }
    $pageHost = $uri.IdnHost.ToLowerInvariant()
    if ($value -match '^[A-Za-z][A-Za-z0-9+.-]*://') {
        $shown = $null
        if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$shown)) { return $false }
        return $shown.Scheme -ceq $uri.Scheme -and $shown.IdnHost.ToLowerInvariant() -ceq $pageHost -and $shown.Port -eq $uri.Port
    }
    $authority = [regex]::Match(($value -split '[/?#]', 2)[0], '^(?<host>\[[^\]]+\]|[^:\s]+)(?::(?<port>\d{1,5}))?$')
    if (-not $authority.Success) { return $false }
    $shownPort = if ($authority.Groups['port'].Success) { [int]$authority.Groups['port'].Value } else { 443 }
    $shownHost = $authority.Groups['host'].Value
    if (-not $shownHost.StartsWith('[')) {
        try { $shownHost = $script:SavedLoginIdn.GetAscii($shownHost) } catch { return $false }
    }
    $shownHost = $shownHost.ToLowerInvariant()
    return $shownPort -eq $uri.Port -and ($shownHost -ceq $pageHost -or "www.$shownHost" -ceq $pageHost)
}

# What changed between the host's check and the write step, or ''. The origin,
# not the full address, is compared: a path, query or fragment change on the
# same site keeps the login valid.
function Get-SavedLoginChange($expected, $actual) {
    if ([string]$actual.window_id -cne [string]$expected.window_id) { return 'the browser window changed' }
    if ([string]$actual.pid -cne [string]$expected.pid) { return 'the browser process changed' }
    if ([string]$actual.origin -cne [string]$expected.origin) { return 'the page origin changed' }
    if ([string]$actual.document_id -cne [string]$expected.document_id) { return 'the page was replaced' }
    if ([string]$actual.runtime_id -cne [string]$expected.runtime_id) { return 'focus moved to another element' }
    if ([string]$actual.field -cne [string]$expected.field) { return 'another field kind was asked for' }
    if ([int]$actual.value_length -ne [int]$expected.value_length) { return 'the field content changed' }
    return ''
}

# Reads that fail for any reason refuse; a refusal keeps its own reason.
function Invoke-SavedLoginRead([scriptblock]$read) {
    try { return & $read }
    catch {
        if ("$($_.Exception.Message)" -match '^(saved_login_|window_id is stale)') { throw }
        Stop-SavedLogin 'the browser window could not be read through accessibility'
    }
}

# The window a login may go into, by its own word: a top-level Chromium frame
# window whose process is named chrome, msedge or brave. Its signature is
# proven separately (Assert-SavedLoginSignedImage) before any of its
# accessibility data is trusted.
function Assert-SavedLoginBrowser($handle) {
    if (-not [MixWin32]::IsWindowHandle($handle)) { throw "window_id is stale or invalid: $([MixWin32]::WindowId($handle))" }
    $info = [MixWin32]::Info($handle)
    $process = ([string]$info.App).ToLowerInvariant()
    if ($process -eq 'firefox') {
        Stop-SavedLogin 'Firefox is not supported yet: its page address cannot be read reliably through accessibility'
    }
    if ($process -eq 'brave') {
        Stop-SavedLogin 'Brave is not supported yet: its code signer has not been verified'
    }
    if (-not $script:SavedLoginVendors.ContainsKey($process) -or $info.ClassName -cne 'Chrome_WidgetWin_1' -or
        [MixWin32]::TopLevelWindow($handle) -ne $handle) {
        Stop-SavedLogin "the window belongs to '$process', not a Chrome or Edge browser window; saved logins are web logins"
    }
    return $info
}

# The live process behind the window, verified afresh (no cache): its kernel
# image path, held open with writes denied, must carry a valid Authenticode
# signature (cache-only chain, no network) whose organization is the vendor the
# process name claims, and the image name must be that process name. Returns
# the process's creation time, which binds every later read to this process.
# Anything unproven refuses.
function Assert-SavedLoginSignedImage($info) {
    $process = ([string]$info.App).ToLowerInvariant()
    $vendor = [string]$script:SavedLoginVendors[$process]
    $image = $null
    try { $image = [MixWin32]::VerifiedProcessImage([uint32]$info.Pid) } catch { }
    if ($null -eq $image -or -not $image.Publisher -or [long]$image.StartTime -eq 0) {
        Stop-SavedLogin "the '$process' window's program could not be verified as a signed browser"
    }
    if ([System.IO.Path]::GetFileNameWithoutExtension([string]$image.Path).ToLowerInvariant() -cne $process -or
        [string]$image.Publisher -cnotmatch ('(?:^|,\s*)O=(?:"' + [regex]::Escape($vendor) + '"|' + [regex]::Escape($vendor) + ')\s*(?:,|$)')) {
        Stop-SavedLogin "the '$process' window's program is not signed by $vendor"
    }
    return [long]$image.StartTime
}

# The page document holding `element`, walking up the window's own
# accessibility tree: the nearest document must be the web content root,
# hosted directly by the browser's render widget window, and the walk must end
# at this browser window. A field in an embedded frame or a nested document, or
# in the browser's own UI such as the address bar, is refused.
function Get-SavedLoginDocument($element, $info) {
    $document = $null
    $current = $element
    # The raw view is a finite tree rooted at the desktop, so the walk ends.
    while ($true) {
        $current = $script:SavedLoginWalker.GetParent($current)
        if ($null -eq $current) { break }
        $node = $current.Current
        if ([long]$node.NativeWindowHandle -eq $info.Handle.ToInt64()) {
            if ($null -ne $document) { return $document }
            break
        }
        if ($null -ne $document -or $node.ControlType -ne [System.Windows.Automation.ControlType]::Document) { continue }
        $container = $script:SavedLoginWalker.GetParent($current)
        $containerHandle = if ($null -eq $container) { 0 } else { [long]$container.Current.NativeWindowHandle }
        $containerInfo = if ($containerHandle -ne 0) { [MixWin32]::Info((New-Object IntPtr($containerHandle))) } else { $null }
        if ($null -eq $containerInfo -or $containerInfo.ClassName -cne $script:SavedLoginContentClass -or
            $containerInfo.Pid -ne $info.Pid) {
            Stop-SavedLogin 'the focused field is inside an embedded frame or nested document, not the page itself'
        }
        $document = $current
        $current = $container
    }
    Stop-SavedLogin 'focus is not on a web page of this browser window'
}

function Get-SavedLoginFieldFacts($element) {
    $node = $element.Current
    $value = $null
    $readOnly = $true
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $readOnly = [bool]$pattern.Current.IsReadOnly
        $value = [string]$pattern.Current.Value
    }
    catch { }
    return @{
        Edit        = $node.ControlType -eq [System.Windows.Automation.ControlType]::Edit
        Focused     = [bool]$node.HasKeyboardFocus
        Enabled     = [bool]$node.IsEnabled -and [bool]$node.IsKeyboardFocusable
        ReadOnly    = $readOnly
        Password    = [bool]$node.IsPassword
        ValueLength = if ($null -eq $value) { -1 } else { $value.Length }
    }
}

function Assert-SavedLoginForeground($handle) {
    if ([MixWin32]::Foreground() -ne $handle) { Stop-SavedLogin 'the browser window is not in the foreground' }
}

# The page document's address, read live from the document element.
function Get-SavedLoginDocumentUri($document) {
    $url = ''
    try { $url = [string]$document.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
    return Get-SavedLoginPageUri $url
}

# Everything the login may be written into, read from the live window: the
# browser in the foreground, the focused field and the origin of the page
# document holding it. Returns the host-facing ids plus the live element and
# document. A miss refuses with its reason.
function Get-SavedLoginTarget($handle, [string]$field, $info) {
    Assert-SavedLoginForeground $handle
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused -or [long]$focused.Current.ProcessId -ne [long]$info.Pid) {
        Stop-SavedLogin 'no field of this browser window holds keyboard focus; click the field first'
    }
    $document = Get-SavedLoginDocument $focused $info
    $uri = Get-SavedLoginDocumentUri $document
    if ($null -eq $uri) { Stop-SavedLogin 'the page is not an HTTPS page' }
    $facts = Get-SavedLoginFieldFacts $focused
    $refusal = Get-SavedLoginFieldRefusal $facts $field
    if ($refusal) { Stop-SavedLogin $refusal }
    return @{
        Ids      = @{
            window_id    = $info.Id
            pid          = [string]$info.Pid
            origin       = Get-SavedLoginOrigin $uri
            document_id  = Get-SavedLoginRuntimeId $document
            runtime_id   = Get-SavedLoginRuntimeId $focused
            field        = $field
            value_length = $facts.ValueLength
        }
        Element  = $focused
        Document = $document
        Uri      = $uri
    }
}

# The window's address bars (the toolbar's OmniboxViewViews edit, as Chromium
# exposes it through UIA), in the browser's own UI only: web content can give
# its elements any class name, so a match under a document or the render widget
# window is never an address bar. The whole window is walked; no node budget.
function Get-SavedLoginAddressBars($handle) {
    $texts = New-Object System.Collections.ArrayList
    $pending = New-Object System.Collections.Stack
    $pending.Push([System.Windows.Automation.AutomationElement]::FromHandle($handle))
    while ($pending.Count -gt 0) {
        $child = $script:SavedLoginWalker.GetFirstChild($pending.Pop())
        while ($null -ne $child) {
            $node = $child.Current
            $content = $node.ControlType -eq [System.Windows.Automation.ControlType]::Document -or
            ($node.NativeWindowHandle -ne 0 -and $node.ClassName -ceq $script:SavedLoginContentClass)
            if (-not $content) {
                if ($node.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $node.ClassName -ceq 'OmniboxViewViews') {
                    $text = ''
                    try { $text = [string]$child.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
                    [void]$texts.Add($text)
                }
                else { $pending.Push($child) }
            }
            $child = $script:SavedLoginWalker.GetNextSibling($child)
        }
    }
    return $texts.ToArray()
}

# The window's address bars must positively confirm the page before any input.
# Fail closed: a window with no readable omnibox cannot prove its page (and a
# real Chromium browser always exposes one), and any bar that is blank, being
# edited, or naming another site refuses.
function Assert-SavedLoginAddressBars($handle, $uri) {
    $bars = @(Get-SavedLoginAddressBars $handle)
    if ($bars.Count -lt 1) { Stop-SavedLogin 'this window exposes no readable address bar to confirm the page' }
    foreach ($text in $bars) {
        if (-not (Test-SavedLoginAddressBar $text $uri)) { Stop-SavedLogin "the address bar does not show the page's own site" }
    }
}

# The last reads before the write, as close to it as UIA allows: the browser
# still in the foreground and still the verified process; the focused element
# still the validated one, still the field kind asked for (a password field for
# a password), enabled, focusable and not read-only; still inside the same page
# document; and that document's live address still the origin. These are
# separate UIA reads followed by a separate write: not an atomic browser-side
# compare-and-write, so a change landing between the last read and SetValue
# is not excluded.
function Assert-SavedLoginStill($handle, $info, [long]$startTime, $expected, [string]$field) {
    $why = ''
    try {
        if ([MixWin32]::Foreground() -ne $handle) { $why = 'the browser window left the foreground' }
        elseif ([long][MixWin32]::ProcessStartTime([uint32]$info.Pid) -ne $startTime -or
            [uint32]([MixWin32]::Info($handle).Pid) -ne [uint32]$info.Pid) { $why = 'the browser process changed' }
        else {
            $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
            if ($null -eq $focused -or (Get-SavedLoginRuntimeId $focused) -cne [string]$expected.runtime_id) {
                $why = 'focus moved to another element'
            }
            else {
                $refusal = Get-SavedLoginFieldRefusal (Get-SavedLoginFieldFacts $focused) $field
                if ($refusal) { $why = "the field changed ($refusal)" }
                else {
                    $document = Get-SavedLoginDocument $focused $info
                    if ((Get-SavedLoginRuntimeId $document) -cne [string]$expected.document_id) { $why = 'the field left the checked page' }
                    else {
                        $uri = Get-SavedLoginDocumentUri $document
                        if ($null -eq $uri -or (Get-SavedLoginOrigin $uri) -cne [string]$expected.origin) { $why = 'the page origin changed' }
                    }
                }
            }
        }
    }
    catch {
        $message = "$($_.Exception.Message)"
        $why = if ($message -match '^saved_login_refused: (.+); no input was sent$') { $Matches[1] } else { 'the field could not be re-read' }
    }
    if ($why) { Stop-SavedLoginChanged $why }
}

# Whether a saved-login owner's runtime process has ended, as the OS proves it
# (MixWin32.ProcessFate); never touches the desktop. `created` binds the answer
# to the exact process (empty: whichever process has the id now).
function Do-ProcessFate($req) {
    $pid32 = [uint32]0
    if (-not [uint32]::TryParse([string]$req.pid, [ref]$pid32)) { return @{ state = 'unknown'; created = '' } }
    $expected = [long]0
    if ($req.created -and -not [long]::TryParse([string]$req.created, [ref]$expected)) { return @{ state = 'unknown'; created = '' } }
    $created = [long]0
    $fate = [MixWin32]::ProcessFate($pid32, $expected, [ref]$created)
    # A FILETIME exceeds a JSON number's exact range, so it travels as text.
    return @{ state = @('unknown', 'running', 'ended')[$fate]; created = if ($created) { [string]$created } else { '' } }
}

# The host's check: refuse anything but a verified browser before touching it,
# bring it forward, then read the target the login is looked up for. The window
# must show a readable address bar and every bar it shows must name the page's
# own site.
function Do-SavedLoginCheck($req) {
    $handle = [MixWin32]::ParseWindowId([string]$req.window_id)
    $info = Invoke-SavedLoginRead { Assert-SavedLoginBrowser $handle }
    $startTime = Invoke-SavedLoginRead { Assert-SavedLoginSignedImage $info }
    $focus = Do-Focus $req
    if ($focus.code) {
        $focus.action = 'fill_saved_login'
        return $focus
    }
    $target = Invoke-SavedLoginRead { Get-SavedLoginTarget $handle ([string]$req.field) $info }
    Invoke-SavedLoginRead { Assert-SavedLoginAddressBars $handle $target.Uri }
    if ([long][MixWin32]::ProcessStartTime([uint32]$info.Pid) -ne $startTime) { Stop-SavedLogin 'the browser process changed during the check' }
    $ids = $target.Ids
    # A FILETIME exceeds a JSON number's exact range, so it travels as text.
    $ids.start_time = [string]$startTime
    return @{ text = 'saved login target checked; no input was sent'; saved_login_target = $ids }
}

# The write step: the process verified again and bound to the check's, the
# address bar re-proven, every target read again and matched to the check, and
# the element's value pattern required (no keystroke fallback); then the last
# re-read and exactly one SetValue. A refusal before it writes nothing; once
# SetValue was invoked, any failure is "possibly written", never retried.
function Do-SavedLoginType($req) {
    $value = [string]$req.text
    if (-not $value) { throw 'saved_login_refused: no saved value reached the worker; no input was sent' }
    # An HTML text or password input strips line breaks from its value (WHATWG
    # value sanitization), so such a value could never be confirmed: refuse it
    # before writing instead of leaving a "possibly written" field.
    if ($value -match '[\r\n]') { throw 'saved_login_refused: the saved value holds a line break, which the field would strip; no input was sent' }
    $handle = [MixWin32]::ParseWindowId([string]$req.window_id)
    $field = [string]$req.field
    $expected = $req.expected
    $info = Invoke-SavedLoginRead { Assert-SavedLoginBrowser $handle }
    $write = @{ invoked = $false; failed = $false; confirmed = $false }
    try {
        $result = Invoke-ForegroundInput $handle 'type' {
            $startTime = Invoke-SavedLoginRead { Assert-SavedLoginSignedImage $info }
            if ([string]$info.Pid -cne [string]$expected.pid -or [string]$startTime -cne [string]$expected.start_time) {
                Stop-SavedLoginChanged 'the browser process changed'
            }
            $expectedUri = Get-SavedLoginPageUri ([string]$expected.origin)
            if ($null -eq $expectedUri) { Stop-SavedLogin 'the checked origin is not an HTTPS origin' }
            Invoke-SavedLoginRead { Assert-SavedLoginAddressBars $handle $expectedUri }
            $target = Invoke-SavedLoginRead { Get-SavedLoginTarget $handle $field $info }
            $change = Get-SavedLoginChange $expected $target.Ids
            if ($change) { Stop-SavedLoginChanged $change }
            $pattern = $null
            if (-not $target.Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -or
                $null -eq $pattern) {
                Stop-SavedLogin 'the field takes no direct value write, and saved logins are never typed as keystrokes'
            }
            if ([bool]$pattern.Current.IsReadOnly) { Stop-SavedLogin 'the field is read-only to direct value writes' }
            Assert-SavedLoginStill $handle $info $startTime $expected $field
            [MixInputObservation]::AssertContinue()
            Assert-ExecutionAuthorization $script:CurrentRequest $handle
            $write.invoked = $true
            try { $pattern.SetValue($value) } catch { $write.failed = $true }
            # Length only (a password field reads back masked), through the
            # set_value readback's settle window: Chromium publishes the new
            # value to UIA after SetValue returns (measured live on Edge).
            # The readback never leaves this block.
            try {
                $write.confirmed = -not $write.failed -and
                (Read-ValueUntil $pattern $null { param($actual) $actual.Length -eq $value.Length }).Equal
            }
            catch { }
        }
    }
    catch {
        if ($write.invoked) {
            throw 'saved_login_unconfirmed: the saved value may have been written into the checked field, but the write did not complete cleanly; it is not retried'
        }
        throw
    }
    $result.action = 'fill_saved_login'
    if ($result.code -and -not $write.invoked) { return $result }
    if (-not $write.confirmed) {
        throw 'saved_login_unconfirmed: the saved value may have been written into the checked field, but the field did not confirm it; it is not retried'
    }
    $result.path = 'uia_setvalue'
    $result.effect = 'confirmed'
    $result.text = "wrote the saved $field into the checked field"
    return $result
}