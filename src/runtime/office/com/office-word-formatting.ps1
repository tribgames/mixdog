# The Latin face alone, as the contract and the portable writer read `name`: Font.Name given an East Asian face
# ("Batang") set the Hangul face too, which the contract leaves to nameEastAsia.
function Set-WordLatinFont($font, [string]$name) {
    $font.NameAscii = $name
    $font.NameOther = $name
}

# Keep the COM and OOXML contracts in points, with independent script fonts.
function Set-WordRunFormat($range, $props) {
    if ($props.name) { Set-WordLatinFont $range.Font ([string]$props.name) }
    if ($props.nameEastAsia) { $range.Font.NameFarEast = [string]$props.nameEastAsia }
    if ($props.size) { $range.Font.Size = [single]$props.size }
    if ($null -ne $props.bold) { $range.Font.Bold = if ($props.bold) { -1 } else { 0 } }
    if ($null -ne $props.italic) { $range.Font.Italic = if ($props.italic) { -1 } else { 0 } }
    if ($null -ne $props.underline) { $range.Font.Underline = if ($props.underline) { 1 } else { 0 } }
    if ($null -ne $props.hidden) { $range.Font.Hidden = if ($props.hidden) { -1 } else { 0 } }
    if ($props.color) { $range.Font.Color = Color-Value ([string]$props.color) }
}

# The portable writer's w:pBdr: size in eighths of a point (snapped to Word's own line widths, which count the
# same way) and the gap to the text in points. A quote's 2 pt bar used to print as Word's default hairline.
function Set-WordParagraphBorder($paragraph, $spec) {
    $side = [string]$spec.side
    $border = $paragraph.Borders.Item($(switch ($side) { 'top' { -1 } 'left' { -2 } 'right' { -4 } default { -3 } }))
    # The line the portable writer draws for the same style: a dashed rule printed solid here.
    $border.LineStyle = switch ([string]$spec.style) { 'dashed' { 3 } 'dash' { 3 } 'dotted' { 2 } 'dot' { 2 } 'double' { 7 } default { 1 } }
    if ($spec.size) {
        $size = [double]$spec.size
        $border.LineWidth = @(2, 4, 6, 8, 12, 18, 24, 36, 48) | Sort-Object { [Math]::Abs($_ - $size) } | Select-Object -First 1
    }
    if ($spec.color) { $border.Color = Color-Value ([string]$spec.color) }
    if ($null -ne $spec.space -and "$($spec.space)" -ne '') {
        $gap = [single]$spec.space
        switch ($side) {
            'top' { $paragraph.Borders.DistanceFromTop = $gap }
            'left' { $paragraph.Borders.DistanceFromLeft = $gap }
            'right' { $paragraph.Borders.DistanceFromRight = $gap }
            default { $paragraph.Borders.DistanceFromBottom = $gap }
        }
    }
}

# A paragraph alignment in the names the portable writer reads (centre, both, distribute as well): "centre" set a
# paragraph centred in the portable file and left here.
function Word-ParagraphAlignment($alignment) {
    switch (([string]$alignment).ToLowerInvariant()) {
        'center' { return 1 }
        'centre' { return 1 }
        'right' { return 2 }
        'justify' { return 3 }
        'both' { return 3 }
        'distribute' { return 4 }
        default { return 0 }
    }
}

function Set-WordParagraphFlow($format, $props) {
    if ($null -ne $props.spacingBefore) { $format.SpaceBefore = [single]$props.spacingBefore }
    if ($null -ne $props.spacingAfter) { $format.SpaceAfter = [single]$props.spacingAfter }
    if ($null -ne $props.lineSpacing) {
        $format.LineSpacingRule = 3 # wdLineSpaceAtLeast; LineSpacing is measured in points.
        $format.LineSpacing = [single]$props.lineSpacing
    }
    if ($null -ne $props.keepWithNext) { $format.KeepWithNext = if ($props.keepWithNext) { -1 } else { 0 } }
    if ($null -ne $props.keepTogether) { $format.KeepTogether = if ($props.keepTogether) { -1 } else { 0 } }
    if ($null -ne $props.widowControl) { $format.WidowControl = if ($props.widowControl) { -1 } else { 0 } }
    if ($null -ne $props.pageBreakBefore) { $format.PageBreakBefore = if ($props.pageBreakBefore) { -1 } else { 0 } }
    # Indents in points and the paragraph's own field, as the portable writer's w:ind and w:shd.
    if ($null -ne $props.indentLeft) { $format.LeftIndent = [single]$props.indentLeft }
    if ($null -ne $props.indentRight) { $format.RightIndent = [single]$props.indentRight }
    if ($null -ne $props.indentFirstLine) { $format.FirstLineIndent = [single]$props.indentFirstLine }
    if ($props.shading) { $format.Shading.BackgroundPatternColor = Color-Value ([string]$props.shading) }
}
