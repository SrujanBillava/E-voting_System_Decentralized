/** Copies text; resolves false (instead of throwing) when the browser refuses, so the UI can offer manual selection. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
