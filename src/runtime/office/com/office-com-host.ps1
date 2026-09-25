$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'office-com-cleanup.ps1')
. (Join-Path $PSScriptRoot 'office-word-formatting.ps1')

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
        }
        catch {}
    }
    return $null
}

function Active-Application([string]$progId) {
    try {
        return [System.Runtime.InteropServices.Marshal]::GetActiveObject($progId)
    }
    catch {
        return $null
    }
}

function Installed([string]$progId) {
    if (-not $progId) { return $false }
    try { return $null -ne [type]::GetTypeFromProgID($progId) } catch { return $false }
}

function New-HiddenApplication([string]$format, [string]$progId) {
    $processName = switch ($format) { 'docx' { 'WINWORD' } 'xlsx' { 'EXCEL' } 'pptx' { 'POWERPNT' } }
    $baseline = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id; $_.Dispose() })
    $app = New-Object -ComObject $progId
    $newProcesses = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $baseline -notcontains $_.Id })
    try {
        if ($newProcesses.Count -ne 1) {
            Release-OfficeObject $app
            throw 'Background Office refused a shared or unidentified application before opening the document.'
        }
    }
    finally { foreach ($process in $newProcesses) { $process.Dispose() } }
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

# Word's Range.Text still spells struck-through deletions while changes are
# tracked, so a paragraph reads "oneuno" where the page shows one word going
# and another coming. The portable reader's `text` is the accepted view; this
# leaves the deleted spans out and hands them back as deletedText.
function Word-AcceptedText($doc, $range) {
    $deleted = @()
    $tracked = $false
    try {
        # Range.Revisions also lists a revision that merely touches the range's
        # edge (the next table cell's, say), so only one that overlaps it counts.
        $count = [int]$range.Revisions.Count
        for ($position = 1; $position -le $count; $position++) {
            $revision = $range.Revisions.Item($position)
            $start = [Math]::Max([int]$range.Start, [int]$revision.Range.Start)
            $end = [Math]::Min([int]$range.End, [int]$revision.Range.End)
            if ($end -le $start) { continue }
            $tracked = $true
            $typeCode = [int]$revision.Type
            if ($typeCode -ne 2 -and $typeCode -ne 14) { continue }
            $deleted += [pscustomobject]@{ Start = $start; End = $end }
        }
    }
    catch {}
    if ($deleted.Count -eq 0) { return [ordered]@{ text = [string]$range.Text; deleted = ''; tracked = $tracked } }
    $kept = ''
    $gone = ''
    $cursor = [int]$range.Start
    foreach ($span in @($deleted | Sort-Object Start)) {
        if ($span.Start -gt $cursor) { $kept += [string]$doc.Range($cursor, $span.Start).Text }
        if ($span.End -gt $cursor) {
            $gone += [string]$doc.Range([Math]::Max($cursor, $span.Start), $span.End).Text
            $cursor = $span.End
        }
    }
    if ($cursor -lt [int]$range.End) { $kept += [string]$doc.Range($cursor, [int]$range.End).Text }
    return [ordered]@{ text = $kept; deleted = $gone; tracked = $tracked }
}

function Snapshot-Word($doc, $payload) {
    try { $null = $doc.Repaginate() } catch {}
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
        $accepted = Word-AcceptedText $doc $p.Range
        $text = ([string]$accepted.text).TrimEnd("`r", "`a")
        $deletedText = ([string]$accepted.deleted).TrimEnd("`r", "`a")
        # An empty body paragraph is listed too, as the portable reader lists it: left out, a paragraph cleared for
        # later text had no number to fill it by. Empty table marks (a row's end) stay out, as they do there.
        $emptyBody = $text.Length -eq 0 -and $deletedText.Length -eq 0 -and -not $(try { [bool]$p.Range.Information(12) } catch { $false })
        if ($text.Length -gt 0 -or $deletedText.Length -gt 0 -or $emptyBody) {
            $style = $p.Range.Style
            $styleName = try { [string]$style.NameLocal } catch {
                try { [string]$style.Name } catch { [string]$style }
            }
            $styleName = Word-CanonicalStyleName $doc $styleName
            $tabStops = @()
            try {
                for ($tabIndex = 1; $tabIndex -le $p.Format.TabStops.Count; $tabIndex++) {
                    $tab = $p.Format.TabStops.Item($tabIndex)
                    $tabStops += [ordered]@{
                        position  = [double]$tab.Position
                        alignment = [int]$tab.Alignment
                        leader    = [int]$tab.Leader
                    }
                }
            }
            catch {}
            $entry = [ordered]@{
                path      = "/body/p[$index]"
                index     = $index
                text      = $text
                style     = $styleName
                start     = [int]$p.Range.Start
                end       = [int]$p.Range.End
                inTable   = $(try { [bool]$p.Range.Information(12) } catch { $false })
                pageStart = $(try { [int]$p.Range.Information(3) } catch { 0 })
                pageEnd   = $(try {
                        $endRange = $p.Range.Duplicate
                        $end = [Math]::Max([int]$endRange.Start, [int]$endRange.End - 1)
                        $endRange.SetRange($end, $end)
                        [int]$endRange.Information(3)
                    }
                    catch { 0 })
                format    = [ordered]@{
                    alignment       = [int]$p.Format.Alignment
                    spacingBefore   = [double]$p.Format.SpaceBefore
                    spacingAfter    = [double]$p.Format.SpaceAfter
                    lineSpacing     = [double]$p.Format.LineSpacing
                    keepWithNext    = [int]$p.Format.KeepWithNext
                    pageBreakBefore = [int]$p.Format.PageBreakBefore
                    tabStops        = $tabStops
                }
            }
            # The portable reader reports the same two facts from the XML: tracked
            # changes touching the paragraph, and list membership as kind + 0-based level.
            if ($accepted.tracked) { $entry.tracked = $true }
            if ($deletedText.Length -gt 0) { $entry.deletedText = $deletedText }
            # Word can hide a run: the words stay in the document and the page does not
            # show them. Reported like ordinary body text they get quoted and edited as
            # what the document says, so the hidden part is named beside the paragraph.
            $hiddenText = ''
            try {
                $hiddenState = [int]$p.Range.Font.Hidden
                if ($hiddenState -eq -1) { $hiddenText = $text }
                elseif ($hiddenState -ne 0 -and [int]$p.Range.Words.Count -le 200) {
                    foreach ($word in @($p.Range.Words)) {
                        if ([int]$word.Font.Hidden -eq -1) { $hiddenText += [string]$word.Text }
                    }
                }
            }
            catch {}
            $hiddenText = ([string]$hiddenText).TrimEnd("`r", "`a")
            if ($hiddenText.Length -gt 0) { $entry.hiddenText = $hiddenText }
            # The type the paragraph is set in, the same reading the portable snapshot
            # resolves from styles.xml. Word answers 9999999 for a range set in more
            # than one size, which says nothing about the paragraph and is left out.
            try {
                $paragraphFont = $p.Range.Font
                $paragraphSize = [double]$paragraphFont.Size
                if ($paragraphSize -gt 0 -and $paragraphSize -lt 1639) {
                    $entry.font = [ordered]@{
                        name = [string]$paragraphFont.Name
                        size = $paragraphSize
                        bold = ([int]$paragraphFont.Bold -eq -1)
                    }
                }
            }
            catch {}
            try {
                $listFormat = $p.Range.ListFormat
                $listType = [int]$listFormat.ListType
                if ($listType -ne 0) {
                    # A gallery template reports an outline list type for bullets and
                    # numbers alike; the level's number style (22 picture bullet, 23
                    # bullet) is what separates them.
                    $levelNumber = [Math]::Max(1, [int]$listFormat.ListLevelNumber)
                    $numberStyle = $(try { [int]$listFormat.ListTemplate.ListLevels.Item($levelNumber).NumberStyle } catch { -1 })
                    $entry.list = [ordered]@{
                        kind  = $(if ($numberStyle -eq 23 -or $numberStyle -eq 22 -or $listType -eq 1 -or $listType -eq 5) { 'bullet' } else { 'number' })
                        level = $levelNumber - 1
                    }
                }
            }
            catch {}
            $paragraphs += $entry
        }
    }
    $tables = @()
    for ($i = 1; $i -le $doc.Tables.Count; $i++) {
        $table = $doc.Tables.Item($i)
        $rows = @()
        for ($r = 1; $r -le $table.Rows.Count; $r++) {
            $cells = @()
            for ($c = 1; $c -le $table.Columns.Count; $c++) {
                # The cell's accepted view and its struck-through words, as for a
                # paragraph, so a redline in a table reads the same way.
                try {
                    $accepted = Word-AcceptedText $doc $table.Cell($r, $c).Range
                    $cells += [ordered]@{
                        text        = ([string]$accepted.text).TrimEnd("`r", "`a")
                        deletedText = ([string]$accepted.deleted).TrimEnd("`r", "`a")
                        tracked     = [bool]$accepted.tracked
                    }
                }
                catch { $cells += $null }
            }
            $rows += , $cells
        }
        $tableRows = @()
        for ($r = 1; $r -le $rows.Count; $r++) {
            $cells = @()
            for ($c = 1; $c -le @($rows[$r - 1]).Count; $c++) {
                $record = @($rows[$r - 1])[$c - 1]
                $cell = [ordered]@{ path = "/body/tbl[$i]/row[$r]/cell[$c]"; index = $c; text = $(if ($null -eq $record) { $null } else { $record.text }) }
                if ($null -ne $record -and $record.tracked) { $cell.tracked = $true }
                if ($null -ne $record -and $record.deletedText.Length -gt 0) { $cell.deletedText = $record.deletedText }
                $cells += $cell
            }
            $tableRows += [ordered]@{ path = "/body/tbl[$i]/row[$r]"; index = $r; cells = $cells }
        }
        $columnWidths = @()
        try {
            for ($columnIndex = 1; $columnIndex -le $table.Columns.Count; $columnIndex++) {
                $columnWidths += [double]$table.Columns.Item($columnIndex).Width
            }
        }
        catch {
            try {
                $firstRow = $table.Rows.Item(1)
                for ($columnIndex = 1; $columnIndex -le $firstRow.Cells.Count; $columnIndex++) {
                    $columnWidths += [double]$firstRow.Cells.Item($columnIndex).Width
                }
            }
            catch {}
        }
        $tables += [ordered]@{
            path         = "/body/tbl[$i]"
            index        = $i
            style        = $(Word-CanonicalStyleName $doc $(try { [string]$table.Style.NameLocal } catch { try { [string]$table.Style } catch { '' } }))
            alignment    = $(try { [int]$table.Rows.Alignment } catch { 0 })
            columnWidths = $columnWidths
            rows         = $tableRows
            start        = [int]$table.Range.Start
            end          = [int]$table.Range.End
            pageStart    = $(try {
                    $startRange = $table.Range.Duplicate
                    $startRange.Collapse(1)
                    [int]$startRange.Information(3)
                }
                catch { 0 })
            pageEnd      = $(try {
                    $endRange = $table.Range.Duplicate
                    $end = [Math]::Max([int]$endRange.Start, [int]$endRange.End - 1)
                    $endRange.SetRange($end, $end)
                    [int]$endRange.Information(3)
                }
                catch { 0 })
        }
    }
    $blockOrder = @(
        @($paragraphs | Where-Object { -not [bool]$_.inTable } | ForEach-Object {
                [ordered]@{ type = 'paragraph'; index = [int]$_.index; path = [string]$_.path; start = [int]$_.start }
            })
        @($tables | ForEach-Object {
                [ordered]@{ type = 'table'; index = [int]$_.index; path = [string]$_.path; start = [int]$_.start }
            })
    ) | Sort-Object { [int]$_['start'] }
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
                    # Read straight off the section: a collection passed through an
                    # if-expression unrolls into an array whose Item(n) is 0-based.
                    $item = if ($location -eq 'header') { $section.Headers.Item([int]$kind.value) } else { $section.Footers.Item([int]$kind.value) }
                    if (-not [bool]$item.Exists) { continue }
                    $stories += [ordered]@{
                        path           = "/section[$sectionIndex]/${location}[$($kind.name)]"
                        kind           = [string]$kind.name
                        location       = $location
                        text           = ([string]$item.Range.Text).TrimEnd("`r", "`a")
                        linkToPrevious = [bool]$item.LinkToPrevious
                    }
                }
                catch {}
            }
        }
        $sections += [ordered]@{
            path         = "/section[$sectionIndex]"
            index        = $sectionIndex
            orientation  = [int]$section.PageSetup.Orientation
            topMargin    = [double]$section.PageSetup.TopMargin
            bottomMargin = [double]$section.PageSetup.BottomMargin
            leftMargin   = [double]$section.PageSetup.LeftMargin
            rightMargin  = [double]$section.PageSetup.RightMargin
            stories      = $stories
        }
    }
    $images = @()
    for ($imageIndex = 1; $imageIndex -le $doc.InlineShapes.Count; $imageIndex++) {
        $image = $doc.InlineShapes.Item($imageIndex)
        $images += [ordered]@{
            path    = "/body/image[$imageIndex]"
            index   = $imageIndex
            type    = [int]$image.Type
            width   = [double]$image.Width
            height  = [double]$image.Height
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
                    index  = $replyIndex
                    author = $(try { [string]$reply.Author } catch { '' })
                    date   = $(try { ([datetime]$reply.Date).ToUniversalTime().ToString('o') } catch { '' })
                    text   = $(try { ([string]$reply.Range.Text).TrimEnd("`r", "`a") } catch { '' })
                }
            }
        }
        catch {}
        $comments += [ordered]@{
            path         = "/body/comment[$commentIndex]"
            index        = $commentIndex
            author       = $(try { [string]$comment.Author } catch { '' })
            initials     = $(try { [string]$comment.Initial } catch { '' })
            date         = $(try { ([datetime]$comment.Date).ToUniversalTime().ToString('o') } catch { '' })
            text         = $(try { ([string]$comment.Range.Text).TrimEnd("`r", "`a") } catch { '' })
            anchoredText = $(try { ([string]$comment.Scope.Text).TrimEnd("`r", "`a") } catch { '' })
            resolved     = $(try { [bool]$comment.Done } catch { $false })
            replies      = $replies
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
    $revisionsByParagraph = @{}
    $revisionAuthors = [ordered]@{}
    $propertyChangeCount = 0
    # Word lists formatting revisions among the others; the portable reader
    # counts them apart as propertyChangeCount and tallies each author's
    # insertions and deletions, so the same figures are reported here.
    $insertionTypes = @(1, 15, 16)
    $deletionTypes = @(2, 14, 17)
    $propertyTypes = @(3, 8, 10, 11, 12, 13)
    $documentEnd = [int]$doc.Content.End
    for ($revisionIndex = 1; $revisionIndex -le $doc.Revisions.Count; $revisionIndex++) {
        $revision = $doc.Revisions.Item($revisionIndex)
        $typeCode = [int]$revision.Type
        $author = $(try { [string]$revision.Author } catch { '' })
        $entry = [ordered]@{
            path     = "/body/revision[$revisionIndex]"
            index    = $revisionIndex
            type     = $(if ($revisionTypes.ContainsKey($typeCode)) { [string]$revisionTypes[$typeCode] } else { 'unknown' })
            typeCode = $typeCode
            author   = $author
            date     = $(try { ([datetime]$revision.Date).ToUniversalTime().ToString('o') } catch { '' })
            text     = $(try { ([string]$revision.Range.Text).TrimEnd("`r", "`a") } catch { '' })
        }
        # The paragraph the revision starts in: the range up to and including
        # its first character ends inside that paragraph, so the paragraph count
        # of that range is the ordinal (a range ending exactly at a paragraph
        # start would not count the paragraph).
        try {
            $head = [Math]::Min($documentEnd, [Math]::Max(0, [int]$revision.Range.Start) + 1)
            $paragraph = [Math]::Max(1, [int]$doc.Range(0, $head).Paragraphs.Count)
            $entry.at = "/body/p[$paragraph]"
            if (-not $revisionsByParagraph.ContainsKey($paragraph)) { $revisionsByParagraph[$paragraph] = @() }
            $revisionsByParagraph[$paragraph] += $revisionIndex
        }
        catch {}
        $revisions += $entry
        if ($propertyTypes -contains $typeCode) { $propertyChangeCount++; continue }
        if (-not $revisionAuthors.Contains($author)) { $revisionAuthors[$author] = [ordered]@{ author = $author; insertions = 0; deletions = 0 } }
        if ($insertionTypes -contains $typeCode) { $revisionAuthors[$author].insertions++ }
        elseif ($deletionTypes -contains $typeCode) { $revisionAuthors[$author].deletions++ }
    }
    foreach ($entry in $paragraphs) {
        if ($revisionsByParagraph.ContainsKey([int]$entry.index)) { $entry.revisions = @($revisionsByParagraph[[int]$entry.index]) }
    }
    $footnotes = @()
    for ($noteIndex = 1; $noteIndex -le $doc.Footnotes.Count; $noteIndex++) {
        $note = $doc.Footnotes.Item($noteIndex)
        $footnotes += [ordered]@{
            path  = "/body/footnote[$noteIndex]"
            index = $noteIndex
            text  = ([string]$note.Range.Text).TrimEnd("`r", "`a")
        }
    }
    $endnotes = @()
    for ($noteIndex = 1; $noteIndex -le $doc.Endnotes.Count; $noteIndex++) {
        $note = $doc.Endnotes.Item($noteIndex)
        $endnotes += [ordered]@{
            path  = "/body/endnote[$noteIndex]"
            index = $noteIndex
            text  = ([string]$note.Range.Text).TrimEnd("`r", "`a")
        }
    }
    $contentControls = @()
    for ($controlIndex = 1; $controlIndex -le $doc.ContentControls.Count; $controlIndex++) {
        $control = $doc.ContentControls.Item($controlIndex)
        $contentControls += [ordered]@{
            path         = "/body/content-control[$controlIndex]"
            index        = $controlIndex
            tag          = [string]$control.Tag
            title        = [string]$control.Title
            lockContents = [bool]$control.LockContents
            lockControl  = [bool]$control.LockContentControl
            text         = ([string]$control.Range.Text).TrimEnd("`r", "`a")
        }
    }
    return [ordered]@{
        format              = 'docx'
        path                = [string]$doc.FullName
        trackChanges        = [bool]$doc.TrackRevisions
        paragraphCount      = $doc.Paragraphs.Count
        tableCount          = $doc.Tables.Count
        commentCount        = $comments.Count
        revisionCount       = $doc.Revisions.Count
        comments            = $comments
        revisions           = $revisions
        revisionAuthors     = @($revisionAuthors.Values)
        propertyChangeCount = $propertyChangeCount
        footnoteCount       = $footnotes.Count
        endnoteCount        = $endnotes.Count
        footnotes           = $footnotes
        endnotes            = $endnotes
        contentControlCount = $contentControls.Count
        contentControls     = $contentControls
        paragraphs          = $paragraphs
        tables              = $tables
        blockOrder          = $blockOrder
        sections            = $sections
        images              = $images
        pagination          = $(if ($payload.paged) {
                [ordered]@{
                    unit       = 'paragraph'
                    offset     = $paragraphOffset
                    limit      = $paragraphLimit
                    returned   = $paragraphs.Count
                    total      = [int]$doc.Paragraphs.Count
                    nextOffset = $(if ($paragraphEnd -lt [int]$doc.Paragraphs.Count) { $paragraphEnd } else { $null })
                }
            }
            else { $null })
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
            $rows += , $line
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
        # Rows and columns the sheet withholds (a filter, an outline, a working
        # column). The portable reader answers with the same two lists, so an edit
        # never lands in a hidden column on one backend and a visible one on the other.
        $hiddenRows = @()
        $hiddenColumns = @()
        try {
            if ([int]$used.Rows.Count -le 500) {
                $firstRow = [int]$used.Row
                for ($hiddenIndex = 1; $hiddenIndex -le [int]$used.Rows.Count; $hiddenIndex++) {
                    if ([bool]$used.Rows.Item($hiddenIndex).Hidden) { $hiddenRows += ($firstRow + $hiddenIndex - 1) }
                }
            }
            if ([int]$used.Columns.Count -le 200) {
                $firstColumn = [int]$used.Column
                for ($hiddenIndex = 1; $hiddenIndex -le [int]$used.Columns.Count; $hiddenIndex++) {
                    if ([bool]$used.Columns.Item($hiddenIndex).Hidden) { $hiddenColumns += (Excel-ColumnLetters ($firstColumn + $hiddenIndex - 1)) }
                }
            }
        }
        catch {}
        $entry = [ordered]@{
            path          = "/sheet[$([string]$sheet.Name)]"
            name          = [string]$sheet.Name
            rows          = [int]$used.Rows.Count
            columns       = [int]$used.Columns.Count
            # Excel answers with a code (-1 visible, 0 hidden, 2 very hidden). The
            # portable reader answers with the word set_sheet_visibility takes, so one
            # workbook must read the same on both backends.
            visibility    = $(switch ([int]$sheet.Visible) { 0 { 'hidden' } 2 { 'very_hidden' } default { 'visible' } })
            hiddenRows    = @($hiddenRows)
            hiddenColumns = @($hiddenColumns)
            pageSetup     = [ordered]@{
                # Relative, as the portable reader reports it: the review parses A1:P30, and $A$1:$P$30 read as no
                # print area at all.
                printArea      = $(try { ([string]$sheet.PageSetup.PrintArea) -replace '\$', '' } catch { '' })
                zoom           = $(try { $sheet.PageSetup.Zoom } catch { $null })
                fitToPagesWide = $(try { $sheet.PageSetup.FitToPagesWide } catch { $null })
                fitToPagesTall = $(try { $sheet.PageSetup.FitToPagesTall } catch { $null })
                orientation    = $(try { [int]$sheet.PageSetup.Orientation } catch { 0 })
                paperSize      = $(try { [int]$sheet.PageSetup.PaperSize } catch { 0 })
                # What every printed page says, in the same &L/&C/&R form the file stores
                # and the portable reader reports.
                header         = $(try {
                        (@('L', 'C', 'R') | ForEach-Object {
                            $slot = switch ($_) { 'L' { [string]$sheet.PageSetup.LeftHeader } 'C' { [string]$sheet.PageSetup.CenterHeader } default { [string]$sheet.PageSetup.RightHeader } }
                            if ($slot) { "&$_$slot" }
                        }) -join ''
                    }
                    catch { '' })
                footer         = $(try {
                        (@('L', 'C', 'R') | ForEach-Object {
                            $slot = switch ($_) { 'L' { [string]$sheet.PageSetup.LeftFooter } 'C' { [string]$sheet.PageSetup.CenterFooter } default { [string]$sheet.PageSetup.RightFooter } }
                            if ($slot) { "&$_$slot" }
                        }) -join ''
                    }
                    catch { '' })
            }
        }
        $tables = @()
        for ($tableIndex = 1; $tableIndex -le $sheet.ListObjects.Count; $tableIndex++) {
            $table = $sheet.ListObjects.Item($tableIndex)
            $tables += [ordered]@{
                path  = "/sheet[$([string]$sheet.Name)]/table[$tableIndex]"
                index = $tableIndex
                name  = [string]$table.Name
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
            }
            catch {}
            $charts += [ordered]@{
                path      = "/sheet[$([string]$sheet.Name)]/chart[$chartIndex]"
                index     = $chartIndex
                name      = [string]$chartObject.Name
                chartType = [int]$chart.ChartType
                title     = $(if ($chart.HasTitle) { [string]$chart.ChartTitle.Text } else { '' })
                left      = [double]$chartObject.Left
                top       = [double]$chartObject.Top
                width     = [double]$chartObject.Width
                height    = [double]$chartObject.Height
                anchor    = Excel-DrawingAnchor $chartObject
                series    = $series
            }
        }
        # Pictures, placed on the grid as the portable reader places them: without them (and the charts' cells) the
        # review's print-area and overlap checks never ran on a workbook Excel had opened.
        $images = @()
        foreach ($shape in @($sheet.Shapes)) {
            try {
                if ([int]$shape.Type -ne 13) { continue }
                $images += [ordered]@{
                    path    = "/sheet[$([string]$sheet.Name)]/image[$($images.Count + 1)]"
                    index   = $images.Count + 1
                    name    = [string]$shape.Name
                    altText = [string]$shape.AlternativeText
                    anchor  = Excel-DrawingAnchor $shape
                }
            }
            catch {}
        }
        $pivots = @()
        for ($pivotIndex = 1; $pivotIndex -le $sheet.PivotTables().Count; $pivotIndex++) {
            $pivot = $sheet.PivotTables().Item($pivotIndex)
            $pivots += [ordered]@{
                path  = "/sheet[$([string]$sheet.Name)]/pivot[$pivotIndex]"
                index = $pivotIndex
                name  = [string]$pivot.Name
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
                    path             = "/sheet[$([string]$sheet.Name)]/validation[$validationIndex]"
                    index            = $validationIndex
                    ranges           = @([string]$area.Address($false, $false))
                    type             = [int]$validation.Type
                    alertStyle       = [int]$validation.AlertStyle
                    operator         = [int]$validation.Operator
                    allowBlank       = [bool]$validation.IgnoreBlank
                    inCellDropdown   = [bool]$validation.InCellDropdown
                    showInputMessage = [bool]$validation.ShowInput
                    showErrorMessage = [bool]$validation.ShowError
                    inputTitle       = [string]$validation.InputTitle
                    inputMessage     = [string]$validation.InputMessage
                    errorTitle       = [string]$validation.ErrorTitle
                    errorMessage     = [string]$validation.ErrorMessage
                    formula1         = $(try { [string]$validation.Formula1 } catch { '' })
                    formula2         = $(try { [string]$validation.Formula2 } catch { '' })
                }
            }
        }
        catch {}
        $conditionalFormats = @()
        try {
            $conditionRange = $used
            if ($payload.range -and [string]::Equals([string]$payload.sheet, [string]$sheet.Name, [System.StringComparison]::OrdinalIgnoreCase)) {
                $conditionRange = $sheet.Range([string]$payload.range)
            }
            for ($conditionIndex = 1; $conditionIndex -le $conditionRange.FormatConditions.Count; $conditionIndex++) {
                $condition = $conditionRange.FormatConditions.Item($conditionIndex)
                $conditionalFormats += [ordered]@{
                    path     = "/sheet[$([string]$sheet.Name)]/conditional-format[$conditionIndex]"
                    index    = $conditionIndex
                    range    = $(try { [string]$condition.AppliesTo.Address($false, $false) } catch { [string]$conditionRange.Address($false, $false) })
                    type     = $(try { [int]$condition.Type } catch { 0 })
                    operator = $(try { [int]$condition.Operator } catch { 0 })
                    formula1 = $(try { [string]$condition.Formula1 } catch { '' })
                    formula2 = $(try { [string]$condition.Formula2 } catch { '' })
                    priority = $(try { [int]$condition.Priority } catch { 0 })
                }
            }
        }
        catch {}
        $notes = @()
        try {
            $commentCells = $sheet.Cells.SpecialCells(-4144)
            foreach ($cell in @($commentCells.Cells)) {
                $notes += [ordered]@{
                    path   = "/sheet[$([string]$sheet.Name)]/cell[$([string]$cell.Address($false, $false))]/note"
                    cell   = [string]$cell.Address($false, $false)
                    text   = [string]$cell.Comment.Text()
                    author = [string]$cell.Comment.Author
                }
            }
        }
        catch {}
        $mergedRanges = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        # The walk below costs two COM calls per cell — seconds on an ordinary sheet — and almost every
        # sheet has no merged cell at all. Asking the whole range once answers that: False means no cell
        # in it is merged. Only a mixed answer ($null) or an all-merged range needs the bounded walk.
        $rangeMerge = $null
        try { $rangeMerge = $used.MergeCells } catch { $rangeMerge = $null }
        if ($null -eq $rangeMerge -or [bool]$rangeMerge) {
            $mergeScanCount = 0
            for ($mergeRow = 1; $mergeRow -le $used.Rows.Count -and $mergeScanCount -lt 2000; $mergeRow++) {
                for ($mergeColumn = 1; $mergeColumn -le $used.Columns.Count -and $mergeScanCount -lt 2000; $mergeColumn++) {
                    $mergeScanCount++
                    try {
                        $cell = $used.Cells.Item($mergeRow, $mergeColumn)
                        if ($cell.MergeCells) { $null = $mergedRanges.Add([string]$cell.MergeArea.Address($false, $false)) }
                    }
                    catch {}
                }
            }
        }
        $freezePanes = $null
        if ([string]::Equals([string]$book.ActiveSheet.Name, [string]$sheet.Name, [System.StringComparison]::OrdinalIgnoreCase)) {
            try {
                $window = $book.Windows.Item(1)
                $split = Excel-FrozenSplit $window
                $freezePanes = [ordered]@{
                    frozen      = [bool]$window.FreezePanes
                    splitRow    = $split.row
                    splitColumn = $split.column
                }
            }
            catch {}
        }
        $autoFilter = $null
        try {
            if ($sheet.AutoFilterMode -and $null -ne $sheet.AutoFilter) {
                $autoFilter = [ordered]@{ enabled = $true; range = [string]$sheet.AutoFilter.Range.Address($false, $false) }
            }
        }
        catch {}
        $protection = [ordered]@{
            contents       = [bool]$sheet.ProtectContents
            drawingObjects = [bool]$sheet.ProtectDrawingObjects
            scenarios      = [bool]$sheet.ProtectScenarios
        }
        $entry.tables = $tables
        $entry.charts = $charts
        $entry.images = $images
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
        # A sheet past 500 cells reads its first rows up to that many cells and says it was cut, as the portable
        # reader pages it: it had read none, and every review of cells (the header, the hierarchy, the formulas)
        # passed a large sheet on Excel unread.
        $columnsRead = [Math]::Min([int]$used.Columns.Count, 500)
        $rowsRead = [Math]::Min([int]$used.Rows.Count, [Math]::Max(1, [Math]::Floor(500 / [Math]::Max(1, $columnsRead))))
        $entry.truncated = ($rowsRead -lt [int]$used.Rows.Count -or $columnsRead -lt [int]$used.Columns.Count)
        # Where the sheet's rows end, past the page the cells were read from.
        $entry.lastRow = [int]$used.Row + [int]$used.Rows.Count - 1
        $cells = @()
        for ($r = 1; $r -le $rowsRead; $r++) {
            for ($c = 1; $c -le $columnsRead; $c++) {
                $cell = $used.Cells.Item($r, $c)
                if ($null -ne $cell.Value2 -or $cell.HasFormula) {
                    $address = ([string]$cell.Address($false, $false)).Replace('$', '')
                    $cells += [ordered]@{
                        path    = "/sheet[$([string]$sheet.Name)]/cell[$address]"
                        ref     = $address
                        value   = $cell.Value2
                        formula = $(if ($cell.HasFormula) { [string]$cell.Formula } else { $null })
                        style   = [ordered]@{
                            fontName     = [string]$cell.Font.Name
                            fontSize     = [double]$cell.Font.Size
                            bold         = [bool]$cell.Font.Bold
                            italic       = [bool]$cell.Font.Italic
                            color        = [double]$cell.Font.Color
                            fillColor    = [double]$cell.Interior.Color
                            numberFormat = Excel-EnglishNumberFormat $cell
                        }
                    }
                }
            }
        }
        $entry.cells = $cells
        $entry.formulaLineage = @($cells | Where-Object { $_.formula } | ForEach-Object {
                [ordered]@{
                    path       = "$($_.path)/lineage"
                    from       = $_.path
                    formula    = $_.formula
                    precedents = @(Excel-FormulaPrecedents ([string]$_.formula) ([string]$sheet.Name))
                }
            })
        $entry.lineageCount = $entry.formulaLineage.Count
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
                path          = "/defined-name[$nameIndex]"
                index         = $nameIndex
                name          = [string]$name.Name
                nameLocal     = [string]$name.NameLocal
                refersTo      = [string]$name.RefersTo
                refersToLocal = [string]$name.RefersToLocal
                visible       = [bool]$name.Visible
            }
        }
        catch {}
    }
    # A paged request must always be answered with a pagination block. This
    # complete-workbook path reported none, so a caller could not tell a whole
    # snapshot apart from a silently truncated one.
    $completeCells = 0
    foreach ($entry in $sheets) { $completeCells += @($entry.cells).Count }
    return [ordered]@{
        format           = 'xlsx'
        path             = [string]$book.FullName
        activeSheet      = [string]$book.ActiveSheet.Name
        definedNameCount = $definedNames.Count
        definedNames     = $definedNames
        sheets           = $sheets
        pagination       = $(if ($payload.paged) {
                [ordered]@{
                    unit       = 'cell'
                    scope      = 'workbook'
                    offset     = 0
                    limit      = [Math]::Max(1, [int]$payload.limit)
                    returned   = $completeCells
                    total      = $completeCells
                    nextOffset = $null
                }
            }
            else { $null })
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
        }
        else {
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
                        path    = "/sheet[$([string]$sheet.Name)]/cell[$address]"
                        ref     = $address
                        row     = $absoluteRow
                        column  = $absoluteColumn
                        formula = $formula
                    }
                    $formulaEntries.Add($formulaEntry)
                    if (-not $detailed) {
                        $blockFormulas.Add([ordered]@{
                                rowOffset    = $r - 1
                                columnOffset = $c - 1
                                formula      = $formula
                            })
                    }
                }
                if ($detailed) {
                    $entry = [ordered]@{
                        path    = "/sheet[$([string]$sheet.Name)]/cell[$address]"
                        ref     = $address
                        value   = $value
                        formula = $formula
                    }
                }
                if ($detailed -and $payload.includeStyles) {
                    $cell = $range.Cells.Item($r, $c)
                    $entry.style = [ordered]@{
                        fontName     = [string]$cell.Font.Name
                        fontSize     = [double]$cell.Font.Size
                        bold         = [bool]$cell.Font.Bold
                        italic       = [bool]$cell.Font.Italic
                        color        = [double]$cell.Font.Color
                        fillColor    = [double]$cell.Interior.Color
                        numberFormat = Excel-EnglishNumberFormat $cell
                    }
                }
                if ($detailed) { $cells.Add($entry) }
            }
            if (-not $detailed) { $blockValues[$r - 1] = $line }
        }
        if (-not $detailed) {
            [object[]]$blockFormulaOutput = @($blockFormulas)
            $rowBlocks.Add([ordered]@{
                    startRow    = $rangeStartRow
                    startColumn = $rangeStartColumn
                    rowCount    = $rangeRows
                    columnCount = $rangeColumns
                    values      = $blockValues
                    formulas    = $blockFormulaOutput
                })
        }
        $cursor += $take
        $remaining -= $take
    }
    $lineage = @($formulaEntries | ForEach-Object {
            [ordered]@{
                path       = "$($_.path)/lineage"
                from       = $_.path
                formula    = $_.formula
                precedents = @(Excel-FormulaPrecedents ([string]$_.formula) ([string]$sheet.Name))
            }
        })
    [object[]]$cellOutput = @()
    [object[]]$rowBlockOutput = @()
    if ($detailed) { $cellOutput = @($cells) } else { $rowBlockOutput = @($rowBlocks) }
    return [ordered]@{
        format      = 'xlsx'
        path        = [string]$book.FullName
        activeSheet = [string]$book.ActiveSheet.Name
        sheetCount  = [int]$book.Worksheets.Count
        sheets      = @([ordered]@{
                path           = "/sheet[$([string]$sheet.Name)]"
                name           = [string]$sheet.Name
                rows           = $rowCount
                columns        = $columnCount
                address        = [string]$base.Address($false, $false)
                cellCount      = $total
                representation = $(if ($detailed) { 'cells' } else { 'row-blocks' })
                cells          = $cellOutput
                rowBlocks      = $rowBlockOutput
                lineageCount   = $lineage.Count
                formulaLineage = $lineage
                truncated      = $cursor -lt $total
            })
        pagination  = [ordered]@{
            unit       = 'cell'
            scope      = "$([string]$sheet.Name)!$([string]$base.Address($false, $false))"
            offset     = $offset
            limit      = $limit
            returned   = $populated
            scanned    = $cursor - $offset
            total      = $total
            nextOffset = $(if ($cursor -lt $total) { $cursor } else { $null })
        }
    }
}

