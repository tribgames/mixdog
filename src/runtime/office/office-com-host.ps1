$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit-Json($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 20 -Compress))
}

function ProgId-ForFormat([string]$format) {
  switch ($format.ToLowerInvariant()) {
    'docx' { return 'Word.Application' }
    'xlsx' { return 'Excel.Application' }
    'pptx' { return 'PowerPoint.Application' }
    default { return $null }
  }
}

function Office-SaveFormatForPath([string]$format, [string]$path) {
  $extension = [System.IO.Path]::GetExtension($path).TrimStart('.').ToLowerInvariant()
  switch ($format) {
    'docx' {
      switch ($extension) {
        'docm' { return 13 }
        'dotx' { return 14 }
        'dotm' { return 15 }
        default { return 16 }
      }
    }
    'xlsx' {
      switch ($extension) {
        'xlsm' { return 52 }
        'xltm' { return 53 }
        'xltx' { return 54 }
        default { return 51 }
      }
    }
    'pptx' {
      switch ($extension) {
        'pptm' { return 25 }
        'potx' { return 26 }
        'potm' { return 27 }
        default { return 24 }
      }
    }
  }
}

function Collection-For($app, [string]$format) {
  switch ($format) {
    'docx' { return $app.Documents }
    'xlsx' { return $app.Workbooks }
    'pptx' { return $app.Presentations }
  }
}

