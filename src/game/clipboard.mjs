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

/**
 * Copies `text`, then hands `show` the status a screen reads: COPIED or COPY
 * FAILED. `live()` says whether the screen visit that asked is still on; once
 * it is over at resolution, `show` gets nothing.
 */
export async function copyWithStatus(clipboard, text, show, live = () => true) {
  const status = (await copyText(clipboard, text)) ? 'COPIED' : 'COPY FAILED';
  if (live()) show(status);
}

/** The SAVE CODE label, followed by the copy status when there is one. */
export function saveLabel(status) {
  return status ? `SAVE CODE  ${status}` : 'SAVE CODE';
}