# The notes body is located by placeholder type, never by position. A notes page
# written outside PowerPoint carries no slide-image placeholder, so asking for
# item 2 threw and every speaker note authored by the portable backend read back
# as null instead of its text.
function PowerPoint-NotesText($slide) {
    $text = ''
    try {
        foreach ($notesShape in @($slide.NotesPage.Shapes)) {
            $isNotesBody = $false
            try { $isNotesBody = [int]$notesShape.PlaceholderFormat.Type -eq 2 } catch {}
            if (-not $isNotesBody) { continue }
            if ($notesShape.HasTextFrame -and $notesShape.TextFrame.HasText) {
                $text = [string]$notesShape.TextFrame.TextRange.Text
            }
            break
        }
    }
    catch {}
    return $text
}

function Snapshot-PowerPoint($presentation, $payload) {
    $slides = @()
    $slideOffset = if ($payload.paged) { [Math]::Max(0, [int]$payload.offset) } else { 0 }
    $slideLimit = if ($payload.paged) { [Math]::Max(1, [int]$payload.limit) } else { [int]$presentation.Slides.Count }
    $slideNumbers = if ($payload.pages) {
        @($payload.pages | ForEach-Object { [int]$_ })
    }
    else {
        $end = [Math]::Min([int]$presentation.Slides.Count, $slideOffset + $slideLimit)
        if ($end -le $slideOffset) { @() } else { @(($slideOffset + 1)..$end) }
    }
    foreach ($slideNumber in $slideNumbers) {
        if ($slideNumber -lt 1 -or $slideNumber -gt $presentation.Slides.Count) { throw "PowerPoint slide out of range: $slideNumber" }
        $slide = $presentation.Slides.Item($slideNumber)
        $shapes = @()
        for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
            $shape = $slide.Shapes.Item($shapeIndex)
            # Every $shape.A.B.C is a separate cross-process call into PowerPoint, so each chain is walked once
            # per shape and reused below: a 10-slide deck was paying thousands of round trips (snapshot ~20 s).
            $text = $null
            $textFrameRef = $null
            $textRangeRef = $null
            $rangeFontRef = $null
            $textRange2Ref = $null
            try {
                if ($shape.HasTextFrame) {
                    $textFrameRef = $shape.TextFrame
                    $textRangeRef = $textFrameRef.TextRange
                    $rangeFontRef = $textRangeRef.Font
                    if ($textFrameRef.HasText) { $text = [string]$textRangeRef.Text }
                    try { $textRange2Ref = $shape.TextFrame2.TextRange } catch {}
                }
            }
            catch {}
            $fillRef = $(try { $shape.Fill } catch { $null })
            $lineRef = $(try { $shape.Line } catch { $null })
            $shadowRef = $(try { $shape.Shadow } catch { $null })
            $placeholder = $null
            try {
                if ([int]$shape.Type -eq 14) {
                    $placeholder = [ordered]@{
                        type  = [int]$shape.PlaceholderFormat.Type
                        index = [int]$shape.PlaceholderFormat.Index
                    }
                }
            }
            catch {}
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
            }
            catch {}
            $crop = $null
            try {
                if ([int]$shape.Type -eq 13) {
                    $crop = [ordered]@{
                        left   = [double]$shape.PictureFormat.CropLeft
                        right  = [double]$shape.PictureFormat.CropRight
                        top    = [double]$shape.PictureFormat.CropTop
                        bottom = [double]$shape.PictureFormat.CropBottom
                    }
                }
            }
            catch {}
            $table = $null
            try {
                if ($shape.HasTable) {
                    $rows = @()
                    for ($rowIndex = 1; $rowIndex -le $shape.Table.Rows.Count; $rowIndex++) {
                        $cells = @()
                        for ($columnIndex = 1; $columnIndex -le $shape.Table.Columns.Count; $columnIndex++) {
                            $cells += [string]$shape.Table.Cell($rowIndex, $columnIndex).Shape.TextFrame.TextRange.Text
                        }
                        $rows += , $cells
                    }
                    $table = [ordered]@{
                        rows    = [int]$shape.Table.Rows.Count
                        columns = [int]$shape.Table.Columns.Count
                        values  = $rows
                    }
                }
            }
            catch {}
            # Preset geometry in the OOXML vocabulary the portable snapshot reports, so the
            # composition receipt reads a chevron, a brace, or a rule the same way on both backends.
            $geometry = ''
            try {
                $shapeType = [int]$shape.Type
                if ($shapeType -eq 9) { $geometry = 'line' }
                elseif ($shapeType -eq 5) { $geometry = 'custGeom' }
                elseif ($shapeType -eq 1 -or $shapeType -eq 14) {
                    $auto = [int]$shape.AutoShapeType
                    $presetNames = @{ 1 = 'rect'; 2 = 'parallelogram'; 3 = 'trapezoid'; 4 = 'diamond'; 5 = 'roundRect'; 6 = 'octagon'; 7 = 'triangle'; 8 = 'rtTriangle'; 9 = 'ellipse'; 10 = 'hexagon'; 11 = 'plus'; 12 = 'pentagon'; 13 = 'can'; 14 = 'cube'; 15 = 'bevel'; 16 = 'foldedCorner'; 18 = 'donut'; 20 = 'blockArc'; 25 = 'arc'; 26 = 'bracketPair'; 27 = 'bracePair'; 29 = 'leftBracket'; 30 = 'rightBracket'; 31 = 'leftBrace'; 32 = 'rightBrace'; 33 = 'rightArrow'; 34 = 'leftArrow'; 35 = 'upArrow'; 36 = 'downArrow'; 37 = 'leftRightArrow'; 38 = 'upDownArrow'; 51 = 'homePlate'; 52 = 'chevron'; 105 = 'wedgeRectCallout'; 106 = 'wedgeRoundRectCallout'; 107 = 'wedgeEllipseCallout' }
                    if ($auto -gt 0) { $geometry = $(if ($presetNames.ContainsKey($auto)) { [string]$presetNames[$auto] } else { "auto$auto" }) }
                }
            }
            catch {}
            $shapes += [ordered]@{
                path             = "/slide[$([int]$slide.SlideIndex)]/shape[$shapeIndex]"
                index            = $shapeIndex
                name             = [string]$shape.Name
                type             = [int]$shape.Type
                geometry         = $geometry
                text             = $text
                placeholder      = $placeholder
                group            = $group
                crop             = $crop
                table            = $table
                left             = [double]$shape.Left
                top              = [double]$shape.Top
                width            = [double]$shape.Width
                height           = [double]$shape.Height
                rotation         = [double]$shape.Rotation
                fillColor        = $(try { [double]$fillRef.ForeColor.RGB } catch { $null })
                fillVisible      = $(try { [int]$fillRef.Visible -ne 0 } catch { $null })
                fillTransparency = $(try { [double]$fillRef.Transparency } catch { $null })
                lineColor        = $(try { [double]$lineRef.ForeColor.RGB } catch { $null })
                lineTransparency = $(try { [double]$lineRef.Transparency } catch { $null })
                shadow           = $(try {
                        [ordered]@{
                            visible      = [int]$shadowRef.Visible
                            color        = [double]$shadowRef.ForeColor.RGB
                            transparency = [double]$shadowRef.Transparency
                            blur         = [double]$shadowRef.Blur
                            offsetX      = [double]$shadowRef.OffsetX
                            offsetY      = [double]$shadowRef.OffsetY
                        }
                    }
                    catch { $null })
                textFrame        = $(try {
                        [ordered]@{
                            marginLeft       = [double]$textFrameRef.MarginLeft
                            marginTop        = [double]$textFrameRef.MarginTop
                            marginRight      = [double]$textFrameRef.MarginRight
                            marginBottom     = [double]$textFrameRef.MarginBottom
                            paragraphSpacing = [double]$textRangeRef.ParagraphFormat.SpaceBefore
                        }
                    }
                    catch { $null })
                textBounds       = $(try {
                        [ordered]@{
                            width  = [double]$textRange2Ref.BoundWidth
                            height = [double]$textRange2Ref.BoundHeight
                        }
                    }
                    catch { $null })
                font             = $(try {
                        [ordered]@{
                            name   = [string]$rangeFontRef.Name
                            size   = [double]$rangeFontRef.Size
                            bold   = [int]$rangeFontRef.Bold
                            italic = [int]$rangeFontRef.Italic
                            # RRGGBB, as the portable snapshot reports it and every colour input takes it: a BGR long
                            # copied from here into add_textbox was refused, and a mixed range answers a negative
                            # sentinel (-2147483648), which is left out.
                            # A range whose runs differ (an authored title's line-break runs carry no colour of their own)
                            # answers the sentinel; the colour of its first run with text stands in, as the portable reader
                            # reports it.
                            color  = $(try {
                                    $rgb = [long]$rangeFontRef.Color.RGB
                                    if ($rgb -lt 0 -or $rgb -gt 16777215) {
                                        $runTotal = [Math]::Min([int]$textRangeRef.Runs().Count, 8)
                                        for ($ri = 1; $ri -le $runTotal; $ri++) {
                                            $run = $textRangeRef.Runs($ri, 1)
                                            if ([string]$run.Text -match '\S') { $rgb = [long]$run.Font.Color.RGB; break }
                                        }
                                    }
                                    if ($rgb -ge 0 -and $rgb -le 16777215) { Color-Hex $rgb } else { $null }
                                }
                                catch { $null })
                        }
                    }
                    catch { $null })
                # Per-run sizes and colors: TextRange.Font reports a mixed range as -2147483648, so the composition
                # receipt reads the distinct run values instead (type scale and text colors in use). A uniform range
                # answers in two reads — walking every run of every shape is what made the snapshot cost seconds a slide.
                runs             = $(try {
                        if (-not $rangeFontRef -or -not $text) { $null } else {
                            $rangeSize = [double]$rangeFontRef.Size
                            $rangeColor = [double]$rangeFontRef.Color.RGB
                            if ($rangeSize -gt 0 -and $rangeColor -ge 0) {
                                [ordered]@{ sizes = @($rangeSize); colors = @($rangeColor) }
                            }
                            else {
                                $runSizes = @(); $runColors = @()
                                $runCount = [Math]::Min([int]$textRangeRef.Runs().Count, 40)
                                for ($ri = 1; $ri -le $runCount; $ri++) {
                                    $run = $textRangeRef.Runs($ri, 1)
                                    if ([string]$run.Text -match '\S') { $runSizes += [double]$run.Font.Size; $runColors += [double]$run.Font.Color.RGB }
                                }
                                [ordered]@{ sizes = @(@($runSizes | Sort-Object -Unique)); colors = @(@($runColors | Sort-Object -Unique)) }
                            }
                        }
                    }
                    catch { $null })
                chart            = $(try {
                        if ($shape.HasChart) {
                            $chart = $shape.Chart
                            [ordered]@{
                                path        = "/slide[$([int]$slide.SlideIndex)]/shape[$shapeIndex]/chart"
                                chartType   = [int]$chart.ChartType
                                title       = $(if ($chart.HasTitle) { [string]$chart.ChartTitle.Text } else { '' })
                                seriesCount = [int]$chart.SeriesCollection().Count
                                series      = $(try {
                                        $items = @()
                                        for ($seriesIndex = 1; $seriesIndex -le $chart.SeriesCollection().Count; $seriesIndex++) {
                                            $series = $chart.SeriesCollection().Item($seriesIndex)
                                            $items += [ordered]@{
                                                index          = $seriesIndex
                                                name           = [string]$series.Name
                                                formula        = ''
                                                chartType      = $(try { [int]$series.ChartType } catch { $null })
                                                axisGroup      = $(try { [int]$series.AxisGroup } catch { $null })
                                                trendlineCount = $(try { [int]$series.Trendlines().Count } catch { 0 })
                                                hasErrorBars   = $(try { [bool]$series.HasErrorBars } catch { $false })
                                                hasDataLabels  = [bool]$series.HasDataLabels
                                                dataLabels     = $(if ($series.HasDataLabels) {
                                                        [ordered]@{
                                                            showValue        = [bool]$series.DataLabels().ShowValue
                                                            showCategoryName = [bool]$series.DataLabels().ShowCategoryName
                                                            numberFormat     = [string]$series.DataLabels().NumberFormat
                                                            position         = [int]$series.DataLabels().Position
                                                        }
                                                    }
                                                    else { $null })
                                            }
                                        }
                                        , $items
                                    }
                                    catch { , @() })
                                axes        = $(try {
                                        $axes = @()
                                        foreach ($axisSpec in @(
                                                [ordered]@{ name = 'category'; type = 1 },
                                                [ordered]@{ name = 'value'; type = 2 }
                                            )) {
                                            $axis = $chart.Axes([int]$axisSpec.type, 1)
                                            $axes += [ordered]@{
                                                type         = [string]$axisSpec.name
                                                title        = $(if ($axis.HasTitle) { [string]$axis.AxisTitle.Text } else { '' })
                                                minimum      = $(try { [double]$axis.MinimumScale } catch { $null })
                                                maximum      = $(try { [double]$axis.MaximumScale } catch { $null })
                                                majorUnit    = $(try { [double]$axis.MajorUnit } catch { $null })
                                                numberFormat = $(try { [string]$axis.TickLabels.NumberFormat } catch { '' })
                                            }
                                        }
                                        $axes
                                    }
                                    catch { @() })
                            }
                        }
                        else { $null }
                    }
                    catch { $null })
            }
        }
        $notes = PowerPoint-NotesText $slide
        $comments = @()
        try {
            for ($commentIndex = 1; $commentIndex -le $slide.Comments.Count; $commentIndex++) {
                $comment = $slide.Comments.Item($commentIndex)
                $comments += [ordered]@{
                    path     = "/slide[$([int]$slide.SlideIndex)]/comment[$commentIndex]"
                    index    = $commentIndex
                    author   = [string]$comment.Author
                    initials = [string]$comment.AuthorInitials
                    text     = [string]$comment.Text
                    left     = [double]$comment.Left
                    top      = [double]$comment.Top
                }
            }
        }
        catch {}
        $animations = @()
        try {
            $sequence = $slide.TimeLine.MainSequence
            for ($effectIndex = 1; $effectIndex -le $sequence.Count; $effectIndex++) {
                $effect = $sequence.Item($effectIndex)
                $animations += [ordered]@{
                    index    = $effectIndex
                    shape    = [string]$effect.Shape.Name
                    effect   = [int]$effect.EffectType
                    trigger  = [int]$effect.Timing.TriggerType
                    duration = [double]$effect.Timing.Duration
                    delay    = [double]$effect.Timing.TriggerDelayTime
                }
            }
        }
        catch {}
        $layoutName = $(try { [string]$slide.CustomLayout.Name } catch { '' })
        $layoutIndex = 0
        try {
            for ($candidateIndex = 1; $candidateIndex -le $presentation.SlideMaster.CustomLayouts.Count; $candidateIndex++) {
                if ([string]::Equals([string]$presentation.SlideMaster.CustomLayouts.Item($candidateIndex).Name, $layoutName, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $layoutIndex = $candidateIndex
                    break
                }
            }
        }
        catch {}
        $followMasterBackground = $(try { [bool]$slide.FollowMasterBackground } catch { $false })
        $backgroundSource = $(if ($followMasterBackground) { 'layout' } else { 'slide' })
        $backgroundColor = $null
        try {
            if ($followMasterBackground) {
                try {
                    $backgroundColor = Color-Hex ([long]$slide.CustomLayout.Background.Fill.ForeColor.RGB)
                }
                catch {}
                if (-not $backgroundColor) {
                    $backgroundSource = 'master'
                    try { $backgroundColor = Color-Hex ([long]$presentation.SlideMaster.Background.Fill.ForeColor.RGB) } catch {}
                }
            }
            else {
                $backgroundColor = Color-Hex ([long]$slide.Background.Fill.ForeColor.RGB)
            }
        }
        catch {}
        $slides += [ordered]@{
            path       = "/slide[$([int]$slide.SlideIndex)]"
            index      = [int]$slide.SlideIndex
            # A hidden slide ships with the deck and is skipped when it is shown; both
            # readers must say so, or a withdrawn page is summarized as presented.
            hidden     = $(try { [bool]$slide.SlideShowTransition.Hidden } catch { $false })
            layout     = [ordered]@{ index = $layoutIndex; name = $layoutName }
            background = [ordered]@{
                followMaster = $followMasterBackground
                source       = $backgroundSource
                color        = $backgroundColor
            }
            shapes     = $shapes
            notes      = $notes
            comments   = $comments
            animations = $animations
            transition = [ordered]@{
                effect        = $(try { [int]$slide.SlideShowTransition.EntryEffect } catch { 0 })
                advanceOnTime = $(try { [bool]$slide.SlideShowTransition.AdvanceOnTime } catch { $false })
                advanceTime   = $(try { [double]$slide.SlideShowTransition.AdvanceTime } catch { 0 })
            }
        }
    }
    $layouts = @()
    try {
        for ($layoutIndex = 1; $layoutIndex -le $presentation.SlideMaster.CustomLayouts.Count; $layoutIndex++) {
            $layout = $presentation.SlideMaster.CustomLayouts.Item($layoutIndex)
            $layouts += [ordered]@{
                path  = "/layout[$layoutIndex]"
                index = $layoutIndex
                name  = [string]$layout.Name
            }
        }
    }
    catch {}
    $designs = @()
    try {
        for ($designIndex = 1; $designIndex -le $presentation.Designs.Count; $designIndex++) {
            $design = $presentation.Designs.Item($designIndex)
            $designs += [ordered]@{
                index = $designIndex
                name  = [string]$design.Name
            }
        }
    }
    catch {}
    return [ordered]@{
        format      = 'pptx'
        path        = [string]$presentation.FullName
        slideCount  = $presentation.Slides.Count
        slideWidth  = [double]$presentation.PageSetup.SlideWidth
        slideHeight = [double]$presentation.PageSetup.SlideHeight
        layoutCount = $layouts.Count
        layouts     = $layouts
        designCount = $designs.Count
        designs     = $designs
        slides      = $slides
        theme       = $(try { [string]$presentation.Designs.Item(1).Name } catch { '' })
        pagination  = $(if ($payload.paged) {
                [ordered]@{
                    unit       = 'slide'
                    offset     = $slideOffset
                    limit      = $slideLimit
                    returned   = $slides.Count
                    total      = [int]$presentation.Slides.Count
                    nextOffset = $(if (-not $payload.pages -and $slideOffset + $slides.Count -lt [int]$presentation.Slides.Count) { $slideOffset + $slides.Count } else { $null })
                }
            }
            else { $null })
    }
}

function Same-OfficePath([string]$left, [string]$right) {
    try {
        return [string]::Equals(
            [System.IO.Path]::GetFullPath($left),
            [System.IO.Path]::GetFullPath($right),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    catch {
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
                    kind      = $(if ([int]$range.Start -eq [int]$range.End) { 'insertion-point' } else { 'text' })
                    target    = $target
                    key       = "$target`:$([int]$range.Start)-$([int]$range.End)"
                    start     = [int]$range.Start
                    end       = [int]$range.End
                    text      = $([string]$range.Text).TrimEnd("`r", "`a")
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
                    available  = $true
                    kind       = 'range'
                    target     = $target
                    key        = "$([string]$sheet.Name)!$address@$activeCell"
                    sheet      = [string]$sheet.Name
                    address    = $address
                    activeCell = $activeCell
                    rows       = [int]$selection.Rows.Count
                    columns    = [int]$selection.Columns.Count
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
                }
                elseif ($selectionType -eq 1) {
                    foreach ($selectedSlide in @($selection.SlideRange)) { $paths += "/slide[$([int]$selectedSlide.SlideIndex)]" }
                }
                elseif ($slideIndex -gt 0) {
                    $paths += "/slide[$slideIndex]"
                }
                return [ordered]@{
                    available     = $true
                    kind          = $(switch ($selectionType) { 1 { 'slides' } 2 { 'shapes' } 3 { 'text' } default { 'none' } })
                    target        = $(if ($paths.Count -gt 0) { [string]$paths[0] } else { '/' })
                    targets       = $paths
                    key           = "$selectionType`:$($paths -join ',')"
                    slide         = $slideIndex
                    selectionType = $selectionType
                }
            }
        }
    }
    catch {
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

# A Word table's per-column text alignment: every paragraph of every cell in the
# column, the way the portable backend writes each cell's justification.
function Set-WordTableColumnAlignments($table, $alignments) {
    $values = @($alignments)
    $columnCount = [int]$table.Columns.Count
    for ($column = 1; $column -le [Math]::Min($columnCount, $values.Count); $column++) {
        $alignment = switch (([string]$values[$column - 1]).ToLowerInvariant()) { 'center' { 1 } 'right' { 2 } 'justify' { 3 } default { 0 } }
        for ($row = 1; $row -le [int]$table.Rows.Count; $row++) {
            try { $table.Cell($row, $column).Range.ParagraphFormat.Alignment = $alignment } catch {}
        }
    }
}

# An unstyled table reads the same on both backends: a rule under the header and
# hairlines between rows (the portable writer's default borders); an explicit
# style, borders, or shading replaces it.
function Set-WordTableDefaultRules($table) {
    try {
        $table.Borders.Enable = 0
        $bottom = $table.Borders.Item(-3)   # wdBorderBottom
        $bottom.LineStyle = 1; $bottom.LineWidth = 4; $bottom.Color = Color-Value 'BFC5CB'
        $inside = $table.Borders.Item(-5)   # wdBorderHorizontal
        $inside.LineStyle = 1; $inside.LineWidth = 2; $inside.Color = Color-Value 'D8DCE0'
    }
    catch {}
}

# Explicit table borders in the portable writer's vocabulary: one spec for every
# side, or { top, left, bottom, right, insideH, insideV } each { enabled?, style?,
# size? (eighths of a point), color? }. A stat strip keeps only its bottom rule
# on both backends instead of Word's full grid.
function Set-WordTableBorders($table, $borders) {
    $sides = [ordered]@{ top = -1; left = -2; bottom = -3; right = -4; insideH = -5; insideV = -6 }
    # A bare true or a style name is one spec for every side; only an object can
    # name sides (a boolean has no properties, and a null name is no key).
    $named = @()
    if ($borders -isnot [bool] -and $borders -isnot [string]) {
        $named = @($borders.PSObject.Properties | ForEach-Object { $_.Name } | Where-Object { $_ -and $sides.Contains($_) })
    }
    $uniform = $named.Count -eq 0
    foreach ($side in $sides.Keys) {
        $spec = if ($uniform) { $borders } else { $borders.$side }
        $edge = $table.Borders.Item($sides[$side])
        $style = if ($null -eq $spec) { 'none' } elseif ($spec -is [string]) { $spec } elseif ($spec.style) { [string]$spec.style } else { 'single' }
        if ($spec -eq $false -or $spec.enabled -eq $false -or $style -eq 'none' -or $style -eq 'nil') {
            try { $edge.LineStyle = 0 } catch {}
            continue
        }
        try {
            $edge.LineStyle = switch ($style) { 'dashed' { 3 } 'dotted' { 2 } 'double' { 7 } default { 1 } }
            $size = if ($spec -isnot [string] -and $spec.size) { [int]$spec.size } else { 4 }
            $edge.LineWidth = $(if ($size -le 2) { 2 } elseif ($size -le 4) { 4 } elseif ($size -le 6) { 6 } elseif ($size -le 8) { 8 } elseif ($size -le 12) { 12 } elseif ($size -le 18) { 18 } elseif ($size -le 24) { 24 } elseif ($size -le 36) { 36 } else { 48 })
            if ($spec -isnot [string] -and $spec.color) { $edge.Color = Color-Value ([string]$spec.color) }
        }
        catch {}
    }
}

# The document's own bullet list: the same marks, face, and hanging indent the
# portable numbering part writes, so a list reads alike on both backends. Word's
# gallery default is a heavy Symbol bullet, and the gallery belongs to the user's
# template, not to this document.
function Get-WordBulletTemplate($doc) {
    foreach ($existing in @($doc.ListTemplates)) {
        try { if ([string]$existing.Name -eq 'MixdogBullet') { return $existing } } catch {}
    }
    $template = $doc.ListTemplates.Add($true, 'MixdogBullet')
    $marks = @([string][char]0x2022, [string][char]0x25E6, [string][char]0x25AA)
    for ($level = 1; $level -le 3; $level++) {
        $entry = $template.ListLevels.Item($level)
        # A literal mark with no %n placeholder is the bullet; setting NumberStyle
        # to the bullet style on an outline template throws (0x800A1200).
        $entry.NumberFormat = $marks[$level - 1]
        $entry.Font.Name = 'Arial'
        $entry.NumberPosition = [single](36 * $level - 18)
        $entry.TextPosition = [single](36 * $level)
        $entry.TabPosition = [single](36 * $level)
        $entry.TrailingCharacter = 0
    }
    return $template
}

# The document's own numbered list, as the portable numbering part writes it: 1. / a. / i. on the bullet list's
# hanging indents. Word's gallery default continued whatever list came before — after a bullet list the numbered
# items came out as bullets.
function Get-WordNumberTemplate($doc) {
    foreach ($existing in @($doc.ListTemplates)) {
        try { if ([string]$existing.Name -eq 'MixdogNumber') { return $existing } } catch {}
    }
    $template = $doc.ListTemplates.Add($true, 'MixdogNumber')
    # wdListNumberStyleArabic, LowercaseLetter, LowercaseRoman.
    $styles = @(0, 4, 2)
    for ($level = 1; $level -le 3; $level++) {
        $entry = $template.ListLevels.Item($level)
        $entry.NumberFormat = "%$level."
        $entry.NumberStyle = $styles[$level - 1]
        $entry.StartAt = 1
        $entry.NumberPosition = [single](36 * $level - 18)
        $entry.TextPosition = [single](36 * $level)
        $entry.TabPosition = [single](36 * $level)
        $entry.TrailingCharacter = 0
    }
    return $template
}

# An item right after a list item continues the numbered list; after a heading, a body paragraph, or a table it
# starts again at 1, as the portable writer numbers it.
function Apply-WordNumber($doc, $paragraph, $index) {
    $continue = $false
    if ($index -gt 1) {
        $previous = $doc.Paragraphs.Item($index - 1).Range
        $continue = ([int]$previous.ListFormat.ListType -ne 0) -and -not [bool]$previous.Information(12)
    }
    try {
        $paragraph.Range.ListFormat.ApplyListTemplate((Get-WordNumberTemplate $doc), $continue, 2)
        $paragraph.Range.ListFormat.ListLevelNumber = 1
    }
    catch { $paragraph.Range.ListFormat.ApplyNumberDefault() }
}

function Apply-WordBullet($doc, $paragraph) {
    try {
        # Applied to this paragraph only (wdListApplyToSelection), continuing the
        # list before it, at the first level: applying to the whole list renumbered
        # the earlier items into the template's deeper levels.
        $paragraph.Range.ListFormat.ApplyListTemplate((Get-WordBulletTemplate $doc), $true, 2)
        $paragraph.Range.ListFormat.ListLevelNumber = 1
    }
    catch { $paragraph.Range.ListFormat.ApplyBulletDefault() }
}

# Excel reads the colour of a number format section in its UI language even through the English NumberFormat
# property: a Korean Excel refuses "#,##0;[Red]-#,##0" (the whole batch failed) and takes "[빨강]", and reports the
# colour back the same way. The file format and the portable writer keep the English names, so the Office backend
# translates on the way in and out for the UI languages it knows. The names are code points: the host script is read
# without a byte-order mark, and a literal Hangul string arrives mangled.
function Excel-Word([int[]]$codes) { return -join ($codes | ForEach-Object { [char]$_ }) }
$script:ExcelColorNames = @{
    # Korean: 검정 파랑 녹청 녹색 자홍 빨강 흰색 노랑, and 색N for ColorN.
    1042 = @{
        Black   = Excel-Word 0xAC80, 0xC815
        Blue    = Excel-Word 0xD30C, 0xB791
        Cyan    = Excel-Word 0xB179, 0xCCAD
        Green   = Excel-Word 0xB179, 0xC0C9
        Magenta = Excel-Word 0xC790, 0xD64D
        Red     = Excel-Word 0xBE68, 0xAC15
        White   = Excel-Word 0xD770, 0xC0C9
        Yellow  = Excel-Word 0xB178, 0xB791
        Color   = Excel-Word 0xC0C9
    }
}
$script:ExcelColorNamesInUse = $null
$script:ExcelColorPattern = '\[(Black|Blue|Cyan|Green|Magenta|Red|White|Yellow|Color(\d{1,2}))\]'
$script:ExcelColorKeys = @('Black', 'Blue', 'Cyan', 'Green', 'Magenta', 'Red', 'White', 'Yellow')

function Excel-ColorNames($application) {
    if ($null -eq $script:ExcelColorNamesInUse) {
        $language = $(try { [int]$application.LanguageSettings.LanguageID(2) } catch { 0 })
        $script:ExcelColorNamesInUse = if ($script:ExcelColorNames.ContainsKey($language)) { $script:ExcelColorNames[$language] } else { @{} }
    }
    return $script:ExcelColorNamesInUse
}

# A format whose colours Excel refuses by their English names is written with the UI language's; an install whose
# names are not known here keeps the format without the colour rather than failing the batch.
function Set-ExcelNumberFormat($target, [string]$format) {
    try {
        $target.NumberFormat = $format
        return
    }
    catch {
        if ($format -notmatch $script:ExcelColorPattern) { throw }
    }
    $names = Excel-ColorNames $target.Application
    if ($names.Count) {
        $local = [regex]::Replace($format, $script:ExcelColorPattern, [System.Text.RegularExpressions.MatchEvaluator]{
                param($match)
                if ($match.Groups[2].Success) { return "[$($names.Color)$($match.Groups[2].Value)]" }
                return "[$($names[$match.Groups[1].Value])]"
            }.GetNewClosure(), 'IgnoreCase')
        try {
            $target.NumberFormat = $local
            return
        }
        catch {}
    }
    $target.NumberFormat = [regex]::Replace($format, $script:ExcelColorPattern, '', 'IgnoreCase')
}

# A range's format as the file and the portable writer spell it: the UI language's colour names back in English.
function Excel-EnglishNumberFormat($range) {
    $format = [string]$range.NumberFormat
    if ($format -notmatch '\[') { return $format }
    $names = Excel-ColorNames $range.Application
    if (-not $names.Count) { return $format }
    foreach ($key in $script:ExcelColorKeys) { $format = $format.Replace("[$($names[$key])]", "[$key]") }
    return [regex]::Replace($format, "\[$([regex]::Escape($names.Color))(\d{1,2})\]", '[Color$1]')
}

# A chart or picture beside a table is wider than a portrait page. A sheet that
# declares no fit, print scale, or print area takes one page wide and keeps
# paging down (a fit only scales down, so a small sheet prints as before); a
# declared setup is the author's and stays. Returns the fit applied, or $null.
# PageSetup needs a printer driver; without one the sheet is left as it is.
function Set-ExcelSheetOnePageWide($sheet) {
    try {
        $setup = $sheet.PageSetup
        if ($setup.Zoom -eq $false) { return $null }
        if ([int]$setup.Zoom -ne 100) { return $null }
        if (-not [string]::IsNullOrWhiteSpace([string]$setup.PrintArea)) { return $null }
        $setup.Zoom = $false
        $setup.FitToPagesWide = 1
        $setup.FitToPagesTall = $false
        return 'one-page-wide'
    }
    catch { return $null }
}

# The chart kinds the portable writer draws, by the XlChartType Excel and PowerPoint take. An unknown name is refused
# as the portable writer refuses it: falling back to a clustered column drew "stacked_column" as side-by-side bars.
function Office-ChartTypeCode($chartType) {
    if ($null -eq $chartType -or [string]::IsNullOrWhiteSpace([string]$chartType)) { return 51 }
    if ($chartType -is [int] -or $chartType -is [long] -or $chartType -is [double]) { return [int]$chartType }
    $codes = [ordered]@{ column = 51; bar = 57; stacked_column = 52; stacked_bar = 58; line = 4; area = 1; pie = 5; doughnut = -4120; scatter = -4169 }
    $kind = ([string]$chartType).Trim().ToLowerInvariant() -replace '[\s-]+', '_'
    if ($kind -eq 'donut') { $kind = 'doughnut' }
    if ($codes.Contains($kind)) { return [int]$codes[$kind] }
    $number = 0
    if ([int]::TryParse($kind, [ref]$number)) { return $number }
    throw "Unknown chart type: $chartType; use one of $($codes.Keys -join ', ')"
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
    }
    else {
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
        }
        catch {}
    }
    return $ranges
}