function Find-OpenDocument($app, [string]$format, [string]$path) {
  $full = [System.IO.Path]::GetFullPath($path)
  foreach ($item in @(Collection-For $app $format)) {
    try {
      if ([string]::Equals([System.IO.Path]::GetFullPath([string]$item.FullName), $full, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $item
      }
    } catch {}
  }
  return $null
}

function Active-Application([string]$progId) {
  try {
    return [System.Runtime.InteropServices.Marshal]::GetActiveObject($progId)
  } catch {
    return $null
  }
}

function Installed([string]$progId) {
  if (-not $progId) { return $false }
  try { return $null -ne [type]::GetTypeFromProgID($progId) } catch { return $false }
}

function New-HiddenApplication([string]$format, [string]$progId) {
  $app = New-Object -ComObject $progId
  try { $app.DisplayAlerts = 0 } catch {}
  try { $app.AutomationSecurity = 3 } catch {}
  if ($format -ne 'pptx') {
    try { $app.Visible = $false } catch {}
  }
  return $app
}

function Open-BackgroundDocument($app, [string]$format, [string]$path) {
  switch ($format) {
    'docx' { return $app.Documents.Open($path) }
    'xlsx' {
      $book = $app.Workbooks.Open($path)
      try { $app.CalculateFullRebuild() } catch {}
      return $book
    }
    'pptx' { return $app.Presentations.Open($path, $false, $false, $false) }
  }
}

function Snapshot-Word($doc, $payload) {
  $paragraphs = @()
  $paragraphOffset = if ($payload.paged) { [Math]::Max(0, [int]$payload.offset) } else { 0 }
  $paragraphLimit = if ($payload.paged) { [Math]::Max(1, [int]$payload.limit) } else { [int]$doc.Paragraphs.Count }
  if ($payload.target -and [string]$payload.target -match '^/body/p\[(\d+)\]') {
    $paragraphOffset = [int]$Matches[1] - 1
    $paragraphLimit = 1
  }
  $paragraphEnd = [Math]::Min([int]$doc.Paragraphs.Count, $paragraphOffset + $paragraphLimit)
  for ($index = $paragraphOffset + 1; $index -le $paragraphEnd; $index++) {
    $p = $doc.Paragraphs.Item($index)
    $text = ([string]$p.Range.Text).TrimEnd("`r", "`a")
    if ($text.Length -gt 0) {
      $style = $p.Range.Style
      $styleName = try { [string]$style.NameLocal } catch {
        try { [string]$style.Name } catch { [string]$style }
      }
      $tabStops = @()
      try {
        for ($tabIndex = 1; $tabIndex -le $p.Format.TabStops.Count; $tabIndex++) {
          $tab = $p.Format.TabStops.Item($tabIndex)
          $tabStops += [ordered]@{
            position = [double]$tab.Position
            alignment = [int]$tab.Alignment
            leader = [int]$tab.Leader
          }
        }
      } catch {}
      $paragraphs += [ordered]@{
        path = "/body/p[$index]"
        index = $index
        text = $text
        style = $styleName
        start = [int]$p.Range.Start
        end = [int]$p.Range.End
        pageStart = $(try { [int]$p.Range.Information(3) } catch { 0 })
        pageEnd = $(try {
          $endRange = $p.Range.Duplicate
          $endRange.Collapse(0)
          [int]$endRange.Information(3)
        } catch { 0 })
        format = [ordered]@{
          alignment = [int]$p.Format.Alignment
          spacingBefore = [double]$p.Format.SpaceBefore
          spacingAfter = [double]$p.Format.SpaceAfter
          lineSpacing = [double]$p.Format.LineSpacing
          keepWithNext = [int]$p.Format.KeepWithNext
          pageBreakBefore = [int]$p.Format.PageBreakBefore
          tabStops = $tabStops
        }
      }
    }
  }
  $tables = @()
  for ($i = 1; $i -le $doc.Tables.Count; $i++) {
    $table = $doc.Tables.Item($i)
    $rows = @()
    for ($r = 1; $r -le $table.Rows.Count; $r++) {
      $cells = @()
      for ($c = 1; $c -le $table.Columns.Count; $c++) {
        try { $cells += ([string]$table.Cell($r, $c).Range.Text).TrimEnd("`r", "`a") } catch { $cells += $null }
      }
      $rows += ,$cells
    }
    $tableRows = @()
    for ($r = 1; $r -le $rows.Count; $r++) {
      $cells = @()
      for ($c = 1; $c -le @($rows[$r - 1]).Count; $c++) {
        $cells += [ordered]@{ path = "/body/tbl[$i]/row[$r]/cell[$c]"; index = $c; text = @($rows[$r - 1])[$c - 1] }
      }
      $tableRows += [ordered]@{ path = "/body/tbl[$i]/row[$r]"; index = $r; cells = $cells }
    }
    $columnWidths = @()
    try {
      for ($columnIndex = 1; $columnIndex -le $table.Columns.Count; $columnIndex++) {
        $columnWidths += [double]$table.Columns.Item($columnIndex).Width
      }
    } catch {
      try {
        $firstRow = $table.Rows.Item(1)
        for ($columnIndex = 1; $columnIndex -le $firstRow.Cells.Count; $columnIndex++) {
          $columnWidths += [double]$firstRow.Cells.Item($columnIndex).Width
        }
      } catch {}
    }
    $tables += [ordered]@{
      path = "/body/tbl[$i]"
      index = $i
      style = $(try { [string]$table.Style.NameLocal } catch { try { [string]$table.Style } catch { '' } })
      alignment = $(try { [int]$table.Rows.Alignment } catch { 0 })
      columnWidths = $columnWidths
      rows = $tableRows
      start = [int]$table.Range.Start
      end = [int]$table.Range.End
      pageStart = $(try {
        $startRange = $table.Range.Duplicate
        $startRange.Collapse(1)
        [int]$startRange.Information(3)
      } catch { 0 })
      pageEnd = $(try {
        $endRange = $table.Range.Duplicate
        $endRange.Collapse(0)
        [int]$endRange.Information(3)
      } catch { 0 })
    }
  }
  $blockOrder = @(
    @($paragraphs | ForEach-Object {
      [ordered]@{ type = 'paragraph'; index = [int]$_.index; path = [string]$_.path; start = [int]$_.start }
    })
    @($tables | ForEach-Object {
      [ordered]@{ type = 'table'; index = [int]$_.index; path = [string]$_.path; start = [int]$_.start }
    })
  ) | Sort-Object start
  $sections = @()
  for ($sectionIndex = 1; $sectionIndex -le $doc.Sections.Count; $sectionIndex++) {
    $section = $doc.Sections.Item($sectionIndex)
    $stories = @()
    foreach ($kind in @(
      [ordered]@{ name = 'primary'; value = 1 },
      [ordered]@{ name = 'first'; value = 2 },
      [ordered]@{ name = 'even'; value = 3 }
    )) {
      foreach ($location in @('header', 'footer')) {
        try {
          $collection = if ($location -eq 'header') { $section.Headers } else { $section.Footers }
          $item = $collection.Item([int]$kind.value)
          $stories += [ordered]@{
            path = "/section[$sectionIndex]/${location}[$($kind.name)]"
            kind = [string]$kind.name
            location = $location
            text = ([string]$item.Range.Text).TrimEnd("`r", "`a")
            linkToPrevious = [bool]$item.LinkToPrevious
          }
        } catch {}
      }
    }
    $sections += [ordered]@{
      path = "/section[$sectionIndex]"
      index = $sectionIndex
      orientation = [int]$section.PageSetup.Orientation
      topMargin = [double]$section.PageSetup.TopMargin
      bottomMargin = [double]$section.PageSetup.BottomMargin
      leftMargin = [double]$section.PageSetup.LeftMargin
      rightMargin = [double]$section.PageSetup.RightMargin
      stories = $stories
    }
  }
  $images = @()
  for ($imageIndex = 1; $imageIndex -le $doc.InlineShapes.Count; $imageIndex++) {
    $image = $doc.InlineShapes.Item($imageIndex)
    $images += [ordered]@{
      path = "/body/image[$imageIndex]"
      index = $imageIndex
      type = [int]$image.Type
      width = [double]$image.Width
      height = [double]$image.Height
      altText = $(try { [string]$image.AlternativeText } catch { '' })
    }
  }
  $comments = @()
  for ($commentIndex = 1; $commentIndex -le $doc.Comments.Count; $commentIndex++) {
    $comment = $doc.Comments.Item($commentIndex)
    $isReply = $false
    try { $isReply = $null -ne $comment.Ancestor } catch {}
    if ($isReply) { continue }
    $replies = @()
    try {
      for ($replyIndex = 1; $replyIndex -le $comment.Replies.Count; $replyIndex++) {
        $reply = $comment.Replies.Item($replyIndex)
        $replies += [ordered]@{
          index = $replyIndex
          author = $(try { [string]$reply.Author } catch { '' })
          date = $(try { ([datetime]$reply.Date).ToUniversalTime().ToString('o') } catch { '' })
          text = $(try { ([string]$reply.Range.Text).TrimEnd("`r", "`a") } catch { '' })
        }
      }
    } catch {}
    $comments += [ordered]@{
      path = "/body/comment[$commentIndex]"
      index = $commentIndex
      author = $(try { [string]$comment.Author } catch { '' })
      initials = $(try { [string]$comment.Initial } catch { '' })
      date = $(try { ([datetime]$comment.Date).ToUniversalTime().ToString('o') } catch { '' })
      text = $(try { ([string]$comment.Range.Text).TrimEnd("`r", "`a") } catch { '' })
      anchoredText = $(try { ([string]$comment.Scope.Text).TrimEnd("`r", "`a") } catch { '' })
      resolved = $(try { [bool]$comment.Done } catch { $false })
      replies = $replies
    }
  }
  $revisionTypes = @{
    1 = 'insertion'; 2 = 'deletion'; 3 = 'property'; 4 = 'paragraph_number'
    5 = 'display_field'; 6 = 'reconcile'; 7 = 'conflict'; 8 = 'style'
    9 = 'replacement'; 10 = 'paragraph_property'; 11 = 'table_property'
    12 = 'section_property'; 13 = 'style_definition'; 14 = 'moved_from'
    15 = 'moved_to'; 16 = 'cell_insertion'; 17 = 'cell_deletion'; 18 = 'cell_merge'
  }
  $revisions = @()
  for ($revisionIndex = 1; $revisionIndex -le $doc.Revisions.Count; $revisionIndex++) {
    $revision = $doc.Revisions.Item($revisionIndex)
    $typeCode = [int]$revision.Type
    $revisions += [ordered]@{
      path = "/body/revision[$revisionIndex]"
      index = $revisionIndex
      type = $(if ($revisionTypes.ContainsKey($typeCode)) { [string]$revisionTypes[$typeCode] } else { 'unknown' })
      typeCode = $typeCode
      author = $(try { [string]$revision.Author } catch { '' })
      date = $(try { ([datetime]$revision.Date).ToUniversalTime().ToString('o') } catch { '' })
      text = $(try { ([string]$revision.Range.Text).TrimEnd("`r", "`a") } catch { '' })
    }
  }
  $footnotes = @()
  for ($noteIndex = 1; $noteIndex -le $doc.Footnotes.Count; $noteIndex++) {
    $note = $doc.Footnotes.Item($noteIndex)
    $footnotes += [ordered]@{
      path = "/body/footnote[$noteIndex]"
      index = $noteIndex
      text = ([string]$note.Range.Text).TrimEnd("`r", "`a")
    }
  }
  $endnotes = @()
  for ($noteIndex = 1; $noteIndex -le $doc.Endnotes.Count; $noteIndex++) {
    $note = $doc.Endnotes.Item($noteIndex)
    $endnotes += [ordered]@{
      path = "/body/endnote[$noteIndex]"
      index = $noteIndex
      text = ([string]$note.Range.Text).TrimEnd("`r", "`a")
    }
  }
  $contentControls = @()
  for ($controlIndex = 1; $controlIndex -le $doc.ContentControls.Count; $controlIndex++) {
    $control = $doc.ContentControls.Item($controlIndex)
    $contentControls += [ordered]@{
      path = "/body/content-control[$controlIndex]"
      index = $controlIndex
      tag = [string]$control.Tag
      title = [string]$control.Title
      lockContents = [bool]$control.LockContents
      lockControl = [bool]$control.LockContentControl
      text = ([string]$control.Range.Text).TrimEnd("`r", "`a")
    }
  }
  return [ordered]@{
    format = 'docx'
    path = [string]$doc.FullName
    paragraphCount = $doc.Paragraphs.Count
    tableCount = $doc.Tables.Count
    commentCount = $comments.Count
    revisionCount = $doc.Revisions.Count
    comments = $comments
    revisions = $revisions
    footnoteCount = $footnotes.Count
    endnoteCount = $endnotes.Count
    footnotes = $footnotes
    endnotes = $endnotes
    contentControlCount = $contentControls.Count
    contentControls = $contentControls
    paragraphs = $paragraphs
    tables = $tables
    blockOrder = $blockOrder
    sections = $sections
    images = $images
    pagination = $(if ($payload.paged) {
      [ordered]@{
        unit = 'paragraph'
        offset = $paragraphOffset
        limit = $paragraphLimit
        returned = $paragraphs.Count
        total = [int]$doc.Paragraphs.Count
        nextOffset = $(if ($paragraphEnd -lt [int]$doc.Paragraphs.Count) { $paragraphEnd } else { $null })
      }
    } else { $null })
  }
}

function Cell-Value($cell) {
  $value = $cell.Value2
  if ($null -eq $value) { return $null }
  if ($value -is [System.Array]) {
    $rows = @()
    for ($r = 1; $r -le $value.GetLength(0); $r++) {
      $line = @()
      for ($c = 1; $c -le $value.GetLength(1); $c++) { $line += $value[$r, $c] }
      $rows += ,$line
    }
    return $rows
  }
  return $value
}

function Excel-FormulaPrecedents([string]$formula, [string]$currentSheet) {
  $output = @()
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $clean = $formula.Replace("'", '')
  foreach ($match in [regex]::Matches($clean, '(?:(?<sheet>[A-Za-z0-9_ .-]+)!)?\$?(?<col>[A-Z]{1,3})\$?(?<row>[1-9]\d*)')) {
    $sheet = if ($match.Groups['sheet'].Success) { [string]$match.Groups['sheet'].Value } else { $currentSheet }
    $ref = "$([string]$match.Groups['col'].Value)$([string]$match.Groups['row'].Value)"
    $key = "$sheet!$ref"
    if ($seen.Add($key)) {
      $output += [ordered]@{ sheet = $sheet; ref = $ref; path = "/sheet[$sheet]/cell[$ref]" }
    }
  }
  return $output
}

function Snapshot-Excel($book, $payload) {
  $sheets = @()
  foreach ($sheet in @($book.Worksheets)) {
    $used = $sheet.UsedRange
    $entry = [ordered]@{
      path = "/sheet[$([string]$sheet.Name)]"
      name = [string]$sheet.Name
      rows = [int]$used.Rows.Count
      columns = [int]$used.Columns.Count
      visible = [int]$sheet.Visible
      pageSetup = [ordered]@{
        printArea = $(try { [string]$sheet.PageSetup.PrintArea } catch { '' })
        zoom = $(try { $sheet.PageSetup.Zoom } catch { $null })
        fitToPagesWide = $(try { $sheet.PageSetup.FitToPagesWide } catch { $null })
        fitToPagesTall = $(try { $sheet.PageSetup.FitToPagesTall } catch { $null })
        orientation = $(try { [int]$sheet.PageSetup.Orientation } catch { 0 })
        paperSize = $(try { [int]$sheet.PageSetup.PaperSize } catch { 0 })
      }
    }
    $tables = @()
    for ($tableIndex = 1; $tableIndex -le $sheet.ListObjects.Count; $tableIndex++) {
      $table = $sheet.ListObjects.Item($tableIndex)
      $tables += [ordered]@{
        path = "/sheet[$([string]$sheet.Name)]/table[$tableIndex]"
        index = $tableIndex
        name = [string]$table.Name
        range = [string]$table.Range.Address($false, $false)
        style = [string]$table.TableStyle
      }
    }
    $charts = @()
    for ($chartIndex = 1; $chartIndex -le $sheet.ChartObjects().Count; $chartIndex++) {
      $chartObject = $sheet.ChartObjects().Item($chartIndex)
      $chart = $chartObject.Chart
      $series = @()
      try {
        for ($seriesIndex = 1; $seriesIndex -le $chart.SeriesCollection().Count; $seriesIndex++) {
          $seriesItem = $chart.SeriesCollection().Item($seriesIndex)
          $series += [ordered]@{ index = $seriesIndex; name = [string]$seriesItem.Name; formula = [string]$seriesItem.Formula }
        }
      } catch {}
      $charts += [ordered]@{
        path = "/sheet[$([string]$sheet.Name)]/chart[$chartIndex]"
        index = $chartIndex
        name = [string]$chartObject.Name
        chartType = [int]$chart.ChartType
        title = $(if ($chart.HasTitle) { [string]$chart.ChartTitle.Text } else { '' })
        left = [double]$chartObject.Left
        top = [double]$chartObject.Top
        width = [double]$chartObject.Width
        height = [double]$chartObject.Height
        series = $series
      }
    }
    $pivots = @()
    for ($pivotIndex = 1; $pivotIndex -le $sheet.PivotTables().Count; $pivotIndex++) {
      $pivot = $sheet.PivotTables().Item($pivotIndex)
      $pivots += [ordered]@{
        path = "/sheet[$([string]$sheet.Name)]/pivot[$pivotIndex]"
        index = $pivotIndex
        name = [string]$pivot.Name
        range = [string]$pivot.TableRange2.Address($false, $false)
      }
    }
    $validations = @()
    try {
      $validationCells = $sheet.Cells.SpecialCells(-4174)
      for ($validationIndex = 1; $validationIndex -le $validationCells.Areas.Count; $validationIndex++) {
        $area = $validationCells.Areas.Item($validationIndex)
        $validation = $area.Cells.Item(1, 1).Validation
        $validations += [ordered]@{
          path = "/sheet[$([string]$sheet.Name)]/validation[$validationIndex]"
          index = $validationIndex
          ranges = @([string]$area.Address($false, $false))
          type = [int]$validation.Type
          alertStyle = [int]$validation.AlertStyle
          operator = [int]$validation.Operator
          allowBlank = [bool]$validation.IgnoreBlank
          inCellDropdown = [bool]$validation.InCellDropdown
          showInputMessage = [bool]$validation.ShowInput
          showErrorMessage = [bool]$validation.ShowError
          inputTitle = [string]$validation.InputTitle
          inputMessage = [string]$validation.InputMessage
          errorTitle = [string]$validation.ErrorTitle
          errorMessage = [string]$validation.ErrorMessage
          formula1 = $(try { [string]$validation.Formula1 } catch { '' })
          formula2 = $(try { [string]$validation.Formula2 } catch { '' })
        }
      }
    } catch {}
    $conditionalFormats = @()
    try {
      $conditionRange = $used
      if ($payload.range -and [string]::Equals([string]$payload.sheet, [string]$sheet.Name, [System.StringComparison]::OrdinalIgnoreCase)) {
        $conditionRange = $sheet.Range([string]$payload.range)
      }
      for ($conditionIndex = 1; $conditionIndex -le $conditionRange.FormatConditions.Count; $conditionIndex++) {
        $condition = $conditionRange.FormatConditions.Item($conditionIndex)
        $conditionalFormats += [ordered]@{
          path = "/sheet[$([string]$sheet.Name)]/conditional-format[$conditionIndex]"
          index = $conditionIndex
          range = $(try { [string]$condition.AppliesTo.Address($false, $false) } catch { [string]$conditionRange.Address($false, $false) })
          type = $(try { [int]$condition.Type } catch { 0 })
          operator = $(try { [int]$condition.Operator } catch { 0 })
          formula1 = $(try { [string]$condition.Formula1 } catch { '' })
          formula2 = $(try { [string]$condition.Formula2 } catch { '' })
          priority = $(try { [int]$condition.Priority } catch { 0 })
        }
      }
    } catch {}
    $notes = @()
    try {
      $commentCells = $sheet.Cells.SpecialCells(-4144)
      foreach ($cell in @($commentCells.Cells)) {
        $notes += [ordered]@{
          path = "/sheet[$([string]$sheet.Name)]/cell[$([string]$cell.Address($false, $false))]/note"
          cell = [string]$cell.Address($false, $false)
          text = [string]$cell.Comment.Text()
          author = [string]$cell.Comment.Author
        }
      }
    } catch {}
    $mergedRanges = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $mergeScanCount = 0
    for ($mergeRow = 1; $mergeRow -le $used.Rows.Count -and $mergeScanCount -lt 2000; $mergeRow++) {
      for ($mergeColumn = 1; $mergeColumn -le $used.Columns.Count -and $mergeScanCount -lt 2000; $mergeColumn++) {
        $mergeScanCount++
        try {
          $cell = $used.Cells.Item($mergeRow, $mergeColumn)
          if ($cell.MergeCells) { $null = $mergedRanges.Add([string]$cell.MergeArea.Address($false, $false)) }
        } catch {}
      }
    }
    $freezePanes = $null
    if ([string]::Equals([string]$book.ActiveSheet.Name, [string]$sheet.Name, [System.StringComparison]::OrdinalIgnoreCase)) {
      try {
        $window = $book.Windows.Item(1)
        $freezePanes = [ordered]@{
          frozen = [bool]$window.FreezePanes
          splitRow = [int]$window.SplitRow
          splitColumn = [int]$window.SplitColumn
        }
      } catch {}
    }
    $autoFilter = $null
    try {
      if ($sheet.AutoFilterMode -and $null -ne $sheet.AutoFilter) {
        $autoFilter = [ordered]@{ enabled = $true; range = [string]$sheet.AutoFilter.Range.Address($false, $false) }
      }
    } catch {}
    $protection = [ordered]@{
      contents = [bool]$sheet.ProtectContents
      drawingObjects = [bool]$sheet.ProtectDrawingObjects
      scenarios = [bool]$sheet.ProtectScenarios
    }
    $entry.tables = $tables
    $entry.charts = $charts
    $entry.pivots = $pivots
    $entry.validationCount = $validations.Count
    $entry.validations = $validations
    $entry.conditionalFormatCount = $conditionalFormats.Count
    $entry.conditionalFormats = $conditionalFormats
    $entry.noteCount = $notes.Count
    $entry.notes = $notes
    $entry.mergedRanges = @($mergedRanges) | Sort-Object
    $entry.freezePanes = $freezePanes
    $entry.autoFilter = $autoFilter
    $entry.protection = $protection
    $cellCount = [int]$used.Rows.Count * [int]$used.Columns.Count
    if ($cellCount -le 500) {
      $cells = @()
      for ($r = 1; $r -le $used.Rows.Count; $r++) {
        for ($c = 1; $c -le $used.Columns.Count; $c++) {
          $cell = $used.Cells.Item($r, $c)
          if ($null -ne $cell.Value2 -or $cell.HasFormula) {
            $address = ([string]$cell.Address($false, $false)).Replace('$', '')
            $cells += [ordered]@{
              path = "/sheet[$([string]$sheet.Name)]/cell[$address]"
              ref = $address
              value = $cell.Value2
              formula = $(if ($cell.HasFormula) { [string]$cell.Formula } else { $null })
              style = [ordered]@{
                fontName = [string]$cell.Font.Name
                fontSize = [double]$cell.Font.Size
                bold = [bool]$cell.Font.Bold
                italic = [bool]$cell.Font.Italic
                color = [double]$cell.Font.Color
                fillColor = [double]$cell.Interior.Color
                numberFormat = [string]$cell.NumberFormat
              }
            }
          }
        }
      }
      $entry.cells = $cells
      $entry.formulaLineage = @($cells | Where-Object { $_.formula } | ForEach-Object {
        [ordered]@{
          path = "$($_.path)/lineage"
          from = $_.path
          formula = $_.formula
          precedents = @(Excel-FormulaPrecedents ([string]$_.formula) ([string]$sheet.Name))
        }
      })
      $entry.lineageCount = $entry.formulaLineage.Count
    }
    if ($payload.sheet -and [string]::Equals([string]$payload.sheet, [string]$sheet.Name, [System.StringComparison]::OrdinalIgnoreCase)) {
      $range = $used
      if ($payload.range) { $range = $sheet.Range([string]$payload.range) }
      if (($range.Rows.Count * $range.Columns.Count) -le 2000) {
        $entry.values = Cell-Value $range
        $entry.address = [string]$range.Address()
      }
    }
    $sheets += $entry
  }
  $definedNames = @()
  for ($nameIndex = 1; $nameIndex -le $book.Names.Count; $nameIndex++) {
    try {
      $name = $book.Names.Item($nameIndex)
      $definedNames += [ordered]@{
        path = "/defined-name[$nameIndex]"
        index = $nameIndex
        name = [string]$name.Name
        nameLocal = [string]$name.NameLocal
        refersTo = [string]$name.RefersTo
        refersToLocal = [string]$name.RefersToLocal
        visible = [bool]$name.Visible
      }
    } catch {}
  }
  return [ordered]@{
    format = 'xlsx'
    path = [string]$book.FullName
    activeSheet = [string]$book.ActiveSheet.Name
    definedNameCount = $definedNames.Count
    definedNames = $definedNames
    sheets = $sheets
  }
}

function Excel-ColumnLabel([int]$column) {
  $label = ''
  while ($column -gt 0) {
    $column--
    $label = [char](65 + ($column % 26)) + $label
    $column = [Math]::Floor($column / 26)
  }
  return $label
}

function Matrix-Item($matrix, [int]$row, [int]$column) {
  if ($matrix -is [System.Array]) {
    if ($matrix.Rank -eq 2) {
      return $matrix.GetValue(
        $matrix.GetLowerBound(0) + $row - 1,
        $matrix.GetLowerBound(1) + $column - 1
      )
    }
    return $matrix.GetValue($matrix.GetLowerBound(0) + $row - 1)
  }
  if ($row -eq 1 -and $column -eq 1) { return $matrix }
  return $null
}

function Snapshot-ExcelPage($book, $payload) {
  $sheet = $book.ActiveSheet
  if ($payload.sheet) { $sheet = $book.Worksheets.Item([string]$payload.sheet) }
  $base = $sheet.UsedRange
  if ($payload.range) { $base = $sheet.Range([string]$payload.range) }
  $rowCount = [int]$base.Rows.Count
  $columnCount = [int]$base.Columns.Count
  $total = [int64]$rowCount * [int64]$columnCount
  $offset = [Math]::Max(0, [int64]$payload.offset)
  $limit = [Math]::Min(10000, [Math]::Max(1, [int]$payload.limit))
  if ($offset -gt $total) { $offset = $total }
  $remaining = [Math]::Min([int64]$limit, $total - $offset)
  $cursor = $offset
  $detailed = [bool]$payload.includeStyles -or $total -le 500
  $cells = [System.Collections.Generic.List[object]]::new()
  $rowBlocks = [System.Collections.Generic.List[object]]::new()
  $formulaEntries = [System.Collections.Generic.List[object]]::new()
  $populated = 0
  while ($remaining -gt 0) {
    $rowOffset = [Math]::Floor($cursor / $columnCount)
    $columnOffset = [int]($cursor % $columnCount)
    if ($columnOffset -eq 0 -and $remaining -ge $columnCount) {
      $takeRows = [Math]::Floor($remaining / $columnCount)
      $take = [int64]$takeRows * $columnCount
      $range = $sheet.Range(
        $base.Cells.Item($rowOffset + 1, 1),
        $base.Cells.Item($rowOffset + $takeRows, $columnCount)
      )
    } else {
      $take = [Math]::Min($remaining, $columnCount - $columnOffset)
      $takeRows = 1
      $range = $sheet.Range(
        $base.Cells.Item($rowOffset + 1, $columnOffset + 1),
        $base.Cells.Item($rowOffset + 1, $columnOffset + $take)
      )
    }
    $values = $range.Value2
    $formulas = $range.Formula
    $rangeRows = [int]$range.Rows.Count
    $rangeColumns = [int]$range.Columns.Count
    $rangeStartRow = [int]$range.Row
    $rangeStartColumn = [int]$range.Column
    $blockValues = $null
    $blockFormulas = $null
    if (-not $detailed) {
      $blockValues = [object[]]::new($rangeRows)
      $blockFormulas = [System.Collections.Generic.List[object]]::new()
    }
    for ($r = 1; $r -le $rangeRows; $r++) {
      $line = $null
      if (-not $detailed) { $line = [object[]]::new($rangeColumns) }
      for ($c = 1; $c -le $rangeColumns; $c++) {
        $value = Matrix-Item $values $r $c
        $formulaValue = Matrix-Item $formulas $r $c
        $formula = if ([string]$formulaValue -like '=*') { [string]$formulaValue } else { $null }
        if (-not $detailed) { $line[$c - 1] = $value }
        if ($null -eq $value -and $null -eq $formula) { continue }
        $populated++
        $absoluteRow = $null
        $absoluteColumn = $null
        $address = $null
        if ($detailed -or $formula) {
          $absoluteRow = $rangeStartRow + $r - 1
          $absoluteColumn = $rangeStartColumn + $c - 1
          $address = "$(Excel-ColumnLabel $absoluteColumn)$absoluteRow"
        }
        if ($formula) {
          $formulaEntry = [ordered]@{
            path = "/sheet[$([string]$sheet.Name)]/cell[$address]"
            ref = $address
            row = $absoluteRow
            column = $absoluteColumn
            formula = $formula
          }
          $formulaEntries.Add($formulaEntry)
          if (-not $detailed) {
            $blockFormulas.Add([ordered]@{
              rowOffset = $r - 1
              columnOffset = $c - 1
              formula = $formula
            })
          }
        }
        if ($detailed) {
          $entry = [ordered]@{
            path = "/sheet[$([string]$sheet.Name)]/cell[$address]"
            ref = $address
            value = $value
            formula = $formula
          }
        }
        if ($detailed -and $payload.includeStyles) {
          $cell = $range.Cells.Item($r, $c)
          $entry.style = [ordered]@{
            fontName = [string]$cell.Font.Name
            fontSize = [double]$cell.Font.Size
            bold = [bool]$cell.Font.Bold
            italic = [bool]$cell.Font.Italic
            color = [double]$cell.Font.Color
            fillColor = [double]$cell.Interior.Color
            numberFormat = [string]$cell.NumberFormat
          }
        }
        if ($detailed) { $cells.Add($entry) }
      }
      if (-not $detailed) { $blockValues[$r - 1] = $line }
    }
    if (-not $detailed) {
      [object[]]$blockFormulaOutput = @($blockFormulas)
      $rowBlocks.Add([ordered]@{
        startRow = $rangeStartRow
        startColumn = $rangeStartColumn
        rowCount = $rangeRows
        columnCount = $rangeColumns
        values = $blockValues
        formulas = $blockFormulaOutput
      })
    }
    $cursor += $take
    $remaining -= $take
  }
  $lineage = @($formulaEntries | ForEach-Object {
    [ordered]@{
      path = "$($_.path)/lineage"
      from = $_.path
      formula = $_.formula
      precedents = @(Excel-FormulaPrecedents ([string]$_.formula) ([string]$sheet.Name))
    }
  })
  [object[]]$cellOutput = @()
  [object[]]$rowBlockOutput = @()
  if ($detailed) { $cellOutput = @($cells) } else { $rowBlockOutput = @($rowBlocks) }
  return [ordered]@{
    format = 'xlsx'
    path = [string]$book.FullName
    activeSheet = [string]$book.ActiveSheet.Name
    sheetCount = [int]$book.Worksheets.Count
    sheets = @([ordered]@{
      path = "/sheet[$([string]$sheet.Name)]"
      name = [string]$sheet.Name
      rows = $rowCount
      columns = $columnCount
      address = [string]$base.Address($false, $false)
      cellCount = $total
      representation = $(if ($detailed) { 'cells' } else { 'row-blocks' })
      cells = $cellOutput
      rowBlocks = $rowBlockOutput
      lineageCount = $lineage.Count
      formulaLineage = $lineage
      truncated = $cursor -lt $total
    })
    pagination = [ordered]@{
      unit = 'cell'
      scope = "$([string]$sheet.Name)!$([string]$base.Address($false, $false))"
      offset = $offset
      limit = $limit
      returned = $populated
      scanned = $cursor - $offset
      total = $total
      nextOffset = $(if ($cursor -lt $total) { $cursor } else { $null })
    }
  }
}

function Snapshot-PowerPoint($presentation, $payload) {
  $slides = @()
  $slideOffset = if ($payload.paged) { [Math]::Max(0, [int]$payload.offset) } else { 0 }
  $slideLimit = if ($payload.paged) { [Math]::Max(1, [int]$payload.limit) } else { [int]$presentation.Slides.Count }
  $slideNumbers = if ($payload.pages) {
    @($payload.pages | ForEach-Object { [int]$_ })
  } else {
    $end = [Math]::Min([int]$presentation.Slides.Count, $slideOffset + $slideLimit)
    if ($end -le $slideOffset) { @() } else { @(($slideOffset + 1)..$end) }
  }
  foreach ($slideNumber in $slideNumbers) {
    if ($slideNumber -lt 1 -or $slideNumber -gt $presentation.Slides.Count) { throw "PowerPoint slide out of range: $slideNumber" }
    $slide = $presentation.Slides.Item($slideNumber)
    $shapes = @()
    for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
      $shape = $slide.Shapes.Item($shapeIndex)
      $text = $null
      try {
        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $text = [string]$shape.TextFrame.TextRange.Text }
      } catch {}
      $placeholder = $null
      try {
        if ([int]$shape.Type -eq 14) {
          $placeholder = [ordered]@{
            type = [int]$shape.PlaceholderFormat.Type
            index = [int]$shape.PlaceholderFormat.Index
          }
        }
      } catch {}
      $group = $null
      try {
        if ([int]$shape.Type -eq 6) {
          $items = @()
          for ($groupIndex = 1; $groupIndex -le $shape.GroupItems.Count; $groupIndex++) {
            $item = $shape.GroupItems.Item($groupIndex)
            $items += [ordered]@{ index = $groupIndex; name = [string]$item.Name; type = [int]$item.Type }
          }
          $group = [ordered]@{ count = $items.Count; items = $items }
        }
      } catch {}
      $crop = $null
      try {
        if ([int]$shape.Type -eq 13) {
          $crop = [ordered]@{
            left = [double]$shape.PictureFormat.CropLeft
            right = [double]$shape.PictureFormat.CropRight
            top = [double]$shape.PictureFormat.CropTop
            bottom = [double]$shape.PictureFormat.CropBottom
          }
        }
      } catch {}
      $table = $null
      try {
        if ($shape.HasTable) {
          $rows = @()
          for ($rowIndex = 1; $rowIndex -le $shape.Table.Rows.Count; $rowIndex++) {
            $cells = @()
            for ($columnIndex = 1; $columnIndex -le $shape.Table.Columns.Count; $columnIndex++) {
              $cells += [string]$shape.Table.Cell($rowIndex, $columnIndex).Shape.TextFrame.TextRange.Text
            }
            $rows += ,$cells
          }
          $table = [ordered]@{
            rows = [int]$shape.Table.Rows.Count
            columns = [int]$shape.Table.Columns.Count
            values = $rows
          }
        }
      } catch {}
      $shapes += [ordered]@{
        path = "/slide[$([int]$slide.SlideIndex)]/shape[$shapeIndex]"
        index = $shapeIndex
        name = [string]$shape.Name
        type = [int]$shape.Type
        text = $text
        placeholder = $placeholder
        group = $group
        crop = $crop
        table = $table
        left = [double]$shape.Left
        top = [double]$shape.Top
        width = [double]$shape.Width
        height = [double]$shape.Height
        rotation = [double]$shape.Rotation
        fillColor = $(try { [double]$shape.Fill.ForeColor.RGB } catch { $null })
        fillTransparency = $(try { [double]$shape.Fill.Transparency } catch { $null })
        lineColor = $(try { [double]$shape.Line.ForeColor.RGB } catch { $null })
        lineTransparency = $(try { [double]$shape.Line.Transparency } catch { $null })
        shadow = $(try {
          [ordered]@{
            visible = [int]$shape.Shadow.Visible
            color = [double]$shape.Shadow.ForeColor.RGB
            transparency = [double]$shape.Shadow.Transparency
            blur = [double]$shape.Shadow.Blur
            offsetX = [double]$shape.Shadow.OffsetX
            offsetY = [double]$shape.Shadow.OffsetY
          }
        } catch { $null })
        textFrame = $(try {
          [ordered]@{
            marginLeft = [double]$shape.TextFrame.MarginLeft
            marginTop = [double]$shape.TextFrame.MarginTop
            marginRight = [double]$shape.TextFrame.MarginRight
            marginBottom = [double]$shape.TextFrame.MarginBottom
            paragraphSpacing = [double]$shape.TextFrame.TextRange.ParagraphFormat.SpaceAfter
          }
        } catch { $null })
        font = $(try {
          [ordered]@{
            name = [string]$shape.TextFrame.TextRange.Font.Name
            size = [double]$shape.TextFrame.TextRange.Font.Size
            bold = [int]$shape.TextFrame.TextRange.Font.Bold
            italic = [int]$shape.TextFrame.TextRange.Font.Italic
            color = [double]$shape.TextFrame.TextRange.Font.Color.RGB
          }
        } catch { $null })
        chart = $(try {
          if ($shape.HasChart) {
            $chart = $shape.Chart
            [ordered]@{
              path = "/slide[$([int]$slide.SlideIndex)]/shape[$shapeIndex]/chart"
              chartType = [int]$chart.ChartType
              title = $(if ($chart.HasTitle) { [string]$chart.ChartTitle.Text } else { '' })
              seriesCount = [int]$chart.SeriesCollection().Count
              series = $(try {
                $items = @()
                for ($seriesIndex = 1; $seriesIndex -le $chart.SeriesCollection().Count; $seriesIndex++) {
                  $series = $chart.SeriesCollection().Item($seriesIndex)
                  $items += [ordered]@{
                    index = $seriesIndex
                    name = [string]$series.Name
                    formula = ''
                    chartType = $(try { [int]$series.ChartType } catch { $null })
                    axisGroup = $(try { [int]$series.AxisGroup } catch { $null })
                    trendlineCount = $(try { [int]$series.Trendlines().Count } catch { 0 })
                    hasErrorBars = $(try { [bool]$series.HasErrorBars } catch { $false })
                    hasDataLabels = [bool]$series.HasDataLabels
                    dataLabels = $(if ($series.HasDataLabels) {
                      [ordered]@{
                        showValue = [bool]$series.DataLabels().ShowValue
                        showCategoryName = [bool]$series.DataLabels().ShowCategoryName
                        numberFormat = [string]$series.DataLabels().NumberFormat
                        position = [int]$series.DataLabels().Position
                      }
                    } else { $null })
                  }
                }
                $items
              } catch { @() })
              axes = $(try {
                $axes = @()
                foreach ($axisSpec in @(
                  [ordered]@{ name = 'category'; type = 1 },
                  [ordered]@{ name = 'value'; type = 2 }
                )) {
                  $axis = $chart.Axes([int]$axisSpec.type, 1)
                  $axes += [ordered]@{
                    type = [string]$axisSpec.name
                    title = $(if ($axis.HasTitle) { [string]$axis.AxisTitle.Text } else { '' })
                    minimum = $(try { [double]$axis.MinimumScale } catch { $null })
                    maximum = $(try { [double]$axis.MaximumScale } catch { $null })
                    majorUnit = $(try { [double]$axis.MajorUnit } catch { $null })
                    numberFormat = $(try { [string]$axis.TickLabels.NumberFormat } catch { '' })
                  }
                }
                $axes
              } catch { @() })
            }
          } else { $null }
        } catch { $null })
      }
    }
    $notes = $null
    try { $notes = [string]$slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text } catch {}
    $comments = @()
    try {
      for ($commentIndex = 1; $commentIndex -le $slide.Comments.Count; $commentIndex++) {
        $comment = $slide.Comments.Item($commentIndex)
        $comments += [ordered]@{
          path = "/slide[$([int]$slide.SlideIndex)]/comment[$commentIndex]"
          index = $commentIndex
          author = [string]$comment.Author
          initials = [string]$comment.AuthorInitials
          text = [string]$comment.Text
          left = [double]$comment.Left
          top = [double]$comment.Top
        }
      }
    } catch {}
    $animations = @()
    try {
      $sequence = $slide.TimeLine.MainSequence
      for ($effectIndex = 1; $effectIndex -le $sequence.Count; $effectIndex++) {
        $effect = $sequence.Item($effectIndex)
        $animations += [ordered]@{
          index = $effectIndex
          shape = [string]$effect.Shape.Name
          effect = [int]$effect.EffectType
          trigger = [int]$effect.Timing.TriggerType
          duration = [double]$effect.Timing.Duration
          delay = [double]$effect.Timing.TriggerDelayTime
        }
      }
    } catch {}
    $layoutName = $(try { [string]$slide.CustomLayout.Name } catch { '' })
    $layoutIndex = 0
    try {
      for ($candidateIndex = 1; $candidateIndex -le $presentation.SlideMaster.CustomLayouts.Count; $candidateIndex++) {
        if ([string]::Equals([string]$presentation.SlideMaster.CustomLayouts.Item($candidateIndex).Name, $layoutName, [System.StringComparison]::OrdinalIgnoreCase)) {
          $layoutIndex = $candidateIndex
          break
        }
      }
    } catch {}
    $followMasterBackground = $(try { [bool]$slide.FollowMasterBackground } catch { $false })
    $backgroundSource = $(if ($followMasterBackground) { 'layout' } else { 'slide' })
    $backgroundColor = $null
    try {
      if ($followMasterBackground) {
        try {
          $backgroundColor = Color-Hex ([long]$slide.CustomLayout.Background.Fill.ForeColor.RGB)
        } catch {}
        if (-not $backgroundColor) {
          $backgroundSource = 'master'
          try { $backgroundColor = Color-Hex ([long]$presentation.SlideMaster.Background.Fill.ForeColor.RGB) } catch {}
        }
      } else {
        $backgroundColor = Color-Hex ([long]$slide.Background.Fill.ForeColor.RGB)
      }
    } catch {}
    $slides += [ordered]@{
      path = "/slide[$([int]$slide.SlideIndex)]"
      index = [int]$slide.SlideIndex
      layout = [ordered]@{ index = $layoutIndex; name = $layoutName }
      background = [ordered]@{
        followMaster = $followMasterBackground
        source = $backgroundSource
        color = $backgroundColor
      }
      shapes = $shapes
      notes = $notes
      comments = $comments
      animations = $animations
      transition = [ordered]@{
        effect = $(try { [int]$slide.SlideShowTransition.EntryEffect } catch { 0 })
        advanceOnTime = $(try { [bool]$slide.SlideShowTransition.AdvanceOnTime } catch { $false })
        advanceTime = $(try { [double]$slide.SlideShowTransition.AdvanceTime } catch { 0 })
      }
    }
  }
  $layouts = @()
  try {
    for ($layoutIndex = 1; $layoutIndex -le $presentation.SlideMaster.CustomLayouts.Count; $layoutIndex++) {
      $layout = $presentation.SlideMaster.CustomLayouts.Item($layoutIndex)
      $layouts += [ordered]@{
        path = "/layout[$layoutIndex]"
        index = $layoutIndex
        name = [string]$layout.Name
      }
    }
  } catch {}
  $designs = @()
  try {
    for ($designIndex = 1; $designIndex -le $presentation.Designs.Count; $designIndex++) {
      $design = $presentation.Designs.Item($designIndex)
      $designs += [ordered]@{
        index = $designIndex
        name = [string]$design.Name
      }
    }
  } catch {}
  return [ordered]@{
    format = 'pptx'
    path = [string]$presentation.FullName
    slideCount = $presentation.Slides.Count
    slideWidth = [double]$presentation.PageSetup.SlideWidth
    slideHeight = [double]$presentation.PageSetup.SlideHeight
    layoutCount = $layouts.Count
    layouts = $layouts
    designCount = $designs.Count
    designs = $designs
    slides = $slides
    theme = $(try { [string]$presentation.Designs.Item(1).Name } catch { '' })
    pagination = $(if ($payload.paged) {
      [ordered]@{
        unit = 'slide'
        offset = $slideOffset
        limit = $slideLimit
        returned = $slides.Count
        total = [int]$presentation.Slides.Count
        nextOffset = $(if (-not $payload.pages -and $slideOffset + $slides.Count -lt [int]$presentation.Slides.Count) { $slideOffset + $slides.Count } else { $null })
      }
    } else { $null })
  }
}

