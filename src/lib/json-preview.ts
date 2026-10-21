/** JSONC is intentionally excluded: its comments are not JSON string tokens. */
export function isJsonPath(path: string): boolean {
  return /\.(?:json|jsonl|ndjson)$/i.test(path);
}

const hexQuad = /^[\da-f]{4}$/i;
const hiddenCharacter = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Bound the fragment array even for a multi-megabyte escaped string. */
class PreviewText {
  private fragments: string[] = [];
  private blocks: string[] = [];
  append(value: string): void {
    if (!value) return;
    this.fragments.push(value);
    if (this.fragments.length >= 1024) this.flush();
  }
  private flush(): void {
    if (!this.fragments.length) return;
    this.blocks.push(this.fragments.join(""));
    this.fragments = [];
  }
  finish(): string {
    this.flush();
    return this.blocks.join("");
  }
}

function unicodeEscape(source: string, start: number): number | null {
  if (source[start] !== "\\" || source[start + 1] !== "u") return null;
  const digits = source.slice(start + 2, start + 6);
  return hexQuad.test(digits) ? Number.parseInt(digits, 16) : null;
}

/**
 * Make escaped Unicode readable without reparsing or reserializing the document.
 * Numeric precision, whitespace and source line positions stay intact. Only
 * complete, valid JSON string tokens are changed, so JSON Lines works as well.
 * The returned text is for reading; callers must keep the source used for saving.
 */
export function jsonUnicodePreview(source: string): string {
  let output: PreviewText | undefined;
  let copiedUntil = 0;
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '"') { index++; continue; }
    const tokenStart = index;
    index++;
    let valid = true;
    let closed = false;
    let tokenOutput: PreviewText | undefined;
    let copiedInToken = tokenStart;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code === 34) { index++; closed = true; break; }
      if (code < 32) valid = false;
      if (code !== 92) { index++; continue; }
      const start = index;
      const escape = source[index + 1];
      if (escape !== "u") {
        if (!escape || !'"\\/bfnrt'.includes(escape)) valid = false;
        index += 2;
        continue;
      }
      const unit = unicodeEscape(source, start);
      if (unit === null) { valid = false; index += 2; continue; }
      index += 6;
      let point = unit;
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = unicodeEscape(source, index);
        if (low === null || low < 0xdc00 || low > 0xdfff) continue;
        point = 0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00;
        index += 6;
      }
      const character = String.fromCodePoint(point);
      // Keep escape spellings that could alter syntax or hide/reorder content.
      if (point < 0x80 || hiddenCharacter.test(character)) continue;
      tokenOutput ??= new PreviewText();
      tokenOutput.append(source.slice(copiedInToken, start));
      tokenOutput.append(character);
      copiedInToken = index;
    }
    if (!closed || !valid || !tokenOutput) continue;
    tokenOutput.append(source.slice(copiedInToken, index));
    output ??= new PreviewText();
    output.append(source.slice(copiedUntil, tokenStart));
    output.append(tokenOutput.finish());
    copiedUntil = index;
  }
  if (!output) return source;
  output.append(source.slice(copiedUntil));
  return output.finish();
}