function Template-CountFilled($filled, [string]$key, [int]$count) {
    $filled[$key] = $(if ($filled.Contains($key)) { [int]$filled[$key] + $count } else { $count })
}

function Fill-WordTemplate($doc, $op) {
    $values = Template-ValueMap $op
    $filled = [ordered]@{}
    foreach ($range in @(Word-StoryRanges $doc)) {
        $text = [string]$range.Text
        # The token with its particle first (shared/korean-particles.mjs): "{{company}}은 " lands as 모아페이는.
        foreach ($entry in @($op.particles)) {
            if ($null -eq $entry) { continue }
            $count = [regex]::Matches($text, [regex]::Escape([string]$entry.find)).Count
            if ($count -eq 0) { continue }
            $search = $range.Duplicate
            if ($search.Find.Execute([string]$entry.find, $false, $false, $false, $false, $false, $true, 0, $false, [string]$entry.replace, 2)) {
                Template-CountFilled $filled ([string]$entry.key) $count
            }
        }
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
    }
    catch {}
    try {
        if ($shape.HasTable) {
            for ($row = 1; $row -le $shape.Table.Rows.Count; $row++) {
                for ($column = 1; $column -le $shape.Table.Columns.Count; $column++) {
                    $ranges += $shape.Table.Cell($row, $column).Shape.TextFrame.TextRange
                }
            }
        }
    }
    catch {}
    try {
        if ([int]$shape.Type -eq 6) {
            for ($index = 1; $index -le $shape.GroupItems.Count; $index++) {
                $ranges += @(PowerPoint-ShapeTextRanges $shape.GroupItems.Item($index))
            }
        }
    }
    catch {}
    return $ranges
}

function PowerPoint-TextRanges($presentation) {
    $ranges = @()
    foreach ($slide in @($presentation.Slides)) {
        foreach ($shape in @($slide.Shapes)) { $ranges += @(PowerPoint-ShapeTextRanges $shape) }
        try {
            foreach ($shape in @($slide.NotesPage.Shapes)) { $ranges += @(PowerPoint-ShapeTextRanges $shape) }
        }
        catch {}
    }
    return $ranges
}

