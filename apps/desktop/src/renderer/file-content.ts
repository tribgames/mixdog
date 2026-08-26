// Accept any file whose first 4 KB has no NUL byte and a low control-character
// ratio, instead of trusting an extension whitelist.
export async function fileLooksLikeText(file: File): Promise<boolean> {
  try {
    const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (bytes.length === 0) return true;
    let control = 0;
    for (const byte of bytes) {
      if (byte === 0) return false;
      if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
    }
    return control / bytes.length <= 0.3;
  } catch {
    return false;
  }
}
