export type ResponseTextOffsets = { startOffset: number; endOffset: number };
export type ResponseAnnotation = {
  id?: string;
  text: string;
  annotation?: string;
  source?: ResponseTextOffsets & { messageId: string; contentOffsets?: ResponseTextOffsets };
};

const heading = '# Response annotations:';
const openTag = '<response-annotations>';
const closeTag = '</response-annotations>';
const requestHeading = '## My request:';
const instructions = 'Each annotation quotes an earlier Codex response and may include a note. Use all quotes as context and address each note. Mark addressed annotations with `:codex-annotation{index="N" id="ID"}`, using the one-based array position and exact id. Omit the id attribute when the annotation has no id.';

export function responseTextOffsets(value: unknown): ResponseTextOffsets | undefined {
  if (!value || typeof value !== 'object') return;
  const { startOffset, endOffset } = value as Partial<ResponseTextOffsets>;
  if (typeof startOffset === 'number' && typeof endOffset === 'number' &&
      Number.isSafeInteger(startOffset) && Number.isSafeInteger(endOffset) && startOffset >= 0 && endOffset > startOffset)
    return { startOffset, endOffset };
}

/** Desktop sends the annotations and question in the same text input. */
export function formatResponseAnnotations(request: string, annotations: ResponseAnnotation[]): string {
  if (!annotations.length) return request;
  const json = JSON.stringify(annotations);
  const context = `\n${heading}\n${instructions}\n${openTag}\n${json}\n${closeTag}\n`;
  return withRequest(context, request);
}

function withRequest(context: string, request: string): string {
  return request.trim() ? `${context}\n${requestHeading}\n${request}` : context;
}

export function replaceResponseAnnotationRequest(message: string, request: string): string {
  const original = parseResponseAnnotations(message);
  return original ? withRequest(original.context, request) : request;
}

/** Parse the leading desktop prompt wrapper without treating quoted or fenced
 * examples in ordinary messages as response annotations. */
export function parseResponseAnnotations(message: string): { annotations: ResponseAnnotation[]; request: string; context: string } | null {
  if (!message.trimStart().startsWith(heading)) return null;
  const normalized = message.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  if (!normalized.startsWith(`${heading}\n`)) return null;
  const start = normalized.indexOf(`\n${openTag}\n`);
  if (start < 0) return null;
  const jsonStart = start + openTag.length + 2;
  const end = normalized.indexOf(`\n${closeTag}`, jsonStart);
  if (end < 0) return null;
  const contextEnd = end + closeTag.length + 1;
  const tail = normalized.slice(contextEnd);
  if (tail && !tail.startsWith('\n')) return null;
  try {
    const value: unknown = JSON.parse(normalized.slice(jsonStart, end));
    if (!Array.isArray(value) || !value.length) return null;
    const annotations: ResponseAnnotation[] = [];
    for (const entry of value) {
      if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return null;
      const annotation: ResponseAnnotation = { text: entry.text };
      if (typeof entry.id === 'string' && entry.id) annotation.id = entry.id;
      if (typeof entry.annotation === 'string' && entry.annotation.trim()) annotation.annotation = entry.annotation;
      const offsets = responseTextOffsets(entry.source);
      if (offsets && typeof entry.source.messageId === 'string' && entry.source.messageId) {
        const contentOffsets = responseTextOffsets(entry.source.contentOffsets);
        annotation.source = { messageId: entry.source.messageId, ...offsets, ...(contentOffsets && { contentOffsets }) };
      }
      annotations.push(annotation);
    }
    const request = tail.replace(/^\n+/, '').replace(/^## My request(?: for Codex)?:[ \t]*(?:\n|$)/, '');
    return { annotations, request, context: `\n${normalized.slice(0, contextEnd)}\n` };
  } catch { return null; }
}