function Fill-PowerPointTemplate($presentation, $op) {
    $values = Template-ValueMap $op
    $filled = [ordered]@{}
    foreach ($range in @(PowerPoint-TextRanges $presentation)) {
        $text = [string]$range.Text
        foreach ($entry in @($op.particles)) {
            if ($null -eq $entry) { continue }
            $expected = [regex]::Matches($text, [regex]::Escape([string]$entry.find)).Count
            $replaced = 0
            $after = 0
            while ($replaced -lt $expected) {
                $found = $range.Replace([string]$entry.find, [string]$entry.replace, $after, 0, 0)
                if ($null -eq $found) { break }
                $replaced++
                $after = [int]$found.Start + [Math]::Max([int]$found.Length, 1) - 1
            }
            if ($replaced -gt 0) { Template-CountFilled $filled ([string]$entry.key) $replaced }
        }
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

# Word reports styles under the UI language, so a Korean install answers "제목 1"
# where the package stores the styleId "Heading1". Handing that localized name to
# the portable backend writes an unknown w:pStyle value and the styling is lost,
# so reads are mapped back onto the same identifiers the writer accepts.
$script:WordBuiltinStyleIds = @{
    -1   = 'Normal'
    -2   = 'Heading1'
    -3   = 'Heading2'
    -4   = 'Heading3'
    -5   = 'Heading4'
    -6   = 'Heading5'
    -7   = 'Heading6'
    -8   = 'Heading7'
    -9   = 'Heading8'
    -10  = 'Heading9'
    -63  = 'Title'
    -75  = 'Subtitle'
    -106 = 'TableNormal'
    -155 = 'TableGrid'
    -181 = 'Quote'
    -182 = 'IntenseQuote'
}

$script:WordLocalStyleMap = $null

function Word-CanonicalStyleName($doc, [string]$localName) {
    if ([string]::IsNullOrWhiteSpace($localName)) { return '' }
    if ($null -eq $script:WordLocalStyleMap) {
        $map = @{}
        foreach ($entry in $script:WordBuiltinStyleIds.GetEnumerator()) {
            try {
                $local = [string]$doc.Styles.Item([int]$entry.Key).NameLocal
                if (-not [string]::IsNullOrWhiteSpace($local)) { $map[$local] = [string]$entry.Value }
            }
            catch {}
        }
        $script:WordLocalStyleMap = $map
    }
    if ($script:WordLocalStyleMap.ContainsKey($localName)) { return [string]$script:WordLocalStyleMap[$localName] }
    return $localName
}

function Word-StyleValue([string]$name) {
    # Built-in styles go by their id: a Korean Word names Quote "인용", so compose_document's quote failed by name.
    $styles = @{
        quote        = -181
        intensequote = -182
        normal    = -1
        heading1  = -2
        heading2  = -3
        heading3  = -4
        heading4  = -5
        heading5  = -6
        heading6  = -7
        heading7  = -8
        heading8  = -9
        heading9  = -10
        title     = -63
        subtitle  = -75
        tablegrid = -155
        # A Korean Word refuses these English names too ("캡션", "목록 단락", "간격 없음"): the ids reach them in any
        # language. (WdBuiltinStyle)
        caption          = -35
        listparagraph    = -180
        listbullet       = -49
        listbullet2      = -55
        listbullet3      = -56
        listnumber       = -50
        listnumber2      = -59
        listnumber3      = -60
        nospacing        = -158
        bodytext         = -67
        footnotetext     = -30
        endnotetext      = -44
        header           = -32
        footer           = -33
        tocheading       = -267
        toc1             = -20
        toc2             = -21
        toc3             = -22
        hyperlink        = -86
        strong           = -88
        emphasis         = -89
        subtleemphasis   = -261
        intenseemphasis  = -262
        booktitle        = -265
        blocktext        = -85
        plaintext        = -91
    }
    $key = $name.Replace(' ', '').Replace('-', '').ToLowerInvariant()
    if ($styles.ContainsKey($key)) { return [int]$styles[$key] }
    return $name
}

# A named style set on a range or a table. A name the document does not hold (a table style the template lacks, an
# English name of a style a Korean Word only knows in Korean) leaves the formatting as it was and is returned for the
# result to report, where it had failed the whole batch that the portable writer ran through.
function Set-WordStyle($target, [string]$name) {
    try {
        $target.Style = Word-StyleValue $name
        return $null
    }
    catch {
        return $name
    }
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
    # Word stamps tracked changes and comments with the application user name.
    # An explicit author on the operation labels them instead, and the name is
    # restored right after the operation whatever happens inside it.
    $authorLabel = if ($null -ne $op.author) { [string]$op.author } else { '' }
    if ([string]::IsNullOrWhiteSpace($authorLabel)) { return Invoke-WordOperation $doc $op }
    $app = $doc.Application
    $previousUserName = [string]$app.UserName
    # A signed-in Office account overrides the user name unless Word is told
    # to use the local values; both settings go back afterwards.
    $previousLocalInfo = $null
    try { $previousLocalInfo = [bool]$app.Options.UseLocalUserInfo } catch {}
    $initialsLabel = if ($null -ne $op.initials) { [string]$op.initials } else { '' }
    $previousInitials = $null
    if (-not [string]::IsNullOrWhiteSpace($initialsLabel)) { try { $previousInitials = [string]$app.UserInitials } catch {} }
    try {
        $app.UserName = $authorLabel
        if ($null -ne $previousInitials) { try { $app.UserInitials = $initialsLabel } catch {} }
        try { $app.Options.UseLocalUserInfo = $true } catch {}
        return Invoke-WordOperation $doc $op
    }
    finally {
        try { $app.UserName = $previousUserName } catch {}
        if ($null -ne $previousInitials) { try { $app.UserInitials = $previousInitials } catch {} }
        if ($null -ne $previousLocalInfo) { try { $app.Options.UseLocalUserInfo = $previousLocalInfo } catch {} }
    }
}

function Invoke-WordOperation($doc, $op) {
    switch ([string]$op.op) {
        'fill_template' { return Fill-WordTemplate $doc $op }
        'replace_text' {
            # Each match is found whole and only the words between the ones the find and the replacement share at
            # either end are rewritten (docx-tracked-edits.mjs sharedWordEdges): under tracking, "86억 원으로" →
            # "86억 원(잠정)으로" marks "원으로" → "원(잠정)으로", not the whole phrase.
            $find = [string]$op.find
            $replacement = [string]$op.replace
            if (-not $find) { throw 'replace_text requires non-empty find' }
            $before = @([regex]::Matches($find, '\s+|\S+') | ForEach-Object { $_.Value })
            $after = @([regex]::Matches($replacement, '\s+|\S+') | ForEach-Object { $_.Value })
            $lead = 0
            while ($lead -lt $before.Count -and $lead -lt $after.Count -and $before[$lead] -ceq $after[$lead]) { $lead++ }
            $trail = 0
            while ($trail -lt ($before.Count - $lead) -and $trail -lt ($after.Count - $lead) -and $before[$before.Count - 1 - $trail] -ceq $after[$after.Count - 1 - $trail]) { $trail++ }
            $leadChars = (@($before | Select-Object -First $lead) -join '').Length
            $trailChars = (@($before | Select-Object -Last $trail) -join '').Length
            if ($trail -eq 0) { $trailChars = 0 }
            $insert = (@($after | Select-Object -Skip $lead -First ($after.Count - $lead - $trail)) -join '')
            $count = 0
            $range = $doc.Content.Duplicate
            $resumeAt = 0
            while ($range.Find.Execute($find, $false, $false, $false, $false, $false, $true, 0)) {
                $matchStart = [int]$range.Start
                $matchEnd = [int]$range.End
                # A search resumed inside a table cell comes back to the cell's start and finds the struck words it just
                # replaced: under tracking, "old" → "new" in a cell ran ten thousand times until the host timed out. A
                # match before the point the search resumed from is the one already done.
                if ($matchStart -lt $resumeAt) { break }
                $deleted = ($matchEnd - $matchStart) - $leadChars - $trailChars
                $target = $doc.Range($matchStart + $leadChars, $matchEnd - $trailChars)
                $target.Text = $insert
                $count++
                if ($count -gt 10000) { break }
                # The search resumes past the whole edit. Under tracking the struck words stay in the story beside
                # the inserted ones, and Find still reads them, so resuming at the insertion's end found the same
                # phrase again and replaced it forever.
                $resume = if ($doc.TrackRevisions) { $matchEnd + $insert.Length } else { $matchEnd - $deleted + $insert.Length }
                $resumeAt = [Math]::Min($resume, [int]$doc.Content.End)
                $range = $doc.Range($resumeAt, [int]$doc.Content.End)
            }
            return [ordered]@{ op = 'replace_text'; changed = $count -gt 0; count = $count }
        }
        'append_text' {
            $text = [string]$op.text
            $existing = ([string]$doc.Content.Text).TrimEnd("`r", "`a")
            $reusedInitialParagraph = [string]::IsNullOrWhiteSpace($existing)
            if ($reusedInitialParagraph) {
                $paragraph = $doc.Paragraphs.Item(1)
                $paragraph.Range.Text = "$text`r"
            }
            else {
                $range = $doc.Content.Duplicate
                $range.Collapse(0)
                $paragraph = $doc.Paragraphs.Add($range)
                $paragraph.Range.Text = "$text`r"
            }
            $paragraphIndex = if ($reusedInitialParagraph) { 1 } else { [Math]::Max(1, [int]$doc.Paragraphs.Count - 1) }
            $paragraph = $doc.Paragraphs.Item($paragraphIndex)
            $props = $op.properties
            # The style comes first: applying a paragraph style resets its list format, so a bullet set before
            # style:'Normal' (compose_document's lists) was dropped in Word and kept by the portable writer.
            $style = if ($op.style) { [string]$op.style } elseif ($op.properties.style) { [string]$op.properties.style } else { '' }
            $styleNotFound = if ($style) { Set-WordStyle $paragraph.Range $style } else { $null }
            if ($props.listKind) {
                $kind = ([string]$props.listKind).ToLowerInvariant()
                if ($kind -eq 'number') {
                    Apply-WordNumber $doc $paragraph $paragraphIndex
                }
                elseif ($kind -ne 'none') {
                    Apply-WordBullet $doc $paragraph
                }
                else {
                    $paragraph.Range.ListFormat.RemoveNumbers()
                }
                if ([int]$props.listLevel -gt 0) {
                    # The level is a property of the list format; indenting one step at a
                    # time depends on the template's tab stops and can stop short.
                    try { $paragraph.Range.ListFormat.ListLevelNumber = [int]$props.listLevel + 1 } catch {
                        for ($level = 0; $level -lt [int]$props.listLevel; $level++) { $paragraph.Range.ListFormat.ListIndent() }
                    }
                }
            }
            elseif (-not $style) {
                # A named style already set the list format it carries (List Bullet keeps its bullet).
                $paragraph.Range.ListFormat.RemoveNumbers()
            }
            Set-WordRunFormat $paragraph.Range $props
            $format = $paragraph.Format
            if ($props.alignment) {
                $format.Alignment = Word-ParagraphAlignment $props.alignment
            }
            Set-WordParagraphFlow $format $props
            if ($props.tabStops) {
                $format.TabStops.ClearAll()
                foreach ($tab in @($props.tabStops)) {
                    $alignment = switch ([string]$tab.alignment) { 'center' { 1 } 'right' { 2 } 'decimal' { 3 } 'bar' { 4 } default { 0 } }
                    $leader = switch ([string]$tab.leader) { 'dot' { 1 } 'dots' { 1 } 'dotted' { 1 } 'dash' { 2 } 'hyphen' { 2 } 'line' { 3 } 'underscore' { 3 } 'heavy' { 4 } 'middleDot' { 5 } default { 0 } }
                    $null = $format.TabStops.Add([single]$tab.position, $alignment, $leader)
                }
            }
            if ($props.border) { Set-WordParagraphBorder $paragraph $props.border }
            $appended = [ordered]@{ op = 'append_text'; changed = $true; paragraph = $paragraphIndex; path = "/body/p[$paragraphIndex]"; style = $style }
            if ($styleNotFound) { $appended.styleNotFound = $styleNotFound }
            return $appended
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
            }
            elseif ($values.Count -gt 0) {
                [Math]::Max(1, [int]@($values | ForEach-Object { @($_).Count } | Measure-Object -Maximum).Maximum)
            }
            else {
                1
            }
            if ($op.paragraph) {
                $range = $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate
                $range.Collapse(0)
            }
            else {
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
            $styleNotFound = @()
            if ($props.style) { $styleNotFound += @(Set-WordStyle $table ([string]$props.style)) }
            if ($props.textStyle) { $styleNotFound += @(Set-WordStyle $table.Range ([string]$props.textStyle)) }
            $styleNotFound = @($styleNotFound | Where-Object { $_ })
            if ($props.fontName) { Set-WordLatinFont $table.Range.Font ([string]$props.fontName) }
            if ($props.fontNameEastAsia) { $table.Range.Font.NameFarEast = [string]$props.fontNameEastAsia }
            if ($props.fontSize) { $table.Range.Font.Size = [single]$props.fontSize }
            if ($props.color) { $table.Range.Font.Color = Color-Value ([string]$props.color) }
            if ($null -ne $props.spacingAfter) { $table.Range.ParagraphFormat.SpaceAfter = [single]$props.spacingAfter }
            # The portable writer's line pitch: one exact line of 1.3x the size in every cell, so a Hangul label and
            # the Latin-only figure beside it share a baseline (Malgun Gothic's taller line lifted the label 2 pt).
            $table.Range.ParagraphFormat.LineSpacingRule = 4   # wdLineSpaceExactly
            $table.Range.ParagraphFormat.LineSpacing = $(if ($props.fontSize) { [single]$props.fontSize } else { [single]11 }) * 1.3
            if ($props.keepWithNext) { $table.Range.ParagraphFormat.KeepWithNext = -1 }
            else {
                # The portable writer's widow and orphan control, row by row: the header travels with the first two
                # rows and the last two rows travel together.
                for ($row = 1; $row -lt $rows; $row++) {
                    if ($row -le 2 -or $row -eq $rows - 1) { $table.Rows.Item($row).Range.ParagraphFormat.KeepWithNext = -1 }
                }
            }
            # The portable writer's anatomy: a row reads from its top, and the header row sits on its rule (bottom).
            try { $table.Range.Cells.VerticalAlignment = 0 } catch {}
            if ($rows -gt 1 -and $props.headerBold -ne $false -and $props.repeatHeader -ne $false) {
                try { $table.Rows.Item(1).Cells.VerticalAlignment = 3 } catch {}
            }
            # The header row is set apart by weight unless the caller says otherwise.
            if ($rows -gt 1 -and $props.headerBold -ne $false -and $props.repeatHeader -ne $false) {
                try { $table.Rows.Item(1).Range.Font.Bold = -1 } catch {}
            }
            # A style the document does not hold draws the default rules too, as the portable writer does, rather than
            # Word's full grid.
            $unstyled = -not $props.style -or $styleNotFound -contains [string]$props.style
            if ($unstyled -and -not ($props.borders -or $props.shading)) { Set-WordTableDefaultRules $table }
            if ($props.alignment) {
                $table.Rows.Alignment = switch ([string]$props.alignment) { 'center' { 1 } 'right' { 2 } default { 0 } }
            }
            if ($props.columnAlignments) { Set-WordTableColumnAlignments $table $props.columnAlignments }
            if ($props.columnWidths) {
                for ($column = 1; $column -le [Math]::Min($columns, @($props.columnWidths).Count); $column++) {
                    $table.Columns.Item($column).Width = [single]@($props.columnWidths)[$column - 1]
                }
            }
            elseif ($columns -gt 1) {
                # No widths given, the portable writer's rule (naturalTableColumnWidths) on Word's own measure:
                # equal columns while every cell fits its column on one line; each column its longest line and the
                # extra shared evenly while those fit the text width; otherwise Word's layout across the width.
                # Columns.AutoFit measures at once — AutoFitBehavior alone leaves a hidden Word's widths unchanged.
                try {
                    $setup = $table.Range.Sections.Item(1).PageSetup
                    $usable = $setup.PageWidth - $setup.LeftMargin - $setup.RightMargin
                    $table.Columns.AutoFit()
                    $natural = @(1..$columns | ForEach-Object { [double]$table.Columns.Item($_).Width })
                    $total = ($natural | Measure-Object -Sum).Sum
                    if (@($natural | Where-Object { $_ -gt $usable / $columns }).Count -eq 0) {
                        $widths = @(1..$columns | ForEach-Object { $usable / $columns })
                    }
                    elseif ($total -le $usable) {
                        $widths = @($natural | ForEach-Object { $_ + ($usable - $total) / $columns })
                    }
                    else {
                        $widths = @()
                        $table.AutoFitBehavior(2)
                    }
                    if ($widths.Count) {
                        $table.AutoFitBehavior(0)
                        for ($column = 1; $column -le $columns; $column++) { $table.Columns.Item($column).Width = [single]$widths[$column - 1] }
                    }
                }
                catch {}
            }
            if ($props.rowHeights) {
                for ($row = 1; $row -le [Math]::Min($rows, @($props.rowHeights).Count); $row++) {
                    $table.Rows.Item($row).SetHeight([single]@($props.rowHeights)[$row - 1], 1)
                }
            }
            if ($props.borders) { Set-WordTableBorders $table $props.borders }
            if ($props.shading) { $table.Shading.BackgroundPatternColor = Color-Value ([string]$props.shading) }
            # A layout grid (every rule off, no fill, no style) registers with the text around it, as the portable
            # writer draws it: its outer cells drop the padding on the page side, the padding between columns stays.
            if ($props.borders -and -not $props.style -and -not $props.shading) {
                $b = $props.borders
                $allOff = ($b.enabled -eq $false) -or (@('top', 'left', 'bottom', 'right', 'insideH', 'insideV') | Where-Object { $null -eq $b.$_ -or $b.$_.enabled -ne $false }).Count -eq 0
                if ($allOff) {
                    for ($row = 1; $row -le $rows; $row++) {
                        try { $table.Cell($row, 1).LeftPadding = 0 } catch {}
                        try { $table.Cell($row, $columns).RightPadding = 0 } catch {}
                    }
                }
            }
            # The first row is the header: it repeats on every continuation page unless
            # the caller says the row is data.
            if ($rows -gt 1 -and $props.repeatHeader -ne $false) {
                try { $table.Rows.Item(1).HeadingFormat = $true } catch {}
            }
            $added = [ordered]@{ op = 'add_table'; changed = $true; table = [int]$table.Index; rows = $rows; columns = $columns }
            if ($styleNotFound.Count) { $added.styleNotFound = $styleNotFound -join ', ' }
            return $added
        }
        'set_table_style' {
            $table = $doc.Tables.Item([int]$op.table)
            $props = $op.properties
            $styleNotFound = if ($props.style) { Set-WordStyle $table ([string]$props.style) } else { $null }
            if ($props.alignment) {
                $table.Rows.Alignment = switch ([string]$props.alignment) { 'center' { 1 } 'right' { 2 } default { 0 } }
            }
            if ($props.columnAlignments) { Set-WordTableColumnAlignments $table $props.columnAlignments }
            if ($props.columnWidths) {
                for ($column = 1; $column -le [Math]::Min($table.Columns.Count, @($props.columnWidths).Count); $column++) {
                    $table.Columns.Item($column).Width = [single]@($props.columnWidths)[$column - 1]
                }
            }
            # The sides the caller names, as add_table and the portable writer draw them: enabling every border drew a
            # full grid under a spec that asked for a rule above and below.
            if ($props.borders) { Set-WordTableBorders $table $props.borders }
            if ($props.shading) { $table.Shading.BackgroundPatternColor = Color-Value ([string]$props.shading) }
            $restyled = [ordered]@{ op = 'set_table_style'; changed = $true; table = [int]$op.table }
            if ($styleNotFound) { $restyled.styleNotFound = $styleNotFound }
            return $restyled
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
                $cell.VerticalAlignment = switch ([string]$props.verticalAlignment) { 'center' { 1 } 'middle' { 1 } 'bottom' { 3 } default { 0 } }
            }
            if ($props.width) { $cell.Width = [single]$props.width }
            if ($null -ne $props.bold) { $cell.Range.Font.Bold = if ($props.bold) { -1 } else { 0 } }
            if ($null -ne $props.italic) { $cell.Range.Font.Italic = if ($props.italic) { -1 } else { 0 } }
            if ($props.fontName) { Set-WordLatinFont $cell.Range.Font ([string]$props.fontName) }
            if ($props.fontNameEastAsia) { $cell.Range.Font.NameFarEast = [string]$props.fontNameEastAsia }
            if ($props.fontSize) {
                $cell.Range.Font.Size = [single]$props.fontSize
                # The line pitch follows the size, as add_table set it.
                $cell.Range.ParagraphFormat.LineSpacingRule = 4
                $cell.Range.ParagraphFormat.LineSpacing = [single]$props.fontSize * 1.3
            }
            if ($props.color) { $cell.Range.Font.Color = Color-Value ([string]$props.color) }
            if ($props.horizontalAlignment) {
                # The cell's horizontal alignment is its paragraphs' alignment.
                $cell.Range.ParagraphFormat.Alignment = switch (([string]$props.horizontalAlignment).ToLowerInvariant()) {
                    'center' { 1 }
                    'centre' { 1 }
                    'right' { 2 }
                    'justify' { 3 }
                    'left' { 0 }
                    default { throw "set_table_cell_style horizontalAlignment must be left, center, right, or justify, not $($props.horizontalAlignment)" }
                }
            }
            return [ordered]@{ op = 'set_table_cell_style'; changed = $true; table = [int]$op.table; row = [int]$op.row; col = [int]$op.col }
        }
        'set_paragraph_text' {
            # The text inside the paragraph mark, which stays with its formatting: text and a new mark written over
            # the whole range added a paragraph to a table cell (its range ends at the end-of-cell mark) and pushed
            # every later paragraph number down by one.
            $range = (Word-EditableParagraph $doc ([int]$op.paragraph) 'set_paragraph_text').Range.Duplicate
            $null = $range.MoveEnd(1, -1)
            $range.Text = [string]$op.text
            return [ordered]@{ op = 'set_paragraph_text'; changed = $true }
        }
        # set_run_text is deliberately absent here. It addresses OOXML runs, Word
        # exposes no run object, and the closest match — its word list — numbers
        # differently, so the same index rewrote different text. The operation is
        # portable-only; the registry rejects it before dispatch in Office mode.
        'remove_paragraph' {
            (Word-EditableParagraph $doc ([int]$op.paragraph) 'remove_paragraph').Range.Delete()
            return [ordered]@{ op = 'remove_paragraph'; changed = $true }
        }
        'move_paragraph' {
            # FormattedText hands back the paragraph's own range, not a copy: deleted first, it inserted nothing and the
            # paragraph was lost. The copy lands first and the source goes after, placed as the portable writer places
            # it: before the index-th paragraph that remains, or after the last one.
            $paragraphs = $doc.Paragraphs
            $from = [int]$op.paragraph
            $source = (Word-EditableParagraph $doc $from 'move_paragraph').Range.Duplicate
            $wanted = [Math]::Max(1, [int]$op.index)
            $anchor = if ($wanted -ge $from) { $wanted + 1 } else { $wanted }
            if ($anchor -le $paragraphs.Count) {
                $destination = $paragraphs.Item($anchor).Range.Duplicate
                $destination.Collapse(1)
                $destination.FormattedText = $source.FormattedText
                $source.Delete()
            }
            elseif ($from -lt $paragraphs.Count) {
                # After the last paragraph: Word's final mark cannot move, so the copy goes into a new last paragraph,
                # the empty one left after it is joined, and the paragraph takes back its own style and format.
                $style = [string]$paragraphs.Item($from).Style.NameLocal
                $format = $paragraphs.Item($from).Format.Duplicate
                $paragraphs.Item($paragraphs.Count).Range.InsertParagraphAfter()
                $destination = $paragraphs.Item($paragraphs.Count).Range.Duplicate
                $destination.FormattedText = $source.FormattedText
                $source.Delete()
                if ($paragraphs.Item($paragraphs.Count).Range.Text -eq "`r") {
                    $null = $paragraphs.Item($paragraphs.Count - 1).Range.Characters.Last.Delete()
                }
                $moved = $paragraphs.Item($paragraphs.Count)
                $moved.Style = $style
                $moved.Format = $format
            }
            return [ordered]@{ op = 'move_paragraph'; changed = $true }
        }
        'add_image' {
            $width = if ($op.width) { [single]$op.width } else { [single]0 }
            $height = if ($op.height) { [single]$op.height } else { [single]0 }
            # The picture takes a paragraph of its own where the batch has reached — after
            # the named paragraph, or at the end of the document — the way the portable
            # writer places it; Word's default is the insertion point, i.e. the document start.
            $anchorRange = if ($op.paragraph) { $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate } else { $doc.Content.Duplicate }
            $anchorRange.Collapse(0)
            $pictureParagraph = $doc.Paragraphs.Add($anchorRange)
            $pictureRange = $pictureParagraph.Range.Duplicate
            $pictureRange.Collapse(1)
            $shape = $doc.InlineShapes.AddPicture([string]$op.path, $false, $true, $pictureRange)
            if ($width -gt 0) { $shape.Width = $width }
            if ($height -gt 0) { $shape.Height = $height }
            if ($op.altText) { $shape.AlternativeText = [string]$op.altText }
            # A new paragraph takes the formatting of the one before it — after a list item the picture came with a
            # bullet — so it starts from Normal, as the portable writer's bare paragraph does. It keeps with the
            # paragraph after it (its caption) unless the caller says otherwise: a picture that ended a page left
            # its caption alone at the top of the next.
            $paragraph = $shape.Range.Paragraphs.Item(1)
            try { $paragraph.Range.ListFormat.RemoveNumbers() } catch {}
            try { $paragraph.Format.Reset() } catch {}
            $flow = @{ keepWithNext = $true }
            if ($op.properties) { foreach ($property in $op.properties.PSObject.Properties) { $flow[$property.Name] = $property.Value } }
            if ($flow.alignment) { $paragraph.Format.Alignment = Word-ParagraphAlignment $flow.alignment }
            Set-WordParagraphFlow $paragraph.Format ([pscustomobject]$flow)
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
            }
            catch {
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
            }
            else {
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
            }
            catch {
                throw 'This Word version does not expose resolved comment state through COM'
            }
            return [ordered]@{ op = 'set_comment_resolved'; changed = $true; comment = $index; resolved = [bool]$op.resolved }
        }
        'set_font' {
            $range = $doc.Content.Duplicate
            if (-not $op.find) { throw 'set_font requires non-empty find' }
            $range.Find.ClearFormatting()
            if (-not $range.Find.Execute([string]$op.find, $false, $false, $false, $false, $false, $true, 0, $false)) { throw "Font target not found in document body: $($op.find)" }
            $props = $op.properties
            Set-WordRunFormat $range $props
            return [ordered]@{ op = 'set_font'; changed = $true }
        }
        'set_paragraph_style' {
            $paragraph = $doc.Paragraphs.Item([int]$op.paragraph)
            $styleNotFound = Set-WordStyle $paragraph.Range ([string]$op.style)
            $styled = [ordered]@{ op = 'set_paragraph_style'; changed = -not $styleNotFound; style = [string]$op.style }
            if ($styleNotFound) { $styled.styleNotFound = $styleNotFound }
            return $styled
        }
        'set_paragraph_format' {
            $paragraph = $doc.Paragraphs.Item([int]$op.paragraph)
            $format = $paragraph.Format
            $props = $op.properties
            if ($props.alignment) {
                $format.Alignment = Word-ParagraphAlignment $props.alignment
            }
            Set-WordParagraphFlow $format $props
            if ($props.tabStops) {
                $format.TabStops.ClearAll()
                foreach ($tab in @($props.tabStops)) {
                    $alignment = switch ([string]$tab.alignment) { 'center' { 1 } 'right' { 2 } 'decimal' { 3 } 'bar' { 4 } default { 0 } }
                    $leader = switch ([string]$tab.leader) { 'dot' { 1 } 'dots' { 1 } 'dotted' { 1 } 'dash' { 2 } 'hyphen' { 2 } 'line' { 3 } 'underscore' { 3 } 'heavy' { 4 } 'middleDot' { 5 } default { 0 } }
                    $null = $format.TabStops.Add([single]$tab.position, $alignment, $leader)
                }
            }
            if ($props.border) { Set-WordParagraphBorder $paragraph $props.border }
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
            # kind names either the thing (header, footer) or the page variant; an
            # unknown name is refused rather than written into a default header.
            $named = ([string]$op.kind).ToLowerInvariant()
            if ($named -and @('header', 'footer', 'default', 'first', 'even') -notcontains $named) {
                throw 'set_header_footer kind must be header, footer, default, first, or even'
            }
            $variant = ([string]$op.variant).ToLowerInvariant()
            if ($variant -and @('default', 'first', 'even') -notcontains $variant) {
                throw 'set_header_footer variant must be default, first, or even'
            }
            if (-not $variant -and @('default', 'first', 'even') -contains $named) { $variant = $named }
            $kind = switch ($variant) {
                'first' { 2 }
                'even' { 3 }
                default { 1 }
            }
            $useFooter = if ($named -eq 'footer') { $true } elseif ($named -eq 'header') { $false } else { ($null -ne $op.header -and -not [bool]$op.header) }
            # The story is taken straight off the section. A COM collection handed
            # through an if-expression is unrolled by the pipeline into an array, and
            # an array's Item(1) is its second element — the first-page header — so
            # the default header used to land on the first page only, with titlePg on.
            $item = if ($useFooter) { $section.Footers.Item($kind) } else { $section.Headers.Item($kind) }
            $item.Exists = $true
            $item.Range.Text = [string]$op.text
            # The running line in the author's type, as the portable writer sets it.
            $props = $op.properties
            if ($props) {
                $range = $item.Range
                if ($props.name) { Set-WordLatinFont $range.Font ([string]$props.name) }
                if ($props.nameEastAsia) { $range.Font.NameFarEast = [string]$props.nameEastAsia }
                if ($props.size) { $range.Font.Size = [single]$props.size }
                if ($null -ne $props.bold) { $range.Font.Bold = if ($props.bold) { -1 } else { 0 } }
                if ($props.color) { $range.Font.Color = Color-Value ([string]$props.color) }
                if ($props.alignment) {
                    $range.ParagraphFormat.Alignment = switch (([string]$props.alignment).ToLowerInvariant()) {
                        'center' { 1 }
                        'centre' { 1 }
                        'right' { 2 }
                        'justify' { 3 }
                        'left' { 0 }
                        default { throw "set_header_footer alignment must be left, center, right, or justify, not $($props.alignment)" }
                    }
                }
            }
            return [ordered]@{ op = 'set_header_footer'; changed = $true; section = $section.Index; header = (-not $useFooter); variant = $(if ($variant) { $variant } else { 'default' }) }
        }
        'track_changes' {
            $doc.TrackRevisions = [bool]$op.enabled
            return [ordered]@{ op = 'track_changes'; changed = $true; enabled = [bool]$doc.TrackRevisions }
        }
        'normalize_runs' {
            # Word's object model reads text across run boundaries, so the portable
            # run merge has nothing to do here; the opening batch stays the same on
            # both backends when the operation carries allowNoChange.
            return [ordered]@{ op = 'normalize_runs'; changed = $false; merged = 0; note = 'Word searches text across runs itself; nothing to normalize in a Microsoft Office session.' }
        }
        'resolve_revisions' {
            $resolution = ([string]$op.resolution).ToLowerInvariant()
            $settled = $(if ($resolution -eq 'reject') { 'reject' } else { 'accept' })
            $author = [string]$op.author
            if ($author) {
                # Word settles all revisions or one, never one reviewer's, so each of
                # the reviewer's revisions is settled on its own. Walking from the last
                # keeps the earlier indexes valid while the collection shrinks.
                $count = 0
                for ($position = $doc.Revisions.Count; $position -ge 1; $position--) {
                    if ($position -gt $doc.Revisions.Count) { continue }
                    $revision = $doc.Revisions.Item($position)
                    if ([string]$revision.Author -ne $author) { continue }
                    if ($resolution -eq 'reject') { $revision.Reject() } else { $revision.Accept() }
                    $count++
                }
                $result = [ordered]@{ op = 'resolve_revisions'; changed = $count -gt 0; resolved = $count; author = $author; resolution = $settled }
                if ($count -eq 0) {
                    # A label matching nobody is most often misspelt; the names present
                    # let the caller correct it, as the portable backend reports them.
                    $reviewers = @()
                    for ($position = 1; $position -le $doc.Revisions.Count; $position++) {
                        $name = [string]$doc.Revisions.Item($position).Author
                        if ($reviewers -notcontains $name) { $reviewers += $name }
                    }
                    $quoted = ($reviewers | ForEach-Object { '"' + $_ + '"' }) -join ', '
                    $result.note = $(if ($reviewers.Count -gt 0) { "No revision by `"$author`"; the tracked changes are by $quoted." } else { "No revision by `"$author`"; the document carries no tracked change." })
                }
                return $result
            }
            $count = $doc.Revisions.Count
            if ($resolution -eq 'reject') { $doc.RejectAllRevisions() } else { $doc.AcceptAllRevisions() }
            return [ordered]@{ op = 'resolve_revisions'; changed = $count -gt 0; resolved = $count; resolution = $settled }
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
            # The table lands where the batch has reached — after the named paragraph, or at
            # the end of the document — in a paragraph of its own, as the portable writer
            # places it; it is rebuilt again when the document is saved, once the headings exist.
            $tocAnchor = if ($op.paragraph) { $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate } else { $doc.Content.Duplicate }
            $tocAnchor.Collapse(0)
            $tocParagraph = $doc.Paragraphs.Add($tocAnchor)
            $range = $tocParagraph.Range.Duplicate
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
            if (-not $op.kind) {
                $section.PageSetup.DifferentFirstPageHeaderFooter = 0
                $section.PageSetup.OddAndEvenPagesHeaderFooter = 0
            }
            elseif ([string]$op.kind -eq 'first') {
                $section.PageSetup.DifferentFirstPageHeaderFooter = -1
            }
            elseif ([string]$op.kind -eq 'even') {
                $section.PageSetup.OddAndEvenPagesHeaderFooter = -1
            }
            $kind = switch ([string]$op.kind) {
                'first' { 2 }
                'even' { 3 }
                default { 1 }
            }
            $footerKinds = @($kind)
            foreach ($footerKind in $footerKinds) {
                $footer = $section.Footers.Item($footerKind)
                $footer.Exists = $true
                # A footer that already says something (a source line from set_header_footer) keeps it: the number
                # takes a paragraph of its own under it, as the portable writer adds one. Writing over the whole
                # footer lost the line. An empty footer takes the number in its one paragraph.
                $said = ([string]$footer.Range.Text).Trim([char[]]"`r`n`a ")
                if ($said) { $footer.Range.InsertParagraphAfter() }
                $range = $footer.Range.Paragraphs.Last.Range
                if ($said) { $null = $range.MoveEnd(1, -1) } else { $range = $footer.Range }
                # The same treatment as the portable writer: the number alone, a prefix
                # only when asked for, the total only with includeTotal:true.
                $range.Text = $(if ($op.prefix) { ([string]$op.prefix) + ' ' } else { '' })
                $range = $footer.Range
                $range.Collapse(0)
                $null = $footer.Range.Fields.Add($range, -1, 'PAGE', $true)
                if ([bool]$op.includeTotal) {
                    $range = $footer.Range
                    $range.Collapse(0)
                    $range.InsertAfter(' ' + $(if ($null -ne $op.separator) { [string]$op.separator } else { '/' }) + ' ')
                    $range = $footer.Range
                    $range.Collapse(0)
                    $null = $footer.Range.Fields.Add($range, -1, 'NUMPAGES', $true)
                }
                $numberLine = $footer.Range.Paragraphs.Last.Range
                $numberLine.ParagraphFormat.Alignment = switch (([string]$op.alignment).ToLowerInvariant()) {
                    'left' { 0 }
                    'right' { 2 }
                    default { 1 }
                }
                try {
                    $normalFont = $doc.Styles.Item(-1).Font
                    if ($normalFont.Name) { $numberLine.Font.Name = [string]$normalFont.Name }
                    if ($normalFont.NameFarEast) { $numberLine.Font.NameFarEast = [string]$normalFont.NameFarEast }
                    $numberLine.Font.Size = 9
                    # The number's own ink, not the colour of the footer line it was split from (wdColorAutomatic).
                    if ($said) { $numberLine.Font.Color = -16777216 }
                }
                catch {}
            }
            return [ordered]@{ op = 'add_page_numbers'; changed = $true; section = [int]$section.Index }
        }
        'insert_break' {
            $range = if ($op.paragraph) {
                $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate
            }
            else {
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
            }
            elseif ($kind -eq 'number') {
                $paragraph.Range.ListFormat.ApplyNumberDefault()
            }
            else {
                Apply-WordBullet $doc $paragraph
            }
            if ($op.level) { $paragraph.Range.ListFormat.ListIndent(); for ($level = 2; $level -lt [int]$op.level; $level++) { $paragraph.Range.ListFormat.ListIndent() } }
            return [ordered]@{ op = 'set_list'; changed = $true; paragraph = [int]$op.paragraph; kind = $(if ($kind) { $kind } else { 'bullet' }) }
        }
        'add_hyperlink' {
            $range = if ($op.paragraph) { $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate } else { $doc.Content.Duplicate }
            if ($op.find) {
                $found = $range.Find.Execute([string]$op.find, $false, $false, $false, $false, $false, $true)
                if (-not $found) { throw "Hyperlink target text not found: $($op.find)" }
            }
            else {
                # At the end of the paragraph's text, as the portable writer appends the link: laid over the whole
                # paragraph, its mark included, the link joined it to the next paragraph, and a display replaced
                # the paragraph's own text.
                if ($op.paragraph) { $null = $range.MoveEnd(1, -1) }
                $range.Collapse(0)
            }
            $display = if ($null -ne $op.display) { [string]$op.display } elseif ($op.find) { [string]$range.Text } else { [string]$op.address }
            $link = $doc.Hyperlinks.Add($range, [string]$op.address, [string]$op.subAddress, $null, $display)
            return [ordered]@{ op = 'add_hyperlink'; changed = $true; address = [string]$link.Address; subAddress = [string]$link.SubAddress }
        }
        'add_bookmark' {
            $range = if ($op.paragraph) { $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate } else { $doc.Content.Duplicate }
            if ($op.find) {
                $found = $range.Find.Execute([string]$op.find, $false, $false, $false, $false, $false, $true)
                if (-not $found) { throw "Bookmark target text not found: $($op.find)" }
            }
            elseif (-not $op.paragraph) {
                $range.Collapse(0)
            }
            $bookmark = $doc.Bookmarks.Add([string]$op.name, $range)
            return [ordered]@{ op = 'add_bookmark'; changed = $true; name = [string]$bookmark.Name }
        }
        'set_content_control' {
            $tag = [string]$op.tag
            $control = $null
            for ($index = 1; $index -le $doc.ContentControls.Count; $index++) {
                $candidate = $doc.ContentControls.Item($index)
                if ($tag) {
                    if ([string]$candidate.Tag -eq $tag) { $control = $candidate; break }
                }
                elseif ($index -eq [int]$op.control) { $control = $candidate; break }
            }
            if ($null -eq $control) {
                throw $(if ($tag) { "DOCX content control not found for tag: $tag" } else { "DOCX content control $($op.control) not found" })
            }
            # A locked control refuses the write; saying so beats a COM error nobody can read.
            if ($control.LockContents) { throw "DOCX content control $($(if ($tag) { $tag } else { $op.control })) is locked for editing" }
            $control.Range.Text = [string]$op.text
            return [ordered]@{ op = 'set_content_control'; changed = $true; control = $(if ($tag) { $tag } else { [int]$op.control }); tag = [string]$control.Tag; text = [string]$op.text }
        }
        'add_note' {
            $kind = $(if ($op.kind) { ([string]$op.kind).ToLowerInvariant() } else { 'footnote' })
            if ($kind -ne 'footnote' -and $kind -ne 'endnote') { throw "add_note kind must be footnote or endnote" }
            $range = if ($op.paragraph) { $doc.Paragraphs.Item([int]$op.paragraph).Range.Duplicate } else { $doc.Content.Duplicate }
            $anchor = 'paragraph'
            if ($op.find) {
                $found = $range.Find.Execute([string]$op.find, $false, $false, $false, $false, $false, $true)
                if (-not $found) { throw "Note anchor text not found: $($op.find)" }
                $anchor = 'phrase'
            }
            # The note reads in the face of the text it cites, as the portable writer sets it: Word's Footnote Text
            # style otherwise printed the source line of a serif memo in the document's default sans.
            $citedFont = $range.Font
            $citedName = $(try { [string]$citedFont.Name } catch { '' })
            $citedFarEast = $(try { [string]$citedFont.NameFarEast } catch { '' })
            # The mark follows the cited phrase, so the range collapses to its end; a paragraph's end is the end of
            # its text, inside its mark, or the mark opened the next paragraph ("[1]C three").
            if ($op.paragraph -and -not $op.find) { $null = $range.MoveEnd(1, -1) }
            $range.Collapse(0)
            $note = $(if ($kind -eq 'endnote') {
                    $doc.Endnotes.Add($range, '', [string]$op.text)
                }
                else {
                    $doc.Footnotes.Add($range, '', [string]$op.text)
                })
            try {
                if ($citedName) { $note.Range.Font.Name = $citedName }
                if ($citedFarEast) { $note.Range.Font.NameFarEast = $citedFarEast }
                # The whole paragraph, the mark and the space after it included: the note's range leaves them out, and
                # at the body's 11 pt they set the line taller than its 9 pt text, as the portable note style does not.
                foreach ($notePara in @($note.Range.Paragraphs)) { $notePara.Range.Font.Size = 9 }
                # Set tight, single-spaced, 2 pt apart, as the portable writer's note style: a Korean Word's Footnote
                # Text takes Normal's 8 pt after and 1.08 lines, and two source lines took a sixth of the page foot.
                $noteFormat = $note.Range.ParagraphFormat
                $noteFormat.SpaceBefore = 0
                $noteFormat.SpaceAfter = 2
                $noteFormat.LineSpacingRule = 0
            }
            catch {}
            return [ordered]@{ op = 'add_note'; changed = $true; kind = $kind; note = [int]$note.Index; anchor = $anchor }
        }
        'set_page' {
            # Without an explicit section the edit lands on the one being written into
            # — the last — which is what the portable backend does too.
            $section = $doc.Sections.Item($(if ($op.section) { [int]$op.section } else { [int]$doc.Sections.Count }))
            $props = $op.properties
            if ($props.orientation) { $section.PageSetup.Orientation = $(if ([string]$props.orientation -eq 'landscape') { 1 } else { 0 }) }
            # pageSize arrives as points; the sheet is turned the way the section now lies.
            if ($null -ne $props.pageWidth -and $null -ne $props.pageHeight) {
                $width = [single]$props.pageWidth
                $height = [single]$props.pageHeight
                if (([int]$section.PageSetup.Orientation -eq 1) -eq ($width -lt $height)) { $width, $height = $height, $width }
                $section.PageSetup.PageWidth = $width
                $section.PageSetup.PageHeight = $height
            }
            if ($props.topMargin) { $section.PageSetup.TopMargin = [single]$props.topMargin }
            if ($props.bottomMargin) { $section.PageSetup.BottomMargin = [single]$props.bottomMargin }
            if ($props.leftMargin) { $section.PageSetup.LeftMargin = [single]$props.leftMargin }
            if ($props.rightMargin) { $section.PageSetup.RightMargin = [single]$props.rightMargin }
            # Columns are a property of the section, so the text flows through them
            # instead of being placed into boxes; 1 returns the section to one column.
            if ($null -ne $props.columns) {
                $columnCount = [int]$props.columns
                if ($columnCount -lt 1 -or $columnCount -gt 12) { throw 'set_page columns must be a whole number from 1 to 12' }
                $null = $section.PageSetup.TextColumns.SetCount($columnCount)
                if ($columnCount -gt 1) {
                    $section.PageSetup.TextColumns.EvenlySpaced = -1
                    $section.PageSetup.TextColumns.Spacing = $(if ($null -ne $props.columnSpacing) { [single]$props.columnSpacing } else { [single]35.4 })
                }
            }
            elseif ($null -ne $props.columnSpacing) {
                $section.PageSetup.TextColumns.EvenlySpaced = -1
                $section.PageSetup.TextColumns.Spacing = [single]$props.columnSpacing
            }
            return [ordered]@{ op = 'set_page'; changed = $true; section = $section.Index; columns = [int]$section.PageSetup.TextColumns.Count }
        }
        'fit_table' {
            $table = $doc.Tables.Item([int]$op.table)
            $table.AutoFitBehavior(2)
            return [ordered]@{ op = 'fit_table'; changed = $true; table = [int]$op.table }
        }
        default { throw "Unsupported DOCX operation: $($op.op)" }
    }
}

function Invoke-ExcelComRetry(
    [scriptblock]$operation,
    [string]$label,
    [int[]]$additionalTransientHResults = @()
) {
    $lastError = ''
    $transientHResults = @(-2146777998, -2147418111, -2147417846) + @($additionalTransientHResults)
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        try {
            return & $operation
        }
        catch {
            $hresult = [int]$_.Exception.HResult
            if ($transientHResults -notcontains $hresult) { throw }
            $lastError = [string]$_.Exception.Message
            Start-Sleep -Milliseconds 100
        }
    }
    throw "$label remained busy after transient COM retries. Last error: $lastError"
}

function Assert-WorksheetName([string]$operation, [string]$name) {
    # Excel refuses these itself, with a COM error nobody can act on.
    $label = ([string]$name).Trim()
    if (-not $label) { throw "$operation requires name" }
    if ($label.Length -gt 31) { throw "Worksheet names are limited to 31 characters" }
    $forbidden = [regex]::Match($label, '[:\\/?*\[\]]')
    if ($forbidden.Success) { throw "Worksheet names cannot contain : \ / ? * [ ] — `"$label`" has $($forbidden.Value)" }
    if ($label.StartsWith("'") -or $label.EndsWith("'")) { throw "Worksheet names cannot start or end with an apostrophe: $label" }
    if ($label -match '^(?i)history$') { throw "History is reserved by Excel and cannot name a worksheet" }
    return $label
}

# A paragraph an edit may rewrite: one inside a table of contents is Word's own field result, which it refused with
# "the range cannot be edited" and nothing to act on. The contents are rebuilt from the headings, so say that.
function Word-EditableParagraph($doc, [int]$index, [string]$opName) {
    $paragraph = $doc.Paragraphs.Item($index)
    $start = [int]$paragraph.Range.Start
    foreach ($toc in @($doc.TablesOfContents)) {
        if ($start -ge [int]$toc.Range.Start -and $start -lt [int]$toc.Range.End) {
            throw "$opName paragraph $index is an entry of the table of contents, which Word rebuilds from the headings: edit the heading it lists, or name a paragraph outside the contents."
        }
    }
    return $paragraph
}

# A chart frame or picture on the cell grid, in the portable reader's shape: the cells under its corners, 1-based.
function Excel-DrawingAnchor($drawing) {
    try {
        $first = $drawing.TopLeftCell
        $last = $drawing.BottomRightCell
        return [ordered]@{
            from        = [string]$first.Address($false, $false)
            to          = [string]$last.Address($false, $false)
            startColumn = [int]$first.Column
            startRow    = [int]$first.Row
            endColumn   = [int]$last.Column
            endRow      = [int]$last.Row
            left        = [Math]::Round([double]$drawing.Left, 2)
            top         = [Math]::Round([double]$drawing.Top, 2)
            width       = [Math]::Round([double]$drawing.Width, 2)
            height      = [Math]::Round([double]$drawing.Height, 2)
        }
    }
    catch { return $null }
}

# The frozen rows and columns as the top-left pane holds them. SplitRow counts only the frozen rows a small hidden
# window can show (a 7-row header under an 86 pt title band read as 6 in a 141 pt window); the pane keeps them all.
function Excel-FrozenSplit($window) {
    $row = [int]$window.SplitRow
    $column = [int]$window.SplitColumn
    if ([bool]$window.FreezePanes -and $window.Panes.Count -gt 1) {
        $frozen = $window.Panes.Item(1).VisibleRange
        if ($row -gt 0) { $row = [int]$frozen.Rows.Count }
        if ($column -gt 0) { $column = [int]$frozen.Columns.Count }
    }
    return [ordered]@{ row = $row; column = $column }
}

function Excel-Sheet($book, $op) {
    if ($op.sheet) {
        try {
            return $book.Worksheets.Item([string]$op.sheet)
        }
        catch {
            $names = @()
            foreach ($ws in @($book.Worksheets)) { $names += [string]$ws.Name }
            throw "Worksheet not found: $($op.sheet). Available sheets: $($names -join ', '). Add it with add_sheet or target an existing sheet."
        }
    }
    return $book.ActiveSheet
}

# A chart or picture already on the sheet, addressed by the name the snapshot
# reports or by its 1-based position, so one address works on both backends.
function Excel-Drawing($sheet, $op) {
    $wanted = if ($null -ne $op.drawing) { $op.drawing } else { $op.name }
    if ($null -eq $wanted -or [string]::IsNullOrWhiteSpace([string]$wanted)) {
        throw "$([string]$op.op) requires drawing: the name the snapshot reports, or its 1-based index on the sheet."
    }
    $shapes = @($sheet.Shapes)
    $ordinal = 0
    if ([int]::TryParse([string]$wanted, [ref]$ordinal) -and $ordinal -ge 1 -and $ordinal -le $shapes.Count) {
        return $shapes[$ordinal - 1]
    }
    foreach ($shape in $shapes) {
        if ([string]::Equals([string]$shape.Name, [string]$wanted, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $shape
        }
    }
    $known = @()
    for ($index = 0; $index -lt $shapes.Count; $index += 1) { $known += "$($index + 1): $([string]$shapes[$index].Name)" }
    $held = if ($known.Count) { $known -join ', ' } else { 'no drawings' }
    throw "Drawing not found: $wanted. This sheet holds $held."
}

function Activate-ExcelSheetWindow($book, $sheet) {
    $appVisible = [bool]$book.Application.Visible
    $window = $book.Windows.Item(1)
    if ($appVisible) {
        $null = $book.Activate()
        $null = $window.Activate()
        $null = $sheet.Activate()
        return $window
    }
    try { $book.Application.ScreenUpdating = $false } catch {}
    try { $null = $sheet.Activate() } catch {}
    if ('MixdogOfficeInterop' -as [type]) {
        $hWnd = $(try { [long]$book.Application.Hwnd } catch { 0 })
        if ($hWnd) {
            try { $null = [MixdogOfficeInterop]::HideWindow($hWnd) } catch {}
            for ($attempt = 0; $attempt -lt 20 -and [MixdogOfficeInterop]::WindowVisible($hWnd); $attempt++) {
                Start-Sleep -Milliseconds 25
                try { $null = [MixdogOfficeInterop]::HideWindow($hWnd) } catch {}
            }
            if ([MixdogOfficeInterop]::WindowVisible($hWnd)) {
                throw 'Background Excel view window remained visible after sheet activation.'
            }
        }
    }
    return $window
}

function Excel-ContentPrintArea($sheet) {
    $used = $null
    $shapes = $null
    $startCell = $null
    $endCell = $null
    try {
        $used = $sheet.UsedRange
        $firstRow = [int]$used.Row
        $firstColumn = [int]$used.Column
        $lastRow = $firstRow + [int]$used.Rows.Count - 1
        $lastColumn = $firstColumn + [int]$used.Columns.Count - 1
        $shapes = $sheet.Shapes
        for ($index = 1; $index -le [int]$shapes.Count; $index++) {
            $shape = $null
            $topLeft = $null
            $bottomRight = $null
            try {
                $shape = $shapes.Item($index)
                $topLeft = $shape.TopLeftCell
                $bottomRight = $shape.BottomRightCell
                $firstRow = [Math]::Min($firstRow, [int]$topLeft.Row)
                $firstColumn = [Math]::Min($firstColumn, [int]$topLeft.Column)
                $lastRow = [Math]::Max($lastRow, [int]$bottomRight.Row)
                $lastColumn = [Math]::Max($lastColumn, [int]$bottomRight.Column)
            }
            finally {
                if ($null -ne $bottomRight) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($bottomRight) } catch {} }
                if ($null -ne $topLeft) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($topLeft) } catch {} }
                if ($null -ne $shape) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shape) } catch {} }
            }
        }
        $startCell = $sheet.Cells.Item($firstRow, $firstColumn)
        $endCell = $sheet.Cells.Item($lastRow, $lastColumn)
        return [string]$sheet.Range($startCell, $endCell).Address($true, $true, 1)
    }
    finally {
        if ($null -ne $endCell) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($endCell) } catch {} }
        if ($null -ne $startCell) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($startCell) } catch {} }
        if ($null -ne $shapes) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shapes) } catch {} }
        if ($null -ne $used) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($used) } catch {} }
    }
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
                }
                catch {
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
    # A layout type (blank, title, obj, …) names the same layout in every language, as the portable writer reads it
    # from the layout part; a Korean PowerPoint calls Blank "빈 화면". The types run in PpSlideLayout's order (title = 1
    # … picTx = 36), and a layout's type is the one a slide made from it reports.
    $types = @('title', 'tx', 'twoColTx', 'tbl', 'txAndChart', 'chartAndTx', 'dgm', 'chart', 'txAndClipArt', 'clipArtAndTx', 'titleOnly', 'blank', 'txAndObj', 'objAndTx', 'objOnly', 'obj', 'txAndMedia', 'mediaAndTx', 'objOverTx', 'txOverObj', 'txAndTwoObj', 'twoObjAndTx', 'twoObjOverTx', 'fourObj', 'vertTx', 'clipArtAndVertTx', 'vertTitleAndTx', 'vertTitleAndTxOverChart', 'twoObj', 'objAndTwoObj', 'twoObjAndObj', 'cust', 'secHead', 'twoTxTwoObj', 'objTx', 'picTx')
    # The default layouts' English names, which the portable writer's template carries, name the same types in a
    # PowerPoint of another language: 'Title Only' failed a batch on a Korean PowerPoint, whose layout is "제목만".
    $defaultNames = @{ 'title slide' = 'title'; 'title and content' = 'obj'; 'section header' = 'secHead'; 'two content' = 'twoObj'; 'comparison' = 'twoTxTwoObj'; 'title only' = 'titleOnly'; 'content with caption' = 'objTx'; 'picture with caption' = 'picTx'; 'title and vertical text' = 'vertTx'; 'vertical title and text' = 'vertTitleAndTx' }
    $lookup = ([string]$reference).Trim().ToLowerInvariant()
    $typeName = if ($defaultNames.ContainsKey($lookup)) { $defaultNames[$lookup] } else { [string]$reference }
    $wanted = [Array]::FindIndex([string[]]$types, [Predicate[string]]{ param($type) [string]::Equals($type, $typeName, [System.StringComparison]::OrdinalIgnoreCase) }) + 1
    if ($wanted -gt 0) {
        for ($index = 1; $index -le $layouts.Count; $index++) {
            $probe = $presentation.Slides.AddSlide($presentation.Slides.Count + 1, $layouts.Item($index))
            $type = [int]$probe.Layout
            $probe.Delete()
            if ($type -eq $wanted) { return [ordered]@{ Index = $index; Layout = $layouts.Item($index) } }
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
            $name = Assert-WorksheetName 'add_sheet' ([string]$op.name)
            # Excel's Add() inserts before the active sheet; the portable writer appends,
            # so a Report · Data · Calc · Checks workbook keeps that order on both backends.
            $sheet = $book.Worksheets.Add([System.Type]::Missing, $book.Worksheets.Item($book.Worksheets.Count))
            $sheet.Name = $name
            return [ordered]@{ op = 'add_sheet'; changed = $true; sheet = [string]$sheet.Name }
        }
        'copy_sheet' {
            if ($op.name) { $null = Assert-WorksheetName 'copy_sheet' ([string]$op.name) }
            $source = Excel-Sheet $book $op
            # Missing, not $null, for Before, as add_sheet passes it: Excel refused a null Before ("unable to get the
            # Copy property of the Worksheet class") and copy_sheet failed every batch.
            $source.Copy([System.Type]::Missing, $book.Worksheets.Item($book.Worksheets.Count))
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
            }
            else {
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
            (Excel-Sheet $book $op).Delete()
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
            if ($props.numberFormat) { Set-ExcelNumberFormat $target ([string]$props.numberFormat) }
            if ($props.color) { $target.Font.Color = Color-Value ([string]$props.color) }
            if ($props.fillColor) { $target.Interior.Color = Color-Value ([string]$props.fillColor) }
            # The names the portable writer reads (centre, middle, general, fill, distributed) mean the same here:
            # "centre" set the header left in Excel and centred in the portable file.
            if ($props.horizontalAlignment) {
                $target.HorizontalAlignment = switch ([string]$props.horizontalAlignment) {
                    'center' { -4108 }
                    'centre' { -4108 }
                    'right' { -4152 }
                    'justify' { -4130 }
                    'fill' { 5 }
                    'distributed' { -4117 }
                    'general' { 1 }
                    default { -4131 }
                }
            }
            if ($props.verticalAlignment) {
                $target.VerticalAlignment = switch ([string]$props.verticalAlignment) {
                    'center' { -4108 }
                    'centre' { -4108 }
                    'middle' { -4108 }
                    'bottom' { -4107 }
                    'justify' { -4130 }
                    'distributed' { -4117 }
                    default { -4160 }
                }
            }
            if ($null -ne $props.wrapText) { $target.WrapText = [bool]$props.wrapText }
            if ($null -ne $props.indent) {
                # The portable writer's rule: an indented cell with no alignment of its own is set left.
                $level = [Math]::Max(0, [Math]::Min(15, [int][Math]::Round([double]$props.indent)))
                if ($level -gt 0 -and -not $props.horizontalAlignment -and $(try { [int]$target.HorizontalAlignment } catch { 0 }) -eq 1) {
                    $target.HorizontalAlignment = -4131
                }
                $target.IndentLevel = $level
            }
            if ($null -ne $props.locked) { $target.Locked = [bool]$props.locked }
            if ($props.borders) {
                # The four edges as the portable writer's border element: one spec for every side, or a spec per side;
                # a side named none is cleared, a side not named keeps what the cell had.
                $sideIndex = @{ left = 7; top = 8; bottom = 9; right = 10 }
                $uniform = -not ($props.borders.PSObject.Properties.Name | Where-Object { $sideIndex.ContainsKey($_) })
                foreach ($side in @('left', 'top', 'bottom', 'right')) {
                    $spec = if ($uniform) { $props.borders } else { $props.borders.$side }
                    if ($null -eq $spec) { continue }
                    $style = if ($spec -is [string]) { $spec } elseif ($spec.style) { [string]$spec.style } else { 'thin' }
                    $clear = $spec -eq $false -or $style -eq 'none' -or $spec.enabled -eq $false
                    # The portable writer rules every cell of the range, so the lines between its cells are drawn too:
                    # the edge index alone boxed a block the file writer drew as a grid. One side cleared alone leaves
                    # the lines between cells, as there each neighbour keeps its opposite side.
                    $edges = @($target.Borders.Item($sideIndex[$side]))
                    $inside = if ($side -in @('left', 'right')) { 11 } else { 12 }   # xlInsideVertical, xlInsideHorizontal
                    $across = if ($inside -eq 11) { [int]$target.Columns.Count } else { [int]$target.Rows.Count }
                    if ($across -gt 1 -and ($uniform -or -not $clear)) { $edges += $target.Borders.Item($inside) }
                    foreach ($edge in $edges) {
                        if ($clear) { $edge.LineStyle = -4142; continue }
                        $edge.LineStyle = switch ($style) { 'dashed' { -4115 } 'dotted' { -4118 } 'double' { -4119 } default { 1 } }
                        $edge.Weight = switch ($style) { 'hair' { 1 } 'medium' { -4138 } 'thick' { 4 } default { 2 } }
                        if ($spec -isnot [string] -and $spec.color) { $edge.Color = Color-Value ([string]$spec.color) }
                    }
                }
            }
            return [ordered]@{ op = 'set_style'; changed = $true }
        }
        'add_image' {
            $sheet = Excel-Sheet $book $op
            # A snapshot reports where a picture sits as cells, so a caller may place
            # it by cell; explicit points still win.
            $anchor = if ($op.cell) { $sheet.Range([string]$op.cell) } else { $null }
            $left = if ($op.left) { [single]$op.left } elseif ($anchor) { [single]$anchor.Left } else { [single]0 }
            $top = if ($op.top) { [single]$op.top } elseif ($anchor) { [single]$anchor.Top } else { [single]0 }
            $width = if ($op.width) { [single]$op.width } else { [single]320 }
            $height = if ($op.height) { [single]$op.height } else { [single]240 }
            $picture = $sheet.Shapes.AddPicture([string]$op.path, $false, $true, $left, $top, $width, $height)
            if ($op.altText) { $picture.AlternativeText = [string]$op.altText }
            $pageFit = Set-ExcelSheetOnePageWide $sheet
            $imageResult = [ordered]@{ op = 'add_image'; changed = $true }
            if ($pageFit) { $imageResult.pageFit = $pageFit }
            return $imageResult
        }
        'rename_sheet' {
            $sheet = Excel-Sheet $book $op
            $sheet.Name = Assert-WorksheetName 'rename_sheet' ([string]$op.name)
            return [ordered]@{ op = 'rename_sheet'; changed = $true; sheet = [string]$sheet.Name }
        }
        'set_drawing' {
            $sheet = Excel-Sheet $book $op
            $shape = Excel-Drawing $sheet $op
            if ($null -eq $op.left -and $null -eq $op.top -and $null -eq $op.width -and $null -eq $op.height) {
                throw 'set_drawing needs left, top, width, or height'
            }
            if ($null -ne $op.left) { $shape.Left = [single]$op.left }
            if ($null -ne $op.top) { $shape.Top = [single]$op.top }
            if ($null -ne $op.width) { $shape.Width = [single]$op.width }
            if ($null -ne $op.height) { $shape.Height = [single]$op.height }
            return [ordered]@{ op = 'set_drawing'; changed = $true; sheet = [string]$sheet.Name; drawing = [string]$shape.Name }
        }
        'delete_drawing' {
            $sheet = Excel-Sheet $book $op
            $shape = Excel-Drawing $sheet $op
            $drawingName = [string]$shape.Name
            $shape.Delete()
            return [ordered]@{ op = 'delete_drawing'; changed = $true; sheet = [string]$sheet.Name; drawing = $drawingName }
        }
        'add_table' {
            $sheet = Excel-Sheet $book $op
            $source = $sheet.Range([string]$op.range)
            $table = $sheet.ListObjects.Add(1, $source, $null, 1)
            if ($op.name) { $table.Name = [string]$op.name }
            # 'none' is the portable writer's word for a table with no built-in style (compose_sheet paints the range
            # itself); Excel has no style of that name and refused the whole composed sheet. It clears the style.
            if ($op.style) {
                $tableStyle = [string]$op.style
                if ($tableStyle.ToLowerInvariant() -eq 'none') { $tableStyle = '' }
                $table.TableStyle = $tableStyle
            }
            return [ordered]@{ op = 'add_table'; changed = $true; name = [string]$table.Name }
        }
        'add_chart' {
            $sheet = Excel-Sheet $book $op
            $chartType = Office-ChartTypeCode $op.chartType
            $frameAnchor = if ($op.cell) { $sheet.Range([string]$op.cell) } else { $null }
            $left = if ($null -ne $op.left) { [single]$op.left } elseif ($frameAnchor) { [single]$frameAnchor.Left } else { [single]300 }
            $top = if ($null -ne $op.top) { [single]$op.top } elseif ($frameAnchor) { [single]$frameAnchor.Top } else { [single]20 }
            $width = if ($op.width) { [single]$op.width } else { [single]480 }
            if ($op.toColumn) {
                # To the right edge of toColumn as this workbook lays its columns out, as the portable writer measures
                # its own: a Korean Excel's column is an eighth wider than the points a caller could have given.
                if (-not $frameAnchor) { throw 'XLSX add_chart toColumn ends a frame placed at cell; give cell as well' }
                $end = $sheet.Range("$(([string]$op.toColumn).Trim())1")
                if ([int]$end.Column -lt [int]$frameAnchor.Column) { throw "XLSX add_chart toColumn $($op.toColumn) lies left of $($op.cell)" }
                $width = [single]([double]$end.Left + [double]$end.Width - [double]$frameAnchor.Left)
            }
            $height = if ($op.height) { [single]$op.height } else { [single]280 }
            $shape = Invoke-ExcelComRetry {
                return $sheet.Shapes.AddChart2(-1, $chartType, $left, $top, $width, $height)
            } 'Excel add chart'
            $pageFit = Set-ExcelSheetOnePageWide $sheet
            $chart = Invoke-ExcelComRetry { return $shape.Chart } 'Excel chart proxy'
            if ($op.range) {
                # plotBy:'rows' (xlRows = 1) as the portable writer reads it: the first row the categories, each row
                # under it a series. Always passing xlColumns drew a row of periods as one bar per year.
                $plotBy = if (([string]$op.plotBy).ToLowerInvariant() -eq 'rows') { 1 } else { 2 }
                $null = Invoke-ExcelComRetry {
                    $chart.SetSourceData($sheet.Range([string]$op.range), $plotBy)
                    return $true
                } 'Excel chart source'
                if ($plotBy -eq 1) {
                    # Excel reads a header row of years as numbers and plots it as a series of its own; the series are
                    # named explicitly instead: the first row (after its first cell) the categories, each row under
                    # it one series named by its first cell.
                    $null = Invoke-ExcelComRetry {
                        $block = $sheet.Range([string]$op.range)
                        $rows = [int]$block.Rows.Count
                        $columns = [int]$block.Columns.Count
                        while ($chart.SeriesCollection().Count -gt 0) { $chart.SeriesCollection(1).Delete() }
                        $categories = $block.Cells.Item(1, 2).Resize(1, $columns - 1)
                        for ($row = 2; $row -le $rows; $row++) {
                            $series = $chart.SeriesCollection().NewSeries()
                            $series.Name = [string]$block.Cells.Item($row, 1).Text
                            $series.Values = $block.Cells.Item($row, 2).Resize(1, $columns - 1)
                            $series.XValues = $categories
                        }
                        # A rebuilt single series brings Excel's automatic title back with it.
                        if (-not $op.title) { $chart.HasTitle = $true; $chart.HasTitle = $false }
                        return $true
                    } 'Excel chart series by rows'
                }
            }
            if ($op.title) {
                $null = Invoke-ExcelComRetry {
                    $chart.HasTitle = $true
                    $chart.ChartTitle.Text = [string]$op.title
                    return $true
                } 'Excel chart title'
                Set-ChartTitleFace $chart 12
            }
            # A chart given no title carries none, as in the portable file; Excel otherwise writes its own "Chart Title".
            if (-not $op.title) { try { $chart.HasTitle = $false } catch {} }
            # Horizontal bars read top-down in the range's order, as the portable writer draws them: the category axis
            # runs reversed and the value axis crosses it at the far end, so it stays under the bars.
            if ($chartType -eq 57 -or $chartType -eq 58) {
                try { $axis = $chart.Axes(1); $axis.ReversePlotOrder = $true; $axis.Crosses = 2 } catch {}
            }
            $seriesCount = [int](Invoke-ExcelComRetry {
                    return $chart.SeriesCollection().Count
                } 'Excel chart series')
            $palette = @($op.seriesColors | Where-Object {
                    $null -ne $_ -and -not [string]::IsNullOrWhiteSpace([string]$_)
                })
            # A pie or doughnut is its categories: each slice takes the next colour of the palette, as the portable
            # writer cycles them. One colour for the whole series drew the pie as a single disc.
            $slices = $chartType -eq 5 -or $chartType -eq -4120
            for ($seriesIndex = 1; $seriesIndex -le $seriesCount; $seriesIndex++) {
                $series = $chart.SeriesCollection().Item($seriesIndex)
                if ($palette.Count -gt 0 -and $slices) {
                    $points = $(try { [int]$series.Points().Count } catch { 0 })
                    for ($pointIndex = 1; $pointIndex -le $points; $pointIndex++) {
                        $color = Color-Value ([string]$palette[($pointIndex - 1) % $palette.Count])
                        try { $point = $series.Points($pointIndex); $point.Format.Fill.Solid(); $point.Format.Fill.ForeColor.RGB = $color } catch {}
                    }
                }
                elseif ($palette.Count -gt 0) {
                    $color = Color-Value ([string]$palette[($seriesIndex - 1) % $palette.Count])
                    try { $series.Format.Fill.Solid(); $series.Format.Fill.ForeColor.RGB = $color } catch {}
                    try { $series.Format.Line.ForeColor.RGB = $color } catch {}
                }
                if ([bool]$op.showValues) {
                    try {
                        $series.ApplyDataLabels()
                        $labels = $series.DataLabels()
                        $labels.ShowValue = $true
                        $labels.ShowCategoryName = $false
                        if ($op.valueNumberFormat) { $labels.NumberFormat = [string]$op.valueNumberFormat }
                        if ($op.dataLabelPosition) {
                            $labels.Position = switch (([string]$op.dataLabelPosition).ToLowerInvariant()) {
                                'center' { -4108 }
                                'inside_base' { 4 }
                                'inside_end' { 3 }
                                'outside_end' { 2 }
                                default { 5 }
                            }
                        }
                        if ($op.dataLabelColor) { $labels.Font.Color = Color-Value ([string]$op.dataLabelColor) }
                    }
                    catch {}
                    # Each slice's value in the ink its slice can carry, as the portable writer sets it.
                    $insideLabels = -not $op.dataLabelPosition -or @('center', 'inside_end', 'inside_base') -contains ([string]$op.dataLabelPosition).ToLowerInvariant()
                    if ($slices -and $insideLabels -and -not $op.dataLabelColor -and $palette.Count -gt 0) {
                        $points = $(try { [int]$series.Points().Count } catch { 0 })
                        for ($pointIndex = 1; $pointIndex -le $points; $pointIndex++) {
                            $ink = Color-Value (Ink-OnFill ([string]$palette[($pointIndex - 1) % $palette.Count]))
                            try { $series.Points($pointIndex).DataLabel.Font.Color = $ink } catch {}
                        }
                    }
                }
            }
            # A pie's legend names its slices, as the portable writer keeps it; otherwise one series goes unlabelled.
            $legendVisible = $(if ($null -ne $op.showLegend) { [bool]$op.showLegend } else { $seriesCount -gt 1 -or $slices })
            $null = Invoke-ExcelComRetry {
                $chart.HasLegend = $legendVisible
                # Under the plot, in series order, as the portable writer places it: Excel's default right-hand legend
                # took a fifth of the frame's width and listed a stacked chart's series upside down.
                if ($legendVisible) { $chart.Legend.Position = -4107 }
                return $true
            } 'Excel chart legend'
            try { $chart.ChartArea.Format.Line.Visible = 0 } catch {}
            try { $chart.PlotArea.Format.Fill.Visible = 0 } catch {}
            try {
                $categoryAxis = $chart.Axes(1, 1)
                $categoryAxis.CategoryType = 2
                $categoryAxis.TickLabelPosition = 4
                $categoryAxis.TickLabels.Orientation = 0
            }
            catch {}
            $plotted = @(for ($index = 1; $index -le $seriesCount; $index++) { try { @($chart.SeriesCollection().Item($index).Values) } catch {} })
            Set-ChartCategoryLabelsLow $chart $plotted
            try {
                $valueAxis = $chart.Axes(2, 1)
                if ([bool]$op.zeroBaseline) { $valueAxis.MinimumScale = 0 }
                if ($op.valueNumberFormat) { $valueAxis.TickLabels.NumberFormat = [string]$op.valueNumberFormat }
            }
            catch {}
            try { $chart.ChartGroups(1).GapWidth = 90 } catch {}
            if ([bool]$op.showValues -and ([string]$op.dataLabelPosition).ToLowerInvariant() -eq 'inside_end') {
                try {
                    $currentInsideWidth = [single]$chart.PlotArea.InsideWidth
                    if ($currentInsideWidth -gt 100) {
                        $chart.PlotArea.InsideWidth = [single]($currentInsideWidth - 18)
                    }
                }
                catch {}
            }
            $pointCount = if ($seriesCount -gt 0) {
                [int](Invoke-ExcelComRetry {
                        return $chart.SeriesCollection().Item(1).Points().Count
                    } 'Excel chart point count' @(-2146827864))
            }
            else {
                0
            }
            $chartResultValue = [ordered]@{ op = 'add_chart'; changed = $true; name = [string]$shape.Name; series = $seriesCount; categories = $pointCount }
            if ($pageFit) { $chartResultValue.pageFit = $pageFit }
            return $chartResultValue
        }
        'sort_range' {
            $sheet = Excel-Sheet $book $op
            $target = $sheet.Range([string]$op.range)
            $hasHeader = $true
            if ($null -ne $op.hasHeader) { $hasHeader = [bool]$op.hasHeader }
            # Same key contract as the portable writer: a column letter, a header, or
            # the range's first column.
            $keyColumn = 1
            $declared = ([string]$op.by).Trim()
            if (-not $declared) { $declared = ([string]$op.column).Trim() }
            if ($declared) {
                if ($declared -match '^[A-Za-z]{1,3}$') {
                    $keyColumn = [int]$sheet.Columns($declared.ToUpperInvariant()).Column - [int]$target.Column + 1
                }
                else {
                    for ($index = 1; $index -le [int]$target.Columns.Count; $index += 1) {
                        $headerText = [string]$target.Cells(1, $index).Text
                        if ($headerText.Trim() -eq $declared) { $keyColumn = $index; break }
                    }
                }
            }
            if ($keyColumn -lt 1 -or $keyColumn -gt [int]$target.Columns.Count) {
                throw "XLSX sort_range by `"$declared`" is outside $([string]$op.range); name a column the range covers."
            }
            # Same two refusals as the portable writer, so a sheet sorts the same way
            # on either backend: a filtered row would keep its flag while the values
            # move under it, and a merged cell cannot travel with one row.
            $firstDataRow = 1
            if ($hasHeader) { $firstDataRow = 2 }
            $withheldRows = @()
            for ($index = $firstDataRow; $index -le [int]$target.Rows.Count; $index += 1) {
                if ([bool]$target.Rows($index).Hidden) { $withheldRows += [int]$target.Rows($index).Row }
            }
            if ($withheldRows.Count -gt 0) {
                $namedRows = ($withheldRows | Select-Object -First 5) -join ', '
                throw "XLSX sort_range would move values under hidden row $namedRows, leaving a different record withheld. Show them first with set_row_visibility visible: true, or sort a range without them."
            }
            if ($target.MergeCells -ne $false) {
                throw "XLSX sort_range cannot move rows through a merged cell in $([string]$op.range); Excel refuses the same sort. Unmerge them first with unmerge_cells."
            }
            $sortOrder = 1
            if (([string]$op.order).ToLowerInvariant().StartsWith('desc')) { $sortOrder = 2 }
            $headerFlag = 2
            if ($hasHeader) { $headerFlag = 1 }
            $keyRange = $target.Columns($keyColumn)
            $null = $target.Sort($keyRange, $sortOrder, $null, $null, 1, $null, 1, $headerFlag)
            return [ordered]@{ op = 'sort_range'; changed = $true; range = [string]$op.range; order = $(if ($sortOrder -eq 2) { 'desc' } else { 'asc' }) }
        }
        'add_conditional_format' {
            $sheet = Excel-Sheet $book $op
            $target = $sheet.Range([string]$op.range)
            # Same three kinds as the portable writer, resolved there: a rule that
            # picks cells, a scale that colors every cell by its value, or a bar.
            $conditionKind = ([string]$op.type).ToLowerInvariant()
            if ($conditionKind -eq 'colorscale') {
                $scalePoints = 2
                if ($op.midColor) { $scalePoints = 3 }
                $scale = $target.FormatConditions.AddColorScale($scalePoints)
                if ($op.minColor) { $scale.ColorScaleCriteria(1).FormatColor.Color = Color-Value ([string]$op.minColor) }
                if ($op.midColor) { $scale.ColorScaleCriteria(2).FormatColor.Color = Color-Value ([string]$op.midColor) }
                $topCriterion = $scalePoints
                if ($op.maxColor) { $scale.ColorScaleCriteria($topCriterion).FormatColor.Color = Color-Value ([string]$op.maxColor) }
            }
            elseif ($conditionKind -eq 'databar') {
                $bar = $target.FormatConditions.AddDatabar()
                $barColor = if ($op.color) { [string]$op.color } elseif ($op.fillColor) { [string]$op.fillColor } else { '' }
                if ($barColor) { $bar.BarColor.Color = Color-Value $barColor }
            }
            else {
                # The portable contract writes the rule the way the file stores it — no leading '=', references relative
                # to the range's top-left cell. Excel's FormatConditions.Add reads a formula without '=' as a text
                # constant: a Gantt rule written "AND(E$4+6>=$C5,E$4<=$D5)" coloured nothing through Microsoft Excel
                # while the portable file coloured every task's weeks.
                $formula = ([string]$op.formula).Trim()
                if (-not $formula.StartsWith('=')) { $formula = "=$formula" }
                $rule = $target.FormatConditions.Add(2, [Type]::Missing, $formula)
                if ($op.color) { $rule.Font.Color = Color-Value ([string]$op.color) }
                if ($op.fillColor) { $rule.Interior.Color = Color-Value ([string]$op.fillColor) }
            }
            # The kind is reported as the contract names it, so both backends answer
            # with the same word.
            return [ordered]@{ op = 'add_conditional_format'; changed = $true; type = $(if ($op.type) { [string]$op.type } else { 'expression' }) }
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
            # Same contract as the portable writer: a list unless the caller names
            # another kind, and a second bound for the ranged kinds.
            $validationType = switch (([string]$op.type).ToLowerInvariant()) {
                'whole' { 1 }
                'decimal' { 2 }
                'date' { 4 }
                'time' { 5 }
                'textlength' { 6 }
                'custom' { 7 }
                default { 3 }
            }
            $validationOperator = switch (([string]$op.operator).ToLowerInvariant()) {
                'notbetween' { 2 }
                'equal' { 3 }
                'notequal' { 4 }
                'greaterthan' { 5 }
                'lessthan' { 6 }
                'greaterthanorequal' { 7 }
                'lessthanorequal' { 8 }
                default { 1 }
            }
            if ($null -ne $op.formula2 -and [string]$op.formula2 -ne '') {
                $target.Validation.Add($validationType, 1, $validationOperator, [string]$op.formula1, [string]$op.formula2)
            }
            else {
                $target.Validation.Add($validationType, 1, $validationOperator, [string]$op.formula1)
            }
            if ($op.inputMessage) { $target.Validation.InputMessage = [string]$op.inputMessage }
            if ($op.errorMessage) { $target.Validation.ErrorMessage = [string]$op.errorMessage }
            return [ordered]@{ op = 'add_validation'; changed = $true }
        }
        'freeze_panes' {
            $sheet = Excel-Sheet $book $op
            $window = Activate-ExcelSheetWindow $book $sheet
            try {
                if ([int]$window.View -ne 1) { $window.View = 1 }
            }
            catch {}
            # row and column name the first row and column that scroll, as the portable writer reads them (row:2
            # freezes the header in row 1): taken as counts, a composed report froze its first data row and column A.
            $splitRow = [Math]::Max(0, $(if ($null -ne $op.row) { [int]$op.row } else { 0 }) - 1)
            $splitColumn = [Math]::Max(0, $(if ($null -ne $op.column) { [int]$op.column } else { 0 }) - 1)
            $window.FreezePanes = $false
            $window.SplitRow = 0
            $window.SplitColumn = 0
            if ($splitRow -gt 0 -or $splitColumn -gt 0) {
                $window.ScrollRow = 1
                $window.ScrollColumn = 1
                # Excel splits only at a row and column on screen, and a hidden background window shows about ten rows
                # at 100%: a report whose header sits in row 12 froze at row 11. The split is made zoomed out and the
                # sheet's own zoom comes back once the panes are frozen. The screen updates meanwhile (the application
                # stays hidden): with updating off, the zoom never reaches the layout the split is measured against.
                $zoom = $(try { $window.Zoom } catch { $null })
                $updating = $(try { [bool]$book.Application.ScreenUpdating } catch { $true })
                try { $book.Application.ScreenUpdating = $true } catch {}
                # A Double, as set_sheet_view and the restore below set it: a hidden window refused an Int32 zoom.
                try { $window.Zoom = [double]10 } catch {}
                $window.SplitRow = $splitRow
                $window.SplitColumn = $splitColumn
                try {
                    $window.FreezePanes = $true
                    # Read while zoomed out: back at the sheet's zoom a small hidden window counts only the frozen rows
                    # it can show (a 7-row header under an 86 pt title band read as 6 in a 141 pt window) though the
                    # panes stay frozen where they were made, and the check failed the batch.
                    $frozenRow = [int]$window.SplitRow
                    $frozenColumn = [int]$window.SplitColumn
                    if ($null -ne $zoom) { try { $window.Zoom = [double]$zoom } catch {} }
                    try { $book.Application.ScreenUpdating = $updating } catch {}
                }
                catch {
                    if ($null -ne $zoom) { try { $window.Zoom = [double]$zoom } catch {} }
                    try { $book.Application.ScreenUpdating = $updating } catch {}
                    $activeSheet = $(try { [string]$book.ActiveSheet.Name } catch { '' })
                    $activeCell = $(try { [string]$book.Application.ActiveCell.Address($false, $false) } catch { '' })
                    $appVisible = $(try { [bool]$book.Application.Visible } catch { $false })
                    $windowVisible = $(try { [bool]$window.Visible } catch { $false })
                    $view = $(try { [int]$window.View } catch { 0 })
                    $windowState = $(try { [int]$window.WindowState } catch { 0 })
                    $windowSize = $(try { "$([int]$window.Width)x$([int]$window.Height)" } catch { 'unknown' })
                    throw "Cannot freeze panes on '$([string]$sheet.Name)' at row=$splitRow column=$splitColumn; activeSheet='$activeSheet', activeCell='$activeCell', appVisible=$appVisible, windowVisible=$windowVisible, windowState=$windowState, windowSize=$windowSize, view=$view, splitRow=$([int]$window.SplitRow), splitColumn=$([int]$window.SplitColumn). $($_.Exception.Message)"
                }
                if ($frozenRow -ne $splitRow -or $frozenColumn -ne $splitColumn) {
                    throw "Excel froze panes at row=$frozenRow column=$frozenColumn instead of row=$splitRow column=$splitColumn"
                }
            }
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
            }
            else {
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
            # Excel answers a name it refuses with a COM error nobody can act on, and
            # the portable writer would put it in a workbook Excel then declines to
            # open: the rule is the same on both backends.
            $name = ([string]$op.name).Trim()
            # The suggestion is built from the caller's own name: a non-ASCII literal
            # in this script file is read back as mojibake by Windows PowerShell.
            if ($name -match '\s') { throw "Excel refuses the defined name `"$name`": it contains a space; use an underscore ($($name -replace '\s+', '_'))." }
            if ($name -notmatch '^[\p{L}_\\]') { throw "Excel refuses the defined name `"$name`": it must start with a letter, underscore, or backslash." }
            if ($name -match '[^\p{L}\p{N}_.\\]') { throw "Excel refuses the defined name `"$name`": use letters, digits, underscores, or periods." }
            if ($name -match '^(?i)([RC]|\$?[A-Z]{1,3}\$?\d{1,7})$') { throw "Excel refuses the defined name `"$name`": Excel reads it as a cell reference, not a name." }
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
            # A row fit names rows (1:12): fitting columns there would rewrite widths
            # the caller never asked about, so only a range naming columns fits them.
            $rowsOnly = ([bool]$op.rows) -and ([string]$op.range -match '^\s*\d+\s*:\s*\d+\s*$')
            # The columns fit the cells of the range only, as the portable writer measures them: fitting the
            # entire columns sized a report's table column to the long subtitle above it.
            # Then the portable writer's rule: two characters of air past the text, so a right-set figure does not
            # run into the label of the next column, a floor of 8 (minWidth when a composed layout asks for one;
            # fit-to-page never enlarges, so the block keeps its width) and a ceiling of 80. A column with nothing in
            # the range keeps its width unless a floor was asked for.
            if (-not $rowsOnly) {
                # A wrapped cell counts at its full line, as the portable writer measures it (up to the 80 ceiling):
                # Excel's own fit skips it, and a note column came back ten characters wide and three lines deep where
                # the portable file set it on one line.
                # WrapText answers for the whole range at once: true, false, or DBNull when the cells differ.
                $measured = $book.Application.Intersect($target, $sheet.UsedRange)
                $wrapAll = if ($null -ne $measured) { $measured.WrapText } else { $false }
                $wrapped = @()
                if ($wrapAll -is [bool] -and $wrapAll) { $wrapped = @($measured) }
                elseif ($wrapAll -isnot [bool]) { $wrapped = @(foreach ($cell in $measured.Cells) { if ($cell.WrapText -eq $true) { $cell } }) }
                foreach ($cell in $wrapped) { $cell.WrapText = $false }
                $null = $target.Columns.AutoFit()
                foreach ($cell in $wrapped) { $cell.WrapText = $true }
                $floored = $null -ne $op.minWidth -and [double]$op.minWidth -gt 0
                $floor = if ($floored) { [math]::Min(80, [double]$op.minWidth) } else { 8 }
                foreach ($column in $target.Columns) {
                    if (-not $floored -and $book.Application.WorksheetFunction.CountA($column) -eq 0) { continue }
                    $column.ColumnWidth = [single][math]::Min(80, [math]::Max($floor, [double]$column.ColumnWidth + 2))
                }
            }
            if ([bool]$op.rows) {
                # Excel fits a row holding a merged cell to one line of default height: the composed sheet's title band,
                # set two lines tall, came back cut to "월별 야간 처리량과". Those rows keep the height they were given,
                # as the portable writer keeps every row's.
                $inUse = $book.Application.Intersect($target.EntireRow, $sheet.UsedRange)
                if ($null -ne $inUse) {
                    foreach ($line in $inUse.Rows) {
                        if ($line.MergeCells -ne $false) { continue }
                        $null = $line.EntireRow.AutoFit()
                    }
                }
            }
            return [ordered]@{ op = 'autofit_range'; changed = $true; range = [string]$op.range }
        }
        'set_page_setup' {
            $sheet = Excel-Sheet $book $op
            $setup = $sheet.PageSetup
            if ([bool]$op.fitToContent) { $setup.PrintArea = Excel-ContentPrintArea $sheet }
            elseif ($op.printArea) { $setup.PrintArea = [string]$op.printArea }
            if ($op.orientation) { $setup.Orientation = $(if ([string]$op.orientation -eq 'landscape') { 2 } else { 1 }) }
            if ($null -ne $op.fitToPagesWide -or $null -ne $op.fitToPagesTall) { $setup.Zoom = $false }
            # Excel expects Variant False for "no page limit"; the integer 0 throws.
            if ($null -ne $op.fitToPagesWide) {
                $setup.FitToPagesWide = $(if ([int]$op.fitToPagesWide -gt 0) { [int]$op.fitToPagesWide } else { $false })
            }
            if ($null -ne $op.fitToPagesTall) {
                $setup.FitToPagesTall = $(if ([int]$op.fitToPagesTall -gt 0) { [int]$op.fitToPagesTall } else { $false })
            }
            if ($null -ne $op.centerHorizontally) { $setup.CenterHorizontally = [bool]$op.centerHorizontally }
            if ($null -ne $op.centerVertically) { $setup.CenterVertically = [bool]$op.centerVertically }
            # Margins are inches, as the portable writer's pageMargins and Excel's Page Setup read them; Excel's
            # object model takes points, and a composed report's 0.5 in margins printed at 0.5 pt, on the paper's edge.
            $inches = { param($value) $book.Application.InchesToPoints([double]$value) }
            if ($null -ne $op.topMargin) { $setup.TopMargin = & $inches $op.topMargin }
            if ($null -ne $op.bottomMargin) { $setup.BottomMargin = & $inches $op.bottomMargin }
            if ($null -ne $op.leftMargin) { $setup.LeftMargin = & $inches $op.leftMargin }
            if ($null -ne $op.rightMargin) { $setup.RightMargin = & $inches $op.rightMargin }
            # The header rows every printed page repeats, as the portable writer's Print_Titles.
            if ($null -ne $op.printTitleRows -and "$($op.printTitleRows)".Trim() -ne '') {
                $span = ("$($op.printTitleRows)" -replace '\$', '').Split(':')
                $first = [int]$span[0]
                $last = if ($span.Count -gt 1) { [int]$span[1] } else { $first }
                if ($first -lt 1 -or $last -lt $first) { throw "set_page_setup printTitleRows is a row or a span of rows such as `"1`" or `"4:5`", not `"$($op.printTitleRows)`"" }
                $setup.PrintTitleRows = "`$$($first):`$$($last)"
            }
            return [ordered]@{ op = 'set_page_setup'; changed = $true; sheet = [string]$sheet.Name; printArea = [string]$setup.PrintArea }
        }
        'set_sheet_view' {
            $sheet = Excel-Sheet $book $op
            $window = Activate-ExcelSheetWindow $book $sheet
            if ($null -ne $op.showGridlines) { $window.DisplayGridlines = [bool]$op.showGridlines }
            # A double: a hidden window with frozen panes refuses an integer zoom ("Specified cast is not valid").
            if ($null -ne $op.zoom) { $window.Zoom = [double][Math]::Max(10, [Math]::Min(400, [int]$op.zoom)) }
            return [ordered]@{ op = 'set_sheet_view'; changed = $true; sheet = [string]$sheet.Name }
        }
        'set_header_footer' {
            $sheet = Excel-Sheet $book $op
            $named = ([string]$op.kind).ToLowerInvariant()
            if (@('header', 'footer') -notcontains $named) { throw 'set_header_footer kind must be header or footer' }
            $alignment = if ($op.alignment) { ([string]$op.alignment).ToLowerInvariant() } else { 'center' }
            if (@('left', 'center', 'right') -notcontains $alignment) { throw 'set_header_footer alignment must be left, center, or right' }
            # LeftHeader / CenterFooter and the rest: the slot and the story name it.
            $slot = "$($alignment.Substring(0, 1).ToUpperInvariant())$($alignment.Substring(1))"
            $property = "$slot$(if ($named -eq 'header') { 'Header' } else { 'Footer' })"
            # Same token vocabulary as the portable writer: {page} / {pages} and the
            # rest become Excel field codes, and the caller's own ampersand survives.
            $marked = ([string]$op.text) -replace '&', '&&'
            $marked = [System.Text.RegularExpressions.Regex]::Replace($marked, '\{page\}', '&P', 'IgnoreCase')
            $marked = [System.Text.RegularExpressions.Regex]::Replace($marked, '\{pages\}', '&N', 'IgnoreCase')
            $marked = [System.Text.RegularExpressions.Regex]::Replace($marked, '\{date\}', '&D', 'IgnoreCase')
            $marked = [System.Text.RegularExpressions.Regex]::Replace($marked, '\{time\}', '&T', 'IgnoreCase')
            $marked = [System.Text.RegularExpressions.Regex]::Replace($marked, '\{sheet\}', '&A', 'IgnoreCase')
            $marked = [System.Text.RegularExpressions.Regex]::Replace($marked, '\{file\}', '&F', 'IgnoreCase')
            $sheet.PageSetup.$property = $marked
            return [ordered]@{ op = 'set_header_footer'; changed = $true; sheet = [string]$sheet.Name; kind = $named; alignment = $alignment }
        }
        'set_sheet_visibility' {
            $sheet = Excel-Sheet $book $op
            # Rows and columns take visible: true/false; a sheet accepts the same word.
            $visibility = if ($null -ne $op.visibility) { ([string]$op.visibility).ToLowerInvariant() }
            elseif ($null -ne $op.visible) { if ([bool]$op.visible) { 'visible' } else { 'hidden' } }
            else { '' }
            $sheet.Visible = switch ($visibility) {
                'hidden' { 0 }
                'very_hidden' { 2 }
                'veryhidden' { 2 }
                'visible' { -1 }
                default { throw "set_sheet_visibility needs visibility: visible, hidden, or very_hidden (or visible: true/false)" }
            }
            return [ordered]@{ op = 'set_sheet_visibility'; changed = $true; sheet = [string]$sheet.Name; visibility = $visibility }
        }
        'set_row_visibility' {
            $sheet = Excel-Sheet $book $op
            if ($null -eq $op.visible) { throw 'set_row_visibility requires visible: true or false' }
            $first = [int]$op.row
            if ($first -lt 1) { throw 'set_row_visibility requires row (1-based)' }
            $count = if ($op.count) { [Math]::Max(1, [int]$op.count) } else { 1 }
            $last = $first + $count - 1
            $sheet.Rows("$($first):$($last)").Hidden = -not [bool]$op.visible
            return [ordered]@{ op = 'set_row_visibility'; changed = $true; sheet = [string]$sheet.Name; visible = [bool]$op.visible; rows = @($first..$last) }
        }
        'set_column_visibility' {
            $sheet = Excel-Sheet $book $op
            if ($null -eq $op.visible) { throw 'set_column_visibility requires visible: true or false' }
            # A letter and a 1-based number name the same column; the caller may use either.
            $column = [string]$op.column
            $first = if ($column -match '^[A-Za-z]+$') { [int]$sheet.Columns($column.ToUpperInvariant()).Column } else { [int]$column }
            if ($first -lt 1) { throw 'set_column_visibility requires column (a letter such as D, or a 1-based number)' }
            $count = if ($op.count) { [Math]::Max(1, [int]$op.count) } else { 1 }
            $last = $first + $count - 1
            $range = $sheet.Range($sheet.Cells.Item(1, $first), $sheet.Cells.Item(1, $last)).EntireColumn
            $range.Hidden = -not [bool]$op.visible
            return [ordered]@{ op = 'set_column_visibility'; changed = $true; sheet = [string]$sheet.Name; visible = [bool]$op.visible; columns = @($first..$last) }
        }
        'set_row_height' {
            $sheet = Excel-Sheet $book $op
            $first = [int]$op.row
            if ($first -lt 1) { throw 'set_row_height requires row (1-based)' }
            $height = [double]$op.height
            if ($null -eq $op.height -or $height -lt 0 -or $height -gt 409) { throw 'set_row_height requires height in points, 0-409' }
            $count = if ($op.count) { [Math]::Max(1, [int]$op.count) } else { 1 }
            $last = $first + $count - 1
            # A single, as the column widths are set: PowerShell's COM binder refused a Double at a second call site.
            $sheet.Rows("$($first):$($last)").RowHeight = [single]$height
            return [ordered]@{ op = 'set_row_height'; changed = $true; sheet = [string]$sheet.Name; rows = @($first..$last); height = $height }
        }
        'set_column_width' {
            $sheet = Excel-Sheet $book $op
            $column = [string]$op.column
            $first = if ($column -match '^[A-Za-z]+$') { [int]$sheet.Columns($column.ToUpperInvariant()).Column } else { [int]$column }
            if ($first -lt 1) { throw 'set_column_width requires column (a letter such as D, or a 1-based number)' }
            $width = [double]$op.width
            if ($null -eq $op.width -or $width -lt 0 -or $width -gt 255) { throw 'set_column_width requires width in characters, 0-255' }
            $count = if ($op.count) { [Math]::Max(1, [int]$op.count) } else { 1 }
            $last = $first + $count - 1
            # A single, as autofit_range sets it: once one call site had set ColumnWidth, PowerShell's COM binder refused a
            # Double at another ("specified cast is not valid") and set_column_width after autofit failed the batch.
            $sheet.Range($sheet.Cells.Item(1, $first), $sheet.Cells.Item(1, $last)).EntireColumn.ColumnWidth = [single]$width
            return [ordered]@{ op = 'set_column_width'; changed = $true; sheet = [string]$sheet.Name; columns = @($first..$last); width = $width }
        }
        default { throw "Unsupported XLSX operation: $($op.op)" }
    }
}

function Ppt-Slide($presentation, $op) {
    return $presentation.Slides.Item([int]$op.slide)
}

# Double literals: given an integer literal, PowerShell bound Max/Min to the Int32 overloads inside a function and
# rounded every fraction (0.5 came back 0, 0.7 came back 1), so a cover crop always started at the left or top edge.
function Clamp-Unit([double]$value) {
    return [Math]::Max([double]0, [Math]::Min([double]1, $value))
}

function Add-PptImage($slide, $op) {
    $left = if ($null -ne $op.left) { [single]$op.left } else { [single]72 }
    $top = if ($null -ne $op.top) { [single]$op.top } else { [single]72 }
    $width = if ($null -ne $op.width) { [single]$op.width } else { [single]320 }
    $height = if ($null -ne $op.height) { [single]$op.height } else { [single]240 }
    $fit = ([string]$(if ($op.fit) { $op.fit } else { 'stretch' })).ToLowerInvariant()
    if ($fit -eq 'stretch') {
        return $slide.Shapes.AddPicture([string]$op.path, $false, $true, $left, $top, $width, $height)
    }
    if (@('contain', 'cover') -notcontains $fit) {
        throw 'Image fit must be stretch, contain, or cover'
    }

    $shape = $slide.Shapes.AddPicture([string]$op.path, $false, $true, 0, 0, -1, -1)
    $sourceWidth = [double]$shape.Width
    $sourceHeight = [double]$shape.Height
    if ($sourceWidth -le 0 -or $sourceHeight -le 0) {
        $shape.Delete()
        throw "PowerPoint could not read image dimensions: $($op.path)"
    }

    if ($fit -eq 'contain') {
        $scale = [Math]::Min([double]$width / $sourceWidth, [double]$height / $sourceHeight)
        $placedWidth = [single]($sourceWidth * $scale)
        $placedHeight = [single]($sourceHeight * $scale)
        $shape.LockAspectRatio = 0
        $shape.Left = [single]($left + (($width - $placedWidth) / 2))
        $shape.Top = [single]($top + (($height - $placedHeight) / 2))
        $shape.Width = $placedWidth
        $shape.Height = $placedHeight
        return $shape
    }

    $sourceRatio = $sourceWidth / $sourceHeight
    $targetRatio = [double]$width / [double]$height
    $cropLeft = 0.0
    $cropTop = 0.0
    $cropRight = 0.0
    $cropBottom = 0.0
    if ($sourceRatio -gt $targetRatio) {
        $visible = $targetRatio / $sourceRatio
        $remaining = 1 - $visible
        $focus = Clamp-Unit $(if ($null -ne $op.focusX) { [double]$op.focusX } else { 0.5 })
        $cropLeft = [Math]::Max([double]0, [Math]::Min($remaining, $focus - ($visible / 2)))
        $cropRight = $remaining - $cropLeft
    }
    elseif ($sourceRatio -lt $targetRatio) {
        $visible = $sourceRatio / $targetRatio
        $remaining = 1 - $visible
        $focus = Clamp-Unit $(if ($null -ne $op.focusY) { [double]$op.focusY } else { 0.5 })
        $cropTop = [Math]::Max([double]0, [Math]::Min($remaining, $focus - ($visible / 2)))
        $cropBottom = $remaining - $cropTop
    }
    $shape.PictureFormat.CropLeft = [single]($sourceWidth * $cropLeft)
    $shape.PictureFormat.CropTop = [single]($sourceHeight * $cropTop)
    $shape.PictureFormat.CropRight = [single]($sourceWidth * $cropRight)
    $shape.PictureFormat.CropBottom = [single]($sourceHeight * $cropBottom)
    $shape.LockAspectRatio = 0
    $shape.Left = $left
    $shape.Top = $top
    $shape.Width = $width
    $shape.Height = $height
    return $shape
}

function Invoke-PowerPointComRetry([scriptblock]$operation, [string]$label) {
    $lastError = ''
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        try {
            return & $operation
        }
        catch {
            $hresult = [int]$_.Exception.HResult
            if (@(-2147418111, -2147417846) -notcontains $hresult) { throw }
            $lastError = [string]$_.Exception.Message
            Start-Sleep -Milliseconds 100
        }
    }
    throw "$label remained busy after transient COM retries. Last error: $lastError"
}

