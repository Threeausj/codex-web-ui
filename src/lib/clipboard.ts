/** Clipboard file items must be read during the paste event. Some browsers
 * expose images through items before their FileList has been populated. */
export function clipboardFiles(clipboard: Pick<DataTransfer, "items" | "files"> | null | undefined): File[] {
  if (!clipboard) return [];
  const files: File[] = [];
  const append = (file: File | null) => {
    if (!file || files.includes(file)) return;
    files.push(file);
  };
  for (const item of Array.from(clipboard.items || [])) {
    if (item.kind !== "file") continue;
    try { append(item.getAsFile()); } catch { /* A failed item must not hide the FileList fallback. */ }
  }
  for (const file of Array.from(clipboard.files || [])) append(file);
  return files;
}

/** Browser aliases can have different names/timestamps; matching metadata can
 * also belong to different images. Compare bytes within this paste only. */
export async function uniqueClipboardFiles(files: readonly File[]): Promise<File[]> {
  const groups = new Map<number, File[]>();
  for (const file of files) {
    const group = groups.get(file.size) || [];
    if (!group.includes(file)) group.push(file);
    groups.set(file.size, group);
  }
  const kept = new Set<File>();
  for (const group of groups.values()) {
    if (group.length === 1) { kept.add(group[0]!); continue; }
    const contents: Uint8Array[] = [];
    for (const file of group) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await file.arrayBuffer()); }
      catch { kept.add(file); continue; } // Preserve the upload fallback.
      const duplicate = contents.some(previous => {
        if (previous.length !== bytes.length) return false;
        for (let index = 0; index < bytes.length; index++) if (previous[index] !== bytes[index]) return false;
        return true;
      });
      if (!duplicate) { kept.add(file); contents.push(bytes); }
    }
  }
  return [...new Set(files)].filter(file => kept.has(file));
}
