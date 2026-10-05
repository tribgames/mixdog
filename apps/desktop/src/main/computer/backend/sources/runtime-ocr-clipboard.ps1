function Do-OcrImage($req) {
    $encoded = [string]$req.image_base64
    if ([string]::IsNullOrWhiteSpace($encoded)) { throw 'ocr_image requires image_base64' }
    $maximum = if ($null -ne $req.max_ocr_words) { [int]$req.max_ocr_words } else { 300 }
    if ($maximum -lt 1 -or $maximum -gt 1000) { throw 'max_ocr_words must be 1..1000' }
    [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
    $stream = $null
    $writer = $null
    $bitmap = $null
    try {
        # Keep screenshots in volatile memory, including when the worker is killed.
        $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
        $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
        $writer.WriteBytes([Convert]::FromBase64String($encoded))
        [void](Await-WinRt ($writer.StoreAsync()) ([uint32]))
        $writer.DetachStream() | Out-Null
        $writer.Dispose()
        $writer = $null
        $stream.Seek(0)
        $decoder = Await-WinRt (
            [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
        ) ([Windows.Graphics.Imaging.BitmapDecoder])
        $maximumDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
        $largest = [math]::Max($decoder.PixelWidth, $decoder.PixelHeight)
        # Window text a dozen pixels tall defeats the recognizer (Korean menus
        # read "도움말" as "도용말대"); doubling it recovered those words while a
        # triple did worse. The boxes are divided back, so callers keep seeing
        # pixels of the image they sent.
        $upscale = if ($largest -le 1600 -and $largest * 2 -le $maximumDimension) { 2 } else { 1 }
        if ($largest -gt $maximumDimension -or $upscale -gt 1) {
            [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
            $scale = if ($upscale -gt 1) { $upscale } else { $maximumDimension / [double]$largest }
            $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
            $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Cubic
            $transform.ScaledWidth = [uint32][math]::Max(1, [math]::Floor($decoder.PixelWidth * $scale))
            $transform.ScaledHeight = [uint32][math]::Max(1, [math]::Floor($decoder.PixelHeight * $scale))
            $bitmap = Await-WinRt (
                $decoder.GetSoftwareBitmapAsync(
                    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                    [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,
                    $transform,
                    [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
                    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)
            ) ([Windows.Graphics.Imaging.SoftwareBitmap])
        }
        else {
            $bitmap = Await-WinRt (
                $decoder.GetSoftwareBitmapAsync()
            ) ([Windows.Graphics.Imaging.SoftwareBitmap])
        }
        $language = ([string]$req.ocr_language).Trim()
        $engine = if ($language) {
            [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
                ([Windows.Globalization.Language]::new($language)))
        }
        else {
            [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        }
        if ($null -eq $engine) {
            throw "Windows OCR has no recognizer for language '$language'"
        }
        $ocr = Await-WinRt (
            $engine.RecognizeAsync($bitmap)
        ) ([Windows.Media.Ocr.OcrResult])
        $words = New-Object System.Collections.ArrayList
        $lines = New-Object System.Collections.ArrayList
        $totalWords = 0
        $lineIndex = 0
        foreach ($line in $ocr.Lines) {
            $minX = [double]::PositiveInfinity; $minY = [double]::PositiveInfinity
            $maxX = [double]::NegativeInfinity; $maxY = [double]::NegativeInfinity
            foreach ($word in $line.Words) {
                $bounds = $word.BoundingRect
                $rect = @{
                    X      = [double]$bounds.X / $upscale
                    Y      = [double]$bounds.Y / $upscale
                    Width  = [double]$bounds.Width / $upscale
                    Height = [double]$bounds.Height / $upscale
                }
                $minX = [math]::Min($minX, $rect.X)
                $minY = [math]::Min($minY, $rect.Y)
                $maxX = [math]::Max($maxX, $rect.X + $rect.Width)
                $maxY = [math]::Max($maxY, $rect.Y + $rect.Height)
                if ($totalWords -lt $maximum) {
                    [void]$words.Add([ordered]@{
                            text     = [string]$word.Text
                            line     = [int]$lineIndex
                            x        = [int][math]::Round($rect.X)
                            y        = [int][math]::Round($rect.Y)
                            width    = [int][math]::Round($rect.Width)
                            height   = [int][math]::Round($rect.Height)
                            center_x = [int][math]::Round($rect.X + $rect.Width / 2)
                            center_y = [int][math]::Round($rect.Y + $rect.Height / 2)
                        })
                }
                $totalWords++
            }
            [void]$lines.Add([ordered]@{
                    line   = [int]$lineIndex
                    text   = [string]$line.Text
                    x      = $(if ([double]::IsInfinity($minX)) { 0 } else { [int][math]::Round($minX) })
                    y      = $(if ([double]::IsInfinity($minY)) { 0 } else { [int][math]::Round($minY) })
                    width  = $(if ([double]::IsInfinity($minX)) { 0 } else { [int][math]::Round($maxX - $minX) })
                    height = $(if ([double]::IsInfinity($minY)) { 0 } else { [int][math]::Round($maxY - $minY) })
                })
            $lineIndex++
        }
        return @{
            text            = ('OCR: ' + $lineIndex + ' lines, ' + $totalWords + ' words')
            language        = [string]$engine.RecognizerLanguage.LanguageTag
            image_width     = [int]($bitmap.PixelWidth / $upscale)
            image_height    = [int]($bitmap.PixelHeight / $upscale)
            lines           = @($lines)
            words           = @($words)
            total_words     = [int]$totalWords
            truncated_words = [math]::Max(0, [int]$totalWords - [int]$words.Count)
        }
    }
    finally {
        if ($null -ne $bitmap -and $bitmap -is [System.IDisposable]) { $bitmap.Dispose() }
        if ($null -ne $writer -and $writer -is [System.IDisposable]) { $writer.Dispose() }
        if ($null -ne $stream -and $stream -is [System.IDisposable]) { $stream.Dispose() }
    }
}

function Do-OcrStatus($req) {
    [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
    $requested = ([string]$req.ocr_language).Trim()
    $installed = @(
        [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
            ForEach-Object { [string]$_.LanguageTag }
    )
    $engine = if ($requested) {
        [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
            ([Windows.Globalization.Language]::new($requested)))
    }
    else {
        [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    return @{
        text                = 'Windows OCR readiness'
        available           = $null -ne $engine
        requested_language  = $(if ($requested) { $requested } else { $null })
        active_language     = $(if ($null -ne $engine) { [string]$engine.RecognizerLanguage.LanguageTag } else { $null })
        installed_languages = @($installed)
    }
}

# Clipboard passthrough is an explicit global operation. Semantic set_value is
# preferred because it neither replaces the user's clipboard nor steals focus.
function Do-ClipboardRead {
    $text = [System.Windows.Forms.Clipboard]::GetText()
    if (-not $text) { return @{ text = 'Clipboard is empty or not text.' } }
    if ($text.Length -gt 30000) { $text = $text.Substring(0, 30000) + '... (truncated)' }
    return @{ text = $text }
}

function Do-ClipboardWrite($text) {
    Assert-ExecutionAuthorization $script:CurrentRequest
    if ($null -eq $text -or ([string]$text).Length -eq 0) {
        [System.Windows.Forms.Clipboard]::Clear()
        $verified = -not [System.Windows.Forms.Clipboard]::ContainsText()
        return New-ActionResult 'clipboard_write' 'clipboard' (Get-VerifiedEffect $verified) $verified 'cleared clipboard' $null 'background' $null
    }
    [System.Windows.Forms.Clipboard]::SetText([string]$text)
    $verified = [System.Windows.Forms.Clipboard]::GetText() -eq [string]$text
    return New-ActionResult 'clipboard_write' 'clipboard' (Get-VerifiedEffect $verified) $verified ('clipboard set: ' + ([string]$text).Length + ' chars') $null 'background' $null
}