$script:PowerPointChartExcelApplications = @{}
$script:PowerPointChartExcelProcessIds = @{}

function Register-PowerPointChartExcelApplication(
    $workbook,
    [int[]]$processIdsBefore,
    [bool]$requireIsolated = $false
) {
    $application = $null
    try {
        $application = $workbook.Application
        if ($null -eq $application) { return }
        $hWnd = $(try { [long]$application.Hwnd } catch { 0 })
        $key = if ($hWnd) {
            "hwnd:$hWnd"
        }
        else {
            "rcw:$([System.Runtime.CompilerServices.RuntimeHelpers]::GetHashCode($application))"
        }
        if ($script:PowerPointChartExcelApplications.ContainsKey($key)) {
            try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($application) } catch {}
            return
        }
        $processId = 0
        if ($hWnd -and ('MixdogOfficeInterop' -as [type])) {
            try { $processId = [MixdogOfficeInterop]::ProcessIdForWindow($hWnd) } catch {}
        }
        $knownOwnedProcess = $processId -gt 0 -and $script:PowerPointChartExcelProcessIds.ContainsKey([int]$processId)
        if ($processId -gt 0 -and $processIdsBefore -contains [int]$processId -and -not $knownOwnedProcess) {
            if ($requireIsolated) {
                throw 'Background PowerPoint chart data refused an embedded workbook that reused an existing user Excel process.'
            }
            return
        }
        if ($processId -gt 0) { $script:PowerPointChartExcelProcessIds[[int]$processId] = $true }
        foreach ($process in @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue)) {
            if ($processIdsBefore -notcontains [int]$process.Id) {
                $script:PowerPointChartExcelProcessIds[[int]$process.Id] = $true
            }
            try { $process.Dispose() } catch {}
        }
        $script:PowerPointChartExcelApplications[$key] = [pscustomobject]@{
            App       = $application
            ProcessId = $processId
        }
        $application = $null
    }
    finally {
        if ($null -ne $application) {
            try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($application) } catch {}
        }
    }
}

