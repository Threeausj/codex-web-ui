<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { previewFilePath } from "../lib/file-preview";

const props = defineProps<{ content: string; path: string; root: string; hostId: string; api: any }>();
const emit = defineEmits<{ openFile: [path: string] }>();
const markup = ref("");
const assets = ref<Record<string, string>>({});
const failures = ref<Record<string, string>>({});
const limited = ref(false);
const externalImages = ref(false);
let generation = 0;
let cacheScope = "";
const scope = () => `${props.hostId}\0${props.root}\0${props.path}`;
const html = computed(() => {
  const template = document.createElement("template");
  template.innerHTML = markup.value;
  for (const image of template.content.querySelectorAll<HTMLImageElement>("img[data-file-image]")) {
    const path = image.dataset.fileImage!;
    if (assets.value[path]) image.src = assets.value[path]!;
    else image.title = failures.value[path] || "正在读取图片…";
  }
  return template.innerHTML;
});

watch(() => [props.content, props.path, props.root, props.hostId], async () => {
  const revision = ++generation;
  const currentScope = scope();
  if (cacheScope !== currentScope) { assets.value = {}; failures.value = {}; cacheScope = currentScope; }
  const fragment = DOMPurify.sanitize(marked.parse(props.content, { async: false }) as string, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "code", "blockquote", "strong", "em", "del", "s", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "details", "summary"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "colspan", "rowspan"],
    ALLOW_DATA_ATTR: false,
  });
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = anchor.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    else {
      const path = previewFilePath(href, props.path, props.root);
      anchor.removeAttribute("href");
      if (path) { anchor.href = "#"; anchor.dataset.filePath = path; }
    }
  }
  const paths = new Set<string>();
  externalImages.value = false;
  limited.value = false;
  for (const image of fragment.querySelectorAll<HTMLImageElement>("img")) {
    const src = image.getAttribute("src") || "";
    image.removeAttribute("src");
    image.loading = "lazy";
    if (/^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[a-z0-9+/=]+$/i.test(src) && src.length <= 11_184_840) { image.src = src; continue; }
    const path = previewFilePath(src, props.path, props.root);
    if (!path) { image.title = "图片地址不可预览"; externalImages.value = true; continue; }
    if (!paths.has(path) && paths.size >= 24) { image.title = "图片数量超过预览上限"; limited.value = true; continue; }
    paths.add(path);
    image.dataset.fileImage = path;
  }
  const container = document.createElement("div");
  container.append(fragment);
  markup.value = container.innerHTML;
  const queue = [...paths].filter(path => !assets.value[path] && !failures.value[path]);
  let index = 0;
  const load = async () => {
    while (index < queue.length && revision === generation && currentScope === scope()) {
      const path = queue[index++]!;
      try {
        const result = await props.api.readFile(path, { silentError: true });
        if (revision !== generation || currentScope !== scope()) return;
        if (!/^data:image\//.test(result.dataUrl || "")) throw new Error("此文件不是可预览的图片");
        assets.value = { ...assets.value, [path]: result.dataUrl };
      } catch (error: any) {
        if (revision !== generation || currentScope !== scope()) return;
        failures.value = { ...failures.value, [path]: error?.message || "图片读取失败" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, load));
}, { immediate: true });

function openLink(event: MouseEvent) {
  const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[data-file-path]");
  if (anchor) { event.preventDefault(); emit("openFile", anchor.dataset.filePath!); }
}
onBeforeUnmount(() => ++generation);
</script>

<template>
  <div class="file-markdown-preview" role="region" aria-label="Markdown 文件预览">
    <div class="markdown" v-html="html" @click="openLink"></div>
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