function Same-OfficePath([string]$left, [string]$right) {
  try {
    return [string]::Equals(
      [System.IO.Path]::GetFullPath($left),
      [System.IO.Path]::GetFullPath($right),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

function Snapshot-Selection($document, [string]$format) {
  try {
    switch ($format) {
      'docx' {
        $selection = $document.Application.Selection
        if ($null -eq $selection -or -not (Same-OfficePath ([string]$selection.Document.FullName) ([string]$document.FullName))) {
          return [ordered]@{ available = $false; reason = 'The active Word selection belongs to another document.' }
        }
        $range = $selection.Range
        $paragraph = [Math]::Max(1, [int]$document.Range(0, [Math]::Max(0, [int]$range.Start)).Paragraphs.Count)
        $target = "/body/p[$paragraph]"
        return [ordered]@{
          available = $true
          kind = $(if ([int]$range.Start -eq [int]$range.End) { 'insertion-point' } else { 'text' })
          target = $target
          key = "$target`:$([int]$range.Start)-$([int]$range.End)"
          start = [int]$range.Start
          end = [int]$range.End
          text = $([string]$range.Text).TrimEnd("`r", "`a")
        }
      }
      'xlsx' {
        $selection = $document.Application.Selection
        $sheet = $selection.Parent
        if ($null -eq $sheet -or -not (Same-OfficePath ([string]$sheet.Parent.FullName) ([string]$document.FullName))) {
          return [ordered]@{ available = $false; reason = 'The active Excel selection belongs to another workbook.' }
        }
        $address = [string]$selection.Address($false, $false)
        $activeCell = [string]$document.Application.ActiveCell.Address($false, $false)
        $target = "/sheet[$([string]$sheet.Name)]/range[$address]"
        return [ordered]@{
          available = $true
          kind = 'range'
          target = $target
          key = "$([string]$sheet.Name)!$address@$activeCell"
          sheet = [string]$sheet.Name
          address = $address
          activeCell = $activeCell
          rows = [int]$selection.Rows.Count
          columns = [int]$selection.Columns.Count
        }
      }
      'pptx' {
        $window = $document.Application.ActiveWindow
        if ($null -eq $window) { return [ordered]@{ available = $false; reason = 'PowerPoint has no active window.' } }
        $selection = $window.Selection
        $slideIndex = $(try { [int]$window.View.Slide.SlideIndex } catch { 0 })
        $selectionType = [int]$selection.Type
        $paths = @()
        if (@(2, 3) -contains $selectionType -and $slideIndex -gt 0) {
          $slide = $document.Slides.Item($slideIndex)
          foreach ($selectedShape in @($selection.ShapeRange)) {
            for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
              if ([int]$slide.Shapes.Item($shapeIndex).Id -eq [int]$selectedShape.Id) {
                $paths += "/slide[$slideIndex]/shape[$shapeIndex]"
                break
              }
            }
          }
        } elseif ($selectionType -eq 1) {
          foreach ($selectedSlide in @($selection.SlideRange)) { $paths += "/slide[$([int]$selectedSlide.SlideIndex)]" }
        } elseif ($slideIndex -gt 0) {
          $paths += "/slide[$slideIndex]"
        }
        return [ordered]@{
          available = $true
          kind = $(switch ($selectionType) { 1 { 'slides' } 2 { 'shapes' } 3 { 'text' } default { 'none' } })
          target = $(if ($paths.Count -gt 0) { [string]$paths[0] } else { '/' })
          targets = $paths
          key = "$selectionType`:$($paths -join ',')"
          slide = $slideIndex
          selectionType = $selectionType
        }
      }
    }
  } catch {
    return [ordered]@{ available = $false; reason = [string]$_.Exception.Message }
  }
  return [ordered]@{ available = $false; reason = 'Selection is unsupported for this format.' }
}

function Snapshot-Document($document, [string]$format, $payload) {
  $value = switch ($format) {
    'docx' { Snapshot-Word $document $payload }
    'xlsx' {
      if ($payload.paged) {
        $sheet = $document.ActiveSheet
        if ($payload.sheet) { $sheet = $document.Worksheets.Item([string]$payload.sheet) }
        $range = $sheet.UsedRange
        if ($payload.range) { $range = $sheet.Range([string]$payload.range) }
        if ($payload.range -or [int64]$range.Rows.Count * [int64]$range.Columns.Count -gt 500 -or [int64]$payload.offset -gt 0) {
          Snapshot-ExcelPage $document $payload
          break
        }
      }
      Snapshot-Excel $document $payload
    }
    'pptx' { Snapshot-PowerPoint $document $payload }
  }
  if ([bool]$payload.includeSelection) { $value['selection'] = Snapshot-Selection $document $format }
  return $value
}

function Color-Value([string]$hex) {
  $clean = $hex.TrimStart('#')
  if ($clean.Length -ne 6) { throw "Invalid color '$hex'; expected RRGGBB" }
  $r = [Convert]::ToInt32($clean.Substring(0, 2), 16)
  $g = [Convert]::ToInt32($clean.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($clean.Substring(4, 2), 16)
  return $r + (256 * $g) + (65536 * $b)
}

function Color-Hex([long]$color) {
  $r = $color -band 255
  $g = ($color -shr 8) -band 255
  $b = ($color -shr 16) -band 255
  return ('{0:X2}{1:X2}{2:X2}' -f $r, $g, $b)
}

function Operation-Property($op, [string]$name, $fallback) {
  $direct = $op.PSObject.Properties[$name]
  if ($null -ne $direct -and $null -ne $direct.Value) { return $direct.Value }
  $properties = $op.PSObject.Properties['properties']
  if ($null -ne $properties -and $null -ne $properties.Value) {
    $nested = $properties.Value.PSObject.Properties[$name]
    if ($null -ne $nested -and $null -ne $nested.Value) { return $nested.Value }
  }
  return $fallback
}

function Template-ValueMap($op) {
  $map = @{}
  $source = $op.tokens
  if ($null -eq $source) { throw 'fill_template requires tokens as an object' }
  if ($source -is [System.Collections.IDictionary]) {
    foreach ($key in $source.Keys) { $map[[string]$key] = $source[$key] }
  } else {
    foreach ($property in @($source.PSObject.Properties)) { $map[[string]$property.Name] = $property.Value }
  }
  return $map
}

function Template-Matches([string]$text) {
  $matches = @()
  foreach ($match in [regex]::Matches($text, '\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}')) {
    $matches += [pscustomobject]@{ Raw = [string]$match.Value; Key = [string]$match.Groups[1].Value }
  }
  return $matches
}

function Word-StoryRanges($doc) {
  $ranges = @()
  for ($storyType = 1; $storyType -le 17; $storyType++) {
    try {
      $current = $doc.StoryRanges.Item($storyType)
      while ($null -ne $current) {
        $ranges += $current.Duplicate
        try { $current = $current.NextStoryRange } catch { $current = $null }
      }
    } catch {}
  }
  return $ranges
}

function Fill-WordTemplate($doc, $op) {
  $values = Template-ValueMap $op
  $filled = [ordered]@{}
  foreach ($range in @(Word-StoryRanges $doc)) {
    $text = [string]$range.Text
    $variants = @{}
    foreach ($match in @(Template-Matches $text)) { $variants[$match.Raw] = $match.Key }
    foreach ($raw in $variants.Keys) {
      $key = [string]$variants[$raw]
      if (-not $values.ContainsKey($key)) { continue }
      $count = [regex]::Matches($text, [regex]::Escape([string]$raw)).Count
      if ($count -eq 0) { continue }
      $search = $range.Duplicate
      $changed = $search.Find.Execute([string]$raw, $false, $false, $false, $false, $false, $true, 0, $false, [string]$values[$key], 2)
      if ($changed) { $filled[$key] = $(if ($filled.Contains($key)) { [int]$filled[$key] + $count } else { $count }) }
    }
  }
  $remaining = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($range in @(Word-StoryRanges $doc)) {
    foreach ($match in @(Template-Matches ([string]$range.Text))) { $null = $remaining.Add([string]$match.Key) }
  }
  $unfilled = @($remaining) | Sort-Object
  if ([bool]$op.strict -and $unfilled.Count -gt 0) { throw "Unfilled template tokens: $($unfilled -join ', ')" }
  return [ordered]@{ op = 'fill_template'; changed = $filled.Count -gt 0; filled = $filled; unfilledTokens = $unfilled; strict = [bool]$op.strict }
}

function PowerPoint-ShapeTextRanges($shape) {
  $ranges = @()
  try {
    if ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $ranges += $shape.TextFrame.TextRange }
  } catch {}
  try {
    if ($shape.HasTable) {
      for ($row = 1; $row -le $shape.Table.Rows.Count; $row++) {
        for ($column = 1; $column -le $shape.Table.Columns.Count; $column++) {
          $ranges += $shape.Table.Cell($row, $column).Shape.TextFrame.TextRange
        }
      }
    }
  } catch {}
  try {
    if ([int]$shape.Type -eq 6) {
      for ($index = 1; $index -le $shape.GroupItems.Count; $index++) {
        $ranges += @(PowerPoint-ShapeTextRanges $shape.GroupItems.Item($index))
      }
    }
  } catch {}
  return $ranges
}

function PowerPoint-TextRanges($presentation) {
  $ranges = @()
  foreach ($slide in @($presentation.Slides)) {
    foreach ($shape in @($slide.Shapes)) { $ranges += @(PowerPoint-ShapeTextRanges $shape) }
    try {
      foreach ($shape in @($slide.NotesPage.Shapes)) { $ranges += @(PowerPoint-ShapeTextRanges $shape) }
    } catch {}
  }
  return $ranges
}

function Fill-PowerPointTemplate($presentation, $op) {
  $values = Template-ValueMap $op
  $filled = [ordered]@{}
  foreach ($range in @(PowerPoint-TextRanges $presentation)) {
    $text = [string]$range.Text
    $variants = @{}
    foreach ($match in @(Template-Matches $text)) { $variants[$match.Raw] = $match.Key }
    foreach ($raw in $variants.Keys) {
      $key = [string]$variants[$raw]
      if (-not $values.ContainsKey($key)) { continue }
      $expected = [regex]::Matches($text, [regex]::Escape([string]$raw)).Count
      $replaced = 0
      $after = 0
      while ($replaced -lt $expected) {
        $found = $range.Replace([string]$raw, [string]$values[$key], $after, 0, 0)
        if ($null -eq $found) { break }
        $replaced++
        $after = [int]$found.Start + [Math]::Max([int]$found.Length, 1) - 1
      }
      if ($replaced -gt 0) { $filled[$key] = $(if ($filled.Contains($key)) { [int]$filled[$key] + $replaced } else { $replaced }) }
    }
  }
  $remaining = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($range in @(PowerPoint-TextRanges $presentation)) {
    foreach ($match in @(Template-Matches ([string]$range.Text))) { $null = $remaining.Add([string]$match.Key) }
  }
  $unfilled = @($remaining) | Sort-Object
  if ([bool]$op.strict -and $unfilled.Count -gt 0) { throw "Unfilled template tokens: $($unfilled -join ', ')" }
  return [ordered]@{ op = 'fill_template'; changed = $filled.Count -gt 0; filled = $filled; unfilledTokens = $unfilled; strict = [bool]$op.strict }
}

function Word-StyleValue([string]$name) {
  $styles = @{
    normal = -1
    heading1 = -2
    heading2 = -3
    heading3 = -4
    heading4 = -5
    heading5 = -6
    heading6 = -7
    heading7 = -8
    heading8 = -9
    heading9 = -10
    title = -63
    subtitle = -75
    tablegrid = -155
  }
  $key = $name.Replace(' ', '').Replace('-', '').ToLowerInvariant()
  if ($styles.ContainsKey($key)) { return [int]$styles[$key] }
  return $name
}

function Provenance-Text($op) {
  $source = $op.source
  if ($null -eq $source) { throw 'add_provenance requires source' }
  $document = if ($source -is [string]) { [string]$source } else { [string]$source.document }
  $target = if ($source -is [string]) { '' } else { [string]$source.target }
  $label = if ($source -is [string]) { '' } else { [string]$source.label }
  if ([string]::IsNullOrWhiteSpace($document)) { throw 'add_provenance source.document is required' }
  $text = "Source: $document"
  if (-not [string]::IsNullOrWhiteSpace($target)) { $text += "#$target" }
  if (-not [string]::IsNullOrWhiteSpace($label)) { $text += " ($label)" }
  return $text
}

function Apply-WordOperation($doc, $op) {
  switch ([string]$op.op) {
    'fill_template' { return Fill-WordTemplate $doc $op }
    'replace_text' {
      $range = $doc.Content.Duplicate
      $ok = $range.Find.Execute([string]$op.find, $false, $false, $false, $false, $false, $true, 1, $false, [string]$op.replace, 2)
      return [ordered]@{ op = 'replace_text'; changed = [bool]$ok }
    }
    'append_text' {
      $text = [string]$op.text
      $existing = ([string]$doc.Content.Text).TrimEnd("`r", "`a")
      $reusedInitialParagraph = [string]::IsNullOrWhiteSpace($existing)
      if ($reusedInitialParagraph) {
        $paragraph = $doc.Paragraphs.Item(1)
        $paragraph.Range.Text = "$text`r"
      } else {
        $range = $doc.Content.Duplicate
        $range.Collapse(0)
        $paragraph = $doc.Paragraphs.Add($range)
        $paragraph.Range.Text = "$text`r"
      }
      $style = if ($op.style) { [string]$op.style } elseif ($op.properties.style) { [string]$op.properties.style } else { '' }
      if ($style) { $paragraph.Range.Style = Word-StyleValue $style }
      $props = $op.properties
      if ($props.name) { $paragraph.Range.Font.Name = [string]$props.name }
      if ($props.size) { $paragraph.Range.Font.Size = [single]$props.size }
      if ($null -ne $props.bold) { $paragraph.Range.Font.Bold = if ($props.bold) { -1 } else { 0 } }
      if ($null -ne $props.italic) { $paragraph.Range.Font.Italic = if ($props.italic) { -1 } else { 0 } }
      if ($props.color) { $paragraph.Range.Font.Color = Color-Value ([string]$props.color) }
      $format = $paragraph.Format
      if ($props.alignment) {
        $format.Alignment = switch ([string]$props.alignment) { 'center' { 1 } 'right' { 2 } 'justify' { 3 } default { 0 } }
      }
      if ($null -ne $props.spacingBefore) { $format.SpaceBefore = [single]$props.spacingBefore }
      if ($null -ne $props.spacingAfter) { $format.SpaceAfter = [single]$props.spacingAfter }
      if ($null -ne $props.lineSpacing) { $format.LineSpacing = [single]$props.lineSpacing }
      if ($null -ne $props.keepWithNext) { $format.KeepWithNext = if ($props.keepWithNext) { -1 } else { 0 } }
      if ($null -ne $props.pageBreakBefore) { $format.PageBreakBefore = if ($props.pageBreakBefore) { -1 } else { 0 } }
      if ($props.tabStops) {
        $format.TabStops.ClearAll()
        foreach ($tab in @($props.tabStops)) {
          $alignment = switch ([string]$tab.alignment) { 'center' { 1 } 'right' { 2 } 'decimal' { 3 } 'bar' { 4 } default { 0 } }
          $leader = switch ([string]$tab.leader) { 'dot' { 1 } 'dash' { 2 } 'line' { 3 } 'heavy' { 4 } 'middleDot' { 5 } default { 0 } }
          $null = $format.TabStops.Add([single]$tab.position, $alignment, $leader)
        }
      }
      if ($props.border) {
        $borderIndex = switch ([string]$props.border.side) { 'top' { -1 } 'left' { -2 } 'right' { -4 } default { -3 } }
        $border = $paragraph.Borders.Item($borderIndex)
        $border.LineStyle = 1
        if ($props.border.color) { $border.Color = Color-Value ([string]$props.border.color) }
      }
      if ($props.listKind) {
        $kind = ([string]$props.listKind).ToLowerInvariant()
        if ($kind -eq 'number') {
          $paragraph.Range.ListFormat.ApplyNumberDefault()
        } elseif ($kind -ne 'none') {
          $paragraph.Range.ListFormat.ApplyBulletDefault()
        } else {
          $paragraph.Range.ListFormat.RemoveNumbers()
        }
        for ($level = 0; $level -lt [int]$props.listLevel; $level++) { $paragraph.Range.ListFormat.ListIndent() }
      } else {
        $paragraph.Range.ListFormat.RemoveNumbers()
      }
      $paragraphIndex = if ($reusedInitialParagraph) { 1 } else { [Math]::Max(1, [int]$doc.Paragraphs.Count - 1) }
      return [ordered]@{ op = 'append_text'; changed = $true; paragraph = $paragraphIndex; path = "/body/p[$paragraphIndex]"; style = $style }
    }
    'set_table_cell' {
      $doc.Tables.Item([int]$op.table).Cell([int]$op.row, [int]$op.col).Range.Text = [string]$op.text
      return [ordered]@{ op = 'set_table_cell'; changed = $true }
    }
    'add_table' {
      $values = @($op.values)
      $rows = if ($op.rows) { [int]$op.rows } elseif ($values.Count -gt 0) { [int]$values.Count } else { 1 }
      $columns = if ($op.columns) {
        [int]$op.columns
      } elseif ($values.Count -gt 0) {
        [Math]::Max(1, [int]@($values | ForEach-Object { @($_).Count } | Measure-Object -Maximum).Maximum)
      } else {
        1
      }
      if ($op.paragraph) {
        $range = $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate
        $range.Collapse(0)
      } else {
        $range = $doc.Content.Duplicate
        $range.Collapse(0)
      }
      $table = $doc.Tables.Add($range, $rows, $columns)
      for ($row = 1; $row -le $rows; $row++) {
        for ($column = 1; $column -le $columns; $column++) {
          if ($row -le $values.Count -and $column -le @($values[$row - 1]).Count) {
            $table.Cell($row, $column).Range.Text = [string]@($values[$row - 1])[$column - 1]
          }
        }
      }
      $props = $op.properties
      if ($props.style) { $table.Style = Word-StyleValue ([string]$props.style) }
      if ($props.textStyle) { $table.Range.Style = Word-StyleValue ([string]$props.textStyle) }
      if ($props.fontName) { $table.Range.Font.Name = [string]$props.fontName }
      if ($props.fontSize) { $table.Range.Font.Size = [single]$props.fontSize }
      if ($props.color) { $table.Range.Font.Color = Color-Value ([string]$props.color) }
      if ($null -ne $props.spacingAfter) { $table.Range.ParagraphFormat.SpaceAfter = [single]$props.spacingAfter }
      if ($props.alignment) {
        $table.Rows.Alignment = switch ([string]$props.alignment) { 'center' { 1 } 'right' { 2 } default { 0 } }
      }
      if ($props.columnWidths) {
        for ($column = 1; $column -le [Math]::Min($columns, @($props.columnWidths).Count); $column++) {
          $table.Columns.Item($column).Width = [single]@($props.columnWidths)[$column - 1]
        }
      }
      if ($props.borders) { $table.Borders.Enable = 1 }
      if ($props.shading) { $table.Shading.BackgroundPatternColor = Color-Value ([string]$props.shading) }
      return [ordered]@{ op = 'add_table'; changed = $true; table = [int]$table.Index; rows = $rows; columns = $columns }
    }
    'set_table_style' {
      $table = $doc.Tables.Item([int]$op.table)
      $props = $op.properties
      if ($props.style) { $table.Style = Word-StyleValue ([string]$props.style) }
      if ($props.alignment) {
        $table.Rows.Alignment = switch ([string]$props.alignment) { 'center' { 1 } 'right' { 2 } default { 0 } }
      }
      if ($props.columnWidths) {
        for ($column = 1; $column -le [Math]::Min($table.Columns.Count, @($props.columnWidths).Count); $column++) {
          $table.Columns.Item($column).Width = [single]@($props.columnWidths)[$column - 1]
        }
      }
      if ($props.borders) { $table.Borders.Enable = 1 }
      if ($props.shading) { $table.Shading.BackgroundPatternColor = Color-Value ([string]$props.shading) }
      return [ordered]@{ op = 'set_table_style'; changed = $true; table = [int]$op.table }
    }
    'merge_table_cells' {
      $table = $doc.Tables.Item([int]$op.table)
      $rowSpan = [Math]::Max(1, $(if ($op.rowSpan) { [int]$op.rowSpan } else { 1 }))
      $colSpan = [Math]::Max(1, $(if ($op.colSpan) { [int]$op.colSpan } else { 1 }))
      $lastRow = [int]$op.row + $rowSpan - 1
      $lastCol = [int]$op.col + $colSpan - 1
      $table.Cell([int]$op.row, [int]$op.col).Merge($table.Cell($lastRow, $lastCol))
      return [ordered]@{ op = 'merge_table_cells'; changed = $true; table = [int]$op.table; row = [int]$op.row; col = [int]$op.col }
    }
    'set_table_cell_style' {
      $cell = $doc.Tables.Item([int]$op.table).Cell([int]$op.row, [int]$op.col)
      $props = $op.properties
      if ($props.fillColor) { $cell.Shading.BackgroundPatternColor = Color-Value ([string]$props.fillColor) }
      if ($props.verticalAlignment) {
        $cell.VerticalAlignment = switch ([string]$props.verticalAlignment) { 'center' { 1 } 'bottom' { 3 } default { 0 } }
      }
      if ($props.width) { $cell.Width = [single]$props.width }
      if ($null -ne $props.bold) { $cell.Range.Font.Bold = if ($props.bold) { -1 } else { 0 } }
      if ($null -ne $props.italic) { $cell.Range.Font.Italic = if ($props.italic) { -1 } else { 0 } }
      if ($props.fontName) { $cell.Range.Font.Name = [string]$props.fontName }
      if ($props.fontSize) { $cell.Range.Font.Size = [single]$props.fontSize }
      if ($props.color) { $cell.Range.Font.Color = Color-Value ([string]$props.color) }
      return [ordered]@{ op = 'set_table_cell_style'; changed = $true; table = [int]$op.table; row = [int]$op.row; col = [int]$op.col }
    }
    'set_paragraph_text' {
      $paragraph = $doc.Paragraphs.Item([int]$op.paragraph)
      $paragraph.Range.Text = ([string]$op.text) + "`r"
      return [ordered]@{ op = 'set_paragraph_text'; changed = $true }
    }
    'set_run_text' {
      $paragraph = $doc.Paragraphs.Item([int]$op.paragraph)
      $run = $paragraph.Range.Words.Item([int]$op.run)
      $run.Text = [string]$op.text
      return [ordered]@{ op = 'set_run_text'; changed = $true }
    }
    'remove_paragraph' {
      $doc.Paragraphs.Item([int]$op.paragraph).Range.Delete()
      return [ordered]@{ op = 'remove_paragraph'; changed = $true }
    }
    'move_paragraph' {
      $source = $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate
      $formatted = $source.FormattedText
      $source.Delete()
      $destination = $doc.Paragraphs.Item([int]$op.index).Range.Duplicate
      $destination.Collapse(1)
      $destination.FormattedText = $formatted
      return [ordered]@{ op = 'move_paragraph'; changed = $true }
    }
    'add_image' {
      $width = if ($op.width) { [single]$op.width } else { [single]0 }
      $height = if ($op.height) { [single]$op.height } else { [single]0 }
      $shape = $doc.InlineShapes.AddPicture([string]$op.path, $false, $true)
      if ($width -gt 0) { $shape.Width = $width }
      if ($height -gt 0) { $shape.Height = $height }
      return [ordered]@{ op = 'add_image'; changed = $true }
    }
    'add_comment' {
      $range = $doc.Content.Duplicate
      $found = $range.Find.Execute([string]$op.find)
      if (-not $found) { throw "Comment target not found: $($op.find)" }
      $null = $doc.Comments.Add($range, [string]$op.text)
      return [ordered]@{ op = 'add_comment'; changed = $true }
    }
    'add_comment_reply' {
      $index = [int]$op.comment
      if ($index -lt 1 -or $index -gt $doc.Comments.Count) { throw "Comment index out of range: $index" }
      $comment = $doc.Comments.Item($index)
      try {
        $range = $comment.Scope.Duplicate
        $null = $comment.Replies.Add($range, [string]$op.text)
      } catch {
        throw 'This Word version does not expose threaded comment replies through COM'
      }
      return [ordered]@{ op = 'add_comment_reply'; changed = $true; comment = $index }
    }
    'add_provenance' {
      $paragraphIndex = [int]$op.paragraph
      if ($paragraphIndex -lt 1 -or $paragraphIndex -gt $doc.Paragraphs.Count) { throw "Provenance paragraph index out of range: $paragraphIndex" }
      $range = $doc.Paragraphs.Item($paragraphIndex).Range.Duplicate
      if ($range.End -gt $range.Start) { $range.End-- }
      $text = Provenance-Text $op
      $null = $doc.Comments.Add($range, $text)
      return [ordered]@{ op = 'add_provenance'; changed = $true; target = "/body/p[$paragraphIndex]"; citation = $text }
    }
    'delete_comment' {
      $index = [int]$op.comment
      if ($index -lt 1 -or $index -gt $doc.Comments.Count) { throw "Comment index out of range: $index" }
      $comment = $doc.Comments.Item($index)
      if ($comment.Replies.Count -gt 0) {
        $comment.DeleteRecursively()
      } else {
        $comment.Delete()
      }
      return [ordered]@{ op = 'delete_comment'; changed = $true; comment = $index }
    }
    'set_comment_resolved' {
      $index = [int]$op.comment
      if ($index -lt 1 -or $index -gt $doc.Comments.Count) { throw "Comment index out of range: $index" }
      $comment = $doc.Comments.Item($index)
      try {
        $comment.Done = [bool]$op.resolved
      } catch {
        throw 'This Word version does not expose resolved comment state through COM'
      }
      return [ordered]@{ op = 'set_comment_resolved'; changed = $true; comment = $index; resolved = [bool]$op.resolved }
    }
    'set_font' {
      $range = $doc.Content.Duplicate
      if ($op.find -and -not $range.Find.Execute([string]$op.find)) { throw "Font target not found: $($op.find)" }
      $props = $op.properties
      if ($props.name) { $range.Font.Name = [string]$props.name }
      if ($props.size) { $range.Font.Size = [single]$props.size }
      if ($null -ne $props.bold) { $range.Font.Bold = if ($props.bold) { -1 } else { 0 } }
      if ($null -ne $props.italic) { $range.Font.Italic = if ($props.italic) { -1 } else { 0 } }
      if ($props.color) { $range.Font.Color = Color-Value ([string]$props.color) }
      return [ordered]@{ op = 'set_font'; changed = $true }
    }
    'set_paragraph_style' {
      $paragraph = $doc.Paragraphs.Item([int]$op.paragraph)
      $paragraph.Range.Style = Word-StyleValue ([string]$op.style)
      return [ordered]@{ op = 'set_paragraph_style'; changed = $true; style = [string]$op.style }
    }
    'set_paragraph_format' {
      $paragraph = $doc.Paragraphs.Item([int]$op.paragraph)
      $format = $paragraph.Format
      $props = $op.properties
      if ($props.alignment) {
        $format.Alignment = switch ([string]$props.alignment) { 'center' { 1 } 'right' { 2 } 'justify' { 3 } default { 0 } }
      }
      if ($null -ne $props.spacingBefore) { $format.SpaceBefore = [single]$props.spacingBefore }
      if ($null -ne $props.spacingAfter) { $format.SpaceAfter = [single]$props.spacingAfter }
      if ($null -ne $props.lineSpacing) { $format.LineSpacing = [single]$props.lineSpacing }
      if ($null -ne $props.keepWithNext) { $format.KeepWithNext = if ($props.keepWithNext) { -1 } else { 0 } }
      if ($null -ne $props.pageBreakBefore) { $format.PageBreakBefore = if ($props.pageBreakBefore) { -1 } else { 0 } }
      if ($props.tabStops) {
        $format.TabStops.ClearAll()
        foreach ($tab in @($props.tabStops)) {
          $alignment = switch ([string]$tab.alignment) { 'center' { 1 } 'right' { 2 } 'decimal' { 3 } 'bar' { 4 } default { 0 } }
          $leader = switch ([string]$tab.leader) { 'dot' { 1 } 'dash' { 2 } 'line' { 3 } 'heavy' { 4 } 'middleDot' { 5 } default { 0 } }
          $null = $format.TabStops.Add([single]$tab.position, $alignment, $leader)
        }
      }
      if ($props.border) {
        $borderIndex = switch ([string]$props.border.side) { 'top' { -1 } 'left' { -2 } 'right' { -4 } default { -3 } }
        $border = $paragraph.Borders.Item($borderIndex)
        $border.LineStyle = 1
        if ($props.border.color) { $border.Color = Color-Value ([string]$props.border.color) }
      }
      return [ordered]@{ op = 'set_paragraph_format'; changed = $true; paragraph = [int]$op.paragraph }
    }
    'insert_table_row' {
      $table = $doc.Tables.Item([int]$op.table)
      if ($op.row) { $null = $table.Rows.Add($table.Rows.Item([int]$op.row)) } else { $null = $table.Rows.Add() }
      return [ordered]@{ op = 'insert_table_row'; changed = $true; rows = $table.Rows.Count }
    }
    'delete_table_row' {
      $table = $doc.Tables.Item([int]$op.table)
      $table.Rows.Item([int]$op.row).Delete()
      return [ordered]@{ op = 'delete_table_row'; changed = $true; rows = $table.Rows.Count }
    }
    'insert_table_column' {
      $table = $doc.Tables.Item([int]$op.table)
      if ($op.column) { $null = $table.Columns.Add($table.Columns.Item([int]$op.column)) } else { $null = $table.Columns.Add() }
      return [ordered]@{ op = 'insert_table_column'; changed = $true; columns = $table.Columns.Count }
    }
    'delete_table_column' {
      $table = $doc.Tables.Item([int]$op.table)
      $table.Columns.Item([int]$op.column).Delete()
      return [ordered]@{ op = 'delete_table_column'; changed = $true; columns = $table.Columns.Count }
    }
    'set_header_footer' {
      $section = $doc.Sections.Item($(if ($op.section) { [int]$op.section } else { 1 }))
      $kind = switch ([string]$op.kind) {
        'first' { 2 }
        'even' { 3 }
        default { 1 }
      }
      $collection = if ($null -ne $op.header -and -not [bool]$op.header) { $section.Footers } else { $section.Headers }
      $collection.Item($kind).Range.Text = [string]$op.text
      return [ordered]@{ op = 'set_header_footer'; changed = $true; section = $section.Index }
    }
    'track_changes' {
      $doc.TrackRevisions = [bool]$op.enabled
      return [ordered]@{ op = 'track_changes'; changed = $true; enabled = [bool]$doc.TrackRevisions }
    }
    'resolve_revisions' {
      $resolution = ([string]$op.resolution).ToLowerInvariant()
      $count = $doc.Revisions.Count
      if ($resolution -eq 'reject') { $doc.RejectAllRevisions() } else { $doc.AcceptAllRevisions() }
      return [ordered]@{ op = 'resolve_revisions'; changed = $count -gt 0; resolved = $count; resolution = $(if ($resolution -eq 'reject') { 'reject' } else { 'accept' }) }
    }
    'resolve_revision' {
      $index = [int]$op.revision
      if ($index -lt 1 -or $index -gt $doc.Revisions.Count) { throw "Revision index out of range: $index" }
      $resolution = ([string]$op.resolution).ToLowerInvariant()
      $revision = $doc.Revisions.Item($index)
      if ($resolution -eq 'reject') { $revision.Reject() } else { $revision.Accept() }
      return [ordered]@{ op = 'resolve_revision'; changed = $true; revision = $index; resolution = $(if ($resolution -eq 'reject') { 'reject' } else { 'accept' }) }
    }
    'insert_toc' {
      $range = if ($op.paragraph) {
        $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate
      } else {
        $doc.Range(0, 0)
      }
      $range.Collapse(1)
      $toc = $doc.TablesOfContents.Add(
        $range,
        $true,
        $(if ($op.lowerHeadingLevel) { [int]$op.lowerHeadingLevel } else { 1 }),
        $(if ($op.upperHeadingLevel) { [int]$op.upperHeadingLevel } else { 9 })
      )
      try { $toc.Update() } catch {}
      return [ordered]@{ op = 'insert_toc'; changed = $true; index = [int]$toc.Index }
    }
    'add_page_numbers' {
      $section = $doc.Sections.Item($(if ($op.section) { [int]$op.section } else { 1 }))
      $kind = switch ([string]$op.kind) {
        'first' { 2 }
        'even' { 3 }
        default { 1 }
      }
      $footer = $section.Footers.Item($kind)
      $range = $footer.Range
      $range.Text = $(if ($null -ne $op.prefix) { [string]$op.prefix } else { 'Page ' })
      $range = $footer.Range
      $range.Collapse(0)
      $null = $footer.Range.Fields.Add($range, -1, 'PAGE', $true)
      if ($null -eq $op.includeTotal -or [bool]$op.includeTotal) {
        $range = $footer.Range
        $range.Collapse(0)
        $range.InsertAfter($(if ($null -ne $op.separator) { [string]$op.separator } else { ' of ' }))
        $range = $footer.Range
        $range.Collapse(0)
        $null = $footer.Range.Fields.Add($range, -1, 'NUMPAGES', $true)
      }
      return [ordered]@{ op = 'add_page_numbers'; changed = $true; section = [int]$section.Index }
    }
    'insert_break' {
      $range = if ($op.paragraph) {
        $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate
      } else {
        $doc.Content.Duplicate
      }
      $range.Collapse(0)
      $breakType = switch ([string]$op.kind) {
        'section_next' { 2 }
        'section_continuous' { 3 }
        default { 7 }
      }
      $range.InsertBreak($breakType)
      return [ordered]@{ op = 'insert_break'; changed = $true; kind = $(if ($op.kind) { [string]$op.kind } else { 'page' }) }
    }
    'set_list' {
      $paragraph = $doc.Paragraphs.Item([int]$op.paragraph)
      $kind = ([string]$op.kind).ToLowerInvariant()
      if ($kind -eq 'none') {
        $paragraph.Range.ListFormat.RemoveNumbers()
      } elseif ($kind -eq 'number') {
        $paragraph.Range.ListFormat.ApplyNumberDefault()
      } else {
        $paragraph.Range.ListFormat.ApplyBulletDefault()
      }
      if ($op.level) { $paragraph.Range.ListFormat.ListIndent(); for ($level = 2; $level -lt [int]$op.level; $level++) { $paragraph.Range.ListFormat.ListIndent() } }
      return [ordered]@{ op = 'set_list'; changed = $true; paragraph = [int]$op.paragraph; kind = $(if ($kind) { $kind } else { 'bullet' }) }
    }
    'add_hyperlink' {
      $range = if ($op.paragraph) { $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate } else { $doc.Content.Duplicate }
      if ($op.find) {
        $found = $range.Find.Execute([string]$op.find, $false, $false, $false, $false, $false, $true)
        if (-not $found) { throw "Hyperlink target text not found: $($op.find)" }
      } elseif (-not $op.paragraph) {
        $range.Collapse(0)
      }
      $display = if ($null -ne $op.display) { [string]$op.display } else { [string]$range.Text }
      $link = $doc.Hyperlinks.Add($range, [string]$op.address, [string]$op.subAddress, $null, $display)
      return [ordered]@{ op = 'add_hyperlink'; changed = $true; address = [string]$link.Address; subAddress = [string]$link.SubAddress }
    }
    'add_bookmark' {
      $range = if ($op.paragraph) { $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate } else { $doc.Content.Duplicate }
      if ($op.find) {
        $found = $range.Find.Execute([string]$op.find, $false, $false, $false, $false, $false, $true)
        if (-not $found) { throw "Bookmark target text not found: $($op.find)" }
      } elseif (-not $op.paragraph) {
        $range.Collapse(0)
      }
      $bookmark = $doc.Bookmarks.Add([string]$op.name, $range)
      return [ordered]@{ op = 'add_bookmark'; changed = $true; name = [string]$bookmark.Name }
    }
    'set_page' {
      $section = $doc.Sections.Item($(if ($op.section) { [int]$op.section } else { 1 }))
      $props = $op.properties
      if ($props.orientation) { $section.PageSetup.Orientation = $(if ([string]$props.orientation -eq 'landscape') { 1 } else { 0 }) }
      if ($props.topMargin) { $section.PageSetup.TopMargin = [single]$props.topMargin }
      if ($props.bottomMargin) { $section.PageSetup.BottomMargin = [single]$props.bottomMargin }
      if ($props.leftMargin) { $section.PageSetup.LeftMargin = [single]$props.leftMargin }
      if ($props.rightMargin) { $section.PageSetup.RightMargin = [single]$props.rightMargin }
      return [ordered]@{ op = 'set_page'; changed = $true; section = $section.Index }
    }
    'fit_table' {
      $table = $doc.Tables.Item([int]$op.table)
      $table.AutoFitBehavior(2)
      return [ordered]@{ op = 'fit_table'; changed = $true; table = [int]$op.table }
    }
    default { throw "Unsupported DOCX operation: $($op.op)" }
  }
}

function Excel-Sheet($book, $op) {
  if ($op.sheet) { return $book.Worksheets.Item([string]$op.sheet) }
  return $book.ActiveSheet
}

function Excel-CellValue($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [System.Boolean]) { return [bool]$value }
  if (
    $value -is [System.Byte] -or
    $value -is [System.SByte] -or
    $value -is [System.Int16] -or
    $value -is [System.UInt16] -or
    $value -is [System.Int32] -or
    $value -is [System.UInt32] -or
    $value -is [System.Int64] -or
    $value -is [System.UInt64] -or
    $value -is [System.Single] -or
    $value -is [System.Double] -or
    $value -is [System.Decimal]
  ) {
    return [double]$value
  }
  return [string]$value
}

function Set-ExcelCellValue($cell, $value) {
  $converted = Excel-CellValue $value
  if ($null -eq $converted) {
    $cell.ClearContents()
    return
  }
  $arguments = [object[]]::new(1)
  $arguments[0] = $converted
  $cell.GetType().InvokeMember(
    'Value2',
    [System.Reflection.BindingFlags]::SetProperty,
    $null,
    $cell,
    $arguments
  ) | Out-Null
}

function Excel-PivotField($pivot, [string]$name) {
  $collection = $pivot.PivotFields()
  $available = @()
  for ($index = 1; $index -le $collection.Count; $index++) {
    $candidate = $collection.Item($index)
    $candidateName = [string]$candidate.Name
    $available += $candidateName
    if ([string]::Equals($candidateName, $name, [System.StringComparison]::OrdinalIgnoreCase)) { return $candidate }
  }
  throw "Pivot field '$name' not found; available fields: $($available -join ', ')"
}

function PowerPoint-Layout($presentation, $reference) {
  $layouts = $presentation.SlideMaster.CustomLayouts
  if ($null -eq $reference -or [string]::IsNullOrWhiteSpace([string]$reference)) {
    for ($index = 1; $index -le $layouts.Count; $index++) {
      if ([string]::Equals([string]$layouts.Item($index).Name, 'Blank', [System.StringComparison]::OrdinalIgnoreCase)) {
        return [ordered]@{ Index = $index; Layout = $layouts.Item($index) }
      }
    }
    for ($index = 1; $index -le $layouts.Count; $index++) {
      $candidate = $layouts.Item($index)
      $contentPlaceholderCount = 0
      for ($shapeIndex = 1; $shapeIndex -le $candidate.Shapes.Count; $shapeIndex++) {
        try {
          $shape = $candidate.Shapes.Item($shapeIndex)
          if ([int]$shape.Type -ne 14) { continue }
          $placeholderType = [int]$shape.PlaceholderFormat.Type
          if ($placeholderType -notin @(13, 15, 16)) { $contentPlaceholderCount++ }
        } catch {
          $contentPlaceholderCount++
        }
      }
      if ($contentPlaceholderCount -eq 0) {
        return [ordered]@{ Index = $index; Layout = $candidate }
      }
    }
    return [ordered]@{ Index = $layouts.Count; Layout = $layouts.Item($layouts.Count) }
  }
  $numeric = 0
  if ([int]::TryParse([string]$reference, [ref]$numeric)) {
    if ($numeric -lt 1 -or $numeric -gt $layouts.Count) { throw "PowerPoint layout index out of range: $numeric" }
    return [ordered]@{ Index = $numeric; Layout = $layouts.Item($numeric) }
  }
  $available = @()
  for ($index = 1; $index -le $layouts.Count; $index++) {
    $candidate = $layouts.Item($index)
    $name = [string]$candidate.Name
    $available += $name
    if ([string]::Equals($name, [string]$reference, [System.StringComparison]::OrdinalIgnoreCase)) {
      return [ordered]@{ Index = $index; Layout = $candidate }
    }
  }
  throw "PowerPoint layout '$reference' not found; available layouts: $($available -join ', ')"
}

function Apply-ExcelOperation($book, $op) {
  switch ([string]$op.op) {
    'replace_text' {
      $changed = $false
      foreach ($sheet in @($book.Worksheets)) {
        $changed = [bool]$sheet.Cells.Replace([string]$op.find, [string]$op.replace, 2, 1, $false, $false, $false, $false) -or $changed
      }
      return [ordered]@{ op = 'replace_text'; changed = $changed }
    }
    'set_cell' {
      $sheet = Excel-Sheet $book $op
      $target = $sheet.Range([string]$op.cell)
      Set-ExcelCellValue $target $op.value
      return [ordered]@{ op = 'set_cell'; changed = $true }
    }
    'set_formula' {
      $sheet = Excel-Sheet $book $op
      $formula = [string]$op.formula
      if (-not $formula.StartsWith('=')) { $formula = "=$formula" }
      $sheet.Range([string]$op.cell).Formula = $formula
      return [ordered]@{ op = 'set_formula'; changed = $true }
    }
    'set_range' {
      $sheet = Excel-Sheet $book $op
      $target = $sheet.Range([string]$op.range)
      $rows = @($op.values)
      $rowCount = $rows.Count
      $columnCount = if ($rowCount -gt 0) { @($rows[0]).Count } else { 0 }
      if ($rowCount -eq [int]$target.Rows.Count -and $columnCount -eq [int]$target.Columns.Count -and ($rowCount * $columnCount) -gt 500) {
        $matrix = New-Object 'object[,]' $rowCount, $columnCount
        for ($r = 0; $r -lt $rowCount; $r++) {
          $line = @($rows[$r])
          for ($c = 0; $c -lt $columnCount; $c++) { $matrix[$r, $c] = $line[$c] }
        }
        $target.Value2 = $matrix
        return [ordered]@{ op = 'set_range'; changed = $true; bulk = $true; cells = $rowCount * $columnCount }
      }
      for ($r = 0; $r -lt $rows.Count; $r++) {
        $line = @($rows[$r])
        for ($c = 0; $c -lt $line.Count; $c++) {
          $cell = $target.Cells.Item($r + 1, $c + 1)
          Set-ExcelCellValue $cell $line[$c]
        }
      }
      return [ordered]@{ op = 'set_range'; changed = $true }
    }
    'append_row' {
      $sheet = Excel-Sheet $book $op
      $row = [int]$sheet.UsedRange.Row + [int]$sheet.UsedRange.Rows.Count
      $values = @($op.values)
      for ($c = 0; $c -lt $values.Count; $c++) {
        $cell = $sheet.Cells.Item($row, $c + 1)
        Set-ExcelCellValue $cell $values[$c]
      }
      return [ordered]@{ op = 'append_row'; changed = $true; row = $row }
    }
    'add_sheet' {
      $sheet = $book.Worksheets.Add()
      $sheet.Name = [string]$op.name
      return [ordered]@{ op = 'add_sheet'; changed = $true; sheet = [string]$sheet.Name }
    }
    'copy_sheet' {
      $source = $book.Worksheets.Item([string]$op.sheet)
      $source.Copy($null, $book.Worksheets.Item($book.Worksheets.Count))
      $copy = $book.Worksheets.Item($book.Worksheets.Count)
      if ($op.name) { $copy.Name = [string]$op.name }
      return [ordered]@{ op = 'copy_sheet'; changed = $true; sheet = [string]$copy.Name }
    }
    'clear_cell' {
      $sheet = Excel-Sheet $book $op
      $sheet.Range([string]$op.cell).Clear()
      return [ordered]@{ op = 'clear_cell'; changed = $true }
    }
    'add_note' {
      $sheet = Excel-Sheet $book $op
      $cell = $sheet.Range([string]$op.cell)
      if ($null -ne $cell.Comment) { $cell.Comment.Delete() }
      $comment = $cell.AddComment([string]$op.text)
      return [ordered]@{ op = 'add_note'; changed = $true; cell = [string]$cell.Address($false, $false); author = [string]$comment.Author }
    }
    'add_provenance' {
      $sheet = Excel-Sheet $book $op
      $cell = $sheet.Range([string]$op.cell)
      $text = Provenance-Text $op
      if ($null -ne $cell.Comment) {
        $existing = [string]$cell.Comment.Text()
        if ($existing -notmatch [regex]::Escape($text)) { $cell.Comment.Text("$existing`n$text") }
      } else {
        $null = $cell.AddComment($text)
      }
      return [ordered]@{ op = 'add_provenance'; changed = $true; target = "/sheet[$([string]$sheet.Name)]/cell[$([string]$cell.Address($false, $false))]"; citation = $text }
    }
    'delete_note' {
      $sheet = Excel-Sheet $book $op
      $cell = $sheet.Range([string]$op.cell)
      $changed = $null -ne $cell.Comment
      if ($changed) { $cell.Comment.Delete() }
      return [ordered]@{ op = 'delete_note'; changed = $changed; cell = [string]$cell.Address($false, $false) }
    }
    'delete_sheet' {
      $book.Worksheets.Item([string]$op.sheet).Delete()
      return [ordered]@{ op = 'delete_sheet'; changed = $true }
    }
    'set_style' {
      $sheet = Excel-Sheet $book $op
      $target = $sheet.Range([string]$(if ($op.range) { $op.range } else { $op.cell }))
      $props = $op.properties
      if ($props.fontName) { $target.Font.Name = [string]$props.fontName }
      if ($props.fontSize) { $target.Font.Size = [single]$props.fontSize }
      if ($null -ne $props.bold) { $target.Font.Bold = [bool]$props.bold }
      if ($null -ne $props.italic) { $target.Font.Italic = [bool]$props.italic }
      if ($props.numberFormat) { $target.NumberFormat = [string]$props.numberFormat }
      if ($props.color) { $target.Font.Color = Color-Value ([string]$props.color) }
      if ($props.fillColor) { $target.Interior.Color = Color-Value ([string]$props.fillColor) }
      if ($props.horizontalAlignment) {
        $target.HorizontalAlignment = switch ([string]$props.horizontalAlignment) {
          'center' { -4108 }
          'right' { -4152 }
          'justify' { -4130 }
          default { -4131 }
        }
      }
      if ($props.verticalAlignment) {
        $target.VerticalAlignment = switch ([string]$props.verticalAlignment) {
          'center' { -4108 }
          'bottom' { -4107 }
          default { -4160 }
        }
      }
      if ($null -ne $props.wrapText) { $target.WrapText = [bool]$props.wrapText }
      return [ordered]@{ op = 'set_style'; changed = $true }
    }
    'add_image' {
      $sheet = Excel-Sheet $book $op
      $left = if ($op.left) { [single]$op.left } else { [single]0 }
      $top = if ($op.top) { [single]$op.top } else { [single]0 }
      $width = if ($op.width) { [single]$op.width } else { [single]320 }
      $height = if ($op.height) { [single]$op.height } else { [single]240 }
      $null = $sheet.Shapes.AddPicture([string]$op.path, $false, $true, $left, $top, $width, $height)
      return [ordered]@{ op = 'add_image'; changed = $true }
    }
    'rename_sheet' {
      $sheet = Excel-Sheet $book $op
      $sheet.Name = [string]$op.name
      return [ordered]@{ op = 'rename_sheet'; changed = $true; sheet = [string]$sheet.Name }
    }
    'add_table' {
      $sheet = Excel-Sheet $book $op
      $source = $sheet.Range([string]$op.range)
      $table = $sheet.ListObjects.Add(1, $source, $null, 1)
      if ($op.name) { $table.Name = [string]$op.name }
      if ($op.style) { $table.TableStyle = [string]$op.style }
      return [ordered]@{ op = 'add_table'; changed = $true; name = [string]$table.Name }
    }
    'add_chart' {
      $sheet = Excel-Sheet $book $op
      $chartTypes = @{ column = 51; bar = 57; line = 4; pie = 5; area = 1; scatter = -4169 }
      $kind = ([string]$op.chartType).ToLowerInvariant()
      $chartType = if ($kind -and $chartTypes.ContainsKey($kind)) { [int]$chartTypes[$kind] } elseif ($op.chartType -as [int]) { [int]$op.chartType } else { 51 }
      $left = if ($null -ne $op.left) { [single]$op.left } else { [single]300 }
      $top = if ($null -ne $op.top) { [single]$op.top } else { [single]20 }
      $width = if ($op.width) { [single]$op.width } else { [single]480 }
      $height = if ($op.height) { [single]$op.height } else { [single]280 }
      $shape = $sheet.Shapes.AddChart2(-1, $chartType, $left, $top, $width, $height)
      if ($op.range) { $shape.Chart.SetSourceData($sheet.Range([string]$op.range), 2) }
      if ($op.title) { $shape.Chart.HasTitle = $true; $shape.Chart.ChartTitle.Text = [string]$op.title }
      $seriesCount = [int]$shape.Chart.SeriesCollection().Count
      $pointCount = if ($seriesCount -gt 0) { [int]$shape.Chart.SeriesCollection().Item(1).Points().Count } else { 0 }
      return [ordered]@{ op = 'add_chart'; changed = $true; name = [string]$shape.Name; series = $seriesCount; categories = $pointCount }
    }
    'add_conditional_format' {
      $sheet = Excel-Sheet $book $op
      $target = $sheet.Range([string]$op.range)
      if ($op.formula) {
        $rule = $target.FormatConditions.Add(2, $null, [string]$op.formula)
        if ($op.color) { $rule.Font.Color = Color-Value ([string]$op.color) }
        if ($op.fillColor) { $rule.Interior.Color = Color-Value ([string]$op.fillColor) }
      } else {
        $null = $target.FormatConditions.AddColorScale(3)
      }
      return [ordered]@{ op = 'add_conditional_format'; changed = $true }
    }
    'delete_conditional_formats' {
      $sheet = Excel-Sheet $book $op
      $target = $sheet.Range([string]$op.range)
      $count = [int]$target.FormatConditions.Count
      $target.FormatConditions.Delete()
      return [ordered]@{ op = 'delete_conditional_formats'; changed = $count -gt 0; count = $count }
    }
    'add_validation' {
      $sheet = Excel-Sheet $book $op
      $target = $sheet.Range([string]$op.range)
      $target.Validation.Delete()
      $target.Validation.Add(3, 1, 1, [string]$op.formula1)
      if ($op.inputMessage) { $target.Validation.InputMessage = [string]$op.inputMessage }
      if ($op.errorMessage) { $target.Validation.ErrorMessage = [string]$op.errorMessage }
      return [ordered]@{ op = 'add_validation'; changed = $true }
    }
    'freeze_panes' {
      $sheet = Excel-Sheet $book $op
      $sheet.Activate()
      $window = $book.Windows.Item(1)
      $window.FreezePanes = $false
      $window.SplitRow = $(if ($null -ne $op.row) { [int]$op.row } else { 1 })
      $window.SplitColumn = $(if ($null -ne $op.column) { [int]$op.column } else { 0 })
      $window.FreezePanes = $true
      return [ordered]@{ op = 'freeze_panes'; changed = $true }
    }
    'add_pivot_table' {
      $sourceSheet = Excel-Sheet $book $op
      $destinationSheet = if ($op.destinationSheet) { $book.Worksheets.Item([string]$op.destinationSheet) } else { $sourceSheet }
      $cache = $book.PivotCaches().Create(1, $sourceSheet.Range([string]$op.source))
      $pivot = $cache.CreatePivotTable($destinationSheet.Range([string]$op.destination), [string]$(if ($op.name) { $op.name } else { "MixdogPivot$($destinationSheet.PivotTables().Count + 1)" }))
      foreach ($field in @($op.rows)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$field)) { (Excel-PivotField $pivot ([string]$field)).Orientation = 1 }
      }
      foreach ($field in @($op.columns)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$field)) { (Excel-PivotField $pivot ([string]$field)).Orientation = 2 }
      }
      foreach ($field in @($op.values)) {
        if ([string]::IsNullOrWhiteSpace([string]$field)) { continue }
        $dataField = $pivot.AddDataField((Excel-PivotField $pivot ([string]$field)), "Sum of $field", -4157)
        $null = $dataField
      }
      return [ordered]@{ op = 'add_pivot_table'; changed = $true; name = [string]$pivot.Name }
    }
    'insert_rows' {
      $sheet = Excel-Sheet $book $op
      $count = if ($op.count) { [int]$op.count } else { 1 }
      for ($index = 0; $index -lt $count; $index++) { $sheet.Rows.Item([int]$op.row).Insert(-4121) }
      return [ordered]@{ op = 'insert_rows'; changed = $true; row = [int]$op.row; count = $count; referenceAware = $true }
    }
    'delete_rows' {
      $sheet = Excel-Sheet $book $op
      $count = if ($op.count) { [int]$op.count } else { 1 }
      for ($index = 0; $index -lt $count; $index++) { $sheet.Rows.Item([int]$op.row).Delete() }
      return [ordered]@{ op = 'delete_rows'; changed = $true; row = [int]$op.row; count = $count; referenceAware = $true }
    }
    'insert_columns' {
      $sheet = Excel-Sheet $book $op
      $count = if ($op.count) { [int]$op.count } else { 1 }
      for ($index = 0; $index -lt $count; $index++) { $sheet.Columns.Item([int]$op.column).Insert(-4161) }
      return [ordered]@{ op = 'insert_columns'; changed = $true; column = [int]$op.column; count = $count; referenceAware = $true }
    }
    'delete_columns' {
      $sheet = Excel-Sheet $book $op
      $count = if ($op.count) { [int]$op.count } else { 1 }
      for ($index = 0; $index -lt $count; $index++) { $sheet.Columns.Item([int]$op.column).Delete() }
      return [ordered]@{ op = 'delete_columns'; changed = $true; column = [int]$op.column; count = $count; referenceAware = $true }
    }
    'merge_cells' {
      $sheet = Excel-Sheet $book $op
      $sheet.Range([string]$op.range).Merge()
      return [ordered]@{ op = 'merge_cells'; changed = $true; range = [string]$op.range }
    }
    'unmerge_cells' {
      $sheet = Excel-Sheet $book $op
      $sheet.Range([string]$op.range).UnMerge()
      return [ordered]@{ op = 'unmerge_cells'; changed = $true; range = [string]$op.range }
    }
    'set_autofilter' {
      $sheet = Excel-Sheet $book $op
      if ($null -ne $op.enabled -and -not [bool]$op.enabled) {
        $sheet.AutoFilterMode = $false
      } else {
        $sheet.Range([string]$op.range).AutoFilter()
      }
      return [ordered]@{ op = 'set_autofilter'; changed = $true; enabled = $(if ($null -ne $op.enabled) { [bool]$op.enabled } else { $true }) }
    }
    'set_hyperlink' {
      $sheet = Excel-Sheet $book $op
      $target = $sheet.Range([string]$op.cell)
      try { $target.Hyperlinks.Delete() } catch {}
      $display = if ($null -ne $op.text) { [string]$op.text } else { [string]$target.Text }
      $link = $sheet.Hyperlinks.Add($target, [string]$op.address, [string]$op.subAddress, [string]$op.screenTip, $display)
      return [ordered]@{ op = 'set_hyperlink'; changed = $true; cell = [string]$op.cell; address = [string]$link.Address }
    }
    'define_name' {
      $refersTo = [string]$op.refersTo
      if (-not $refersTo.StartsWith('=')) { $refersTo = "=$refersTo" }
      $name = $book.Names.Add([string]$op.name, $refersTo)
      return [ordered]@{ op = 'define_name'; changed = $true; name = [string]$name.Name; refersTo = [string]$name.RefersTo }
    }
    'delete_name' {
      $book.Names.Item([string]$op.name).Delete()
      return [ordered]@{ op = 'delete_name'; changed = $true; name = [string]$op.name }
    }
    'protect_sheet' {
      $sheet = Excel-Sheet $book $op
      $sheet.Protect([string]$op.password)
      return [ordered]@{ op = 'protect_sheet'; changed = $true; sheet = [string]$sheet.Name }
    }
    'unprotect_sheet' {
      $sheet = Excel-Sheet $book $op
      $sheet.Unprotect([string]$op.password)
      return [ordered]@{ op = 'unprotect_sheet'; changed = $true; sheet = [string]$sheet.Name }
    }
    'autofit_range' {
      $sheet = Excel-Sheet $book $op
      $target = $sheet.Range([string]$op.range)
      $null = $target.EntireColumn.AutoFit()
      if ([bool]$op.rows) { $null = $target.EntireRow.AutoFit() }
      return [ordered]@{ op = 'autofit_range'; changed = $true; range = [string]$op.range }
    }
    'set_page_setup' {
      $sheet = Excel-Sheet $book $op
      $setup = $sheet.PageSetup
      if ($op.printArea) { $setup.PrintArea = [string]$op.printArea }
      if ($op.orientation) { $setup.Orientation = $(if ([string]$op.orientation -eq 'landscape') { 2 } else { 1 }) }
      if ($null -ne $op.fitToPagesWide -or $null -ne $op.fitToPagesTall) { $setup.Zoom = $false }
      if ($null -ne $op.fitToPagesWide) { $setup.FitToPagesWide = [int]$op.fitToPagesWide }
      if ($null -ne $op.fitToPagesTall) { $setup.FitToPagesTall = [int]$op.fitToPagesTall }
      if ($null -ne $op.centerHorizontally) { $setup.CenterHorizontally = [bool]$op.centerHorizontally }
      if ($null -ne $op.topMargin) { $setup.TopMargin = [double]$op.topMargin }
      if ($null -ne $op.bottomMargin) { $setup.BottomMargin = [double]$op.bottomMargin }
      if ($null -ne $op.leftMargin) { $setup.LeftMargin = [double]$op.leftMargin }
      if ($null -ne $op.rightMargin) { $setup.RightMargin = [double]$op.rightMargin }
      return [ordered]@{ op = 'set_page_setup'; changed = $true; sheet = [string]$sheet.Name; printArea = [string]$setup.PrintArea }
    }
    'set_sheet_view' {
      $sheet = Excel-Sheet $book $op
      $sheet.Activate()
      $window = $book.Windows.Item(1)
      if ($null -ne $op.showGridlines) { $window.DisplayGridlines = [bool]$op.showGridlines }
      if ($null -ne $op.zoom) { $window.Zoom = [Math]::Max(10, [Math]::Min(400, [int]$op.zoom)) }
      return [ordered]@{ op = 'set_sheet_view'; changed = $true; sheet = [string]$sheet.Name }
    }
    'set_sheet_visibility' {
      $sheet = Excel-Sheet $book $op
      $visibility = ([string]$op.visibility).ToLowerInvariant()
      $sheet.Visible = switch ($visibility) {
        'hidden' { 0 }
        'very_hidden' { 2 }
        'veryhidden' { 2 }
        'visible' { -1 }
        default { throw "Unknown worksheet visibility: $visibility" }
      }
      return [ordered]@{ op = 'set_sheet_visibility'; changed = $true; sheet = [string]$sheet.Name; visibility = $visibility }
    }
    default { throw "Unsupported XLSX operation: $($op.op)" }
  }
}

