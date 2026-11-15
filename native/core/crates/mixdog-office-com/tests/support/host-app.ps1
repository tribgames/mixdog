param([string]$Format, [string]$Dir, [string]$Names)
$ErrorActionPreference = 'Stop'
$progId = @{ docx = 'Word.Application'; xlsx = 'Excel.Application'; pptx = 'PowerPoint.Application' }[$Format]
$processName = @{ docx = 'WINWORD'; xlsx = 'EXCEL'; pptx = 'POWERPNT' }[$Format]
$before = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$app = New-Object -ComObject $progId
$after = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id } | Where-Object { $before -notcontains $_ })
foreach ($name in ($Names -split ',')) {
    $path = Join-Path $Dir $name
    switch ($Format) {
        'docx' { $document = $app.Documents.Add(); $document.SaveAs2($path) }
        'xlsx' { $book = $app.Workbooks.Add(); $book.SaveAs($path) }
        'pptx' { $deck = $app.Presentations.Add(0); $null = $deck.Slides.Add(1, 12); $deck.SaveAs($path) }
    }
}
[Console]::Out.WriteLine((@{ ready = $true; appPid = $(if ($after.Count -gt 0) { [int]$after[0] } else { 0 }) } | ConvertTo-Json -Compress))
$null = [Console]::In.ReadLine()
try { $app.Quit() } catch {}
