# OCR

Read before running OCR on pages a snapshot lists in `likelyScannedPages`.

- `action:'detect'` reports `portable.pdfOcr` (`available`, `cachedLanguages`) beforehand: a language not cached is downloaded on first use, so on a machine without network access only the cached ones work.
- `batch operations:[{ op:'ocr_pages', pages, languages:'eng+kor' }]` adds an invisible searchable layer in place — one run per recognized line, so a phrase the page shows is found afterwards.
- The result reports `wordCount` and `averageConfidence`; low confidence means a larger `maxWidth` or a different `languages`. Korean OCR sometimes splits a word into syllables, so search the new text layer with a short token, not a whole phrase.