function Ppt-Slide($presentation, $op) {
  return $presentation.Slides.Item([int]$op.slide)
}

function Set-PowerPointChartData($chart, $categoryValues, $seriesValues) {
  $specs = @($seriesValues)
  if ($specs.Count -eq 0) { throw 'PowerPoint chart data requires at least one series' }
  $categories = @($categoryValues)
  $pointCount = $categories.Count
  foreach ($spec in $specs) { $pointCount = [Math]::Max($pointCount, @($spec.values).Count) }
  if ($pointCount -eq 0) { throw 'PowerPoint chart data requires at least one category or value' }
  if ($categories.Count -eq 0) {
    $categories = @(1..$pointCount | ForEach-Object { "Item $_" })
  }
  $chartData = $null
  $workbook = $null
  $worksheet = $null
  try {
    $chartData = $chart.ChartData
    $null = $chartData.Activate()
    for ($attempt = 0; $attempt -lt 50 -and $null -eq $workbook; $attempt++) {
      try { $workbook = $chartData.Workbook } catch {}
      if ($null -eq $workbook) { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $workbook) { throw 'PowerPoint chart embedded workbook did not activate' }
    $worksheet = $workbook.Worksheets.Item(1)
    $null = $worksheet.Cells.Clear()
    $matrix = New-Object 'object[,]' ($pointCount + 1), ($specs.Count + 1)
    $matrix[0, 0] = 'Category'
    for ($seriesIndex = 1; $seriesIndex -le $specs.Count; $seriesIndex++) {
      $matrix[0, $seriesIndex] = [string]$specs[$seriesIndex - 1].name
    }
    for ($pointIndex = 1; $pointIndex -le $pointCount; $pointIndex++) {
      $category = if ($pointIndex -le $categories.Count) { $categories[$pointIndex - 1] } else { "Item $pointIndex" }
      $matrix[$pointIndex, 0] = $category
      for ($seriesIndex = 1; $seriesIndex -le $specs.Count; $seriesIndex++) {
        $values = @($specs[$seriesIndex - 1].values)
        if ($pointIndex -le $values.Count) {
          $matrix[$pointIndex, $seriesIndex] = $values[$pointIndex - 1]
        }
      }
    }
    $lastColumn = Excel-ColumnLabel ($specs.Count + 1)
    $source = $worksheet.Range("A1:${lastColumn}$($pointCount + 1)")
    $null = ($source.Value2 = $matrix)
    $collection = $chart.SeriesCollection()
    while ($collection.Count -gt 0) { $null = $collection.Item(1).Delete() }
    $sheetName = ([string]$worksheet.Name).Replace("'", "''")
    $lastRow = $pointCount + 1
    for ($seriesIndex = 1; $seriesIndex -le $specs.Count; $seriesIndex++) {
      $column = Excel-ColumnLabel ($seriesIndex + 1)
      $series = $collection.NewSeries()
      $formula = "=SERIES('$sheetName'!`$$column`$1,'$sheetName'!`$A`$2:`$A`$$lastRow,'$sheetName'!`$$column`$2:`$$column`$$lastRow,$seriesIndex)"
      $null = ($series.Formula = $formula)
    }
    $null = $chart.Refresh()
  } finally {
    if ($null -ne $workbook) { try { $null = $workbook.Close($true) } catch {} }
    if ($null -ne $worksheet) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($worksheet) } catch {} }
    if ($null -ne $workbook) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) } catch {} }
    if ($null -ne $chartData) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($chartData) } catch {} }
  }
  for ($seriesIndex = 1; $seriesIndex -le [Math]::Min($specs.Count, [int]$chart.SeriesCollection().Count); $seriesIndex++) {
    $spec = $specs[$seriesIndex - 1]
    if ($spec.color) {
      try {
        $chart.SeriesCollection().Item($seriesIndex).Format.Fill.ForeColor.RGB = Color-Value ([string]$spec.color)
        $chart.SeriesCollection().Item($seriesIndex).Format.Line.ForeColor.RGB = Color-Value ([string]$spec.color)
      } catch {}
    }
  }
  $null = ($chart.HasLegend = $specs.Count -gt 1)
  return [ordered]@{ categories = $pointCount; series = [int]$chart.SeriesCollection().Count }
}

