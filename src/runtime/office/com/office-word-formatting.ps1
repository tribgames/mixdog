# Keep the COM and OOXML contracts in points, with independent script fonts.
function Set-WordRunFormat($range, $props) {
  if ($props.name) { $range.Font.Name = [string]$props.name }
  if ($props.nameEastAsia) { $range.Font.NameFarEast = [string]$props.nameEastAsia }
  if ($props.size) { $range.Font.Size = [single]$props.size }
  if ($null -ne $props.bold) { $range.Font.Bold = if ($props.bold) { -1 } else { 0 } }
  if ($null -ne $props.italic) { $range.Font.Italic = if ($props.italic) { -1 } else { 0 } }
  if ($null -ne $props.underline) { $range.Font.Underline = if ($props.underline) { 1 } else { 0 } }
  if ($props.color) { $range.Font.Color = Color-Value ([string]$props.color) }
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
}