function Close-PowerPointChartExcelApplications([bool]$quit) {
    $records = @($script:PowerPointChartExcelApplications.Values)
    $script:PowerPointChartExcelApplications = @{}
    $processIds = @($script:PowerPointChartExcelProcessIds.Keys | ForEach-Object { [int]$_ })
    $script:PowerPointChartExcelProcessIds = @{}
    foreach ($record in $records) {
        if ($quit) {
            try { $record.App.DisplayAlerts = $false } catch {}
            try {
                $null = Invoke-PowerPointComRetry {
                    $record.App.Quit()
                    return $true
                } 'PowerPoint chart Excel host'
            }
            catch {}
        }
        try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($record.App) } catch {}
    }
    if ($records.Count) {
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
    }
    if ($quit) {
        foreach ($processId in $processIds) {
            $process = $null
            try { $process = [System.Diagnostics.Process]::GetProcessById($processId) } catch {}
            if ($null -eq $process) { continue }
            $exited = $false
            try { $exited = [bool]$process.WaitForExit(500) } catch { $exited = $true }
            if (-not $exited) {
                try {
                    $process.Kill()
                    $null = $process.WaitForExit(1000)
                }
                catch {}
            }
            try { $process.Dispose() } catch {}
        }
    }
    return $records.Count
}

function Set-PowerPointChartData(
    $chart,
    $categoryValues,
    $seriesValues,
    [bool]$allowUiActivation = $true
) {
    $specs = @($seriesValues)
    if ($specs.Count -eq 0) { throw 'PowerPoint chart data requires at least one series' }
    $categories = @($categoryValues)
    $pointCount = $categories.Count
    foreach ($spec in $specs) { $pointCount = [Math]::Max($pointCount, @($spec.values).Count) }
    if ($pointCount -eq 0) { throw 'PowerPoint chart data requires at least one category or value' }
    if ($categories.Count -eq 0) {
        $categories = @(1..$pointCount | ForEach-Object { "Item $_" })
    }
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
    $lastRow = $pointCount + 1
    $sourceAddress = "A1:${lastColumn}${lastRow}"
    $chartData = $null
    $workbook = $null
    $worksheets = $null
    $worksheet = $null
    $source = $null
    $lastOpenError = ''
    $seriesCount = 0
    $excelProcessIdsBefore = @(
        Get-Process -Name EXCEL -ErrorAction SilentlyContinue | ForEach-Object {
            try { [int]$_.Id } finally { try { $_.Dispose() } catch {} }
        }
    )
    try {
        $chartData = $chart.ChartData
        if ($allowUiActivation) { $null = $chartData.Activate() }
        for ($attempt = 0; $attempt -lt 100 -and $null -eq $worksheet; $attempt++) {
            $candidateWorkbook = $null
            $candidateWorksheets = $null
            $candidateWorksheet = $null
            $candidateCells = $null
            $candidateSource = $null
            try {
                if ($attempt -gt 0 -and $allowUiActivation) { $null = $chartData.Activate() }
                $candidateWorkbook = $chartData.Workbook
                if ($null -eq $candidateWorkbook) { throw 'Workbook is not ready' }
                $candidateWorksheets = $candidateWorkbook.Worksheets
                if ($null -eq $candidateWorksheets -or [int]$candidateWorksheets.Count -eq 0) {
                    throw 'Worksheets collection is not ready'
                }
                $candidateWorksheet = $candidateWorksheets.Item(1)
                if ($null -eq $candidateWorksheet) { throw 'First worksheet is not ready' }
                $candidateCells = $candidateWorksheet.Cells
                if ($null -eq $candidateCells) { throw 'Worksheet cells are not ready' }
                # A non-null worksheet proxy can still be stale while the embedded
                # workbook is activating. Adopt the full chain only after the first
                # intended worksheet operation succeeds.
                $null = $candidateCells.Clear()
                $candidateSource = $candidateWorksheet.Range($sourceAddress)
                if ($null -eq $candidateSource) { throw 'Chart source range is not ready' }
                $null = ($candidateSource.Value2 = $matrix)
                $sheetName = ([string]$candidateWorksheet.Name).Replace("'", "''")
                $sourceFormula = "='$sheetName'!`$A`$1:`$$lastColumn`$$lastRow"
                # Bind the complete range in one native operation so PowerPoint replaces
                # its placeholder series without a chain of mutable COM collection calls.
                $chart.SetSourceData($sourceFormula, 2)
                $workbook = $candidateWorkbook
                $worksheets = $candidateWorksheets
                $worksheet = $candidateWorksheet
                $source = $candidateSource
                Register-PowerPointChartExcelApplication $candidateWorkbook $excelProcessIdsBefore (-not $allowUiActivation)
                $candidateWorkbook = $null
                $candidateWorksheets = $null
                $candidateWorksheet = $null
                $candidateSource = $null
            }
            catch {
                $lastOpenError = [string]$_.Exception.Message
            }
            finally {
                if ($null -ne $candidateSource) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($candidateSource) } catch {} }
                if ($null -ne $candidateCells) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($candidateCells) } catch {} }
                if ($null -ne $candidateWorksheet) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($candidateWorksheet) } catch {} }
                if ($null -ne $candidateWorksheets) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($candidateWorksheets) } catch {} }
                if ($null -ne $candidateWorkbook) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($candidateWorkbook) } catch {} }
            }
            if ($null -eq $worksheet) { Start-Sleep -Milliseconds 100 }
        }
        if ($null -eq $worksheet) {
            throw "PowerPoint chart embedded workbook did not expose its first worksheet. Last error: $lastOpenError"
        }
        try {
            $null = $chart.Refresh()
            $categoryAxis = $chart.Axes(1, 1)
            $categoryAxis.CategoryType = 2
            $categoryAxis.TickLabelPosition = 4
            $categoryAxis.TickLabels.Orientation = 0
        }
        catch {}
        $seriesCount = [int](Invoke-PowerPointComRetry { $chart.SeriesCollection().Count } 'PowerPoint chart series')
        for ($seriesIndex = 1; $seriesIndex -le [Math]::Min($specs.Count, $seriesCount); $seriesIndex++) {
            $spec = $specs[$seriesIndex - 1]
            $series = $chart.SeriesCollection().Item($seriesIndex)
            if ($spec.color) {
                try {
                    $series.Format.Fill.ForeColor.RGB = Color-Value ([string]$spec.color)
                    $series.Format.Line.ForeColor.RGB = Color-Value ([string]$spec.color)
                }
                catch {}
            }
            # Point colours go on once the data sheet is closed (Set-PowerPointPointColors): while it is open a
            # chart added after another one can report no points, and its slices kept the theme's colours.
        }
        # A pie or doughnut keeps the legend that names its slices, as the portable writer draws it.
        $legendVisible = $specs.Count -gt 1 -or @(5, -4120) -contains $(try { [int]$chart.ChartType } catch { 0 })
        $null = Invoke-PowerPointComRetry {
            $chart.HasLegend = $legendVisible
            return $true
        } 'PowerPoint chart legend'
    }
    finally {
        # Close the embedded workbook but never quit the Excel host that PowerPoint
        # started for it: PowerPoint reuses that host for the next chart in the same
        # presentation, and quitting it here left the following operation holding a
        # dead workbook whose Worksheets came back null.
        if ($null -ne $source) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($source) } catch {} }
        if ($null -ne $workbook) { try { $null = $workbook.Close($true) } catch {} }
        if ($null -ne $worksheet) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($worksheet) } catch {} }
        if ($null -ne $worksheets) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($worksheets) } catch {} }
        if ($null -ne $workbook) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) } catch {} }
        if ($null -ne $chartData) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($chartData) } catch {} }
    }
    return [ordered]@{ categories = $pointCount; series = $seriesCount }
}

function Set-PowerPointParagraphs($shape, $paragraphs) {
    $items = @($paragraphs)
    $shape.TextFrame.TextRange.Text = (@($items | ForEach-Object { [string]$_.text }) -join "`r")
    for ($index = 1; $index -le $items.Count; $index++) {
        $spec = $items[$index - 1]
        $paragraph = $shape.TextFrame.TextRange.Paragraphs($index, 1)
        if ($null -ne $spec.level) { $paragraph.IndentLevel = [Math]::Max(1, [Math]::Min(5, [int]$spec.level + 1)) }
        if ($null -ne $spec.bullet) { $paragraph.ParagraphFormat.Bullet.Visible = $(if ([bool]$spec.bullet) { -1 } else { 0 }) }
        if ([bool]$spec.bullet) {
            # The portable writer's bullet: an Arial "•" hanging 22 pt, one more step per level. Visible alone took
            # the box's last list type — a Korean PowerPoint numbered the points "1. 2." — at the template's indents.
            try {
                $paragraph.ParagraphFormat.Bullet.Type = 1
                $paragraph.ParagraphFormat.Bullet.Character = 8226
                $paragraph.ParagraphFormat.Bullet.Font.Name = 'Arial'
                $step = [single]22
                $format2 = $shape.TextFrame2.TextRange.Paragraphs($index, 1).ParagraphFormat
                $format2.LeftIndent = $step * ([Math]::Max(0, [Math]::Min(8, [int]$spec.level)) + 1)
                $format2.FirstLineIndent = -1 * $step
            }
            catch {}
        }
        if ($spec.fontName) { Set-PowerPointFontName $paragraph.Font ([string]$spec.fontName) }
        if ($spec.fontSize) { $paragraph.Font.Size = [single]$spec.fontSize }
        if ($null -ne $spec.bold) { $paragraph.Font.Bold = $(if ([bool]$spec.bold) { -1 } else { 0 }) }
        if ($null -ne $spec.italic) { $paragraph.Font.Italic = $(if ([bool]$spec.italic) { -1 } else { 0 }) }
        if ($spec.color) { $paragraph.Font.Color.RGB = Color-Value ([string]$spec.color) }
    }
    return $items.Count
}

# A series below zero: the category names stand at the foot of the plot, as the portable writer places them, not on
# the zero line, where a loss bar's value label and its category name ran over each other.
# The values come from the caller: read back from a PowerPoint chart they reopened its data and dropped the slice
# colours a doughnut had just been given.
function Set-ChartCategoryLabelsLow($chart, $values) {
    foreach ($value in @($values)) {
        $number = 0.0
        if ([double]::TryParse([string]$value, [ref]$number) -and $number -lt 0) {
            try { $chart.Axes(1, 1).TickLabelPosition = -4134 } catch {}
            return
        }
    }
}

# A chart's data sheet stays open after AddChart2 and after the data writer's own close, whether or not series were
# given: left open, the next chart in the deck was refused ("차트 데이터 표가 이미 열려 있습니다") — every second chart of a
# background deck failed — and in a batch the second data sheet came up as a visible Excel window. The chart reads its
# series from the sheet before the sheet goes away; closed first, a chart given no series was sometimes left with none.
# The ink a shape's fill can carry, as the portable writer chooses it (inkOnFill): white on a dark fill, near-black on
# a light one or on none.
function Ink-Luminance([string]$hex) {
    $channel = { param([int]$value) $c = $value / 255.0; if ($c -le 0.03928) { $c / 12.92 } else { [Math]::Pow(($c + 0.055) / 1.055, 2.4) } }
    return 0.2126 * (& $channel ([Convert]::ToInt32($hex.Substring(0, 2), 16))) + 0.7152 * (& $channel ([Convert]::ToInt32($hex.Substring(2, 2), 16))) + 0.0722 * (& $channel ([Convert]::ToInt32($hex.Substring(4, 2), 16)))
}

# The portable writer's quiet ink for a footer or page number (quietInk): grey enough to recede, and the first step of
# its ladder that clears 4.5:1 against the slide's own field. A field that cannot be read takes the light-slide grey.
function Quiet-Ink([string]$field) {
    $hex = $field.Trim().TrimStart('#')
    if ($hex -notmatch '^[0-9A-Fa-f]{6}$') { return '6A7179' }
    $fieldLuminance = Ink-Luminance $hex
    $light = $fieldLuminance -ge 0.4
    $ladder = if ($light) { @('6A7179', '5A616A', '474D55') } else { @('A9B1B9', 'C2C9D0', 'D9DEE3') }
    foreach ($candidate in $ladder) {
        $ink = Ink-Luminance $candidate
        if (([Math]::Max($ink, $fieldLuminance) + 0.05) / ([Math]::Min($ink, $fieldLuminance) + 0.05) -ge 4.5) { return $candidate }
    }
    if ($light) { return '1F2429' } else { return 'FFFFFF' }
}

# A footer or page number as the portable writer sets it: 10 pt in the quiet ink, the footer from the left margin and
# the number at the right, 40 pt above the foot. PowerPoint's own placeholders kept the theme's 12 pt grey, 3.2:1 on
# a dark slide background.
function Set-PowerPointFooterFace($slide, [bool]$footer) {
    $setup = $slide.Parent.PageSetup
    $width = [single]$setup.SlideWidth
    $height = [single]$setup.SlideHeight
    $fill = $slide.Background.Fill
    $field = if ([int]$fill.Type -eq 1) { Color-Hex ([long]$fill.ForeColor.RGB) } else { '' }
    $ink = Quiet-Ink $field
    $kind = if ($footer) { 15 } else { 13 }   # ppPlaceholderFooter, ppPlaceholderSlideNumber
    foreach ($shape in @($slide.Shapes)) {
        if ([int]$shape.Type -ne 14 -or [int]$shape.PlaceholderFormat.Type -ne $kind) { continue }
        # Singles throughout: a Double after a Single is a cast PowerShell's COM binder refuses.
        $shape.Left = [single]$(if ($footer) { 58 } else { $width - 158 })
        $shape.Top = [single]($height - 40)
        $shape.Width = [single]$(if ($footer) { $width - 240 } else { 100 })
        $shape.Height = [single]24
        $shape.TextFrame.VerticalAnchor = 3
        $range = $shape.TextFrame.TextRange
        $range.Font.Size = [single]10
        $range.Font.Color.RGB = Color-Value $ink
        $range.ParagraphFormat.Alignment = $(if ($footer) { 1 } else { 3 })
    }
}

function Ink-OnFill([string]$fill) {
    $hex = $fill.Trim().TrimStart('#')
    if ($hex -notmatch '^[0-9A-Fa-f]{6}$') { return '1F2429' }
    $channel = { param([int]$value) $c = $value / 255.0; if ($c -le 0.03928) { $c / 12.92 } else { [Math]::Pow(($c + 0.055) / 1.055, 2.4) } }
    $luminance = { param([string]$h) 0.2126 * (& $channel ([Convert]::ToInt32($h.Substring(0, 2), 16))) + 0.7152 * (& $channel ([Convert]::ToInt32($h.Substring(2, 2), 16))) + 0.0722 * (& $channel ([Convert]::ToInt32($h.Substring(4, 2), 16))) }
    $field = & $luminance $hex
    $white = 1.05 / ($field + 0.05)
    $dark = & $luminance '1F2429'
    $ink = ([Math]::Max($field, $dark) + 0.05) / ([Math]::Min($field, $dark) + 0.05)
    if ($white -ge $ink) { return 'FFFFFF' } else { return '1F2429' }
}

# A slide text's alignment and anchor in the names the portable writer reads: verticalAlignment:'center' centred the
# text in the portable file and left it at the top of the box here, and "centre" set it left.
function PowerPoint-ParagraphAlignment($alignment) {
    switch (([string]$alignment).ToLowerInvariant()) {
        'center' { return 2 }
        'centre' { return 2 }
        'right' { return 3 }
        'justify' { return 4 }
        'distributed' { return 5 }
        default { return 1 }
    }
}

# true is PowerPoint's own shadow; an object names its colour, transparency (0-1), blur and offsets in points.
function Set-PowerPointShadow($shape, $shadow) {
    $shape.Shadow.Visible = -1
    if ($shadow.color) { $shape.Shadow.ForeColor.RGB = Color-Value ([string]$shadow.color) }
    if ($null -ne $shadow.transparency) { $shape.Shadow.Transparency = [single]$shadow.transparency }
    if ($null -ne $shadow.blur) { $shape.Shadow.Blur = [single]$shadow.blur }
    if ($null -ne $shadow.offsetX) { $shape.Shadow.OffsetX = [single]$shadow.offsetX }
    if ($null -ne $shadow.offsetY) { $shape.Shadow.OffsetY = [single]$shadow.offsetY }
}

# A named face is the face of the Hangul too, as the portable writer names it for the Latin, East Asian and complex
# scripts: Font.Name alone set the Latin face, and Korean text stayed in the theme's East Asian font.
function Set-PowerPointFontName($font, [string]$name) {
    $font.Name = $name
    $font.NameFarEast = $name
    $font.NameComplexScript = $name
}

function PowerPoint-VerticalAnchor($anchor) {
    switch (([string]$anchor).ToLowerInvariant()) {
        'center' { return 3 }
        'centre' { return 3 }
        'middle' { return 3 }
        'bottom' { return 4 }
        default { return 1 }
    }
}

# A chart title set as the portable writer sets it: bold, in the near-black ink, at its size (0 keeps the application's
# own — PowerPoint's 18.6 pt is the portable slide size too). Office's default was a regular grey title.
function Set-ChartTitleFace($chart, [single]$size) {
    try {
        $font = $chart.ChartTitle.Format.TextFrame2.TextRange.Font
        $font.Bold = -1
        $font.Fill.ForeColor.RGB = Color-Value '171717'
        if ($size -gt 0) { $font.Size = $size }
    }
    catch {}
}

