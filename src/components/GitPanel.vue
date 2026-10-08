<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { repositoryCandidates, missingRepository } from '../lib/git-context';

type GitFile = {
  path: string;
  originalPath?: string;
  index: string;
  working: string;
  untracked: boolean;
  conflicted: boolean;
};
type Worktree = {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};
type Repository = {
  root: string;
  branch: string;
  head: string;
  files: GitFile[];
  branches: string[];
  worktrees: Worktree[];
};
const props = defineProps<{ api: any; state: any }>();
const emit = defineEmits<{
  error: [message: string];
  project: [path: string];
  file: [path: string];
}>();
const repository = ref<Repository | null>(null);
const directory = ref('');
const directoryDraft = ref(props.state.projectPath || '');
const resolvedFromConversation = ref(false);
const directoryChoices = computed(() => repositoryCandidates(props.state.items || [], props.state.projects || [], props.state.hostId, ''));
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const selected = ref<string[]>([]);
const diffFile = ref("");
const diff = ref("");
const stagedDiff = ref(false);
const diffLoading = ref(false);
const message = ref("");
const newBranch = ref("");
const worktreePath = ref("");
const worktreeBranch = ref("");
const worktreeMode = ref("new");
const worktreeStart = ref("");
const startConversation = ref(false);
let generation = 0;
let diffGeneration = 0;
const repositoryScope = computed(() => `${props.state.hostId}\0${props.state.activeThread?.id || ''}\0${props.state.projectPath}`);
const scope = computed(() => `${repositoryScope.value}\0${props.state.permission}`);
let loadedRepositoryScope = "";
const readonly = computed(() => props.state.permission === "read-only");
const canWrite = computed(
  () =>
    !readonly.value && !busy.value && !loading.value && props.state.connected,
);
const selectedFiles = computed(
  () =>
    repository.value?.files.filter((file) =>
      selected.value.includes(file.path),
    ) || [],
);
const selectedStaged = computed(() =>
  selectedFiles.value.filter(
    (file) => !file.untracked && file.index !== " " && !file.conflicted,
  ),
);
const canCommit = computed(
  () =>
    canWrite.value &&
    !!message.value.trim() &&
    !!selectedStaged.value.length &&
    selectedStaged.value.length === selected.value.length,
);
const unstagedCount = computed(
  () =>
    repository.value?.files.filter(
      (file) => file.untracked || file.working !== " ",
    ).length || 0,
);
const stagedCount = computed(
  () =>
    repository.value?.files.filter(
      (file) => !file.untracked && file.index !== " ",
    ).length || 0,
);
const diffLines = computed(() => {
  let oldLine = 0;
  let newLine = 0;
  return diff.value.split("\n").map((text, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { index, text, type: "hunk", old: "", next: "" };
    }
    if (
      /^(?:diff |index |--- |\+\+\+ |new file |deleted file |similarity |rename |Binary )/.test(
        text,
      )
    )
      return { index, text, type: "meta", old: "", next: "" };
    if (text.startsWith("+"))
      return { index, text, type: "added", old: "", next: newLine++ };
    if (text.startsWith("-"))
      return { index, text, type: "removed", old: oldLine++, next: "" };
    if (text.startsWith(" "))
      return { index, text, type: "context", old: oldLine++, next: newLine++ };
    return { index, text, type: "meta", old: "", next: "" };
  });
});
function context() {
  return {
    hostId: props.state.hostId,
    cwd: repository.value?.root || directory.value || props.state.projectPath,
    permission: props.state.permission,
  };
}
function query(values: Record<string, string>) {
  return new URLSearchParams(values).toString();
}
function report(cause: any) {
  error.value = cause?.message || String(cause);
  emit("error", error.value);
}
function apply(result: Repository) {
  repository.value = result;
  directoryDraft.value = result.root;
  selected.value = selected.value.filter((path) =>
    result.files.some((file) => file.path === path),
  );
  if (
    diffFile.value &&
    !result.files.some((file) => file.path === diffFile.value)
  ) {
    diffFile.value = "";
    diff.value = "";
  }
}
async function refresh() {
  const request = ++generation;
  const captured = scope.value;
  if (!props.state.connected || !props.state.projectPath) return;
  loading.value = true;
  error.value = "";
  const input = context();
  const current = () => request === generation && captured === scope.value;
  const read = (cwd: string) => props.api.requestHttp(`/git/status?${query({ ...input, cwd })}`, {}, false);
  try {
    let result: Repository;
    try { result = await read(input.cwd); }
    catch (cause: any) {
      if (!current() || directory.value || !missingRepository(cause.message || '')) throw cause;
      let candidates = repositoryCandidates(props.state.items || [], props.state.projects || [], props.state.hostId, input.cwd);
      // Summary history deliberately omits command items. Read one bounded
      // recent page for directory metadata, without resuming or changing cwd.
      if (props.state.activeThread?.id && props.api.rpc) {
        try {
          const page = await props.api.rpc('thread/items/list', { threadId: props.state.activeThread.id, limit: 40, sortDirection: 'desc' }, 10000, { silentError: true });
          if (!current()) return;
          candidates = repositoryCandidates([...(page.data || [])].reverse(), props.state.projects || [], props.state.hostId, input.cwd).concat(candidates);
        } catch { /* Older runtimes retain project/live-item suggestions. */ }
      }
      let found: Repository | undefined;
      for (const candidate of [...new Set(candidates)].slice(0, 8)) {
        if (!current()) return;
        try { found = await read(candidate); break; }
        catch (failure: any) { if (!missingRepository(failure.message || '')) throw failure; }
      }
      if (!found) throw cause;
      result = found;
      if (!current()) return;
      directory.value = found.root; resolvedFromConversation.value = true;
    }
    if (current()) apply(result);
  } catch (cause: any) {
    if (request === generation && captured === scope.value) {
      repository.value = null;
      error.value = cause.message || "读取 Git 状态失败";
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
function chooseDirectory() {
  if (busy.value || loading.value || !directoryDraft.value.trim().startsWith('/')) return;
  ++generation; ++diffGeneration;
  directory.value = directoryDraft.value.trim(); resolvedFromConversation.value = false;
  repository.value = null; selected.value = []; diff.value = ''; diffFile.value = ''; message.value = ''; notice.value = '';
  void refresh();
}
async function mutate(
  action: string,
  values: Record<string, unknown>,
  success: string,
) {
  if (!canWrite.value) return;
  const captured = scope.value;
  const input = context();
  const request = ++generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await props.api.requestHttp(`/git/${action}`, {
      method: "POST",
      body: JSON.stringify({ ...input, ...values }),
    });
    if (captured !== scope.value || request !== generation) return;
    apply(result);
    notice.value = success;
    if (action === "commit") {
      message.value = "";
      selected.value = [];
      diff.value = "";
      diffFile.value = "";
    }
    if (diffFile.value) await loadDiff(diffFile.value);
    return result;
  } catch (cause) {
    if (captured === scope.value && request === generation) report(cause);
  } finally {
    if (request === generation) busy.value = false;
  }
}
async function loadDiff(path: string) {
  const request = ++diffGeneration;
  const captured = scope.value;
  diffFile.value = path;
  diffLoading.value = true;
  diff.value = "";
  try {
    const result = await props.api.requestHttp(
      `/git/diff?${query({ ...context(), file: path, staged: String(stagedDiff.value) })}`,
    );
    if (request === diffGeneration && captured === scope.value)
      diff.value = result.diff;
  } catch (cause) {
    if (request === diffGeneration && captured === scope.value) report(cause);
  } finally {
    if (request === diffGeneration) diffLoading.value = false;
  }
}
function toggle(path: string) {
  selected.value = selected.value.includes(path)
    ? selected.value.filter((value) => value !== path)
    : [...selected.value, path];
}
async function switchBranch(event: Event) {
  const select = event.target as HTMLSelectElement;
  const value = select.value;
  select.value = repository.value?.branch || "";
  if (value && value !== repository.value?.branch)
    await mutate("branch", { branch: value }, `已切换到 ${value}`);
}
async function createBranch() {
  const result = await mutate(
    "branch",
    { branch: newBranch.value, create: true },
    `已创建并切换到 ${newBranch.value}`,
  );
  if (result) newBranch.value = "";
}
async function openWorktree(path: string) {
  if (path === props.state.projectPath || busy.value || props.state.busy)
    return;
  const captured = scope.value;
  busy.value = true;
  error.value = "";
  try {
    const known = props.state.projects.some(
      (project: any) =>
        project.hostId === props.state.hostId && project.path === path,
    );
    if (known) await props.api.setProject(path);
    else await props.api.addProject(path);
    emit("project", path);
  } catch (cause) {
    if (scope.value === captured) report(cause);
  } finally {
    busy.value = false;
  }
}
async function createWorktree() {
  const createConversation = startConversation.value;
  const result = await mutate(
    "worktree",
    {
      path: worktreePath.value,
      branch: worktreeBranch.value,
      mode: worktreeMode.value,
      ...(worktreeMode.value === 'new' && worktreeStart.value ? { startPoint: worktreeStart.value } : {}),
    },
    "工作树已创建，可在下方打开",
  );
  if (result) {
    worktreePath.value = "";
    worktreeBranch.value = "";
    if (createConversation && result.projectPath) await openWorktreeConversation(result.projectPath);
  }
}
function treeConversations(path: string) {
  return props.state.threads.filter((thread: any) => (thread.hostId || props.state.hostId) === props.state.hostId && thread.cwd === path);
}
async function openWorktreeConversation(path: string) {
  if (busy.value || props.state.busy) return;
  busy.value = true; error.value = '';
  try { await props.api.newThreadInWorktree(path); emit('project', path); }
  catch (cause) { report(cause); }
  finally { busy.value = false; }
}
async function removeWorktree(tree: Worktree) {
  if (!canWrite.value || props.state.busy || tree.path === repository.value?.root || tree.locked || tree.prunable) return;
  const count = treeConversations(tree.path).length;
  if (!window.confirm(`移除工作树“${tree.path}”？仅清理目录，保留分支和 ${count} 个已加载对话。含未提交、未跟踪或忽略文件时会拒绝删除。`)) return;
  const result = await mutate('worktree/remove', { path: tree.path }, '工作树目录已移除，分支和对话保留');
  if (result) {
    const project = props.state.projects.find((entry: any) => (entry.hostId || 'local') === props.state.hostId && entry.path === tree.path);
    if (project) await props.api.removeProject(project);
  }
}
watch(
  () => [scope.value, props.state.connected],
  () => {
    const sameRepository = loadedRepositoryScope === repositoryScope.value;
    loadedRepositoryScope = repositoryScope.value;
    ++generation;
    ++diffGeneration;
    repository.value = null;
    if (!sameRepository) { directory.value = ''; directoryDraft.value = props.state.projectPath || ''; resolvedFromConversation.value = false; }
    if (!sameRepository) selected.value = [];
    diff.value = "";
    diffFile.value = "";
    error.value = "";
    notice.value = "";
    loading.value = false;
    busy.value = false;
    diffLoading.value = false;
    if (!sameRepository) message.value = "";
    if (props.state.connected) void refresh();
  },
  { immediate: true },
);
watch(stagedDiff, () => {
  if (diffFile.value) void loadDiff(diffFile.value);
});
defineExpose({ refresh });
</script>

<template>
  <section class="git-panel" aria-label="Git 工作流">
    <div class="git-toolbar">
      <div>
        <Icon name="GitBranch" :size="15" /><strong>Git / 工作树</strong>
      </div>
      <button
        class="icon-button"
        :disabled="loading || busy || !state.connected"
        aria-label="刷新 Git 状态"
        title="刷新 Git 状态"
        @click="refresh"
      >
        <Icon :name="loading ? 'LoaderCircle' : 'RefreshCw'" :size="15" />
      </button>
    </div>
    <form class="git-directory" @submit.prevent="chooseDirectory">
      <label for="git-repository-directory">仓库目录</label>
      <div><input id="git-repository-directory" v-model="directoryDraft" list="git-directory-choices" aria-label="Git 仓库目录" :disabled="busy || loading" placeholder="输入仓库的绝对路径" /><button class="button button-small button-secondary" :disabled="busy || loading || !state.connected || !directoryDraft.trim().startsWith('/')">打开</button></div>
      <datalist id="git-directory-choices"><option v-for="path in directoryChoices" :key="path" :value="path" /></datalist>
      <p v-if="resolvedFromConversation" class="git-note" role="status">已根据对话中的操作目录找到仓库；对话工作目录保持为 {{ state.projectPath }}。</p>
    </form>
    <div v-if="error" class="git-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="git-notice" role="status">{{ notice }}</div>
    <div v-if="!repository" class="git-empty">
      <Icon name="GitBranch" :size="28" />
      <p>{{ loading ? "正在读取仓库…" : "当前项目未加载 Git 仓库" }}</p>
      <span>选择已有 Git 项目后查看分支、变更与工作树。</span>
    </div>
    <template v-else>
      <div class="git-branch-bar">
        <span>分支</span
        ><select
          :value="repository.branch"
          aria-label="当前 Git 分支"
          :disabled="!canWrite || state.busy"
          @change="switchBranch"
        >
          <option v-if="!repository.branch" value="">
            分离 HEAD · {{ repository.head.slice(0, 7) }}
          </option>
          <option
            v-if="
              repository.branch &&
              !repository.branches.includes(repository.branch)
            "
            :value="repository.branch"
          >
            {{ repository.branch }}
          </option>
          <option v-for="name in repository.branches" :key="name" :value="name">
            {{ name }}
          </option></select
        ><code v-if="repository.head">{{ repository.head.slice(0, 7) }}</code>
      </div>
      <div v-if="readonly" class="git-note">
        当前为只读权限，可查看状态和差异。
      </div>
      <details class="git-section">
        <summary><Icon name="Plus" :size="14" />创建分支</summary>
        <form class="git-inline-form" @submit.prevent="createBranch">
          <input
            v-model="newBranch"
            aria-label="新分支名称"
            placeholder="feature/my-task"
            :disabled="!canWrite || state.busy"
          /><button
            class="button button-small button-secondary"
            :disabled="!canWrite || state.busy || !newBranch.trim()"
          >
            创建并切换
          </button>
        </form>
        <p class="git-note">Git 会保留可兼容的改动；如有冲突会拒绝切换。</p>
      </details>
      <div class="git-section-heading">
        <strong>变更</strong
        ><span>{{ stagedCount }} 已暂存 · {{ unstagedCount }} 未暂存</span>
      </div>
      <div v-if="!repository.files.length" class="git-clean">
        <Icon name="CheckCircle2" :size="16" />工作区干净
      </div>
      <div v-else class="git-files">
        <div
          v-for="entry in repository.files"
          :key="entry.path"
          class="git-file"
          :class="{ active: diffFile === entry.path }"
        >
          <input
            type="checkbox"
            :checked="selected.includes(entry.path)"
            :aria-label="`选择变更 ${entry.path}`"
            :disabled="!canWrite"
            @change="toggle(entry.path)"
          />
          <button
            class="git-file-name"
            :title="
              entry.originalPath
                ? `${entry.originalPath} → ${entry.path}`
                : entry.path
            "
            @click="loadDiff(entry.path)"
          >
            <code
              :class="{
                conflict: entry.conflicted,
                untracked: entry.untracked,
              }"
              >{{ entry.index }}{{ entry.working }}</code
            ><span>{{ entry.path }}</span>
          </button>
          <button
            class="icon-button"
            :disabled="!canWrite"
            :aria-label="`暂存 ${entry.path}`"
            title="暂存此文件"
            @click="mutate('stage', { files: [entry.path] }, '已暂存文件')"
          >
            <Icon name="Plus" :size="13" />
          </button>
          <button
            v-if="!entry.untracked && entry.index !== ' '"
            class="icon-button"
            :disabled="!canWrite"
            :aria-label="`取消暂存 ${entry.path}`"
            title="取消暂存，保留文件改动"
            @click="mutate('unstage', { files: [entry.path] }, '已取消暂存')"
          >
            <Icon name="Undo2" :size="13" />
          </button>
        </div>
      </div>
      <div v-if="selected.length" class="git-selection">
        <span>已选 {{ selected.length }} 个文件</span
        ><button
          class="button button-small button-secondary"
          :disabled="!canWrite"
          @click="mutate('stage', { files: selected }, '已暂存所选文件')"
        >
          暂存所选</button
        ><button
          class="button button-small button-ghost"
          :disabled="!canWrite"
          @click="
            mutate('unstage', { files: selected }, '已取消所选文件的暂存')
          "
        >
          取消暂存
        </button>
      </div>
      <form
        class="git-commit"
        @submit.prevent="
          mutate('commit', { files: selected, message }, '提交成功')
        "
      >
        <textarea
          v-model="message"
          aria-label="Git 提交说明"
          placeholder="提交说明…"
          rows="2"
          :disabled="!canWrite"
        />
        <div>
          <span>仅提交勾选且已暂存的 {{ selectedStaged.length }} 个文件</span
          ><button class="button button-small" :disabled="!canCommit">
            <Icon name="Check" :size="13" />{{ busy ? "处理中…" : "提交所选" }}
          </button>
        </div>
        <p class="git-note">
          所选文件的当前内容会进入提交，包括该文件暂存后的继续修改；其他已暂存文件不会被提交。
        </p>
      </form>
      <section v-if="diffFile" class="git-diff">
        <div class="git-diff-heading">
          <strong :title="diffFile">{{ diffFile }}</strong
          ><button
            class="icon-button"
            aria-label="打开差异文件"
            title="在文件编辑器打开"
            @click="emit('file', `${repository.root}/${diffFile}`)"
          >
            <Icon name="FileText" :size="14" /></button
          ><button
            class="icon-button"
            aria-label="关闭差异"
            @click="
              diffFile = '';
              diff = '';
            "
          >
            <Icon name="X" :size="14" />
          </button>
        </div>
        <div class="git-diff-tabs">
          <button :class="{ active: !stagedDiff }" @click="stagedDiff = false">
            工作区差异</button
          ><button :class="{ active: stagedDiff }" @click="stagedDiff = true">
            已暂存差异
          </button>
        </div>
        <p v-if="diffLoading" class="git-note">读取差异…</p>
        <p v-else-if="!diff" class="git-note">此视图没有差异。</p>
        <div
          v-else
          class="git-diff-lines"
          role="region"
          aria-label="文件逐行差异"
          tabindex="0"
        >
          <div
            v-for="line in diffLines"
            :key="line.index"
            :class="['git-diff-line', line.type]"
          >
            <span class="git-line-number">{{ line.old }}</span
            ><span class="git-line-number">{{ line.next }}</span>
            <pre>{{ line.text }}</pre>
          </div>
        </div>
      </section>
      <details class="git-section git-worktrees" open>
        <summary>
          <Icon name="GitBranch" :size="14" />工作树
          <span>{{ repository.worktrees.length }}</span>
        </summary>
        <div
          v-for="tree in repository.worktrees"
          :key="tree.path"
          class="git-worktree"
        >
          <div>
            <strong
              >{{ tree.branch || "分离 HEAD"
              }}<span v-if="tree.path === repository.root">当前</span
              ><span v-if="tree.locked">已锁定</span></strong
            ><code :title="tree.path">{{ tree.path }}</code>
          </div>
          <button
            class="button button-small button-secondary"
            :disabled="
              tree.path === state.projectPath ||
              busy ||
              state.busy ||
              tree.prunable
            "
            @click="openWorktree(tree.path)"
          >
            打开
          </button>
          <span v-if="treeConversations(tree.path).length" class="git-note">{{ treeConversations(tree.path).length }} 个已加载对话</span>
          <button class="icon-button" :aria-label="`在工作树新建对话 ${tree.path}`" title="创建独立对话" :disabled="busy || state.busy || tree.prunable || !state.connected" @click="openWorktreeConversation(tree.path)"><Icon name="MessagesSquare" :size="14" /></button>
          <button v-if="tree.path !== repository.root && tree.path !== repository.worktrees[0]?.path" class="icon-button" :aria-label="`移除工作树 ${tree.path}`" title="安全移除工作树" :disabled="!canWrite || state.busy || tree.locked || tree.prunable" @click="removeWorktree(tree)"><Icon name="Trash2" :size="14" /></button>
        </div>
        <details class="git-create-worktree">
          <summary>创建独立工作树</summary>
          <form @submit.prevent="createWorktree">
            <input
              v-model="worktreePath"
              aria-label="工作树绝对路径"
              placeholder="新工作树绝对路径（项目之外）"
              :disabled="!canWrite"
            />
            <div>
              <select
                v-model="worktreeMode"
                aria-label="工作树分支模式"
                :disabled="!canWrite"
              >
                <option value="new">新建分支</option>
                <option value="existing">已有分支</option></select
              ><input
                v-if="worktreeMode === 'new'"
                v-model="worktreeBranch"
                aria-label="工作树新分支名称"
                placeholder="feature/parallel-task"
                :disabled="!canWrite"
              /><select
                v-else
                v-model="worktreeBranch"
                aria-label="工作树已有分支"
                :disabled="!canWrite"
              >
                <option value="">选择分支</option>
                <option
                  v-for="name in repository.branches"
                  :key="name"
                  :value="name"
                >
                  {{ name }}
                </option>
              </select>
            </div>
            <label v-if="worktreeMode === 'new'" class="git-note">起始分支<select v-model="worktreeStart" aria-label="工作树起始分支" :disabled="!canWrite"><option value="">当前 HEAD</option><option v-for="name in repository.branches" :key="name" :value="name">{{ name }}</option></select></label>
            <label class="git-note"><input v-model="startConversation" type="checkbox" aria-label="创建工作树后新建对话" :disabled="!canWrite || state.busy" />创建后立即新建独立对话</label>
            <button
              class="button button-small button-secondary"
              :disabled="
                !canWrite || !worktreePath.trim() || !worktreeBranch.trim()
              "
            >
              创建工作树
            </button>
            <p class="git-note">
              从所选分支创建；不复制未提交改动，也不自动执行项目初始化脚本。
            </p>
          </form>
        </details>
      </details>
    </template>
  </section>
</template>

<style scoped>
.git-panel {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 0 16px 24px;
  font-size: 12px;
  color: var(--text);
}
.git-toolbar,
.git-toolbar > div,
.git-branch-bar,
.git-section-heading,
.git-selection,
.git-commit > div,
.git-diff-heading,
.git-worktree,
.git-create-worktree form > div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.git-toolbar {
  justify-content: space-between;
  position: sticky;
  top: 0;
  padding: 12px 0;
  background: var(--surface);
  z-index: 1;
}
.git-toolbar strong {
  font-size: 13px;
}
.git-directory { margin-bottom:12px; }
.git-directory label { display:block; color:var(--muted); font-size:11px; margin-bottom:6px; }
.git-directory > div { display:flex; align-items:center; gap:8px; }
.git-directory input { flex:1; width:0; }
.git-directory .button { flex-shrink:0; }
.git-error,
.git-notice {
  padding: 9px 10px;
  border-radius: 8px;
  margin: 0 0 10px;
  overflow-wrap: anywhere;
}
.git-error {
  background: color-mix(in srgb, var(--red) 9%, transparent);
  color: var(--red);
}
.git-notice {
  background: color-mix(in srgb, var(--green) 10%, transparent);
  color: var(--green);
}
.git-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 50px 10px;
  color: var(--muted);
  gap: 8px;
}
.git-empty p {
  margin: 4px 0;
  color: var(--text);
}
.git-empty span {
  line-height: 1.7;
}
.git-branch-bar select {
  flex: 1;
  min-width: 0;
}
.git-branch-bar > code {
  font-size: 11px;
  color: var(--muted);
}
.git-panel input:not([type="checkbox"]),
.git-panel textarea,
.git-panel select {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 7px;
  padding: 7px 8px;
  color: var(--text);
  font: inherit;
  min-width: 0;
}
.git-panel input:not([type="checkbox"]):focus,
.git-panel textarea:focus,
.git-panel select:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.git-note {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.65;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.git-section {
  border-bottom: 1px solid var(--border);
  padding: 12px 0;
}
.git-section summary,
.git-create-worktree summary {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  font-weight: 500;
  list-style: none;
}
.git-section summary:before,
.git-create-worktree summary:before {
  content: "›";
  font-size: 15px;
  transition: transform 0.15s;
}
.git-section[open] > summary:before,
.git-create-worktree[open] > summary:before {
  transform: rotate(90deg);
}
.git-inline-form {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.git-inline-form input {
  flex: 1;
}
.git-panel button:disabled,
.git-panel input:disabled,
.git-panel textarea:disabled,
.git-panel select:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.git-section-heading {
  justify-content: space-between;
  padding: 15px 0 10px;
}
.git-section-heading span {
  font-size: 10px;
  color: var(--muted);
}
.git-clean {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  padding: 14px 0;
}
.git-files {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.git-file {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 5px 5px 8px;
}
.git-file + .git-file {
  border-top: 1px solid var(--border);
}
.git-file.active {
  background: var(--hover);
}
.git-file input {
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
  flex-shrink: 0;
}
.git-file-name {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex: 1;
  background: none;
  border: 0;
  padding: 4px;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.git-file-name code {
  white-space: pre;
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--warning);
  flex-shrink: 0;
}
.git-file-name code.conflict {
  color: var(--red);
}
.git-file-name code.untracked {
  color: var(--green);
}
.git-file-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.git-file .icon-button {
  width: 25px;
  height: 25px;
  flex-shrink: 0;
}
.git-selection {
  flex-wrap: wrap;
  padding: 10px 0;
}
.git-selection > span {
  flex: 1;
  font-size: 11px;
  color: var(--muted);
}
.git-commit {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.git-commit textarea {
  display: block;
  width: 100%;
  resize: vertical;
  box-sizing: border-box;
}
.git-commit > div {
  justify-content: space-between;
  padding-top: 8px;
}
.git-commit > div > span {
  font-size: 10px;
  color: var(--muted);
}
.git-diff {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.git-diff-heading {
  padding: 8px;
  background: var(--soft);
}
.git-diff-heading strong {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.git-diff-heading .icon-button {
  width: 23px;
  height: 23px;
}
.git-diff-tabs {
  display: flex;
  gap: 12px;
  padding: 6px 9px;
  border-bottom: 1px solid var(--border);
}
.git-diff-tabs button {
  border: 0;
  background: none;
  font-size: 10px;
  color: var(--muted);
  padding: 4px 0;
  cursor: pointer;
}
.git-diff-tabs button.active {
  color: var(--text);
  font-weight: 600;
}
.git-diff > .git-note {
  padding: 5px 9px;
}
.git-diff-lines {
  overflow: auto;
  max-height: 440px;
  padding: 5px 0;
}
.git-diff-line {
  display: flex;
  width: max-content;
  min-width: 100%;
  font-size: 10px;
  line-height: 1.8;
}
.git-line-number {
  flex-shrink: 0;
  width: 29px;
  padding-right: 6px;
  text-align: right;
  color: var(--muted);
  font-family: ui-monospace, monospace;
  user-select: none;
}
.git-diff-line pre {
  margin: 0;
  padding: 0 8px 0 3px;
  font: inherit;
  font-family: ui-monospace, monospace;
  white-space: pre;
}
.git-diff-line.added {
  background: color-mix(in srgb, var(--green) 12%, transparent);
}
.git-diff-line.removed {
  background: color-mix(in srgb, var(--red) 10%, transparent);
}
.git-diff-line.hunk {
  background: color-mix(in srgb, var(--info) 10%, transparent);
  color: var(--info);
}
.git-diff-line.meta {
  color: var(--muted);
}
.git-worktrees summary > span {
  margin-left: auto;
  color: var(--muted);
  font-weight: 400;
}
.git-worktree {
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}
.git-worktree > div {
  flex: 1;
  min-width: 0;
}
.git-worktree strong {
  display: flex;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;
}
.git-worktree strong > span {
  font-size: 9px;
  background: var(--hover);
  color: var(--muted);
  border-radius: 4px;
  padding: 1px 4px;
}
.git-worktree code {
  display: block;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  margin-top: 4px;
}
.git-create-worktree {
  margin-top: 12px;
}
.git-create-worktree form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
}
.git-create-worktree form > div > input,
.git-create-worktree form > div > select:last-child {
  flex: 1;
}
.git-create-worktree form > button {
  align-self: flex-start;
}
.git-create-worktree .git-note {
  margin: 0;
}
@media (max-width: 760px) {
  .git-panel {
    padding: 0 14px 24px;
    font-size: 13px;
  }
  .git-file {
    padding-top: 8px;
    padding-bottom: 8px;
  }
  .git-file .icon-button {
    width: 30px;
    height: 30px;
  }
  .git-diff-line {
    font-size: 11px;
  }
  .git-selection > span {
    flex-basis: 100%;
  }
  .git-file-name span {
    font-size: 12px;
  }
  .git-commit > div {
    flex-wrap: wrap;
  }
}
</style>
