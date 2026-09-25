# Prints PowerPoint's own reading of a shape's font colour: pwsh ppt-font-color.ps1 <deck.pptx> <slide> <shape>
param([string]$Path, [int]$Slide = 3, [int]$Shape = 1)
$app = New-Object -ComObject PowerPoint.Application
try {
    $deck = $app.Presentations.Open((Resolve-Path $Path).Path, $true, $false, $false)
    $font = $deck.Slides.Item($Slide).Shapes.Item($Shape).TextFrame.TextRange.Font
    $rgb = $font.Color.RGB
    "RGB=$rgb type=$($rgb.GetType().FullName) ObjectThemeColor=$($font.Color.ObjectThemeColor) Type=$($font.Color.Type)"
    try { "long=" + [long]$rgb } catch { "long failed: $($_.Exception.Message)" }
    $deck.Close()
}
finally {
    $app.Quit()
}