function Set-PowerPointParagraphs($shape, $paragraphs) {
  $items = @($paragraphs)
  $shape.TextFrame.TextRange.Text = (@($items | ForEach-Object { [string]$_.text }) -join "`r")
  for ($index = 1; $index -le $items.Count; $index++) {
    $spec = $items[$index - 1]
    $paragraph = $shape.TextFrame.TextRange.Paragraphs($index, 1)
    if ($null -ne $spec.level) { $paragraph.IndentLevel = [Math]::Max(1, [Math]::Min(5, [int]$spec.level + 1)) }
    if ($null -ne $spec.bullet) { $paragraph.ParagraphFormat.Bullet.Visible = $(if ([bool]$spec.bullet) { -1 } else { 0 }) }
    if ($spec.fontName) { $paragraph.Font.Name = [string]$spec.fontName }
    if ($spec.fontSize) { $paragraph.Font.Size = [single]$spec.fontSize }
    if ($null -ne $spec.bold) { $paragraph.Font.Bold = $(if ([bool]$spec.bold) { -1 } else { 0 }) }
    if ($null -ne $spec.italic) { $paragraph.Font.Italic = $(if ([bool]$spec.italic) { -1 } else { 0 }) }
    if ($spec.color) { $paragraph.Font.Color.RGB = Color-Value ([string]$spec.color) }
  }
  return $items.Count
}

