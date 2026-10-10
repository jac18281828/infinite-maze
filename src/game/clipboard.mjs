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

/** Copies `text`, then hands `show` the status a screen reads: COPIED or COPY FAILED. */
export async function copyWithStatus(clipboard, text, show) {
  show((await copyText(clipboard, text)) ? 'COPIED' : 'COPY FAILED');
}

/** The SAVE CODE label, followed by the copy status when there is one. */
export function saveLabel(status) {
  return status ? `SAVE CODE  ${status}` : 'SAVE CODE';
}
