# Exploration

- Supplied/home/environment paths need no locator; one parent listing, not
  sibling walks.
- Unknown data: read one sample, let the observed format decide the parser,
  then process the full data programmatically — a sample is not the input
  domain. Large data or binary files go through bounded slices, never whole
  dumps or per-item listings.
