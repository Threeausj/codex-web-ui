<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import DOMPurify from "dompurify";
import MermaidDiagram from "./MermaidDiagram.vue";
import { createConversationMarkdownParser } from "../lib/conversation-math";
import { previewFilePath } from "../lib/file-preview";
import { mermaidSource } from "../lib/markdown-mermaid";
import { randomUUID } from "../lib/uuid";

const props = defineProps<{ content: string; path: string; root: string; hostId: string; api: any }>();
const emit = defineEmits<{ openFile: [path: string] }>();
type PreviewSlot = { kind: "math"; html: string } | { kind: "diagram"; source: string };
type PreviewDiagram = { id: string; target: HTMLElement; source: string };
type PreviewImage = { element: HTMLImageElement; title: string | null };
const documentContent = ref<HTMLElement>();
const diagrams = shallowRef<PreviewDiagram[]>([]);
const assets = new Map<string, string>();
const failures = ref<Record<string, string>>({});
const limited = ref(false);
const externalImages = ref(false);
let generation = 0;
let cacheScope = "";
const scope = () => `${props.hostId}\0${props.root}\0${props.path}`;

function renderDocument(content: string) {
  const slots = new Map<string, PreviewSlot>();
  const prefix = randomUUID();
  function placeholder(tag: "span" | "div", slot: PreviewSlot) {
    const id = prefix + "-" + slots.size;
    slots.set(id, slot);
    return `<${tag} data-preview-slot="${id}"></${tag}>`;
  }
  const parser = createConversationMarkdownParser(html => placeholder("span", { kind: "math", html })).use({
    renderer: {
      code(token) {
        const source = mermaidSource(token);
        return source === undefined ? false : placeholder("div", { kind: "diagram", source }) + "\n";
      },
    },
  });
  const fragment = DOMPurify.sanitize(parser.parse(content, { async: false }) as string, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "div", "span", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "code", "blockquote", "strong", "em", "del", "s", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "details", "summary"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "colspan", "rowspan", "data-preview-slot"],
    ALLOW_DATA_ATTR: false,
  });
  const renderedDiagrams: PreviewDiagram[] = [];
  for (const element of fragment.querySelectorAll<HTMLElement>("[data-preview-slot]")) {
    const id = element.dataset.previewSlot!;
    element.removeAttribute("data-preview-slot");
    const slot = slots.get(id);
    if (!slot) continue;
    if (slot.kind === "diagram") renderedDiagrams.push({ id, target: element, source: slot.source });
    else {
      // KaTeX needs MathML and layout attributes. Apply that policy only to its generated markup.
      const math = DOMPurify.sanitize(slot.html, {
        RETURN_DOM_FRAGMENT: true,
        FORBID_TAGS: ["style", "iframe", "form", "input", "img", "a"],
      });
      element.replaceWith(math);
    }
  }
  return { fragment, renderedDiagrams };
}

watch(() => [documentContent.value, props.content, props.path, props.root, props.hostId] as const, async ([target, content]) => {
  const revision = ++generation;
  if (!target) return;
  const currentScope = scope();
  const hostId = props.hostId;
  if (cacheScope !== currentScope) { assets.clear(); failures.value = {}; cacheScope = currentScope; }
  const { fragment, renderedDiagrams } = renderDocument(content);
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = anchor.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    else {
      const path = previewFilePath(href, props.path, props.root);
      anchor.removeAttribute("href");
      if (path) { anchor.href = "#"; anchor.dataset.filePath = path; }
    }
  }
  const images = new Map<string, PreviewImage[]>();
  externalImages.value = false;
  limited.value = false;
  for (const image of fragment.querySelectorAll<HTMLImageElement>("img")) {
    const src = image.getAttribute("src") || "";
    image.removeAttribute("src");
    image.loading = "lazy";
    if (/^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[a-z0-9+/=]+$/i.test(src) && src.length <= 11_184_840) { image.src = src; continue; }
    const path = previewFilePath(src, props.path, props.root);
    if (!path) { image.title = "图片地址不可预览"; externalImages.value = true; continue; }
    if (!images.has(path) && images.size >= 24) { image.title = "图片数量超过预览上限"; limited.value = true; continue; }
    const matches = images.get(path) || [];
    matches.push({ element: image, title: image.getAttribute("title") });
    images.set(path, matches);
    const stored = assets.get(path);
    if (stored) image.src = stored;
    else image.title = failures.value[path] || "正在读取图片…";
  }
  target.replaceChildren(fragment);
  diagrams.value = renderedDiagrams;
  const queue = [...images].filter(([path]) => !assets.has(path) && !failures.value[path]);
  let index = 0;
  const load = async () => {
    while (index < queue.length && revision === generation && currentScope === scope()) {
      const [path, matches] = queue[index++]!;
      try {
        const result = await props.api.readFile(path, { hostId, silentError: true });
        if (revision !== generation || currentScope !== scope()) return;
        if (!/^data:image\//.test(result.dataUrl || "")) throw new Error("此文件不是可预览的图片");
        assets.set(path, result.dataUrl);
        for (const { element, title } of matches) {
          element.src = result.dataUrl;
          if (title === null) element.removeAttribute("title");
          else element.title = title;
        }
      } catch (error: any) {
        if (revision !== generation || currentScope !== scope()) return;
        const message = error?.message || "图片读取失败";
        failures.value = { ...failures.value, [path]: message };
        for (const { element } of matches) element.title = message;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, load));
});

function openLink(event: MouseEvent) {
  const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[data-file-path]");
  if (anchor) { event.preventDefault(); emit("openFile", anchor.dataset.filePath!); }
}
onBeforeUnmount(() => ++generation);
</script>

<template>
  <div class="file-markdown-preview" role="region" aria-label="Markdown 文件预览">
    <div ref="documentContent" class="markdown" @click="openLink"></div>
    <Teleport v-for="diagram in diagrams" :key="diagram.id" :to="diagram.target">
      <MermaidDiagram :source="diagram.source" />
    </Teleport>
    <p v-if="externalImages" class="preview-note">仅预览项目内图片；外部图片地址不会自动加载。</p>
    <p v-if="limited" class="preview-note">每个文档最多预览 24 张项目图片。</p>
    <p v-if="Object.keys(failures).length" class="preview-note" role="status">部分图片读取失败，可在文件列表中单独打开。</p>
  </div>
</template>

<style scoped>
.file-markdown-preview { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 20px; background: var(--bg); color: var(--text); overflow-wrap: anywhere; }
.file-markdown-preview :deep(.markdown) { font-size: 14px; line-height: 1.7; }
.file-markdown-preview :deep(img) { max-width: 100%; height: auto; }
.file-markdown-preview :deep(pre), .file-markdown-preview :deep(table) { max-width: 100%; overflow-x: auto; }
.preview-note { color: var(--muted); font-size: 12px; margin-top: 16px; }
@media (max-width: 760px) { .file-markdown-preview { padding: 16px; } }
</style>
