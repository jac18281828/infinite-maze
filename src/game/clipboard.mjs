// Clipboard writes for the save and seed codes. The clipboard arrives as an
// argument and no global is read, so node tests this module with a fake.

/** Resolves true once `clipboard.writeText(text)` resolves; false when the clipboard is missing or refuses. */
export async function copyText(clipboard, text) {
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