function Apply-PowerPointOperation($presentation, $op, [bool]$live = $false) {
  switch ([string]$op.op) {
    'fill_template' { return Fill-PowerPointTemplate $presentation $op }
    'replace_text' {
      $count = 0
      foreach ($slide in @($presentation.Slides)) {
        foreach ($shape in @($slide.Shapes)) {
          try {
            if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
              $before = [string]$shape.TextFrame.TextRange.Text
              $after = $before.Replace([string]$op.find, [string]$op.replace)
              if ($after -ne $before) { $shape.TextFrame.TextRange.Text = $after; $count++ }
            }
          } catch {}
        }
      }
      return [ordered]@{ op = 'replace_text'; changed = $count -gt 0; shapes = $count }
    }
    'set_text' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      $shape.TextFrame.TextRange.Text = [string]$op.text
      return [ordered]@{ op = 'set_text'; changed = $true }
    }
    'add_slide' {
      $index = if ($op.index) { [int]$op.index } else { $presentation.Slides.Count + 1 }
      $layout = PowerPoint-Layout $presentation $op.layout
      $slide = $presentation.Slides.AddSlide($index, $layout.Layout)
      return [ordered]@{ op = 'add_slide'; changed = $true; slide = [int]$slide.SlideIndex; layout = [int]$layout.Index; layoutName = [string]$layout.Layout.Name }
    }
    'delete_slide' {
      (Ppt-Slide $presentation $op).Delete()
      return [ordered]@{ op = 'delete_slide'; changed = $true }
    }
    'move_slide' {
      $presentation.Slides.Item([int]$op.slide).MoveTo([int]$op.index)
      return [ordered]@{ op = 'move_slide'; changed = $true }
    }
    'delete_shape' {
      (Ppt-Slide $presentation $op).Shapes.Item([int]$op.shape).Delete()
      return [ordered]@{ op = 'delete_shape'; changed = $true }
    }
    'add_textbox' {
      $slide = Ppt-Slide $presentation $op
      $left = [single](Operation-Property $op 'left' 72)
      $top = [single](Operation-Property $op 'top' 72)
      $width = [single](Operation-Property $op 'width' 360)
      $height = [single](Operation-Property $op 'height' 72)
      $shape = $slide.Shapes.AddTextbox(1, $left, $top, $width, $height)
      try { $shape.TextFrame.AutoSize = 0 } catch {}
      try { $shape.TextFrame2.AutoSize = 0 } catch {}
      $paragraphs = $op.PSObject.Properties['paragraphs']
      if ($null -ne $paragraphs -and $null -ne $paragraphs.Value -and @($paragraphs.Value).Count -gt 0) {
        $null = Set-PowerPointParagraphs $shape $paragraphs.Value
      } else {
        $shape.TextFrame.TextRange.Text = [string]$op.text
      }
      $shape.Left = $left
      $shape.Top = $top
      $shape.Width = $width
      $shape.Height = $height
      $fontSize = Operation-Property $op 'fontSize' $null
      $fontName = Operation-Property $op 'fontName' $null
      $color = Operation-Property $op 'color' $null
      if ($null -ne $fontSize) { $shape.TextFrame.TextRange.Font.Size = [single]$fontSize }
      if ($null -ne $fontName) { $shape.TextFrame.TextRange.Font.Name = [string]$fontName }
      if ($null -ne $color) { $shape.TextFrame.TextRange.Font.Color.RGB = Color-Value ([string]$color) }
      $props = $op.properties
      if ($null -ne $props.bold) { $shape.TextFrame.TextRange.Font.Bold = $(if ([bool]$props.bold) { -1 } else { 0 }) }
      if ($null -ne $props.italic) { $shape.TextFrame.TextRange.Font.Italic = $(if ([bool]$props.italic) { -1 } else { 0 }) }
      if ($props.alignment) {
        $shape.TextFrame.TextRange.ParagraphFormat.Alignment = switch ([string]$props.alignment) {
          'center' { 2 }
          'right' { 3 }
          'justify' { 4 }
          default { 1 }
        }
      }
      if ($props.verticalAlignment) {
        $shape.TextFrame.VerticalAnchor = switch ([string]$props.verticalAlignment) {
          'middle' { 3 }
          'bottom' { 4 }
          default { 1 }
        }
      }
      if ($null -ne $props.marginLeft) { $shape.TextFrame.MarginLeft = [single]$props.marginLeft }
      if ($null -ne $props.marginTop) { $shape.TextFrame.MarginTop = [single]$props.marginTop }
      if ($null -ne $props.marginRight) { $shape.TextFrame.MarginRight = [single]$props.marginRight }
      if ($null -ne $props.marginBottom) { $shape.TextFrame.MarginBottom = [single]$props.marginBottom }
      return [ordered]@{ op = 'add_textbox'; changed = $true; shape = [string]$shape.Name }
    }
    'add_shape' {
      $slide = Ppt-Slide $presentation $op
      $shapeTypes = @{
        rectangle = 1
        rounded_rectangle = 5
        oval = 9
        diamond = 4
        right_arrow = 33
        chevron = 52
      }
      $kind = ([string]$op.shapeType).ToLowerInvariant()
      $shapeType = if ($shapeTypes.ContainsKey($kind)) { [int]$shapeTypes[$kind] } elseif ($op.shapeType -as [int]) { [int]$op.shapeType } else { 1 }
      $left = [single](Operation-Property $op 'left' 72)
      $top = [single](Operation-Property $op 'top' 72)
      $width = [single](Operation-Property $op 'width' 180)
      $height = [single](Operation-Property $op 'height' 90)
      $shape = $slide.Shapes.AddShape($shapeType, $left, $top, $width, $height)
      $fillColor = Operation-Property $op 'fillColor' $null
      $lineColor = Operation-Property $op 'lineColor' $null
      if ($fillColor) { $shape.Fill.Visible = $true; $shape.Fill.ForeColor.RGB = Color-Value ([string]$fillColor) }
      if ($lineColor) { $shape.Line.Visible = $true; $shape.Line.ForeColor.RGB = Color-Value ([string]$lineColor) }
      $paragraphs = $op.PSObject.Properties['paragraphs']
      if ($null -ne $paragraphs -and $null -ne $paragraphs.Value -and @($paragraphs.Value).Count -gt 0) {
        $null = Set-PowerPointParagraphs $shape $paragraphs.Value
      } elseif ($null -ne $op.text) {
        $shape.TextFrame.TextRange.Text = [string]$op.text
      }
      return [ordered]@{ op = 'add_shape'; changed = $true; shape = [string]$shape.Name; shapeType = $shapeType }
    }
    'add_table' {
      $slide = Ppt-Slide $presentation $op
      $values = @($op.values)
      $rows = if ($op.rows) { [int]$op.rows } else { [Math]::Max(1, $values.Count) }
      $columns = if ($op.columns) { [int]$op.columns } elseif ($values.Count -gt 0) { [Math]::Max(1, @($values[0]).Count) } else { 1 }
      $left = [single](Operation-Property $op 'left' 72)
      $top = [single](Operation-Property $op 'top' 72)
      $width = [single](Operation-Property $op 'width' 480)
      $height = [single](Operation-Property $op 'height' 180)
      $shape = $slide.Shapes.AddTable($rows, $columns, $left, $top, $width, $height)
      if ($op.properties.headerRowHeight) { $shape.Table.Rows.Item(1).Height = [single]$op.properties.headerRowHeight }
      if ($op.properties.bodyRowHeight) {
        for ($row = 2; $row -le $rows; $row++) { $shape.Table.Rows.Item($row).Height = [single]$op.properties.bodyRowHeight }
      }
      for ($row = 1; $row -le $rows; $row++) {
        for ($column = 1; $column -le $columns; $column++) {
          $value = if ($row -le $values.Count -and $column -le @($values[$row - 1]).Count) { $values[$row - 1][$column - 1] } else { '' }
          $cell = $shape.Table.Cell($row, $column).Shape
          $cell.TextFrame.TextRange.Text = [string]$value
          $props = $op.properties
          if ($props.fontName) { $cell.TextFrame.TextRange.Font.Name = [string]$props.fontName }
          if ($props.fontSize) { $cell.TextFrame.TextRange.Font.Size = [single]$props.fontSize }
          if ($props.color) { $cell.TextFrame.TextRange.Font.Color.RGB = Color-Value ([string]$props.color) }
          if ($row -eq 1) {
            if ($props.headerFillColor) { $cell.Fill.ForeColor.RGB = Color-Value ([string]$props.headerFillColor) }
            if ($props.headerColor) { $cell.TextFrame.TextRange.Font.Color.RGB = Color-Value ([string]$props.headerColor) }
            $cell.TextFrame.TextRange.Font.Bold = -1
          } elseif ($props.bodyFillColor) {
            $cell.Fill.ForeColor.RGB = Color-Value ([string]$props.bodyFillColor)
          }
        }
      }
      return [ordered]@{ op = 'add_table'; changed = $true; shape = [string]$shape.Name; rows = $rows; columns = $columns }
    }
    'set_table_data' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      if (-not $shape.HasTable) { throw "PowerPoint shape $($op.shape) is not a table" }
      $values = @($op.values)
      $availableRows = [int]$shape.Table.Rows.Count
      $availableColumns = [int]$shape.Table.Columns.Count
      $requestedColumns = 0
      foreach ($rowValues in $values) {
        $requestedColumns = [Math]::Max($requestedColumns, @($rowValues).Count)
      }
      if ($values.Count -gt $availableRows -or $requestedColumns -gt $availableColumns) {
        throw "PowerPoint table shape $($op.shape) is ${availableRows}x${availableColumns}, but received $($values.Count)x${requestedColumns}"
      }
      for ($row = 1; $row -le $availableRows; $row++) {
        for ($column = 1; $column -le $availableColumns; $column++) {
          $value = if ($row -le $values.Count -and $column -le @($values[$row - 1]).Count) { $values[$row - 1][$column - 1] } else { '' }
          $shape.Table.Cell($row, $column).Shape.TextFrame.TextRange.Text = [string]$value
        }
      }
      return [ordered]@{ op = 'set_table_data'; changed = $true; shape = [int]$op.shape; rows = $availableRows; columns = $availableColumns }
    }
    'set_hyperlink' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      $link = $shape.ActionSettings(1).Hyperlink
      $link.Address = [string]$op.address
      $link.SubAddress = [string]$op.subAddress
      return [ordered]@{ op = 'set_hyperlink'; changed = $true; shape = [int]$op.shape; address = [string]$link.Address }
    }
    'z_order' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      $commands = @{ front = 0; back = 1; forward = 2; backward = 3 }
      $command = ([string]$op.command).ToLowerInvariant()
      if (-not $commands.ContainsKey($command)) { throw "Unsupported z-order command: $command" }
      $null = $shape.ZOrder([int]$commands[$command])
      return [ordered]@{ op = 'z_order'; changed = $true; shape = [int]$op.shape; command = $command }
    }
    'align_shapes' {
      $slide = Ppt-Slide $presentation $op
      $commands = @{ left = 0; center = 1; right = 2; top = 3; middle = 4; bottom = 5 }
      $command = ([string]$op.align).ToLowerInvariant()
      if (-not $commands.ContainsKey($command)) { throw "Unsupported shape alignment: $command" }
      $indices = [object[]]@($op.shapes | ForEach-Object { [int]$_ })
      $null = $slide.Shapes.Range($indices).Align([int]$commands[$command], [bool]$op.relativeToSlide)
      return [ordered]@{ op = 'align_shapes'; changed = $true; shapes = @($op.shapes); align = $command }
    }
    'distribute_shapes' {
      $slide = Ppt-Slide $presentation $op
      $commands = @{ horizontal = 0; vertical = 1 }
      $command = ([string]$op.direction).ToLowerInvariant()
      if (-not $commands.ContainsKey($command)) { throw "Unsupported shape distribution: $command" }
      $indices = [object[]]@($op.shapes | ForEach-Object { [int]$_ })
      $null = $slide.Shapes.Range($indices).Distribute([int]$commands[$command], [bool]$op.relativeToSlide)
      return [ordered]@{ op = 'distribute_shapes'; changed = $true; shapes = @($op.shapes); direction = $command }
    }
    'group_shapes' {
      $slide = Ppt-Slide $presentation $op
      $indices = [object[]]@($op.shapes | ForEach-Object { [int]$_ })
      if ($indices.Count -lt 2) { throw 'group_shapes requires at least two shape indexes' }
      $shape = $slide.Shapes.Range($indices).Group()
      return [ordered]@{ op = 'group_shapes'; changed = $true; shape = [int]$shape.ZOrderPosition; name = [string]$shape.Name }
    }
    'ungroup_shape' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      $items = $shape.Ungroup()
      return [ordered]@{ op = 'ungroup_shape'; changed = $true; count = [int]$items.Count }
    }
    'set_notes' {
      $slide = Ppt-Slide $presentation $op
      $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = [string]$op.text
      return [ordered]@{ op = 'set_notes'; changed = $true }
    }
    'add_comment' {
      $slide = Ppt-Slide $presentation $op
      $left = if ($null -ne $op.left) { [single]$op.left } else { [single]20 }
      $top = if ($null -ne $op.top) { [single]$op.top } else { [single]20 }
      $author = if ($op.author) { [string]$op.author } else { 'Mixdog' }
      $initials = if ($op.initials) { [string]$op.initials } else { 'MD' }
      $comment = $slide.Comments.Add($left, $top, $author, $initials, [string]$op.text)
      return [ordered]@{ op = 'add_comment'; changed = $true; slide = [int]$slide.SlideIndex; comment = [int]$comment.Index }
    }
    'delete_comment' {
      $slide = Ppt-Slide $presentation $op
      $index = [int]$op.comment
      if ($index -lt 1 -or $index -gt $slide.Comments.Count) { throw "PowerPoint comment index out of range: $index" }
      $slide.Comments.Item($index).Delete()
      return [ordered]@{ op = 'delete_comment'; changed = $true; slide = [int]$slide.SlideIndex; comment = $index }
    }
    'add_provenance' {
      $slide = Ppt-Slide $presentation $op
      $text = Provenance-Text $op
      $range = $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange
      $existing = [string]$range.Text
      if ($existing -notmatch [regex]::Escape($text)) {
        $range.Text = $(if ([string]::IsNullOrWhiteSpace($existing)) { $text } else { "$($existing.TrimEnd())`r$text" })
      }
      $target = if ($op.shape) { "/slide[$([int]$slide.SlideIndex)]/shape[$([int]$op.shape)]" } else { "/slide[$([int]$slide.SlideIndex)]" }
      return [ordered]@{ op = 'add_provenance'; changed = $true; target = $target; citation = $text }
    }
    'set_footer' {
      $slide = Ppt-Slide $presentation $op
      $slide.HeadersFooters.Footer.Visible = -1
      $slide.HeadersFooters.Footer.Text = [string]$op.text
      return [ordered]@{ op = 'set_footer'; changed = $true }
    }
    'set_slide_number' {
      $slide = Ppt-Slide $presentation $op
      $slide.HeadersFooters.SlideNumber.Visible = $(if ([bool]$op.visible) { -1 } else { 0 })
      return [ordered]@{ op = 'set_slide_number'; changed = $true; visible = [bool]$op.visible }
    }
    'add_image' {
      $slide = Ppt-Slide $presentation $op
      $left = if ($op.left) { [single]$op.left } else { [single]72 }
      $top = if ($op.top) { [single]$op.top } else { [single]72 }
      $width = if ($op.width) { [single]$op.width } else { [single]320 }
      $height = if ($op.height) { [single]$op.height } else { [single]240 }
      $null = $slide.Shapes.AddPicture([string]$op.path, $false, $true, $left, $top, $width, $height)
      return [ordered]@{ op = 'add_image'; changed = $true }
    }
    'replace_image' {
      $slide = Ppt-Slide $presentation $op
      $old = $slide.Shapes.Item([int]$op.shape)
      $left = [single]$old.Left; $top = [single]$old.Top; $width = [single]$old.Width; $height = [single]$old.Height
      $old.Delete()
      $shape = $slide.Shapes.AddPicture([string]$op.path, $false, $true, $left, $top, $width, $height)
      return [ordered]@{ op = 'replace_image'; changed = $true; shape = [string]$shape.Name }
    }
    'crop_image' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      if ($null -ne $op.left) { $shape.PictureFormat.CropLeft = [single]$op.left }
      if ($null -ne $op.right) { $shape.PictureFormat.CropRight = [single]$op.right }
      if ($null -ne $op.top) { $shape.PictureFormat.CropTop = [single]$op.top }
      if ($null -ne $op.bottom) { $shape.PictureFormat.CropBottom = [single]$op.bottom }
      return [ordered]@{ op = 'crop_image'; changed = $true; shape = [int]$op.shape }
    }
    'add_media' {
      $slide = Ppt-Slide $presentation $op
      $left = if ($null -ne $op.left) { [single]$op.left } else { [single]40 }
      $top = if ($null -ne $op.top) { [single]$op.top } else { [single]40 }
      $width = if ($op.width) { [single]$op.width } else { [single]320 }
      $height = if ($op.height) { [single]$op.height } else { [single]180 }
      $link = [bool]$op.link
      $embed = if ($null -ne $op.embed) { [bool]$op.embed } else { -not $link }
      $shape = $slide.Shapes.AddMediaObject2([string]$op.path, $(if ($link) { -1 } else { 0 }), $(if ($embed) { -1 } else { 0 }), $left, $top, $width, $height)
      return [ordered]@{ op = 'add_media'; changed = $true; shape = [int]$shape.ZOrderPosition; media = [string]$op.path; embedded = $embed }
    }
    'apply_theme' {
      if (-not $op.path) { throw 'apply_theme requires path' }
      $presentation.ApplyTheme([string]$op.path)
      return [ordered]@{ op = 'apply_theme'; changed = $true; path = [string]$op.path }
    }
    'set_transition' {
      $slide = Ppt-Slide $presentation $op
      $effects = @{ none = 0; fade = 3849; push = 3850; wipe = 3844; split = 3586; reveal = 3847; random = 513 }
      $kind = ([string]$op.effect).ToLowerInvariant()
      if ($kind) { $slide.SlideShowTransition.EntryEffect = $(if ($effects.ContainsKey($kind)) { [int]$effects[$kind] } elseif ($op.effect -as [int]) { [int]$op.effect } else { throw "Unknown transition effect: $kind" }) }
      if ($null -ne $op.advanceOnTime) { $slide.SlideShowTransition.AdvanceOnTime = [bool]$op.advanceOnTime }
      if ($null -ne $op.advanceTime) { $slide.SlideShowTransition.AdvanceTime = [single]$op.advanceTime }
      if ($null -ne $op.duration) {
        $slide.SlideShowTransition.Speed = if ([single]$op.duration -le 0.5) { 1 } elseif ([single]$op.duration -le 1.5) { 2 } else { 3 }
      }
      return [ordered]@{ op = 'set_transition'; changed = $true; slide = [int]$slide.SlideIndex; effect = [int]$slide.SlideShowTransition.EntryEffect }
    }
    'add_animation' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      $effects = @{ appear = 1; fly = 2; fade = 10; wipe = 22; zoom = 23; float = 30 }
      $triggers = @{ onclick = 1; withprevious = 2; afterprevious = 3 }
      $effectKey = ([string]$op.effect).Replace(' ', '').ToLowerInvariant()
      $triggerKey = ([string]$op.trigger).Replace(' ', '').ToLowerInvariant()
      $effectType = if ($effects.ContainsKey($effectKey)) { [int]$effects[$effectKey] } elseif ($op.effect -as [int]) { [int]$op.effect } else { 10 }
      $triggerType = if ($triggers.ContainsKey($triggerKey)) { [int]$triggers[$triggerKey] } elseif ($op.trigger -as [int]) { [int]$op.trigger } else { 1 }
      $effect = $slide.TimeLine.MainSequence.AddEffect($shape, $effectType, 0, $triggerType)
      if ($null -ne $op.duration) { $effect.Timing.Duration = [single]$op.duration }
      if ($null -ne $op.delay) { $effect.Timing.TriggerDelayTime = [single]$op.delay }
      return [ordered]@{ op = 'add_animation'; changed = $true; slide = [int]$slide.SlideIndex; shape = [int]$op.shape; effect = $effectType }
    }
    'set_shape' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      $props = $op.properties
      if ($null -ne $props.left) { $shape.Left = [single]$props.left }
      if ($null -ne $props.top) { $shape.Top = [single]$props.top }
      if ($props.width) { $shape.Width = [single]$props.width }
      if ($props.height) { $shape.Height = [single]$props.height }
      if ($null -ne $props.rotation) { $shape.Rotation = [single]$props.rotation }
      if ($props.fillColor) { $shape.Fill.Visible = $true; $shape.Fill.ForeColor.RGB = Color-Value ([string]$props.fillColor) }
      if ($null -ne $props.fillTransparency) { $shape.Fill.Transparency = [single]$props.fillTransparency }
      if ($props.lineColor) { $shape.Line.Visible = $true; $shape.Line.ForeColor.RGB = Color-Value ([string]$props.lineColor) }
      if ($null -ne $props.lineTransparency) { $shape.Line.Transparency = [single]$props.lineTransparency }
      if ($props.shadow) {
        $shape.Shadow.Visible = -1
        if ($props.shadow.color) { $shape.Shadow.ForeColor.RGB = Color-Value ([string]$props.shadow.color) }
        if ($null -ne $props.shadow.transparency) { $shape.Shadow.Transparency = [single]$props.shadow.transparency }
        if ($null -ne $props.shadow.blur) { $shape.Shadow.Blur = [single]$props.shadow.blur }
        if ($null -ne $props.shadow.offsetX) { $shape.Shadow.OffsetX = [single]$props.shadow.offsetX }
        if ($null -ne $props.shadow.offsetY) { $shape.Shadow.OffsetY = [single]$props.shadow.offsetY }
      }
      try {
        if ($null -ne $props.marginLeft) { $shape.TextFrame.MarginLeft = [single]$props.marginLeft }
        if ($null -ne $props.marginTop) { $shape.TextFrame.MarginTop = [single]$props.marginTop }
        if ($null -ne $props.marginRight) { $shape.TextFrame.MarginRight = [single]$props.marginRight }
        if ($null -ne $props.marginBottom) { $shape.TextFrame.MarginBottom = [single]$props.marginBottom }
        if ($null -ne $props.paragraphSpacing) { $shape.TextFrame.TextRange.ParagraphFormat.SpaceAfter = [single]$props.paragraphSpacing }
        $font = $shape.TextFrame.TextRange.Font
        if ($props.fontName) { $font.Name = [string]$props.fontName }
        if ($props.fontSize) { $font.Size = [single]$props.fontSize }
        if ($null -ne $props.bold) { $font.Bold = if ($props.bold) { -1 } else { 0 } }
        if ($null -ne $props.italic) { $font.Italic = if ($props.italic) { -1 } else { 0 } }
        if ($props.color) { $font.Color.RGB = Color-Value ([string]$props.color) }
      } catch {}
      return [ordered]@{ op = 'set_shape'; changed = $true; shape = [string]$shape.Name }
    }
    'duplicate_slide' {
      $slides = $presentation.Slides.Item([int]$op.slide).Duplicate()
      $slide = $slides.Item(1)
      if ($op.index) { $slide.MoveTo([int]$op.index) }
      return [ordered]@{ op = 'duplicate_slide'; changed = $true; slide = [int]$slide.SlideIndex }
    }
    'import_slides' {
      if ([int]$presentation.Slides.Count -eq 0) {
        throw 'import_slides cannot target a zero-slide presentation; import as the first batch of a new background deck'
      }
      $after = if ($null -ne $op.after) { [int]$op.after } else { [int]$presentation.Slides.Count }
      $inserted = 0
      $sourcePath = [string]$op.path
      $openPresentations = $presentation.Application.Presentations
      for ($candidateIndex = 1; $candidateIndex -le [int]$openPresentations.Count; $candidateIndex++) {
        $candidate = $openPresentations.Item($candidateIndex)
        try {
          if (
            -not [object]::ReferenceEquals($candidate, $presentation) -and
            [string]::Equals(
              [System.IO.Path]::GetFullPath([string]$candidate.FullName),
              [System.IO.Path]::GetFullPath($sourcePath),
              [System.StringComparison]::OrdinalIgnoreCase
            )
          ) {
            throw 'import_slides requires the saved source deck to be closed before import'
          }
        } catch {
          if ($_.Exception.Message -match '^import_slides requires') { throw }
        }
      }
      if ($op.slides) {
        foreach ($sourceSlide in @($op.slides)) {
          $count = [int]$presentation.Slides.InsertFromFile($sourcePath, $after + $inserted, [int]$sourceSlide, [int]$sourceSlide)
          $inserted += $count
        }
      } else {
        $inserted = [int]$presentation.Slides.InsertFromFile($sourcePath, $after)
      }
      return [ordered]@{ op = 'import_slides'; changed = $inserted -gt 0; count = $inserted; after = $after; source = $sourcePath }
    }
    'keep_slides' {
      $keep = @{}
      foreach ($slideNumber in @($op.slides)) { $keep[[int]$slideNumber] = $true }
      $removed = 0
      for ($index = $presentation.Slides.Count; $index -ge 1; $index--) {
        if (-not $keep.ContainsKey($index)) { $presentation.Slides.Item($index).Delete(); $removed++ }
      }
      return [ordered]@{ op = 'keep_slides'; changed = $removed -gt 0; removed = $removed; remaining = [int]$presentation.Slides.Count }
    }
    'set_slide_background' {
      $slide = Ppt-Slide $presentation $op
      $slide.FollowMasterBackground = $false
      $slide.Background.Fill.Visible = $true
      $slide.Background.Fill.ForeColor.RGB = Color-Value ([string]$op.color)
      return [ordered]@{ op = 'set_slide_background'; changed = $true }
    }
    'set_layout' {
      $slide = Ppt-Slide $presentation $op
      $layout = PowerPoint-Layout $presentation $op.layout
      $slide.CustomLayout = $layout.Layout
      return [ordered]@{ op = 'set_layout'; changed = $true; layout = [int]$layout.Index; layoutName = [string]$layout.Layout.Name }
    }
    'add_chart' {
      $slide = Ppt-Slide $presentation $op
      if ($presentation.Windows.Count -eq 0) {
        $window = $presentation.NewWindow()
        try { $window.WindowState = 2 } catch {}
      }
      $chartTypes = @{ column = 51; bar = 57; line = 4; pie = 5; area = 1; scatter = -4169 }
      $kind = ([string]$op.chartType).ToLowerInvariant()
      $chartType = if ($kind -and $chartTypes.ContainsKey($kind)) { [int]$chartTypes[$kind] } elseif ($op.chartType -as [int]) { [int]$op.chartType } else { 51 }
      $left = if ($null -ne $op.left) { [single]$op.left } else { [single]72 }
      $top = if ($null -ne $op.top) { [single]$op.top } else { [single]72 }
      $width = if ($op.width) { [single]$op.width } else { [single]480 }
      $height = if ($op.height) { [single]$op.height } else { [single]280 }
      $shape = $slide.Shapes.AddChart2(-1, $chartType, $left, $top, $width, $height)
      $chartResult = $null
      $seriesProperty = $op.PSObject.Properties['series']
      if ($null -ne $seriesProperty -and $null -ne $seriesProperty.Value) {
        $chartResult = Set-PowerPointChartData $shape.Chart $op.categories $seriesProperty.Value
      }
      if ($op.title) { $shape.Chart.HasTitle = $true; $shape.Chart.ChartTitle.Text = [string]$op.title }
      return [ordered]@{
        op = 'add_chart'
        changed = $true
        shape = [string]$shape.Name
        categories = $(if ($null -ne $chartResult) { [int]$chartResult.categories } else { 0 })
        series = $(if ($null -ne $chartResult) { [int]$chartResult.series } else { [int]$shape.Chart.SeriesCollection().Count })
      }
    }
    'set_chart_data' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
      $chart = $shape.Chart
      $chartResult = Set-PowerPointChartData $chart $op.categories $op.series
      if ($op.title) { $chart.HasTitle = $true; $chart.ChartTitle.Text = [string]$op.title }
      return [ordered]@{ op = 'set_chart_data'; changed = $true; shape = [int]$op.shape; categories = [int]$chartResult.categories; series = [int]$chartResult.series }
    }
    'set_chart_series' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
      $series = $shape.Chart.SeriesCollection().Item([int]$op.series)
      if ($null -ne $op.name) { $series.Name = [string]$op.name }
      if ($null -ne $op.categories) { $series.XValues = [object[]]@($op.categories) }
      if ($null -ne $op.values) { $series.Values = [object[]]@($op.values) }
      if ($null -ne $op.secondaryAxis) { $series.AxisGroup = $(if ([bool]$op.secondaryAxis) { 2 } else { 1 }) }
      if ($null -ne $op.chartType) {
        $chartTypes = @{ column = 51; bar = 57; line = 4; pie = 5; area = 1; scatter = -4169 }
        $kind = ([string]$op.chartType).ToLowerInvariant()
        $series.ChartType = $(if ($chartTypes.ContainsKey($kind)) { [int]$chartTypes[$kind] } elseif ($op.chartType -as [int]) { [int]$op.chartType } else { throw "Unknown chart type: $kind" })
      }
      return [ordered]@{ op = 'set_chart_series'; changed = $true; shape = [int]$op.shape; series = [int]$op.series }
    }
    'set_chart_axis' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
      $axisType = if ([string]$op.axis -eq 'category') { 1 } else { 2 }
      $axis = $shape.Chart.Axes($axisType, $(if ([bool]$op.secondaryAxis) { 2 } else { 1 }))
      if ($null -ne $op.title) { $axis.HasTitle = $true; $axis.AxisTitle.Text = [string]$op.title }
      if ($null -ne $op.minimum) { $axis.MinimumScale = [double]$op.minimum }
      if ($null -ne $op.maximum) { $axis.MaximumScale = [double]$op.maximum }
      if ($null -ne $op.majorUnit) { $axis.MajorUnit = [double]$op.majorUnit }
      if ($op.numberFormat) { $axis.TickLabels.NumberFormat = [string]$op.numberFormat }
      return [ordered]@{ op = 'set_chart_axis'; changed = $true; shape = [int]$op.shape; axis = [string]$op.axis }
    }
    'set_chart_trendline' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
      $seriesIndex = if ($op.series) { [int]$op.series } else { 1 }
      $types = @{ exponential = 5; linear = -4132; logarithmic = -4133; movingaverage = 6; polynomial = 3; power = 4 }
      $kind = ([string]$op.type).Replace(' ', '').ToLowerInvariant()
      $type = if ($types.ContainsKey($kind)) { [int]$types[$kind] } elseif ($op.type -as [int]) { [int]$op.type } else { -4132 }
      $trendline = $shape.Chart.SeriesCollection().Item($seriesIndex).Trendlines().Add($type)
      if ($null -ne $op.displayEquation) { $trendline.DisplayEquation = [bool]$op.displayEquation }
      if ($null -ne $op.displayRSquared) { $trendline.DisplayRSquared = [bool]$op.displayRSquared }
      return [ordered]@{ op = 'set_chart_trendline'; changed = $true; shape = [int]$op.shape; series = $seriesIndex; type = $type }
    }
    'set_chart_error_bars' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
      $seriesIndex = if ($op.series) { [int]$op.series } else { 1 }
      $series = $shape.Chart.SeriesCollection().Item($seriesIndex)
      $direction = if ([string]$op.direction -eq 'x') { -4168 } else { 1 }
      $series.ErrorBar($direction, 1, 1, [double]$(if ($null -ne $op.amount) { $op.amount } else { 1 }))
      try { $series.ErrorBars.EndStyle = $(if ($op.endStyle -eq 'none') { 0 } else { 1 }) } catch {}
      return [ordered]@{ op = 'set_chart_error_bars'; changed = $true; shape = [int]$op.shape; series = $seriesIndex }
    }
    'set_chart_data_labels' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
      $series = $shape.Chart.SeriesCollection().Item([int]$op.series)
      $null = $series.ApplyDataLabels()
      $labels = $series.DataLabels()
      if ($null -ne $op.showValue) { $labels.ShowValue = [bool]$op.showValue }
      if ($null -ne $op.showCategoryName) { $labels.ShowCategoryName = [bool]$op.showCategoryName }
      if ($op.numberFormat) { $labels.NumberFormat = [string]$op.numberFormat }
      if ($null -ne $op.position) { $labels.Position = [int]$op.position }
      return [ordered]@{ op = 'set_chart_data_labels'; changed = $true; shape = [int]$op.shape; series = [int]$op.series }
    }
    'fit_text' {
      $slide = Ppt-Slide $presentation $op
      $shape = $slide.Shapes.Item([int]$op.shape)
      $minimum = if ($op.minFontSize) { [single]$op.minFontSize } else { [single]8 }
      try { $shape.TextFrame.AutoSize = 0 } catch {}
      try { $shape.TextFrame2.AutoSize = 0 } catch {}
      $maximumWidth = [single]$presentation.PageSetup.SlideWidth - [single]$shape.Left
      $maximumHeight = [single]$presentation.PageSetup.SlideHeight - [single]$shape.Top
      if ($shape.Width -gt $maximumWidth) { $shape.Width = $maximumWidth }
      if ($shape.Height -gt $maximumHeight) { $shape.Height = $maximumHeight }
      $font = $shape.TextFrame.TextRange.Font
      while ($font.Size -gt $minimum -and (
        [single]$shape.TextFrame2.TextRange.BoundWidth -gt ([single]$shape.Width + 1) -or
        [single]$shape.TextFrame2.TextRange.BoundHeight -gt ([single]$shape.Height + 1)
      )) {
        $font.Size = [single]$font.Size - 1
      }
      return [ordered]@{ op = 'fit_text'; changed = $true; shape = [int]$op.shape; fontSize = [single]$font.Size }
    }
    default { throw "Unsupported PPTX operation: $($op.op)" }
  }
}