# One colour per bar or slice (series[].pointColors), once the chart's data sheet is closed: while it is open a chart
# added after another one could report no points at all, and a doughnut kept the theme's colours.
function Set-PowerPointPointColors($chart, $seriesSpecs, [bool]$labelInk = $false) {
    $specs = @($seriesSpecs)
    # Only a slice carries its label on its own fill; a bar's value stands above it on the page.
    $labelInk = $labelInk -and (@(5, -4120) -contains $(try { [int]$chart.ChartType } catch { 0 }))
    $count = $(try { [int]$chart.SeriesCollection().Count } catch { 0 })
    for ($seriesIndex = 1; $seriesIndex -le [Math]::Min($specs.Count, $count); $seriesIndex++) {
        $colors = @($specs[$seriesIndex - 1].pointColors)
        for ($pointIndex = 1; $pointIndex -le $colors.Count; $pointIndex++) {
            $color = [string]$colors[$pointIndex - 1]
            if ([string]::IsNullOrWhiteSpace($color)) { continue }
            $point = $null
            try {
                $point = $chart.SeriesCollection().Item($seriesIndex).Points($pointIndex)
                $point.Format.Fill.Solid()
                $point.Format.Fill.ForeColor.RGB = Color-Value $color
                $point.Format.Line.ForeColor.RGB = Color-Value $color
                # A labelled slice's value in the ink the slice can carry, as the portable writer sets it.
                if ($labelInk -and [bool]$point.HasDataLabel) { $point.DataLabel.Font.Color = Color-Value (Ink-OnFill $color) }
            }
            catch {}
            finally {
                if ($null -ne $point) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($point) } catch {} }
            }
        }
    }
}

# Only a chart that kept PowerPoint's sample data is refreshed first: a refresh after the data writer had coloured
# the slices put a doughnut back on the theme's colours.
function Close-PowerPointChartData($chart, [bool]$sampleData = $false, [int[]]$excelProcessIdsBefore = $null) {
    try {
        $openBook = $chart.ChartData.Workbook
        if ($null -eq $openBook) { return }
        $application = $openBook.Application
        if ($sampleData) { try { $null = $chart.Refresh() } catch {} }
        if ([int]$chart.SeriesCollection().Count -gt 0) { $null = $openBook.Close($true) }
        # The Excel the chart started for its data, left with no workbook, is quit at once: left to shut down on its
        # own it lingered about a minute, and the next call that read the chart (its points, its series count, the
        # review after the batch) waited for it, which timed an operation out. An Excel that was running before the
        # chart, or one this host cannot identify, is left alone.
        if ($null -ne $excelProcessIdsBefore -and [int]$application.Workbooks.Count -eq 0 -and ('MixdogOfficeInterop' -as [type])) {
            $hWnd = $(try { [long]$application.Hwnd } catch { 0 })
            $processId = $(if ($hWnd) { try { [int][MixdogOfficeInterop]::ProcessIdForWindow($hWnd) } catch { 0 } } else { 0 })
            if ($processId -gt 0 -and $excelProcessIdsBefore -notcontains $processId) {
                $application.DisplayAlerts = $false
                $application.Quit()
            }
        }
    }
    catch {}
}

function Excel-ProcessIds {
    return @(Get-Process -Name EXCEL -ErrorAction SilentlyContinue | ForEach-Object {
            try { [int]$_.Id } finally { try { $_.Dispose() } catch {} }
        })
}

function Ensure-PowerPointChartWindow($presentation, [bool]$allowUiActivation) {
    if ([int]$presentation.Windows.Count -gt 0) { return }
    if ($allowUiActivation) {
        $window = $presentation.NewWindow()
        try { $window.WindowState = 2 } catch {}
        return
    }
    $app = $presentation.Application
    try {
        $app.Left = -32000
        $app.Top = -32000
        $app.WindowState = 2
    }
    catch {}
    $window = $presentation.NewWindow()
    try {
        $window.Left = -32000
        $window.Top = -32000
        $window.WindowState = 2
    }
    catch {}
    $hWnd = $(try { [long]$window.HWND } catch { 0 })
    if (-not $hWnd) { $hWnd = $(try { [long]$app.HWND } catch { 0 }) }
    if (-not $hWnd) { $hWnd = $(try { [long]$app.Hwnd } catch { 0 }) }
    if (-not $hWnd -or -not ('MixdogOfficeInterop' -as [type])) {
        try { $window.Close() } catch {}
        throw 'Background PowerPoint chart creation could not establish a verifiably hidden document window.'
    }
    try { $null = [MixdogOfficeInterop]::HideWindow($hWnd) } catch {}
    for ($attempt = 0; $attempt -lt 20 -and [MixdogOfficeInterop]::WindowVisible($hWnd); $attempt++) {
        Start-Sleep -Milliseconds 25
        try { $null = [MixdogOfficeInterop]::HideWindow($hWnd) } catch {}
    }
    if ([MixdogOfficeInterop]::WindowVisible($hWnd)) {
        try { $window.Close() } catch {}
        throw 'Background PowerPoint chart window remained visible and was closed before chart creation.'
    }
}

function Apply-PowerPointOperation(
    $presentation,
    $op,
    [bool]$live = $false,
    [bool]$allowUiActivation = $true
) {
    switch ([string]$op.op) {
        'fill_template' { return Fill-PowerPointTemplate $presentation $op }
        'replace_text' {
            # As the portable writer reads it: a space in find matches a space or a soft line break (char 11, the
            # authored eojeol wrap), never a paragraph end, and only the matched characters are rewritten, so the
            # runs around them keep their weight and colour (the whole shape used to be rewritten in its first run's).
            $words = @(([string]$op.find).Trim() -split '\s+' | Where-Object { $_ })
            if ($words.Count -eq 0) { throw 'replace_text requires non-empty find' }
            $separator = '[ \x0B]+'
            $pattern = ($words | ForEach-Object { [regex]::Escape($_) }) -join $separator
            if ([string]$op.find -match '^\s') { $pattern = $separator + $pattern }
            if ([string]$op.find -match '\s$') { $pattern = $pattern + $separator }
            $count = 0
            $shapes = 0
            foreach ($slide in @($presentation.Slides)) {
                foreach ($shape in @($slide.Shapes)) {
                    try {
                        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
                            $range = $shape.TextFrame.TextRange
                            $found = [regex]::Matches([string]$range.Text, $pattern)
                            for ($index = $found.Count - 1; $index -ge 0; $index--) {
                                $range.Characters($found[$index].Index + 1, $found[$index].Length).Text = [string]$op.replace
                            }
                            if ($found.Count -gt 0) { $count += $found.Count; $shapes++ }
                        }
                    }
                    catch {}
                }
            }
            return [ordered]@{ op = 'replace_text'; changed = $count -gt 0; count = $count; shapes = $shapes }
        }
        'set_text' {
            $slide = Ppt-Slide $presentation $op
            $shape = $slide.Shapes.Item([int]$op.shape)
            $shape.TextFrame.TextRange.Text = [string]$op.text
            return [ordered]@{ op = 'set_text'; changed = $true }
        }
        'add_slide' {
            $index = if ($op.index) { [int]$op.index } else { $presentation.Slides.Count + 1 }
            # No layout named: the layout of the slide it follows, as New Slide does (the portable writer does the
            # same) — unless that is a title page, where the blank default follows instead of a second cover.
            $customLayout = $null
            if ([string]::IsNullOrWhiteSpace([string]$op.layout) -and $presentation.Slides.Count -gt 0) {
                $before = $presentation.Slides.Item([Math]::Max(1, [Math]::Min($presentation.Slides.Count, $index - 1)))
                if ([int]$before.Layout -ne 1) { $customLayout = $before.CustomLayout }
            }
            if ($null -ne $customLayout) {
                $slide = $presentation.Slides.AddSlide($index, $customLayout)
                return [ordered]@{ op = 'add_slide'; changed = $true; slide = [int]$slide.SlideIndex; layout = [int]$customLayout.Index; layoutName = [string]$customLayout.Name }
            }
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
            }
            else {
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
            if ($null -ne $fontName) { Set-PowerPointFontName $shape.TextFrame.TextRange.Font ([string]$fontName) }
            if ($null -ne $color) { $shape.TextFrame.TextRange.Font.Color.RGB = Color-Value ([string]$color) }
            $props = $op.properties
            # The fill and outline a text box is given, drawn as the portable writer draws them; they were not read here.
            $fillColor = Operation-Property $op 'fillColor' $null
            if ($fillColor) { $shape.Fill.Visible = -1; $shape.Fill.Solid(); $shape.Fill.ForeColor.RGB = Color-Value ([string]$fillColor) }
            $fillTransparency = Operation-Property $op 'fillTransparency' $null
            if ($null -ne $fillTransparency) { $shape.Fill.Transparency = [single]([double]$fillTransparency / 100) }
            $lineColor = Operation-Property $op 'lineColor' $null
            if ($lineColor) { $shape.Line.Visible = -1; $shape.Line.ForeColor.RGB = Color-Value ([string]$lineColor) }
            $lineTransparency = Operation-Property $op 'lineTransparency' $null
            if ($null -ne $lineTransparency) { $shape.Line.Transparency = [single]([double]$lineTransparency / 100) }
            $lineWidth = Operation-Property $op 'lineWidth' $null
            if ($null -ne $lineWidth) { $shape.Line.Weight = [single]$lineWidth }
            if ($null -ne $props.altText) { $shape.AlternativeText = [string]$props.altText }
            if ($null -ne $props.rotation) { $shape.Rotation = [single]$props.rotation }
            if ($null -ne $props.bold) { $shape.TextFrame.TextRange.Font.Bold = $(if ([bool]$props.bold) { -1 } else { 0 }) }
            if ($null -ne $props.italic) { $shape.TextFrame.TextRange.Font.Italic = $(if ([bool]$props.italic) { -1 } else { 0 }) }
            if ($props.alignment) {
                $shape.TextFrame.TextRange.ParagraphFormat.Alignment = PowerPoint-ParagraphAlignment $props.alignment
            }
            if ($props.verticalAlignment) {
                $shape.TextFrame.VerticalAnchor = PowerPoint-VerticalAnchor $props.verticalAlignment
            }
            if ($null -ne $props.marginLeft) { $shape.TextFrame.MarginLeft = [single]$props.marginLeft }
            if ($null -ne $props.marginTop) { $shape.TextFrame.MarginTop = [single]$props.marginTop }
            if ($null -ne $props.marginRight) { $shape.TextFrame.MarginRight = [single]$props.marginRight }
            if ($null -ne $props.marginBottom) { $shape.TextFrame.MarginBottom = [single]$props.marginBottom }
            # Space before each paragraph, as the portable writer spaces them; the property was not read here.
            if ($null -ne $props.paragraphSpacing) { $shape.TextFrame.TextRange.ParagraphFormat.SpaceBefore = [single]$props.paragraphSpacing }
            # The shadow set_shape draws; it was read there alone and dropped here.
            if ($props.shadow) { Set-PowerPointShadow $shape $props.shadow }
            if ($op.name) { try { $shape.Name = [string]$op.name } catch {} }
            return [ordered]@{ op = 'add_textbox'; changed = $true; shape = [string]$shape.Name }
        }
        'add_shape' {
            $slide = Ppt-Slide $presentation $op
            # The portable writer's shape names (portable-slide-shapes.mjs GEOMETRY), each the same figure: "rect" and
            # "roundRect" fell back to a plain rectangle here, and "pentagon" drew a regular pentagon where the file
            # draws the home-plate arrow. A name neither backend knows is refused, as the portable writer refuses it.
            $shapeTypes = @{
                rectangle         = 1
                rect              = 1
                square            = 1
                parallelogram     = 2
                trapezoid         = 3
                diamond           = 4
                rounded_rectangle = 5
                rounded_rect      = 5
                roundrect         = 5
                octagon           = 6
                triangle          = 7
                right_triangle    = 8
                oval              = 9
                ellipse           = 9
                circle            = 9
                hexagon           = 10
                can               = 13
                donut             = 18
                arrow             = 33
                right_arrow       = 33
                left_arrow        = 34
                up_arrow          = 35
                down_arrow        = 36
                pentagon          = 51
                chevron           = 52
                star              = 92
                callout           = 105
                plus              = 163
                minus             = 164
                cloud             = 179
            }
            $kind = ([string]$op.shapeType).Trim().ToLowerInvariant() -replace '[\s-]+', '_'
            if ($kind -ne 'line' -and -not $shapeTypes.ContainsKey($kind) -and -not ($op.shapeType -as [int])) {
                throw "Unsupported shapeType: $($op.shapeType). Use one of: $((@($shapeTypes.Keys) + 'line' | Sort-Object) -join ', ')"
            }
            $left = [single](Operation-Property $op 'left' 72)
            $top = [single](Operation-Property $op 'top' 72)
            $width = [single](Operation-Property $op 'width' 180)
            $height = [single](Operation-Property $op 'height' 90)
            if ($kind -eq 'line') {
                $shapeType = 0
                $shape = $slide.Shapes.AddLine($left, $top, $left + $width, $top + $height)
            }
            else {
                $shapeType = if ($shapeTypes.ContainsKey($kind)) { [int]$shapeTypes[$kind] } elseif ($op.shapeType -as [int]) { [int]$op.shapeType } else { 1 }
                $shape = $slide.Shapes.AddShape($shapeType, $left, $top, $width, $height)
            }
            $fillColor = Operation-Property $op 'fillColor' $null
            $lineColor = Operation-Property $op 'lineColor' $null
            if ($fillColor -and $kind -ne 'line') { $shape.Fill.Visible = $true; $shape.Fill.ForeColor.RGB = Color-Value ([string]$fillColor) }
            if ($lineColor) { $shape.Line.Visible = $true; $shape.Line.ForeColor.RGB = Color-Value ([string]$lineColor) }
            # What the caller did not ask for is not drawn, as in the portable file: PowerPoint's own shape comes in
            # the theme's accent with a darker outline and white text, and on a light fill the words disappeared.
            if ($kind -ne 'line') {
                if (-not $fillColor) { try { $shape.Fill.Visible = 0 } catch {} }
                if (-not $lineColor) { try { $shape.Line.Visible = 0 } catch {} }
            }
            $fillTransparency = Operation-Property $op 'fillTransparency' $null
            if ($null -ne $fillTransparency -and $kind -ne 'line') { $shape.Fill.Transparency = [single]([double]$fillTransparency / 100) }
            $lineTransparency = Operation-Property $op 'lineTransparency' $null
            if ($null -ne $lineTransparency) { $shape.Line.Transparency = [single]([double]$lineTransparency / 100) }
            $lineWidth = Operation-Property $op 'lineWidth' $null
            if ($null -ne $lineWidth) { $shape.Line.Weight = [single]$lineWidth }
            $rotation = Operation-Property $op 'rotation' $null
            if ($null -ne $rotation -and $kind -ne 'line') { $shape.Rotation = [single]$rotation }
            if ($kind -ne 'line') {
                $paragraphs = $op.PSObject.Properties['paragraphs']
                if ($null -ne $paragraphs -and $null -ne $paragraphs.Value -and @($paragraphs.Value).Count -gt 0) {
                    $null = Set-PowerPointParagraphs $shape $paragraphs.Value
                }
                else {
                    $textProperty = $op.PSObject.Properties['text']
                    if ($null -ne $textProperty) { $shape.TextFrame.TextRange.Text = [string]$textProperty.Value }
                }
            }
            $props = $op.properties
            try {
                if ($kind -ne 'line' -and -not $props.color) {
                    # A paragraph that names its own colour keeps it, as in the portable file.
                    $ink = Color-Value (Ink-OnFill ([string]$fillColor))
                    $specs = @($op.paragraphs | Where-Object { $null -ne $_ })
                    if ($specs.Count -eq 0) { $shape.TextFrame.TextRange.Font.Color.RGB = $ink }
                    for ($index = 1; $index -le $specs.Count; $index++) {
                        if (-not $specs[$index - 1].color) { $shape.TextFrame.TextRange.Paragraphs($index, 1).Font.Color.RGB = $ink }
                    }
                }
                if ($props.fontName) { Set-PowerPointFontName $shape.TextFrame.TextRange.Font ([string]$props.fontName) }
                if ($props.fontSize) { $shape.TextFrame.TextRange.Font.Size = [single]$props.fontSize }
                if ($props.color) { $shape.TextFrame.TextRange.Font.Color.RGB = Color-Value ([string]$props.color) }
                if ($null -ne $props.bold) { $shape.TextFrame.TextRange.Font.Bold = $(if ([bool]$props.bold) { -1 } else { 0 }) }
                if ($null -ne $props.italic) { $shape.TextFrame.TextRange.Font.Italic = $(if ([bool]$props.italic) { -1 } else { 0 }) }
                if ($props.alignment) {
                    $shape.TextFrame.TextRange.ParagraphFormat.Alignment = PowerPoint-ParagraphAlignment $props.alignment
                }
                if ($props.verticalAlignment) {
                    $shape.TextFrame.VerticalAnchor = PowerPoint-VerticalAnchor $props.verticalAlignment
                }
                if ($null -ne $props.marginLeft) { $shape.TextFrame.MarginLeft = [single]$props.marginLeft }
                if ($null -ne $props.marginTop) { $shape.TextFrame.MarginTop = [single]$props.marginTop }
                if ($null -ne $props.marginRight) { $shape.TextFrame.MarginRight = [single]$props.marginRight }
                if ($null -ne $props.marginBottom) { $shape.TextFrame.MarginBottom = [single]$props.marginBottom }
                if ($null -ne $props.paragraphSpacing) { $shape.TextFrame.TextRange.ParagraphFormat.SpaceBefore = [single]$props.paragraphSpacing }
            }
            catch {}
            if ($props.shadow) { Set-PowerPointShadow $shape $props.shadow }
            # The description set_shape writes, which the picture and contrast reviews read; it was dropped here.
            if ($null -ne $props.altText) { $shape.AlternativeText = [string]$props.altText }
            if ($op.name) { try { $shape.Name = [string]$op.name } catch {} }
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
            # The portable writer's unstyled table: no theme style (PowerPoint's default banded blue), a rule under the
            # header, hairlines between the rows, and figures on the right edge of their column.
            try { $shape.Table.ApplyStyle('{2D5ABB26-0587-4C30-8999-92F81FD0307C}', $false) } catch {}
            # ASCII escapes: the host script is read without a byte-order mark, so a literal Hangul unit or minus sign
            # in a pattern arrives mangled. The units are 배 건 억 조 만 천 원 시간 일 개월 개 명 대 곳 분 초 회 점 년.
            $figure = '^[\s~+\-\u2212\u2013$\u20AC\u20A9\u00A3(]*[\d.,]+\s*(?:[%xXKMBT]|\uBC30|\uAC74|\uC5B5|\uC870|\uB9CC|\uCC9C|\uC6D0|\uC2DC\uAC04|\uC77C|\uAC1C\uC6D4|\uAC1C|\uBA85|\uB300|\uACF3|\uBD84|\uCD08|\uD68C|\uC810|\uB144)*[)]?\s*$|^[-\u2013\u2014]$'
            $rightColumns = @{}
            for ($column = 2; $column -le $columns; $column++) {
                $cells = @(for ($row = 2; $row -le [Math]::Min($rows, $values.Count); $row++) { ([string]@($values[$row - 1])[$column - 1]).Trim() }) | Where-Object { $_ }
                if ($cells.Count -gt 0 -and @($cells | Where-Object { $_ -notmatch $figure }).Count -eq 0) { $rightColumns[$column] = $true }
            }
            # columnWidths share the frame's width in their proportions, as the portable writer's grid does.
            $declared = @($op.properties.columnWidths | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ })
            $declaredSum = ($declared | Measure-Object -Sum).Sum
            if ($declared.Count -eq $columns -and $declaredSum -gt 0 -and @($declared | Where-Object { $_ -le 0 }).Count -eq 0) {
                for ($column = 1; $column -le $columns; $column++) {
                    $shape.Table.Columns.Item($column).Width = [single]($width * $declared[$column - 1] / $declaredSum)
                }
            }
            if ($op.properties.headerRowHeight) { $shape.Table.Rows.Item(1).Height = [single]$op.properties.headerRowHeight }
            if ($op.properties.bodyRowHeight) {
                for ($row = 2; $row -le $rows; $row++) { $shape.Table.Rows.Item($row).Height = [single]$op.properties.bodyRowHeight }
            }
            for ($row = 1; $row -le $rows; $row++) {
                for ($column = 1; $column -le $columns; $column++) {
                    $value = if ($row -le $values.Count -and $column -le @($values[$row - 1]).Count) { $values[$row - 1][$column - 1] } else { '' }
                    $cell = $shape.Table.Cell($row, $column).Shape
                    $cell.TextFrame.TextRange.Text = [string]$value
                    # Centred in its row, as the portable writer anchors a cell: top-anchored, a row taller than its
                    # line left the text against the rule above it.
                    try { $cell.TextFrame.VerticalAnchor = 3 } catch {}
                    $props = $op.properties
                    if ($props.fontName) { Set-PowerPointFontName $cell.TextFrame.TextRange.Font ([string]$props.fontName) }
                    if ($props.fontSize) { $cell.TextFrame.TextRange.Font.Size = [single]$props.fontSize }
                    if ($props.color) { $cell.TextFrame.TextRange.Font.Color.RGB = Color-Value ([string]$props.color) }
                    if ($row -eq 1) {
                        if ($props.headerFillColor) { $cell.Fill.ForeColor.RGB = Color-Value ([string]$props.headerFillColor) }
                        if ($props.headerColor) { $cell.TextFrame.TextRange.Font.Color.RGB = Color-Value ([string]$props.headerColor) }
                        $cell.TextFrame.TextRange.Font.Bold = -1
                    }
                    elseif ($props.bodyFillColor) {
                        $cell.Fill.ForeColor.RGB = Color-Value ([string]$props.bodyFillColor)
                    }
                    if ($rightColumns.ContainsKey($column)) { try { $cell.TextFrame.TextRange.ParagraphFormat.Alignment = 3 } catch {} }
                }
            }
            # The rules go on once the text is in, as a second pass, and each one on both cells that share the edge
            # (this row's bottom, the next row's top): written per cell while filling, PowerPoint kept only the last
            # row's rule.
            for ($row = 1; $row -le $rows; $row++) {
                $ruleColor = Color-Value $(if ($row -eq 1) { '9AA3AD' } else { 'D8DCE0' })
                $ruleWeight = $(if ($row -eq 1) { 1 } else { 0.5 })
                for ($column = 1; $column -le $columns; $column++) {
                    try {
                        $edges = @($shape.Table.Cell($row, $column).Borders.Item(3))
                        if ($row -lt $rows) { $edges += $shape.Table.Cell($row + 1, $column).Borders.Item(1) }
                        foreach ($edge in $edges) {
                            $edge.Visible = -1
                            $edge.Transparency = 0
                            $edge.ForeColor.RGB = $ruleColor
                            $edge.Weight = $ruleWeight
                        }
                    }
                    catch {}
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
            while ($availableRows -lt $values.Count) {
                $null = $shape.Table.Rows.Add()
                $availableRows = [int]$shape.Table.Rows.Count
            }
            while ($availableColumns -lt $requestedColumns) {
                $null = $shape.Table.Columns.Add()
                $availableColumns = [int]$shape.Table.Columns.Count
            }
            if ($values.Count -gt $availableRows -or $requestedColumns -gt $availableColumns) {
                throw "PowerPoint table shape $($op.shape) is ${availableRows}x${availableColumns}, but received $($values.Count)x${requestedColumns}"
            }
            # Fewer rows than the table has: the table shrinks to the data, as the portable writer removes the rows
            # past it, rather than keeping them as blank lines.
            while ($values.Count -gt 0 -and $availableRows -gt $values.Count) {
                $shape.Table.Rows.Item($availableRows).Delete()
                $availableRows = [int]$shape.Table.Rows.Count
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
            if (-not $commands.ContainsKey($command)) { throw 'z_order command must be front, back, forward, or backward' }
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
            Set-PowerPointFooterFace $slide $true
            return [ordered]@{ op = 'set_footer'; changed = $true }
        }
        'set_slide_number' {
            $slide = Ppt-Slide $presentation $op
            $slide.HeadersFooters.SlideNumber.Visible = $(if ([bool]$op.visible) { -1 } else { 0 })
            if ([bool]$op.visible) { Set-PowerPointFooterFace $slide $false }
            return [ordered]@{ op = 'set_slide_number'; changed = $true; visible = [bool]$op.visible }
        }
        'add_image' {
            $slide = Ppt-Slide $presentation $op
            $shape = Add-PptImage $slide $op
            if ($op.altText) { $shape.AlternativeText = [string]$op.altText }
            $fit = ([string]$(if ($op.fit) { $op.fit } else { 'stretch' })).ToLowerInvariant()
            return [ordered]@{ op = 'add_image'; changed = $true; shape = [string]$shape.Name; fit = $fit }
        }
        'replace_image' {
            $slide = Ppt-Slide $presentation $op
            $old = $slide.Shapes.Item([int]$op.shape)
            $left = [single]$old.Left; $top = [single]$old.Top; $width = [single]$old.Width; $height = [single]$old.Height
            $old.Delete()
            $shape = $slide.Shapes.AddPicture([string]$op.path, $false, $true, $left, $top, $width, $height)
            # The old frame's description belongs to the picture that just left it.
            if ($op.altText) { $shape.AlternativeText = [string]$op.altText }
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
            if ($op.altText) { $shape.AlternativeText = [string]$op.altText }
            return [ordered]@{ op = 'add_media'; changed = $true; shape = [int]$shape.ZOrderPosition; media = [string]$op.path; embedded = $embed }
        }
        'apply_theme' {
            if (-not $op.path) { throw 'apply_theme requires path' }
            $presentation.ApplyTheme([string]$op.path)
            return [ordered]@{ op = 'apply_theme'; changed = $true; path = [string]$op.path }
        }
        'set_slide_visibility' {
            $slide = Ppt-Slide $presentation $op
            if ($null -eq $op.visible) { throw 'set_slide_visibility requires visible: true or false' }
            $visible = [bool]$op.visible
            $slide.SlideShowTransition.Hidden = $(if ($visible) { 0 } else { -1 })
            return [ordered]@{ op = 'set_slide_visibility'; changed = $true; slide = [int]$slide.SlideIndex; visible = $visible }
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
            # Same vocabulary as the portable writer: on_click and after_previous are
            # the separator spelling of the same triggers.
            $effectKey = ([string]$op.effect) -replace '[\s_-]', '' | ForEach-Object { $_.ToLowerInvariant() }
            $triggerKey = ([string]$op.trigger) -replace '[\s_-]', '' | ForEach-Object { $_.ToLowerInvariant() }
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
            if ($null -ne $props.altText) { $shape.AlternativeText = [string]$props.altText }
            if ($props.fillColor) { $shape.Fill.Visible = $true; $shape.Fill.ForeColor.RGB = Color-Value ([string]$props.fillColor) }
            # Percentages, as add_shape and the portable writer read them; this path read a fraction.
            if ($null -ne $props.fillTransparency) { $shape.Fill.Transparency = [single]([double]$props.fillTransparency / 100) }
            if ($props.lineColor) { $shape.Line.Visible = $true; $shape.Line.ForeColor.RGB = Color-Value ([string]$props.lineColor) }
            if ($null -ne $props.lineTransparency) { $shape.Line.Transparency = [single]([double]$props.lineTransparency / 100) }
            if ($null -ne $props.lineWidth) { $shape.Line.Weight = [single]$props.lineWidth }
            if ($props.shadow) { Set-PowerPointShadow $shape $props.shadow }
            try {
                if ($null -ne $props.marginLeft) { $shape.TextFrame.MarginLeft = [single]$props.marginLeft }
                if ($null -ne $props.marginTop) { $shape.TextFrame.MarginTop = [single]$props.marginTop }
                if ($null -ne $props.marginRight) { $shape.TextFrame.MarginRight = [single]$props.marginRight }
                if ($null -ne $props.marginBottom) { $shape.TextFrame.MarginBottom = [single]$props.marginBottom }
                if ($null -ne $props.paragraphSpacing) { $shape.TextFrame.TextRange.ParagraphFormat.SpaceBefore = [single]$props.paragraphSpacing }
                # Placed as add_shape and the portable writer place it.
                if ($props.alignment) { $shape.TextFrame.TextRange.ParagraphFormat.Alignment = PowerPoint-ParagraphAlignment $props.alignment }
                if ($props.verticalAlignment) { $shape.TextFrame.VerticalAnchor = PowerPoint-VerticalAnchor $props.verticalAlignment }
                $font = $shape.TextFrame.TextRange.Font
                if ($props.fontName) { Set-PowerPointFontName $font ([string]$props.fontName) }
                if ($props.fontSize) { $font.Size = [single]$props.fontSize }
                if ($null -ne $props.bold) { $font.Bold = if ($props.bold) { -1 } else { 0 } }
                if ($null -ne $props.italic) { $font.Italic = if ($props.italic) { -1 } else { 0 } }
                if ($props.color) { $font.Color.RGB = Color-Value ([string]$props.color) }
            }
            catch {}
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
                }
                catch {
                    if ($_.Exception.Message -match '^import_slides requires') { throw }
                }
            }
            if ($op.slides) {
                foreach ($sourceSlide in @($op.slides)) {
                    $count = [int]$presentation.Slides.InsertFromFile($sourcePath, $after + $inserted, [int]$sourceSlide, [int]$sourceSlide)
                    $inserted += $count
                }
            }
            else {
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
            Ensure-PowerPointChartWindow $presentation $allowUiActivation
            $chartType = Office-ChartTypeCode $op.chartType
            $left = if ($null -ne $op.left) { [single]$op.left } else { [single]72 }
            $top = if ($null -ne $op.top) { [single]$op.top } else { [single]72 }
            $width = if ($op.width) { [single]$op.width } else { [single]480 }
            $height = if ($op.height) { [single]$op.height } else { [single]280 }
            # An array even when no Excel runs: an empty result unrolled to $null and skipped the quit below.
            $excelBefore = @(Excel-ProcessIds)
            $shape = $slide.Shapes.AddChart2(-1, $chartType, $left, $top, $width, $height)
            $chartResult = $null
            $seriesProperty = $op.PSObject.Properties['series']
            if ($null -ne $seriesProperty -and $null -ne $seriesProperty.Value) {
                $chartResult = Set-PowerPointChartData $shape.Chart $op.categories $seriesProperty.Value $allowUiActivation
            }
            if ($op.title) { $shape.Chart.HasTitle = $true; $shape.Chart.ChartTitle.Text = [string]$op.title; Set-ChartTitleFace $shape.Chart 0 }
            # A chart given no title carries none, as the portable writer draws it: PowerPoint otherwise sets the one
            # series' name ("사용자 비중(%)") over the plot as an automatic title, a second headline under the page's.
            else { try { $shape.Chart.HasTitle = $true; $shape.Chart.HasTitle = $false } catch {} }
            # The ring the portable writer draws (a 55 % hole); PowerPoint's own doughnut left a thin band.
            if ($chartType -eq -4120) { try { $shape.Chart.ChartGroups(1).DoughnutHoleSize = 55 } catch {} }
            $chart = $shape.Chart
            if ($chartType -eq 57 -or $chartType -eq 58) {
                try { $axis = $chart.Axes(1); $axis.ReversePlotOrder = $true; $axis.Crosses = 2 } catch {}
            }
            $seriesCount = [int]$chart.SeriesCollection().Count
            for ($seriesIndex = 1; $seriesIndex -le $seriesCount; $seriesIndex++) {
                $series = $chart.SeriesCollection().Item($seriesIndex)
                if ([bool]$op.showValues) {
                    try {
                        $series.ApplyDataLabels()
                        $labels = $series.DataLabels()
                        $labels.ShowValue = $true
                        $labels.ShowCategoryName = $false
                        if ($op.valueNumberFormat) { $labels.NumberFormat = [string]$op.valueNumberFormat }
                        if ($op.dataLabelPosition) {
                            $labels.Position = switch (([string]$op.dataLabelPosition).ToLowerInvariant()) {
                                'center' { -4108 }
                                'inside_base' { 4 }
                                'inside_end' { 3 }
                                'outside_end' { 2 }
                                default { 2 }
                            }
                        }
                        if ($op.dataLabelColor) { $labels.Font.Color = Color-Value ([string]$op.dataLabelColor) }
                    }
                    catch {}
                }
            }
            if ($null -ne $op.showLegend) {
                try { $chart.HasLegend = [bool]$op.showLegend } catch {}
            }
            try { $chart.ChartArea.Format.Line.Visible = 0 } catch {}
            try { $chart.PlotArea.Format.Fill.Visible = 0 } catch {}
            try {
                $valueAxis = $chart.Axes(2, 1)
                if ([bool]$op.zeroBaseline) { $valueAxis.MinimumScale = 0 }
                if ($op.valueNumberFormat) { $valueAxis.TickLabels.NumberFormat = [string]$op.valueNumberFormat }
                $valueAxis.MajorGridlines.Format.Line.ForeColor.RGB = Color-Value 'D9E2DF'
            }
            catch {}
            try { $chart.ChartGroups(1).GapWidth = 72 } catch {}
            Set-ChartCategoryLabelsLow $chart @($op.series | ForEach-Object { @($_.values) })
            Close-PowerPointChartData $shape.Chart ($null -eq $chartResult) $excelBefore
            $insideLabels = -not $op.dataLabelPosition -or @('center', 'inside_end', 'inside_base') -contains ([string]$op.dataLabelPosition).ToLowerInvariant()
            Set-PowerPointPointColors $shape.Chart $op.series ([bool]$op.showValues -and $insideLabels -and -not $op.dataLabelColor)
            return [ordered]@{
                op         = 'add_chart'
                changed    = $true
                shape      = [string]$shape.Name
                categories = $(if ($null -ne $chartResult) { [int]$chartResult.categories } else { 0 })
                series     = $(if ($null -ne $chartResult) { [int]$chartResult.series } else { [int]$shape.Chart.SeriesCollection().Count })
            }
        }
        'set_chart_data' {
            $slide = Ppt-Slide $presentation $op
            $shape = $slide.Shapes.Item([int]$op.shape)
            if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
            $chart = $shape.Chart
            $excelBefore = @(Excel-ProcessIds)
            $chartResult = Set-PowerPointChartData $chart $op.categories $op.series
            if ($op.title) { $chart.HasTitle = $true; $chart.ChartTitle.Text = [string]$op.title }
            Close-PowerPointChartData $chart $false $excelBefore
            Set-PowerPointPointColors $chart $op.series
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
                $series.ChartType = Office-ChartTypeCode $op.chartType
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
            # The kinds by name or by the file's code, as the portable writer reads them ('exp' was drawn as a straight
            # line), an unknown one refused rather than drawn linear, and every series unless one is named.
            $types = @{ linear = -4132; exponential = 5; exp = 5; logarithmic = -4133; log = -4133; polynomial = 3; poly = 3; power = 4; movingaverage = 6; movingavg = 6 }
            $kind = if ($op.type) { ([string]$op.type).ToLowerInvariant() -replace '[\s_-]+', '' } else { 'linear' }
            if (-not $types.ContainsKey($kind)) { throw 'set_chart_trendline type must be linear, exponential, logarithmic, polynomial, power, or moving_average' }
            $type = [int]$types[$kind]
            $collection = $shape.Chart.SeriesCollection()
            $indexes = if ($op.series) { @([int]$op.series) } else { @(1..[int]$collection.Count) }
            foreach ($index in $indexes) {
                $trendline = $collection.Item($index).Trendlines().Add($type)
                if ($null -ne $op.displayEquation) { $trendline.DisplayEquation = [bool]$op.displayEquation }
                if ($null -ne $op.displayRSquared) { $trendline.DisplayRSquared = [bool]$op.displayRSquared }
            }
            return [ordered]@{ op = 'set_chart_trendline'; changed = $true; shape = [int]$op.shape; series = $(if ($op.series) { [int]$op.series } else { 'all' }); type = $type }
        }
        'set_chart_error_bars' {
            $slide = Ppt-Slide $presentation $op
            $shape = $slide.Shapes.Item([int]$op.shape)
            if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
            # As the portable writer reads the fields: every series unless one is named, direction x or y (anything
            # else was drawn as y without a word), endStyle the bars' kind (both, plus, minus), capped ends.
            $collection = $shape.Chart.SeriesCollection()
            $indexes = if ($op.series) { @([int]$op.series) } else { @(1..[int]$collection.Count) }
            $directions = @{ y = 1; vertical = 1; x = -4168; horizontal = -4168 }
            $directionName = if ($op.direction) { ([string]$op.direction).ToLowerInvariant() } else { 'y' }
            if (-not $directions.ContainsKey($directionName)) { throw 'set_chart_error_bars direction must be x or y' }
            $includes = @{ both = 1; plus = 2; minus = 3 }
            $kind = if ($op.endStyle) { ([string]$op.endStyle).ToLowerInvariant() } else { 'both' }
            $include = if ($includes.ContainsKey($kind)) { $includes[$kind] } else { 1 }
            $amount = [double]$(if ($null -ne $op.amount) { $op.amount } else { 0 })
            if (-not ($amount -gt 0)) { throw 'set_chart_error_bars requires a positive amount' }
            foreach ($index in $indexes) {
                $series = $collection.Item($index)
                $series.ErrorBar($directions[$directionName], $include, 1, $amount)
                try { $series.ErrorBars.EndStyle = 1 } catch {}
            }
            return [ordered]@{ op = 'set_chart_error_bars'; changed = $true; shape = [int]$op.shape; series = $(if ($op.series) { [int]$op.series } else { 'all' }) }
        }
        'set_chart_data_labels' {
            $slide = Ppt-Slide $presentation $op
            $shape = $slide.Shapes.Item([int]$op.shape)
            if (-not $shape.HasChart) { throw "Shape $($op.shape) is not a chart" }
            # Every series when none is named, as the portable writer labels them (Item(0) failed the batch), and the
            # position by add_chart's names, which a cast to a number refused. A stacked bar takes no outside_end and
            # a pie or doughnut no position at all, as in the portable writer.
            $collection = $shape.Chart.SeriesCollection()
            $indexes = if ($op.series) { @([int]$op.series) } else { @(1..[int]$collection.Count) }
            $positions = @{ center = -4108; centre = -4108; inside_base = 4; inside_end = 3; outside_end = 2; best_fit = 5 }
            $position = $null
            if ($null -ne $op.position) {
                $name = ([string]$op.position).ToLowerInvariant()
                if ($positions.ContainsKey($name)) { $position = $positions[$name] }
                elseif ($op.position -as [int]) { $position = [int]$op.position }
            }
            $chartType = [int]$shape.Chart.ChartType
            if (@(5, 69, -4102, 70, -4120, 80, 68, 71) -contains $chartType) { $position = $null }
            elseif (@(52, 53, 55, 56, 58, 59, 61, 62) -contains $chartType -and $position -eq 2) { $position = -4108 }
            foreach ($index in $indexes) {
                $series = $collection.Item($index)
                $null = $series.ApplyDataLabels()
                $labels = $series.DataLabels()
                if ($null -ne $op.showValue) { $labels.ShowValue = [bool]$op.showValue }
                if ($null -ne $op.showCategoryName) { $labels.ShowCategoryName = [bool]$op.showCategoryName }
                if ($op.numberFormat) { $labels.NumberFormat = [string]$op.numberFormat }
                if ($null -ne $position) { $labels.Position = $position }
            }
            return [ordered]@{ op = 'set_chart_data_labels'; changed = $true; shape = [int]$op.shape; series = $(if ($op.series) { [int]$op.series } else { 'all' }) }
        }
        'fit_text' {
            $slide = Ppt-Slide $presentation $op
            $shape = $slide.Shapes.Item([int]$op.shape)
            $minimum = if ($op.minFontSize) { [single]$op.minFontSize } else { [single]8 }
            try { $shape.TextFrame.AutoSize = 0 } catch {}
            try { $shape.TextFrame2.AutoSize = 0 } catch {}
            # Singles throughout: single arithmetic comes back a Double, and once a call site had set Width with a
            # Single, PowerShell's COM binder refused the Double here ("specified cast is not valid") and qa's repair
            # of a box past the slide edge failed the batch.
            $maximumWidth = [single]([single]$presentation.PageSetup.SlideWidth - [single]$shape.Left)
            $maximumHeight = [single]([single]$presentation.PageSetup.SlideHeight - [single]$shape.Top)
            if ($shape.Width -gt $maximumWidth) { $shape.Width = $maximumWidth }
            if ($shape.Height -gt $maximumHeight) { $shape.Height = $maximumHeight }
            $font = $shape.TextFrame.TextRange.Font
            while ($font.Size -gt $minimum -and (
                    [single]$shape.TextFrame2.TextRange.BoundWidth -gt ([single]$shape.Width + 1) -or
                    [single]$shape.TextFrame2.TextRange.BoundHeight -gt ([single]$shape.Height + 1)
                )) {
                $font.Size = [single]([single]$font.Size - 1)
            }
            return [ordered]@{ op = 'fit_text'; changed = $true; shape = [int]$op.shape; fontSize = [single]$font.Size }
        }
        default { throw "Unsupported PPTX operation: $($op.op)" }
    }
}

