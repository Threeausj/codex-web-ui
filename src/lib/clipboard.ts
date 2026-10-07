/** Clipboard file items must be read during the paste event. Some browsers
 * expose images through items before their FileList has been populated. */
export function clipboardFiles(clipboard: Pick<DataTransfer, "items" | "files"> | null | undefined): File[] {
  if (!clipboard) return [];
  const files: File[] = [];
  const signatures = new Set<string>();
  const append = (file: File | null) => {
    if (!file) return;
    const signature = [file.name, file.type, file.size, file.lastModified].join("\0");
    if (files.includes(file) || signatures.has(signature)) return;
    signatures.add(signature);
    files.push(file);
  };
  for (const item of Array.from(clipboard.items || [])) {
    if (item.kind !== "file") continue;
    try { append(item.getAsFile()); } catch { /* A failed item must not hide the FileList fallback. */ }
  }
  for (const file of Array.from(clipboard.files || [])) append(file);
  return files;
}