function Apply-Operations($document, [string]$format, $operations, [bool]$live, [bool]$requireChanges = $true) {
  $results = @()
  $undoUnits = 0
  $wordUndoRecord = $null
  $wordRecordStarted = $false
  $failure = $null
  $beforeFingerprint = ''
  if ($live -and @('docx', 'pptx') -contains $format) {
    $beforeFingerprint = Snapshot-Fingerprint (Snapshot-Document $document $format ([ordered]@{}))
  }
  if ($live -and $format -eq 'docx') {
    try {
      $wordUndoRecord = $document.Application.UndoRecord
      $wordUndoRecord.StartCustomRecord('Mixdog Office transaction')
      $wordRecordStarted = $true
    } catch {}
  }
  try {
    foreach ($op in @($operations)) {
      if ($live -and $format -eq 'pptx') {
        try { $document.Application.StartNewUndoEntry() } catch {}
      }
      $emitted = @(switch ($format) {
        'docx' { Apply-WordOperation $document $op }
        'xlsx' { Apply-ExcelOperation $document $op }
        'pptx' { Apply-PowerPointOperation $document $op $live }
      })
      $structured = @($emitted | Where-Object { $_ -is [System.Collections.IDictionary] } | Select-Object -Last 1)
      if ($structured.Count -ne 1) { throw "$($op.op) returned no structured operation result" }
      $entry = $structured[0]
      if ($requireChanges -and -not [bool]$op.allowNoChange -and $entry.Contains('changed') -and -not [bool]$entry.changed) {
        throw "$($op.op) produced no change"
      }
      $results += $entry
      if ($live -and $format -eq 'pptx') { $undoUnits++ }
    }
  } catch {
    $line = [int]$_.InvocationInfo.ScriptLineNumber
    $failure = "$($op.op) failed at office-com-host.ps1:$line`: $($_.Exception.Message)"
  } finally {
    if ($wordRecordStarted) {
      try { $wordUndoRecord.EndCustomRecord() } catch {}
    }
  }
  if ($failure) {
    if ($live -and $format -eq 'docx' -and $wordRecordStarted) {
      try { $null = $document.Undo(1) } catch {}
    } elseif ($live -and $format -eq 'pptx') {
      $attempts = 0
      $maximumAttempts = @($operations).Count + 5
      while ($attempts -lt $maximumAttempts) {
        $currentFingerprint = Snapshot-Fingerprint (Snapshot-Document $document $format ([ordered]@{}))
        if ($currentFingerprint -eq $beforeFingerprint) { break }
        try { $document.Application.CommandBars.ExecuteMso('Undo') } catch { break }
        $attempts++
      }
    }
    throw $failure
  }
  if ($live -and $format -eq 'docx' -and @($operations).Count -gt 0) { $undoUnits = 1 }
  if ($live -and $format -eq 'xlsx' -and @($operations).Count -gt 0) { $undoUnits = 1 }
  return [ordered]@{ results = $results; undoUnits = $undoUnits }
}

function Office-Issue([string]$severity, [string]$code, [string]$path, [string]$message) {
  return [ordered]@{ severity = $severity; code = $code; path = $path; message = $message }
}

function Installed-OfficeFonts {
  $fonts = @{}
  try {
    Add-Type -AssemblyName System.Drawing
    $collection = [System.Drawing.Text.InstalledFontCollection]::new()
    foreach ($family in @($collection.Families)) { $fonts[[string]$family.Name] = $true }
    $collection.Dispose()
  } catch {}
  return $fonts
}

function Missing-FontIssue($fonts, [string]$name, [string]$path) {
  if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('+') -or $fonts.ContainsKey($name)) { return $null }
  return Office-Issue 'warning' 'missing_font' $path "Font is not installed: $name"
}

function Excel-MatrixValue($matrix, [int]$row, [int]$column) {
  if ($matrix -is [Array] -and $matrix.Rank -eq 2) {
    return $matrix.GetValue(
      $matrix.GetLowerBound(0) + $row - 1,
      $matrix.GetLowerBound(1) + $column - 1
    )
  }
  if ($row -eq 1 -and $column -eq 1) { return $matrix }
  return $null
}

function Excel-ColumnLetters([int]$column) {
  $letters = ''
  while ($column -gt 0) {
    $column--
    $letters = [char](65 + ($column % 26)) + $letters
    $column = [Math]::Floor($column / 26)
  }
  return $letters
}

function Excel-RangeCellAddress($range, [int]$row, [int]$column) {
  $absoluteRow = [int]$range.Row + $row - 1
  $absoluteColumn = [int]$range.Column + $column - 1
  return "$(Excel-ColumnLetters $absoluteColumn)$absoluteRow"
}

function Issues-Word($doc) {
  $issues = @()
  $fonts = Installed-OfficeFonts
  if ($doc.Revisions.Count -gt 0) { $issues += Office-Issue 'info' 'unresolved_revisions' '/body' "$($doc.Revisions.Count) tracked revision(s) remain unresolved." }
  if ($doc.Comments.Count -gt 0) { $issues += Office-Issue 'info' 'unresolved_comments' '/body' "$($doc.Comments.Count) comment(s) remain in the document." }
  $fieldIndex = 0
  foreach ($field in @($doc.Fields)) {
    $fieldIndex++
    try {
      $text = ([string]$field.Result.Text).Trim()
      if ($text -match 'Error!|Reference source not found') { $issues += Office-Issue 'error' 'field_error' "/body/field[$fieldIndex]" $text }
    } catch {}
  }
  for ($paragraphIndex = 1; $paragraphIndex -le $doc.Paragraphs.Count; $paragraphIndex++) {
    try {
      $paragraph = $doc.Paragraphs.Item($paragraphIndex)
      $path = "/body/p[$paragraphIndex]"
      $fontIssue = Missing-FontIssue $fonts ([string]$paragraph.Range.Font.Name) $path
      if ($fontIssue) { $issues += $fontIssue }
      $text = ([string]$paragraph.Range.Text).TrimEnd("`r", "`a")
      $fontSize = [single]$paragraph.Range.Font.Size
      if ($text.Length -gt 180 -and $fontSize -ge 18) {
        $issues += Office-Issue 'warning' 'oversized_heading_text' $path 'A long paragraph uses heading-sized text and is likely mis-styled.'
      }
    } catch {}
  }
  for ($tableIndex = 1; $tableIndex -le $doc.Tables.Count; $tableIndex++) {
    try {
      $table = $doc.Tables.Item($tableIndex)
      $width = 0
      foreach ($column in @($table.Columns)) { $width += [double]$column.Width }
      $page = $table.Range.Sections.Item(1).PageSetup
      $available = [double]$page.PageWidth - [double]$page.LeftMargin - [double]$page.RightMargin
      if ($width -gt ($available + 1)) {
        $issues += Office-Issue 'warning' 'table_width' "/body/tbl[$tableIndex]" "Table width $([Math]::Round($width, 1))pt exceeds available page width $([Math]::Round($available, 1))pt."
      }
    } catch {}
  }
  return $issues
}

function Add-CappedOfficeIssue($issues, [ref]$omitted, $issue, [int]$limit = 500) {
  if ($issues.Count -lt $limit) {
    [void]$issues.Add($issue)
  } else {
    $omitted.Value = [int]$omitted.Value + 1
  }
}

function Inspect-ExcelFinancialRange($sheet, $used, $fonts, $commentAddresses) {
  $issues = [System.Collections.ArrayList]::new()
  $omitted = 0
  $rowCount = [int]$used.Rows.Count
  $columnCount = [int]$used.Columns.Count
  $totalCells = [int64]$rowCount * [int64]$columnCount
  $targetChunkCells = 20000
  $rowsPerBlock = [Math]::Min(2000, [Math]::Max(1, [Math]::Floor($targetChunkCells / [Math]::Max(1, [Math]::Min($columnCount, $targetChunkCells)))))
  $scannedCells = [int64]0
  $chunks = 0
  $visualProbeCount = 0
  $checksSheet = [string]::Equals([string]$sheet.Name, 'Checks', [System.StringComparison]::OrdinalIgnoreCase)

  for ($rowStart = 1; $rowStart -le $rowCount; $rowStart += $rowsPerBlock) {
    $rowsThisBlock = [Math]::Min($rowsPerBlock, $rowCount - $rowStart + 1)
    $states = @()
    for ($localRow = 1; $localRow -le $rowsThisBlock; $localRow++) {
      $states += [pscustomobject]@{
        FormulaCount = 0
        FirstFormula = [int]::MaxValue
        LastFormula = 0
        Values = [System.Collections.ArrayList]::new()
      }
    }
    $columnsPerBlock = [Math]::Max(1, [Math]::Floor($targetChunkCells / $rowsThisBlock))
    for ($columnStart = 1; $columnStart -le $columnCount; $columnStart += $columnsPerBlock) {
      $columnsThisBlock = [Math]::Min($columnsPerBlock, $columnCount - $columnStart + 1)
      $chunk = $used.Cells.Item($rowStart, $columnStart).Resize($rowsThisBlock, $columnsThisBlock)
      $values = $chunk.Value2
      $formulas = $chunk.FormulaR1C1
      $chunks++
      $scannedCells += [int64]$rowsThisBlock * [int64]$columnsThisBlock
      for ($localRow = 1; $localRow -le $rowsThisBlock; $localRow++) {
        $state = $states[$localRow - 1]
        for ($localColumn = 1; $localColumn -le $columnsThisBlock; $localColumn++) {
          $value = Excel-MatrixValue $values $localRow $localColumn
          $formula = Excel-MatrixValue $formulas $localRow $localColumn
          $hasFormula = [string]$formula -match '^='
          $absoluteRow = [int]$used.Row + $rowStart + $localRow - 2
          $absoluteColumn = [int]$used.Column + $columnStart + $localColumn - 2
          $address = "$(Excel-ColumnLetters $absoluteColumn)$absoluteRow"
          $path = "/sheet[$($sheet.Name)]/cell[$address]"
          if ($hasFormula) {
            $state.FormulaCount++
            $state.FirstFormula = [Math]::Min([int]$state.FirstFormula, $absoluteColumn)
            $state.LastFormula = [Math]::Max([int]$state.LastFormula, $absoluteColumn)
          } elseif ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
            [void]$state.Values.Add([pscustomobject]@{
              Address = $address
              Path = $path
              Column = $absoluteColumn
              Numeric = $value -is [ValueType] -and $value -isnot [bool]
            })
          }
          if ($checksSheet -and $value -is [bool] -and -not [bool]$value) {
            Add-CappedOfficeIssue $issues ([ref]$omitted) (Office-Issue 'error' 'failed_check' $path 'A formula or explicit check on the Checks sheet evaluates to FALSE.')
          }
          if (($null -ne $value -or $hasFormula) -and $visualProbeCount -lt 32) {
            $visualProbeCount++
            $cell = $chunk.Cells.Item($localRow, $localColumn)
            if ([string]$cell.Text -match '^#{3,}$') {
              Add-CappedOfficeIssue $issues ([ref]$omitted) (Office-Issue 'warning' 'cell_overflow' $path 'Displayed value is clipped because the column is too narrow.')
            }
            $fontIssue = Missing-FontIssue $fonts ([string]$cell.Font.Name) $path
            if ($fontIssue) { Add-CappedOfficeIssue $issues ([ref]$omitted) $fontIssue }
          }
        }
      }
    }
    foreach ($state in $states) {
      foreach ($entry in @($state.Values)) {
        if ($entry.Numeric) {
          if (-not $commentAddresses.ContainsKey([string]$entry.Address)) {
            Add-CappedOfficeIssue $issues ([ref]$omitted) (Office-Issue 'warning' 'hardcode_missing_source' ([string]$entry.Path) 'Hardcoded numeric input has no source comment.')
          }
          if ([int]$state.FormulaCount -gt 0) {
            Add-CappedOfficeIssue $issues ([ref]$omitted) (Office-Issue 'warning' 'rogue_hardcode' ([string]$entry.Path) 'Numeric hardcode appears inside a row that otherwise contains formulas.')
          }
        }
        if ([int]$state.FormulaCount -ge 3 -and [int]$entry.Column -gt [int]$state.FirstFormula -and [int]$entry.Column -lt [int]$state.LastFormula) {
          Add-CappedOfficeIssue $issues ([ref]$omitted) (Office-Issue 'warning' 'formula_inconsistency' ([string]$entry.Path) 'A hardcoded value interrupts a row containing three or more formulas.')
        }
      }
    }
  }
  if ($omitted -gt 0) {
    [void]$issues.Add((Office-Issue 'warning' 'audit_issues_truncated' "/sheet[$($sheet.Name)]" "$omitted additional financial-model audit issue(s) were omitted after the 500-issue response cap."))
  }
  return [ordered]@{
    issues = [object[]]$issues.ToArray()
    coverage = [ordered]@{
      sheet = [string]$sheet.Name
      range = [string]$used.Address($false, $false)
      rows = $rowCount
      columns = $columnCount
      totalCells = $totalCells
      scannedCells = $scannedCells
      chunks = $chunks
      complete = $scannedCells -eq $totalCells
    }
  }
}

