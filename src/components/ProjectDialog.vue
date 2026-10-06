<script setup lang="ts">
import { onMounted, ref } from "vue";
import Icon from "./Icon.vue";
const props = defineProps<{ project: any; api: any; state: any }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const name = ref(props.project.name);
const roots = ref(
  (props.project.rootPaths || [props.project.path])
    .filter((path: string) => path !== props.project.path)
    .join("\n"),
);
const error = ref("");
const saving = ref(false);
onMounted(() => dialog.value?.showModal());
async function save() {
  saving.value = true;
  error.value = "";
  try {
    await props.api.updateProject(props.project, {
      name: name.value.trim(),
      rootPaths: [
        props.project.path,
        ...roots.value
          .split("\n")
          .map((path: string) => path.trim())
          .filter(Boolean),
      ],
    });
    emit("close");
  } catch (cause: any) {
    error.value = cause.message || "无法保存项目";
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <Teleport to="body"
    ><dialog
      ref="dialog"
      class="project-dialog"
      aria-labelledby="project-edit-title"
      @cancel.prevent="!saving && emit('close')"
    >
      <form @submit.prevent="save">
        <header>
          <h2 id="project-edit-title">编辑项目</h2>
          <button
            type="button"
            class="icon-button"
            :disabled="saving"
            aria-label="关闭项目编辑"
            @click="emit('close')"
          >
            <Icon name="X" :size="17" />
          </button>
        </header>
        <label
          >项目名称<input
            v-model="name"
            aria-label="项目名称"
            required
            maxlength="256"
            autofocus
            :disabled="saving"
        /></label>
        <label
          >项目目录<input :value="project.path" aria-label="项目目录" readonly
        /></label>
        <label
          >其他工作目录 <small>（可选，每行一个绝对路径）</small
          ><textarea
            v-model="roots"
            aria-label="其他工作目录"
            rows="3"
            :disabled="saving"
          />
        </label>
        <p class="note">
          {{
            state.hosts.find(
              (host: any) => host.id === (project.hostId || "local"),
            )?.name || "本机"
          }}
          · 项目设置保存在网页版。
        </p>
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
        <footer>
          <button
            type="button"
            class="button button-secondary"
            :disabled="saving"
            @click="emit('close')"
          >
            取消</button
          ><button
            class="button button-primary"
            :disabled="saving || !name.trim()"
          >
            {{ saving ? "保存中…" : "保存项目" }}
          </button>
        </footer>
      </form>
    </dialog></Teleport
  >
</template>
<style scoped>
.project-dialog {
  padding: 24px;
  width: min(460px, calc(100vw - 28px));
  margin: auto;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--surface);
  color: var(--text);
  max-height: calc(100dvh - 32px);
  overflow: auto;
  box-shadow: 0 20px 80px #0002;
}
.project-dialog::backdrop {
  background: var(--scrim);
  backdrop-filter: blur(3px);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 22px;
}
h2 {
  font-size: 18px;
}
label {
  display: block;
  margin-bottom: 16px;
  font-size: 13px;
}
label input,
label textarea {
  display: block;
  width: 100%;
  margin-top: 7px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 10px;
  color: var(--text);
  font: inherit;
  resize: vertical;
}
small,
.note {
  color: var(--muted);
  font-size: 12px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 22px;
}
@media (max-width: 760px) {
  .project-dialog {
    padding: 20px;
  }
  label input,
  label textarea {
    font-size: 16px;
  }
}
</style>