function Apply-Operations(
    $document,
    [string]$format,
    $operations,
    [bool]$live,
    [bool]$requireChanges = $true,
    [bool]$allowUiActivation = $live
) {
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
        }
        catch {}
    }
    try {
        foreach ($op in @($operations)) {
            if ($live -and $format -eq 'pptx') {
                try { $document.Application.StartNewUndoEntry() } catch {}
            }
            $emitted = @(switch ($format) {
                    'docx' { Apply-WordOperation $document $op }
                    'xlsx' { Apply-ExcelOperation $document $op }
                    'pptx' { Apply-PowerPointOperation $document $op $live $allowUiActivation }
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
    }
    catch {
        $line = [int]$_.InvocationInfo.ScriptLineNumber
        $failure = "$($op.op) failed at office-com-host.ps1:$line`: $($_.Exception.Message)"
    }
    finally {
        if ($wordRecordStarted) {
            try { $wordUndoRecord.EndCustomRecord() } catch {}
        }
    }
    $wordChanged = @($results | Where-Object { -not $_.Contains('changed') -or [bool]$_.changed }).Count -gt 0
    if ($failure) {
        # Word keeps an empty custom record off the undo stack, so Undo(1) after an operation that failed before
        # touching the document took back the previous batch instead: a missing table index erased the table added
        # the batch before. Only a batch that changed something is undone.
        if ($live -and $format -eq 'docx' -and $wordRecordStarted -and ($wordChanged -or
                (Snapshot-Fingerprint (Snapshot-Document $document $format ([ordered]@{}))) -ne $beforeFingerprint)) {
            try { $null = $document.Undo(1) } catch {}
        }
        elseif ($live -and $format -eq 'pptx') {
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
    # A batch that changed nothing (allowNoChange) left no record for a later rollback to take back.
    if ($live -and $format -eq 'docx' -and $wordChanged) { $undoUnits = 1 }
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
        foreach ($family in @($collection.Families)) {
            # GDI+ reports culture-localized family names (e.g. 맑은 고딕), while
            # Office documents usually store the invariant English name (Malgun
            # Gothic). Register both so neither spelling reads as missing.
            $fonts[[string]$family.Name] = $true
            try { $fonts[[string]$family.GetName(1033)] = $true } catch {}
        }
        $collection.Dispose()
    }
    catch {}
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
        }
        catch {}
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
        }
        catch {}
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
        }
        catch {}
    }
    return $issues
}

function Add-CappedOfficeIssue($issues, [ref]$omitted, $issue, [int]$limit = 500) {
    if ($issues.Count -lt $limit) {
        [void]$issues.Add($issue)
    }
    else {
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
                LastFormula  = 0
                Values       = [System.Collections.ArrayList]::new()
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
                    }
                    elseif ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
                        [void]$state.Values.Add([pscustomobject]@{
                                Address = $address
                                Path    = $path
                                Column  = $absoluteColumn
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
        issues   = [object[]]$issues.ToArray()
        coverage = [ordered]@{
            sheet        = [string]$sheet.Name
            range        = [string]$used.Address($false, $false)
            rows         = $rowCount
            columns      = $columnCount
            totalCells   = $totalCells
            scannedCells = $scannedCells
            chunks       = $chunks
            complete     = $scannedCells -eq $totalCells
        }
    }
}

# The tie-out sheet is named in the reader's language, and matching the English
# convention alone left a Korean workbook's checks unread: the profile's central
# test never ran and the model passed as if it had none. This file carries no
# byte order mark and Windows PowerShell reads it under the ANSI codepage, so a
# non-Latin name typed here would not survive to the comparison — the names are
# built from their code points instead.
function Is-ChecksSheetName($name) {
    $label = ([string]$name).Trim()
    $accepted = @(
        'checks',
        'check',
        ([string][char]0xAC80 + [string][char]0xC99D),
        ([string][char]0xC810 + [string][char]0xAC80)
    )
    foreach ($candidate in $accepted) {
        if ([string]::Equals($label, $candidate, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Issues-Excel($book, $payload) {
    $issues = @()
    $coverage = @()
    $fonts = Installed-OfficeFonts
    $financialAudit = $payload.auditProfile -eq 'financial-model'
    if ($financialAudit) {
        $hasChecks = $false
        foreach ($candidate in @($book.Worksheets)) {
            if (Is-ChecksSheetName $candidate.Name) { $hasChecks = $true; break }
        }
        if (-not $hasChecks) { $issues += Office-Issue 'warning' 'missing_checks_sheet' '/' 'Financial-model audit expects a Checks sheet with explicit tie-out formulas.' }
    }
    foreach ($sheet in @($book.Worksheets)) {
        if ($payload.sheet -and -not [string]::Equals([string]$payload.sheet, [string]$sheet.Name, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        # A picture on a sheet is described as on a slide or a page: the portable audit asked it of a workbook and
        # this one did not, so the same unlabelled logo passed on Excel alone.
        $pictureIndex = 0
        foreach ($shape in @($sheet.Shapes)) {
            try {
                if ([int]$shape.Type -ne 13) { continue }
                $pictureIndex++
                $description = ([string]$shape.AlternativeText).Trim()
                if (-not $description -or $description -match '^[\w ().\-]+\.(?:png|jpe?g|gif|bmp|tiff?|svg|webp|emf|wmf)$') {
                    $issues += Office-Issue 'warning' 'missing_alt_text' "/sheet[$([string]$sheet.Name)]/image[$pictureIndex]" 'Picture has no alternative text; add_image takes altText.'
                }
            }
            catch {}
        }
        $used = $sheet.UsedRange
        if ($payload.range) { $used = $sheet.Range([string]$payload.range) }
        if ($financialAudit) {
            $commentAddresses = @{}
            try {
                $commentCells = $used.SpecialCells(-4144)
                foreach ($commentCell in @($commentCells.Cells)) {
                    $commentAddresses[[string]$commentCell.Address($false, $false)] = $true
                }
            }
            catch {}
            $inspection = Inspect-ExcelFinancialRange $sheet $used $fonts $commentAddresses
            $issues += @($inspection.issues)
            $coverage += $inspection.coverage
        }
        else {
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
                sheet        = [string]$sheet.Name
                range        = [string]$used.Address($false, $false)
                rows         = [int]$used.Rows.Count
                columns      = [int]$used.Columns.Count
                totalCells   = [int64]$used.Rows.Count * [int64]$used.Columns.Count
                scannedCells = [int64]$sampleRows * [int64]$columns
                complete     = [int64]$sampleRows * [int64]$columns -eq [int64]$used.Rows.Count * [int64]$used.Columns.Count
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
            }
            catch {}
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
        }
        catch {}
        for ($chartIndex = 1; $chartIndex -le $sheet.ChartObjects().Count; $chartIndex++) {
            try {
                $chart = $sheet.ChartObjects().Item($chartIndex).Chart
                if ($chart.SeriesCollection().Count -eq 0) {
                    $issues += Office-Issue 'error' 'empty_chart' "/sheet[$($sheet.Name)]/chart[$chartIndex]" 'Chart has no data series.'
                }
            }
            catch {
                $issues += Office-Issue 'error' 'broken_chart' "/sheet[$($sheet.Name)]/chart[$chartIndex]" 'Chart data could not be inspected.'
            }
        }
    }
    try {
        $links = @($book.LinkSources(1))
        foreach ($link in $links) { if ($link) { $issues += Office-Issue 'warning' 'external_link' '/' "Workbook links to external source: $link" } }
    }
    catch {}
    $totalCells = [int64]0
    $scannedCells = [int64]0
    foreach ($entry in $coverage) {
        $totalCells += [int64]$entry.totalCells
        $scannedCells += [int64]$entry.scannedCells
    }
    return [ordered]@{
        issues        = @($issues)
        auditCoverage = [ordered]@{
            mode         = $(if ($financialAudit) { 'full' } else { 'sampled' })
            complete     = @($coverage | Where-Object { -not $_.complete }).Count -eq 0
            totalCells   = $totalCells
            scannedCells = $scannedCells
            sheets       = $coverage
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
        $largeTextShapeCount = 0
        $dominantTextShapeCount = 0
        # This slide's content text geometry, read once. The overlap pass below works on these numbers instead
        # of asking PowerPoint for every pair's Left/Top/Width/Height again — one 20-shape slide was spending
        # roughly two thousand cross-process calls on that single check.
        $textBoxes = @()
        $slideWidth = [single]$presentation.PageSetup.SlideWidth
        $slideHeight = [single]$presentation.PageSetup.SlideHeight
        foreach ($shape in @($slide.Shapes)) {
            $shapeIndex++
            $path = "/slide[$($slide.SlideIndex)]/shape[$shapeIndex]"
            try {
                if (@(1, 3, 6, 13, 21, 28) -contains [int]$shape.Type -or $shape.HasChart -or $shape.HasTable) { $visualShapeCount++ }
            }
            catch {}
            try {
                if ($shape.Type -eq 13 -and [string]::IsNullOrWhiteSpace([string]$shape.AlternativeText)) {
                    $issues += Office-Issue 'warning' 'missing_alt_text' $path 'Picture has no alternative text.'
                }
            }
            catch {}
            # Named motif shapes are deliberate decoration (ghosted numerals, halos);
            # they are never held to the legibility rules that govern content text.
            $isMotif = $(try { ([string]$shape.Name).StartsWith('Mixdog Motif') } catch { $false })
            # One walk down each chain per shape (TextFrame, TextFrame2, Fill, geometry): every dotted step is a call.
            $frameRef = $(try { if ($shape.HasTextFrame) { $shape.TextFrame } else { $null } } catch { $null })
            $rangeRef = $(try { if ($frameRef) { $frameRef.TextRange } else { $null } } catch { $null })
            $fontRef = $(try { if ($rangeRef) { $rangeRef.Font } else { $null } } catch { $null })
            $bounds2Ref = $(try { if ($frameRef) { $shape.TextFrame2.TextRange } else { $null } } catch { $null })
            $shapeFillRef = $(try { $shape.Fill } catch { $null })
            $shapeLeft = [single]$shape.Left
            $shapeTop = [single]$shape.Top
            $shapeWidth = [single]$shape.Width
            $shapeHeight = [single]$shape.Height
            try {
                if ($frameRef -and $frameRef.HasText -and -not $isMotif) {
                    $textShapeCount++
                    $textBoxes += [ordered]@{
                        index  = $shapeIndex
                        left   = [double]$shapeLeft
                        top    = [double]$shapeTop
                        right  = [double]($shapeLeft + $shapeWidth)
                        bottom = [double]($shapeTop + $shapeHeight)
                        area   = [double]($shapeWidth * $shapeHeight)
                    }
                    $boundWidth = [single]$bounds2Ref.BoundWidth
                    $boundHeight = [single]$bounds2Ref.BoundHeight
                    # A word-wrapped box cannot overflow sideways — PowerPoint folds at the box
                    # width — yet BoundWidth reports a wrapped Korean line up to ~1.1 pt wider than
                    # the box (probe 2026-09-04: 100.62 in a 99.6 pt box, 2 lines, no clipping).
                    # Width is a defect only when wrap is off, or the excess is well past slop.
                    $wordWrap = $(try { [int]$frameRef.WordWrap -ne 0 } catch { $true })
                    $widthSlop = $(if ($wordWrap) { 6 } else { 1 })
                    # BoundWidth also carries an allowance past the last glyph of a line, 0.2-0.33 em across faces
                    # (probe 2026-09-25: Arial 'A' 0.945 em against a 0.667 em advance, Malgun Gothic's Hangul +0.31 em).
                    # At body size it hides in the slop; a 120 pt quotation mark read 30 pt past a box its ink fits.
                    $runSize = $(try { [single]$fontRef.Size } catch { 0 })
                    $lineEnd = $(if ($runSize -gt 0 -and $runSize -lt 1000) { 0.2 * $runSize } else { 0 })
                    if (($boundWidth - $lineEnd) -gt ($shapeWidth + $widthSlop) -or $boundHeight -gt ($shapeHeight + 1)) {
                        $issues += Office-Issue 'warning' 'text_overflow' $path 'Text bounds exceed the containing shape.'
                    }
                    $fontIssue = Missing-FontIssue $fonts ([string]$fontRef.Name) $path
                    if ($fontIssue) { $issues += $fontIssue }
                    $fontSize = [single]$fontRef.Size
                    if ($fontSize -ge 34) { $largeTextShapeCount++ }
                    if ($fontSize -ge 42) { $dominantTextShapeCount++ }
                    # Page chrome (kickers, badges, captions, source lines) is one short
                    # line at caption size; it may be 9 pt and sit nearer the edge. Body
                    # copy keeps the 12 pt / 18 pt floors.
                    $shapeText = [string]$rangeRef.Text
                    $isChrome = ($fontSize -gt 0 -and $fontSize -le 12 -and $shapeText.Trim().Length -le 90 -and $shapeText -notmatch "[\r\n]")
                    if ($fontSize -gt 0 -and $fontSize -lt 9) {
                        $issues += Office-Issue 'warning' 'small_font' $path "Text uses $fontSize pt; nothing on a slide should be smaller than 9 pt."
                    }
                    elseif ($fontSize -gt 0 -and $fontSize -lt 12 -and -not $isChrome) {
                        $issues += Office-Issue 'warning' 'small_font' $path "Text uses $fontSize pt; presentation body text should normally be at least 12 pt."
                    }
                    if ($shapeLeft -lt 0 -or $shapeTop -lt 0 -or
                        ($shapeLeft + $shapeWidth) -gt ($slideWidth + 1) -or
                        ($shapeTop + $shapeHeight) -gt ($slideHeight + 1)) {
                        $issues += Office-Issue 'warning' 'text_outside_slide' $path 'Text shape extends outside the slide boundary.'
                    }
                    $edgeMargin = if ($isChrome) { 10 } else { 18 }
                    if ($shapeLeft -lt $edgeMargin -or $shapeTop -lt $edgeMargin -or
                        ($shapeLeft + $shapeWidth) -gt ($slideWidth - $edgeMargin) -or
                        ($shapeTop + $shapeHeight) -gt ($slideHeight - $edgeMargin)) {
                        $issues += Office-Issue 'warning' 'edge_margin' $path "Text is within $edgeMargin pt of a slide edge."
                    }
                    try {
                        $fillColorValue = $(try { if ($shapeFillRef -and $shapeFillRef.Visible) { [long]$shapeFillRef.ForeColor.RGB } else { -1 } } catch { -1 })
                        $fontColorValue = $(try { [long]$fontRef.Color.RGB } catch { -1 })
                        if ($fillColorValue -ge 0 -and $fontColorValue -ge 0) {
                            $contrast = Color-ContrastRatio $fontColorValue $fillColorValue
                            if ($contrast -lt 3) {
                                $issues += Office-Issue 'warning' 'low_contrast' $path "Text-to-fill contrast ratio is $([Math]::Round($contrast, 2)):1."
                            }
                        }
                    }
                    catch {}
                }
            }
            catch {}
            try {
                if ($shape.Type -eq 14 -and -not ($frameRef -and $frameRef.HasText)) {
                    $placeholderType = [int]$shape.PlaceholderFormat.Type
                    if (@(1, 2, 3, 4, 5, 6, 7) -contains $placeholderType) {
                        $issues += Office-Issue 'warning' 'empty_placeholder' $path 'A visible content placeholder is still empty.'
                    }
                }
            }
            catch {}
            try {
                if ($shape.HasChart -and $shape.Chart.SeriesCollection().Count -eq 0) {
                    $issues += Office-Issue 'error' 'empty_chart' "$path/chart" 'Chart has no data series.'
                }
            }
            catch {
                if ($shape.HasChart) { $issues += Office-Issue 'error' 'broken_chart' "$path/chart" 'Chart data could not be inspected.' }
            }
        }
        for ($leftIndex = 0; $leftIndex -lt $textBoxes.Count; $leftIndex++) {
            $left = $textBoxes[$leftIndex]
            for ($rightIndex = $leftIndex + 1; $rightIndex -lt $textBoxes.Count; $rightIndex++) {
                $right = $textBoxes[$rightIndex]
                # Double literals, as in Clamp-Unit: the Int32 overload rounded each overlap to whole points.
                $x = [Math]::Max([double]0, [Math]::Min($left.right, $right.right) - [Math]::Max($left.left, $right.left))
                $y = [Math]::Max([double]0, [Math]::Min($left.bottom, $right.bottom) - [Math]::Max($left.top, $right.top))
                $intersection = $x * $y
                $smallest = [Math]::Min($left.area, $right.area)
                if ($smallest -gt 0 -and ($intersection / $smallest) -ge 0.25) {
                    $issues += Office-Issue 'warning' 'shape_overlap' "/slide[$($slide.SlideIndex)]" "Text shapes $($left.index) and $($right.index) overlap by at least 25%."
                }
            }
        }
        $typographicVisual = $dominantTextShapeCount -gt 0 -or $largeTextShapeCount -ge 2
        $boundarySlide = [int]$slide.SlideIndex -eq 1 -or [int]$slide.SlideIndex -eq [int]$presentation.Slides.Count
        if ($textShapeCount -gt 0 -and $visualShapeCount -eq 0 -and -not $typographicVisual -and -not $boundarySlide) {
            $issues += Office-Issue 'warning' 'text_only_slide' "/slide[$($slide.SlideIndex)]" 'Slide contains text but no visual shape, chart, table, diagram, or picture.'
        }
        if ($payload.auditProfile -eq 'model-backed-deck') {
            $allText = @($slide.Shapes | ForEach-Object {
                    try { if ($_.HasTextFrame -and $_.TextFrame.HasText) { [string]$_.TextFrame.TextRange.Text } } catch {}
                }) -join ' '
            $notes = PowerPoint-NotesText $slide
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
    $result = [ordered]@{ ok = -not (@($issues | Where-Object severity -EQ 'error').Count -gt 0); format = $format; issueCount = @($issues).Count; issues = @($issues) }
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
            ok                  = [bool]$inspection.ok
            opened              = $true
            issueCount          = [int]$inspection.issueCount
            issues              = @($inspection.issues)
            snapshotFingerprint = Snapshot-Fingerprint $snapshot
        }
    }
    catch {
        return [ordered]@{ ok = $false; opened = $false; error = [string]$_.Exception.Message }
    }
    finally {
        if ($null -ne $validationDocument) {
            try { Close-OfficeDocument $validationDocument $format }
            catch { Write-OfficeCleanupFailure ([ordered]@{ ok = $false; errors = @("Validation document close failed: $($_.Exception.Message)") }) }
            try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($validationDocument) } catch {}
        }
        if ($null -ne $validationApp) {
            try {
                if ((Office-DocumentCount $validationApp $format) -eq 0) { $validationApp.Quit() }
            }
            catch { Write-OfficeCleanupFailure ([ordered]@{ ok = $false; errors = @("Validation application cleanup failed: $($_.Exception.Message)") }) }
            try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($validationApp) } catch {}
        }
    }
}

function Save-Document($document, [string]$format) {
    if ($format -eq 'xlsx') {
        try { $document.Application.CalculateFullRebuild() } catch {}
    }
    if ($format -eq 'docx') {
        # A table of contents is usually written before the sections it lists; the
        # save rebuilds it from the headings as they stand, as the portable writer does.
        try { foreach ($toc in @($document.TablesOfContents)) { try { $toc.Update() } catch {} } } catch {}
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
    }
    finally {
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
    }
    finally {
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
                        # A sheet that declares a fit prints by it, and the review shows that print: forcing one
                        # page wide and any number tall split a one-page report's chart across two preview pages.
                        # Only a sheet with no fit of its own is previewed one page wide.
                        if ($pageSetup.Zoom -eq $false) { continue }
                        $pageSetups += [ordered]@{
                            PageSetup      = $pageSetup
                            Zoom           = $pageSetup.Zoom
                            FitToPagesWide = $pageSetup.FitToPagesWide
                            FitToPagesTall = $pageSetup.FitToPagesTall
                        }
                        $pageSetup.Zoom = $false
                        $pageSetup.FitToPagesWide = 1
                        $pageSetup.FitToPagesTall = $false
                    }
                    catch {}
                }
                $document.ExportAsFixedFormat(0, $output)
            }
            finally {
                foreach ($state in $pageSetups) {
                    try {
                        $state.PageSetup.Zoom = $state.Zoom
                        $state.PageSetup.FitToPagesWide = $state.FitToPagesWide
                        $state.PageSetup.FitToPagesTall = $state.FitToPagesTall
                    }
                    catch {}
                }
            }
        }
        # PowerPoint honors only the first SaveCopyAs PDF export per open
        # presentation and silently ignores later ones, and ExportAsFixedFormat
        # cannot be dispatched through PowerShell's late binder at all. Session
        # hosts therefore reopen the presentation before every repeat export.
        'pptx' { $document.SaveCopyAs($output, 32) }
    }
    # PowerPoint SaveCopyAs can return before the PDF hits disk, so wait for the
    # exported file to exist with a stable non-zero size before reporting success.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $lastSize = -1
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $output) {
            $size = (Get-Item -LiteralPath $output).Length
            if ($size -gt 0 -and $size -eq $lastSize) { return }
            $lastSize = $size
        }
        Start-Sleep -Milliseconds 150
    }
    throw "Rendered PDF did not appear at $output within 30 seconds."
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
    }
    else {
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
            }
            else {
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
                $applied = Apply-Operations $document $format $payload.operations $live ([bool]$payload.requireChanges) $live
                if (-not $live -or $payload.save) { Save-Document $document $format }
                Emit-Json ([ordered]@{ ok = $true; backend = 'microsoft-office-com'; mode = $(if ($live) { 'live' } else { 'background' }); saved = (-not $live -or [bool]$payload.save); results = $applied.results; undoUnits = $applied.undoUnits })
            }
            catch {
                if ($excelCheckpoint) { try { Restore-ExcelCheckpoint $document $excelCheckpoint } catch {} }
                throw
            }
            finally {
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
}
catch {
    Emit-Json ([ordered]@{ ok = $false; backend = 'microsoft-office-com'; error = [string]$_.Exception.Message })
    exit 1
}
finally {
    if ($null -ne $document) {
        if (-not $live) {
            try { Close-OfficeDocument $document $format }
            catch { Write-OfficeCleanupFailure ([ordered]@{ ok = $false; errors = @("Document close failed: $($_.Exception.Message)") }) }
        }
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($document) } catch {}
    }
    if ($null -ne $app) {
        if ($createdApp) {
            try {
                if ((Office-DocumentCount $app $format) -eq 0) { $app.Quit() }
            }
            catch { Write-OfficeCleanupFailure ([ordered]@{ ok = $false; errors = @("Application cleanup failed: $($_.Exception.Message)") }) }
        }
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch {}
    }
    if ($format -eq 'pptx') {
        try { $null = Close-PowerPointChartExcelApplications $createdApp } catch {}
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