function Issues-Excel($book, $payload) {
  $issues = @()
  $coverage = @()
  $fonts = Installed-OfficeFonts
  $financialAudit = $payload.auditProfile -eq 'financial-model'
  if ($financialAudit) {
    $hasChecks = $false
    foreach ($candidate in @($book.Worksheets)) {
      if ([string]::Equals([string]$candidate.Name, 'Checks', [System.StringComparison]::OrdinalIgnoreCase)) { $hasChecks = $true; break }
    }
    if (-not $hasChecks) { $issues += Office-Issue 'warning' 'missing_checks_sheet' '/' 'Financial-model audit expects a Checks sheet with explicit tie-out formulas.' }
  }
  foreach ($sheet in @($book.Worksheets)) {
    if ($payload.sheet -and -not [string]::Equals([string]$payload.sheet, [string]$sheet.Name, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $used = $sheet.UsedRange
    if ($payload.range) { $used = $sheet.Range([string]$payload.range) }
    if ($financialAudit) {
      $commentAddresses = @{}
      try {
        $commentCells = $used.SpecialCells(-4144)
        foreach ($commentCell in @($commentCells.Cells)) {
          $commentAddresses[[string]$commentCell.Address($false, $false)] = $true
        }
      } catch {}
      $inspection = Inspect-ExcelFinancialRange $sheet $used $fonts $commentAddresses
      $issues += @($inspection.issues)
      $coverage += $inspection.coverage
    } else {
      $columns = [Math]::Min([int]$used.Columns.Count, 100)
      $sampleRows = [Math]::Min([int]$used.Rows.Count, [Math]::Max(1, [Math]::Floor(500 / [Math]::Max(1, $columns))))
      $sample = $used.Resize($sampleRows, $columns)
      $sampleValues = $sample.Value2
      $sampleFormulas = $sample.FormulaR1C1
      $visualProbeCount = 0
      for ($r = 1; $r -le $sampleRows; $r++) {
        for ($c = 1; $c -le $columns; $c++) {
          $value = Excel-MatrixValue $sampleValues $r $c
          $formula = Excel-MatrixValue $sampleFormulas $r $c
          if (($null -ne $value -or [string]$formula -match '^=') -and $visualProbeCount -lt 32) {
            $visualProbeCount++
            $cell = $sample.Cells.Item($r, $c)
            $path = "/sheet[$($sheet.Name)]/cell[$(Excel-RangeCellAddress $used $r $c)]"
            if ([string]$cell.Text -match '^#{3,}$') { $issues += Office-Issue 'warning' 'cell_overflow' $path 'Displayed value is clipped because the column is too narrow.' }
            $fontIssue = Missing-FontIssue $fonts ([string]$cell.Font.Name) $path
            if ($fontIssue) { $issues += $fontIssue }
          }
        }
      }
      $coverage += [ordered]@{
        sheet = [string]$sheet.Name
        range = [string]$used.Address($false, $false)
        rows = [int]$used.Rows.Count
        columns = [int]$used.Columns.Count
        totalCells = [int64]$used.Rows.Count * [int64]$used.Columns.Count
        scannedCells = [int64]$sampleRows * [int64]$columns
        complete = [int64]$sampleRows * [int64]$columns -eq [int64]$used.Rows.Count * [int64]$used.Columns.Count
      }
      try {
        $formulaMatrix = $used.FormulaR1C1
        $inconsistencies = 0
        if ($formulaMatrix -is [Array] -and $formulaMatrix.Rank -eq 2) {
          $rowLower = $formulaMatrix.GetLowerBound(0)
          $rowUpper = $formulaMatrix.GetUpperBound(0)
          $columnLower = $formulaMatrix.GetLowerBound(1)
          $columnUpper = $formulaMatrix.GetUpperBound(1)
          for ($matrixRow = $rowLower; $matrixRow -le $rowUpper -and $inconsistencies -lt 100; $matrixRow++) {
            $formulaColumns = @()
            for ($matrixColumn = $columnLower; $matrixColumn -le $columnUpper; $matrixColumn++) {
              if ([string]$formulaMatrix.GetValue($matrixRow, $matrixColumn) -match '^=') { $formulaColumns += $matrixColumn }
            }
            if ($formulaColumns.Count -lt 3) { continue }
            $firstFormula = ($formulaColumns | Measure-Object -Minimum).Minimum
            $lastFormula = ($formulaColumns | Measure-Object -Maximum).Maximum
            for ($matrixColumn = $firstFormula; $matrixColumn -le $lastFormula -and $inconsistencies -lt 100; $matrixColumn++) {
              $entry = [string]$formulaMatrix.GetValue($matrixRow, $matrixColumn)
              if (-not [string]::IsNullOrWhiteSpace($entry) -and $entry -notmatch '^=') {
                $cell = $used.Cells.Item($matrixRow - $rowLower + 1, $matrixColumn - $columnLower + 1)
                $issues += Office-Issue 'warning' 'formula_inconsistency' "/sheet[$($sheet.Name)]/cell[$($cell.Address($false, $false))]" 'A hardcoded value interrupts a row containing three or more formulas.'
                $inconsistencies++
              }
            }
          }
        }
      } catch {}
    }
    try {
      $errorCells = $used.SpecialCells(-4123, 16)
      $errorCount = [int]$errorCells.Cells.Count
      $limit = [Math]::Min($errorCount, 1000)
      for ($errorIndex = 1; $errorIndex -le $limit; $errorIndex++) {
        $cell = $errorCells.Cells.Item($errorIndex)
        $text = [string]$cell.Text
        $issues += Office-Issue 'error' 'formula_error' "/sheet[$($sheet.Name)]/cell[$($cell.Address($false, $false))]" "Cell contains formula error $text"
      }
      if ($errorCount -gt $limit) {
        $issues += Office-Issue 'error' 'formula_error_truncated' "/sheet[$($sheet.Name)]" "$($errorCount - $limit) additional formula error(s) were omitted from the report."
      }
    } catch {}
    for ($chartIndex = 1; $chartIndex -le $sheet.ChartObjects().Count; $chartIndex++) {
      try {
        $chart = $sheet.ChartObjects().Item($chartIndex).Chart
        if ($chart.SeriesCollection().Count -eq 0) {
          $issues += Office-Issue 'error' 'empty_chart' "/sheet[$($sheet.Name)]/chart[$chartIndex]" 'Chart has no data series.'
        }
      } catch {
        $issues += Office-Issue 'error' 'broken_chart' "/sheet[$($sheet.Name)]/chart[$chartIndex]" 'Chart data could not be inspected.'
      }
    }
  }
  try {
    $links = @($book.LinkSources(1))
    foreach ($link in $links) { if ($link) { $issues += Office-Issue 'warning' 'external_link' '/' "Workbook links to external source: $link" } }
  } catch {}
  $totalCells = [int64]0
  $scannedCells = [int64]0
  foreach ($entry in $coverage) {
    $totalCells += [int64]$entry.totalCells
    $scannedCells += [int64]$entry.scannedCells
  }
  return [ordered]@{
    issues = @($issues)
    auditCoverage = [ordered]@{
      mode = $(if ($financialAudit) { 'full' } else { 'sampled' })
      complete = @($coverage | Where-Object { -not $_.complete }).Count -eq 0
      totalCells = $totalCells
      scannedCells = $scannedCells
      sheets = $coverage
    }
  }
}

function Ole-ColorChannel([long]$color, [int]$shift) {
  return [double](($color -shr $shift) -band 255) / 255
}

function Color-Luminance([long]$color) {
  $channels = @(
    (Ole-ColorChannel $color 0),
    (Ole-ColorChannel $color 8),
    (Ole-ColorChannel $color 16)
  )
  $linear = @()
  foreach ($channel in $channels) {
    $linear += $(if ($channel -le 0.03928) { $channel / 12.92 } else { [Math]::Pow(($channel + 0.055) / 1.055, 2.4) })
  }
  return (0.2126 * $linear[0]) + (0.7152 * $linear[1]) + (0.0722 * $linear[2])
}

function Color-ContrastRatio([long]$left, [long]$right) {
  $leftLuminance = Color-Luminance $left
  $rightLuminance = Color-Luminance $right
  $lighter = [Math]::Max($leftLuminance, $rightLuminance)
  $darker = [Math]::Min($leftLuminance, $rightLuminance)
  return ($lighter + 0.05) / ($darker + 0.05)
}

function Issues-PowerPoint($presentation, $payload) {
  $issues = @()
  $fonts = Installed-OfficeFonts
  foreach ($slide in @($presentation.Slides)) {
    if ($payload.pages -and -not (@($payload.pages | ForEach-Object { [int]$_ }) -contains [int]$slide.SlideIndex)) { continue }
    $shapeIndex = 0
    $textShapeCount = 0
    $visualShapeCount = 0
    foreach ($shape in @($slide.Shapes)) {
      $shapeIndex++
      $path = "/slide[$($slide.SlideIndex)]/shape[$shapeIndex]"
      try {
        if (@(1, 3, 6, 13, 21, 28) -contains [int]$shape.Type -or $shape.HasChart -or $shape.HasTable) { $visualShapeCount++ }
      } catch {}
      try {
        if ($shape.Type -eq 13 -and [string]::IsNullOrWhiteSpace([string]$shape.AlternativeText)) {
          $issues += Office-Issue 'warning' 'missing_alt_text' $path 'Picture has no alternative text.'
        }
      } catch {}
      try {
        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
          $textShapeCount++
          $boundWidth = [single]$shape.TextFrame2.TextRange.BoundWidth
          $boundHeight = [single]$shape.TextFrame2.TextRange.BoundHeight
          if ($boundWidth -gt ([single]$shape.Width + 1) -or $boundHeight -gt ([single]$shape.Height + 1)) {
            $issues += Office-Issue 'warning' 'text_overflow' $path 'Text bounds exceed the containing shape.'
          }
          $fontIssue = Missing-FontIssue $fonts ([string]$shape.TextFrame.TextRange.Font.Name) $path
          if ($fontIssue) { $issues += $fontIssue }
          $fontSize = [single]$shape.TextFrame.TextRange.Font.Size
          if ($fontSize -gt 0 -and $fontSize -lt 12) {
            $issues += Office-Issue 'warning' 'small_font' $path "Text uses $fontSize pt; presentation body text should normally be at least 12 pt."
          }
          $slideWidth = [single]$presentation.PageSetup.SlideWidth
          $slideHeight = [single]$presentation.PageSetup.SlideHeight
          if ($shape.Left -lt 0 -or $shape.Top -lt 0 -or
            ([single]$shape.Left + [single]$shape.Width) -gt ($slideWidth + 1) -or
            ([single]$shape.Top + [single]$shape.Height) -gt ($slideHeight + 1)) {
            $issues += Office-Issue 'warning' 'text_outside_slide' $path 'Text shape extends outside the slide boundary.'
          }
          if ($shape.Left -lt 18 -or $shape.Top -lt 18 -or
            ([single]$shape.Left + [single]$shape.Width) -gt ($slideWidth - 18) -or
            ([single]$shape.Top + [single]$shape.Height) -gt ($slideHeight - 18)) {
            $issues += Office-Issue 'warning' 'edge_margin' $path 'Text is within 18 pt of a slide edge.'
          }
          try {
            if ($shape.Fill.Visible -and [long]$shape.Fill.ForeColor.RGB -ge 0 -and [long]$shape.TextFrame.TextRange.Font.Color.RGB -ge 0) {
              $contrast = Color-ContrastRatio ([long]$shape.TextFrame.TextRange.Font.Color.RGB) ([long]$shape.Fill.ForeColor.RGB)
              if ($contrast -lt 3) {
                $issues += Office-Issue 'warning' 'low_contrast' $path "Text-to-fill contrast ratio is $([Math]::Round($contrast, 2)):1."
              }
            }
          } catch {}
        }
      } catch {}
      try {
        if ($shape.Type -eq 14 -and -not ($shape.HasTextFrame -and $shape.TextFrame.HasText)) {
          $placeholderType = [int]$shape.PlaceholderFormat.Type
          if (@(1, 2, 3, 4, 5, 6, 7) -contains $placeholderType) {
            $issues += Office-Issue 'warning' 'empty_placeholder' $path 'A visible content placeholder is still empty.'
          }
        }
      } catch {}
      try {
        if ($shape.HasChart -and $shape.Chart.SeriesCollection().Count -eq 0) {
          $issues += Office-Issue 'error' 'empty_chart' "$path/chart" 'Chart has no data series.'
        }
      } catch {
        if ($shape.HasChart) { $issues += Office-Issue 'error' 'broken_chart' "$path/chart" 'Chart data could not be inspected.' }
      }
    }
    for ($leftIndex = 1; $leftIndex -le $slide.Shapes.Count; $leftIndex++) {
      $left = $slide.Shapes.Item($leftIndex)
      for ($rightIndex = $leftIndex + 1; $rightIndex -le $slide.Shapes.Count; $rightIndex++) {
        $right = $slide.Shapes.Item($rightIndex)
        try {
          $leftHasText = $left.HasTextFrame -and $left.TextFrame.HasText
          $rightHasText = $right.HasTextFrame -and $right.TextFrame.HasText
          if (-not ($leftHasText -and $rightHasText)) { continue }
          $x = [Math]::Max(0, [Math]::Min([double]$left.Left + [double]$left.Width, [double]$right.Left + [double]$right.Width) - [Math]::Max([double]$left.Left, [double]$right.Left))
          $y = [Math]::Max(0, [Math]::Min([double]$left.Top + [double]$left.Height, [double]$right.Top + [double]$right.Height) - [Math]::Max([double]$left.Top, [double]$right.Top))
          $intersection = $x * $y
          $smallest = [Math]::Min([double]$left.Width * [double]$left.Height, [double]$right.Width * [double]$right.Height)
          if ($smallest -gt 0 -and ($intersection / $smallest) -ge 0.25) {
            $issues += Office-Issue 'warning' 'shape_overlap' "/slide[$($slide.SlideIndex)]" "Text shapes $leftIndex and $rightIndex overlap by at least 25%."
          }
        } catch {}
      }
    }
    if ($textShapeCount -gt 0 -and $visualShapeCount -eq 0) {
      $issues += Office-Issue 'warning' 'text_only_slide' "/slide[$($slide.SlideIndex)]" 'Slide contains text but no visual shape, chart, table, diagram, or picture.'
    }
    if ($payload.auditProfile -eq 'model-backed-deck') {
      $allText = @($slide.Shapes | ForEach-Object {
        try { if ($_.HasTextFrame -and $_.TextFrame.HasText) { [string]$_.TextFrame.TextRange.Text } } catch {}
      }) -join ' '
      $notes = $(try { [string]$slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text } catch { '' })
      if ($allText -match '\d' -and $notes -notmatch '(?i)source\s*:|[\w .-]+!\$?[A-Z]{1,3}\$?\d+') {
        $issues += Office-Issue 'warning' 'number_without_source' "/slide[$($slide.SlideIndex)]" 'Model-backed deck slide contains numbers but its notes do not cite a workbook cell or source.'
      }
    }
  }
  return $issues
}

function Issues-Document($document, [string]$format, $payload = $null) {
  if ($null -eq $payload) { $payload = [ordered]@{} }
  $inspection = switch ($format) {
    'docx' { @(Issues-Word $document) }
    'xlsx' { Issues-Excel $document $payload }
    'pptx' { @(Issues-PowerPoint $document $payload) }
  }
  $issues = if ($inspection -is [System.Collections.IDictionary] -and $inspection.Contains('issues')) { @($inspection.issues) } else { @($inspection) }
  $result = [ordered]@{ ok = -not (@($issues | Where-Object severity -eq 'error').Count -gt 0); format = $format; issueCount = @($issues).Count; issues = @($issues) }
  if ($inspection -is [System.Collections.IDictionary] -and $inspection.Contains('auditCoverage')) {
    $result.auditCoverage = $inspection.auditCoverage
  }
  return $result
}

function Open-ValidationDocument($app, [string]$format, [string]$path) {
  switch ($format) {
    'docx' { return $app.Documents.Open($path, $false, $true, $false) }
    'xlsx' { return $app.Workbooks.Open($path, 0, $true) }
    'pptx' { return $app.Presentations.Open($path, $true, $true, $false) }
  }
}

function Validate-NativeDocument([string]$path, [string]$format) {
  $validationApp = $null
  $validationDocument = $null
  try {
    $validationApp = New-HiddenApplication $format (ProgId-ForFormat $format)
    $validationDocument = Open-ValidationDocument $validationApp $format $path
    $snapshot = Snapshot-Document $validationDocument $format ([ordered]@{})
    $inspection = Issues-Document $validationDocument $format ([ordered]@{})
    return [ordered]@{
      ok = [bool]$inspection.ok
      opened = $true
      issueCount = [int]$inspection.issueCount
      issues = @($inspection.issues)
      snapshotFingerprint = Snapshot-Fingerprint $snapshot
    }
  } catch {
    return [ordered]@{ ok = $false; opened = $false; error = [string]$_.Exception.Message }
  } finally {
    if ($null -ne $validationDocument) {
      try { $validationDocument.Close($false) } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($validationDocument) } catch {}
    }
    if ($null -ne $validationApp) {
      try { $validationApp.Quit() } catch {}
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($validationApp) } catch {}
    }
  }
}

function Save-Document($document, [string]$format) {
  if ($format -eq 'xlsx') {
    try { $document.Application.CalculateFullRebuild() } catch {}
  }
  $document.Save()
}

function Save-DocumentCopy($document, [string]$format, [string]$output) {
  switch ($format) {
    'xlsx' { $document.SaveCopyAs($output) }
    'pptx' { $document.SaveCopyAs($output, (Office-SaveFormatForPath $format $output)) }
    default { throw "Save-copy is unsupported for .$format" }
  }
}

function Text-Sha256([string]$text) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Snapshot-Fingerprint($value) {
  return Text-Sha256 ($value | ConvertTo-Json -Depth 30 -Compress)
}

function Restore-ExcelCheckpoint($book, [string]$checkpoint) {
  $app = $book.Application
  $alerts = $app.DisplayAlerts
  $app.DisplayAlerts = $false
  $source = $null
  try {
    $source = $app.Workbooks.Open($checkpoint, $null, $true)
    $originalSheets = @($book.Worksheets)
    $temporary = $book.Worksheets.Add()
    $temporary.Name = "__MixdogRestore$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    foreach ($sheet in $originalSheets) { $sheet.Delete() }
    foreach ($sheet in @($source.Worksheets)) {
      $sheet.Copy([Type]::Missing, $book.Worksheets.Item($book.Worksheets.Count))
    }
    $temporary.Delete()
    $book.Saved = $false
  } finally {
    if ($null -ne $source) { try { $source.Close($false) } catch {} }
    $app.DisplayAlerts = $alerts
  }
}

function Rollback-LiveDocument($document, [string]$format, [string]$checkpoint, [int]$undoUnits) {
  switch ($format) {
    'docx' {
      if ($undoUnits -gt 0) { $null = $document.Undo($undoUnits) }
    }
    'xlsx' { Restore-ExcelCheckpoint $document $checkpoint }
    'pptx' {
      for ($index = 0; $index -lt $undoUnits; $index++) {
        $document.Application.CommandBars.ExecuteMso('Undo')
      }
    }
  }
}

function Render-Document($document, [string]$format, [string]$output) {
  switch ($format) {
    'docx' { $document.ExportAsFixedFormat($output, 17) }
    'xlsx' {
      $pageSetups = @()
      try {
        foreach ($sheet in @($document.Worksheets)) {
          try {
            $pageSetup = $sheet.PageSetup
            $pageSetups += [ordered]@{
              PageSetup = $pageSetup
              Zoom = $pageSetup.Zoom
              FitToPagesWide = $pageSetup.FitToPagesWide
              FitToPagesTall = $pageSetup.FitToPagesTall
            }
            $pageSetup.Zoom = $false
            $pageSetup.FitToPagesWide = 1
            $pageSetup.FitToPagesTall = $false
          } catch {}
        }
        $document.ExportAsFixedFormat(0, $output)
      } finally {
        foreach ($state in $pageSetups) {
          try {
            $state.PageSetup.Zoom = $state.Zoom
            $state.PageSetup.FitToPagesWide = $state.FitToPagesWide
            $state.PageSetup.FitToPagesTall = $state.FitToPagesTall
          } catch {}
        }
      }
    }
    'pptx' { $document.SaveCopyAs($output, 32) }
  }
}

if ($env:MIXDOG_OFFICE_HOST_LIBRARY -eq '1') { return }

$app = $null
$document = $null
$live = $false
$createdApp = $false
try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { throw 'Office host received an empty request' }
  $payload = $raw | ConvertFrom-Json
  $format = ([string]$payload.format).ToLowerInvariant()
  if ($payload.action -eq 'detect') {
    $formats = @('docx', 'xlsx', 'pptx')
    $items = @()
    foreach ($candidate in $formats) {
      $progId = ProgId-ForFormat $candidate
      $installed = Installed $progId
      $active = $false
      $open = $false
      if ($installed) {
        $candidateApp = Active-Application $progId
        if ($null -ne $candidateApp) {
          $active = $true
          if ($payload.path -and ($format -eq $candidate)) {
            $open = $null -ne (Find-OpenDocument $candidateApp $candidate ([string]$payload.path))
          }
          [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($candidateApp)
        }
      }
      $items += [ordered]@{ format = $candidate; installed = $installed; active = $active; documentOpen = $open }
    }
    Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; available = ($items | Where-Object installed).Count -gt 0; applications = $items })
    exit 0
  }

  $progId = ProgId-ForFormat $format
  if (-not (Installed $progId)) { throw "Microsoft Office application for .$format is not installed" }
  $path = [System.IO.Path]::GetFullPath([string]$payload.path)
  if ($payload.mode -eq 'live') {
    $app = Active-Application $progId
    if ($null -eq $app) { throw "No running Microsoft Office application for .$format" }
    $document = Find-OpenDocument $app $format $path
    if ($null -eq $document) { throw "The exact document is not open in Microsoft Office: $path" }
    $live = $true
  } else {
    $app = New-HiddenApplication $format $progId
    $createdApp = $true
    $document = Open-BackgroundDocument $app $format $path
  }

  switch ([string]$payload.action) {
    'snapshot' {
      $value = Snapshot-Document $document $format $payload
      Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); value = $value })
    }
    'issues' {
      $value = Issues-Document $document $format $payload
      Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); value = $value })
    }
    'validate' {
      $value = Validate-NativeDocument $path $format
      $value.documentSaved = [bool]$document.Saved
      Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); value = $value })
    }
    'checkpoint' {
      $output = [System.IO.Path]::GetFullPath([string]$payload.output)
      $value = Snapshot-Document $document $format $payload
      if ($format -eq 'docx') {
        Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); fingerprint = Snapshot-Fingerprint $value; saved = [bool]$document.Saved; value = $value })
      } else {
        Save-DocumentCopy $document $format $output
        Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); output = $output; saved = [bool]$document.Saved; value = $value })
      }
    }
    'batch' {
      $excelCheckpoint = ''
      if ($live -and $format -eq 'xlsx') {
        $extension = [System.IO.Path]::GetExtension($path)
        $excelCheckpoint = Join-Path ([System.IO.Path]::GetTempPath()) "mixdog-excel-batch-$([guid]::NewGuid().ToString('N'))$extension"
        Save-DocumentCopy $document $format $excelCheckpoint
      }
      try {
        $applied = Apply-Operations $document $format $payload.operations $live ([bool]$payload.requireChanges)
        if (-not $live -or $payload.save) { Save-Document $document $format }
        Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); saved = (-not $live -or [bool]$payload.save); results = $applied.results; undoUnits = $applied.undoUnits })
      } catch {
        if ($excelCheckpoint) { try { Restore-ExcelCheckpoint $document $excelCheckpoint } catch {} }
        throw
      } finally {
        if ($excelCheckpoint) { Remove-Item $excelCheckpoint -Force -ErrorAction SilentlyContinue }
      }
    }
    'rollback' {
      if (-not $live) { throw 'Office COM rollback is available for live documents only' }
      Rollback-LiveDocument $document $format ([string]$payload.checkpoint) ([int]$payload.undoUnits)
      $value = Snapshot-Document $document $format $payload
      Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = 'live'; rolledBack = $true; value = $value })
    }
    'save' {
      Save-Document $document $format
      Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); saved = $true; path = $path })
    }
    'render' {
      $output = [System.IO.Path]::GetFullPath([string]$payload.output)
      $wasSaved = [bool]$document.Saved
      Render-Document $document $format $output
      if ($wasSaved -and -not [bool]$document.Saved) { $document.Saved = $true }
      Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); output = $output })
    }
    default { throw "Unsupported Office host action: $($payload.action)" }
  }
} catch {
  Emit-Json ([ordered]@{ ok = $false; backend = 'microsoft-office-com'; error = [string]$_.Exception.Message })
  exit 1
} finally {
  if ($null -ne $document) {
    if (-not $live) {
      try { $document.Close($false) } catch {}
    }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($document) } catch {}
  }
  if ($null -ne $app) {
    if ($createdApp) {
      try { $app.Quit() } catch {}
    }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
