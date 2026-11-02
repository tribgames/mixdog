# Encrypt and decrypt

Read before `action:'secure'`, or before working on a PDF a snapshot reports `encrypted:true`.

- Reading an encrypted file with `passwordRequired:true` needs the user password on that call (`open` or `snapshot` with `password`; it is not kept). Editing needs an unencrypted copy from `action:'secure' security:'decrypt' path password output:<copy.pdf>`; then open that copy.
- `action:'secure' security:'encrypt' path password ownerPassword output:<file.pdf>` writes an AES-256 copy (`ownerPassword` defaults to `password`); `security:'decrypt'` reverses it with the password.
- Both need qpdf on the machine: `action:'detect'` reports `portable.pdfSecurity.available` (qpdf on PATH or `MIXDOG_QPDF_PATH`) before you promise either.
- Verify: opening an encrypted output reports `encrypted:true`; a decrypted one `encrypted:false` with text matching the original.
