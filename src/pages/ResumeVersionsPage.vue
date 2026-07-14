<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
} from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import {
  ResumeVersionApiError,
  resumeVersionsApi,
} from '../api/resumeVersionsApi';
import { profileApi } from '../api/profileApi';
import type {
  ActiveResumeVersionResult,
  ResumeContentSnapshot,
  ResumeVersionListResponse,
  ResumeVersionRecord,
} from '../domain/job-memory';
import type { JobSeekerProfile } from '../storage';
import {
  formatDateTime,
  formatResumeVersionSourceLabel,
} from '../domain/presentation';
import { navigationConfirm } from '../router/confirmNavigation';
import {
  buildProfileResumeSnapshot,
  createResumeIdempotencyKey,
  defaultResumeVersionName,
  hashResumeContentSnapshot,
  hasResumeContent,
  sortResumeVersions,
} from './resumeVersionsModel';

type LoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'internal-error' | 'error';
type ArchiveMode = '' | 'replacement' | 'clear';

const source = ref<ResumeVersionListResponse | null>(null);
const profile = ref<JobSeekerProfile | null>(null);
const loadStatus = ref<LoadStatus>('idle');
const loadError = ref('');
const actionError = ref('');
const notice = ref('');
const duplicateVersionId = ref<string | null>(null);
const expandedTechnicalVersionIds = ref<ReadonlySet<string>>(new Set());
const submitting = ref(false);

let alive = true;
let readGeneration = 0;
let readController: AbortController | null = null;

const createOpen = ref(false);
const createBaseline = ref({ name: '', summary: '' });
const createDraft = reactive({
  idempotencyKey: '',
  name: '',
  summary: '',
  contentSnapshot: { resumeText: '', projectExperience: '' } as ResumeContentSnapshot,
});

const editingSource = ref<ResumeVersionRecord | null>(null);
const editDraft = reactive({ name: '', summary: '' });
const editConflictVersion = ref<number | null>(null);

const archiveTarget = ref<ResumeVersionRecord | null>(null);
const archiveMode = ref<ArchiveMode>('');
const replacementResumeVersionId = ref('');

const sortedVersions = computed(() => sortResumeVersions(
  source.value?.resumeVersions ?? [],
  source.value?.activeResumeVersionId ?? null,
));
const currentProfileSnapshot = computed(() => profile.value === null
  ? null
  : buildProfileResumeSnapshot(profile.value));
const profileHasResumeContent = computed(() => (
  currentProfileSnapshot.value !== null && hasResumeContent(currentProfileSnapshot.value)
));
const createDirty = computed(() => createOpen.value && (
  createDraft.name !== createBaseline.value.name
  || createDraft.summary !== createBaseline.value.summary
));
const editDirty = computed(() => editingSource.value !== null && (
  editDraft.name !== editingSource.value.name
  || editDraft.summary !== editingSource.value.summary
));
const archiveDirty = computed(() => archiveTarget.value !== null && (
  archiveMode.value !== '' || replacementResumeVersionId.value !== ''
));
const hasDirtyDraft = computed(() => createDirty.value || editDirty.value || archiveDirty.value);
const editCanSubmit = computed(() => (
  editDirty.value && editDraft.name.trim() !== '' && !submitting.value
));
const selectableReplacements = computed(() => sortedVersions.value.filter((version) => (
  version.archivedAt === null && version.id !== archiveTarget.value?.id
)));
const archiveCanSubmit = computed(() => !submitting.value && (
  (archiveMode.value === 'replacement' && replacementResumeVersionId.value !== '')
  || archiveMode.value === 'clear'
));
const duplicateVersion = computed(() => (
  duplicateVersionId.value === null
    ? null
    : source.value?.resumeVersions.find((version) => version.id === duplicateVersionId.value) ?? null
));
const createSnapshotPreview = computed(() => [
  '【简历正文】',
  createDraft.contentSnapshot.resumeText || '（空）',
  '',
  '【项目经历】',
  createDraft.contentSnapshot.projectExperience || '（空）',
].join('\n'));

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function setLoadFailure(error: unknown): void {
  if (error instanceof ResumeVersionApiError) {
    if (error.code === 'FEATURE_UNAVAILABLE') {
      loadStatus.value = 'unavailable';
      loadError.value = '后端尚未启用 Job Memory v2 capability。请使用专用临时联调命令。';
      return;
    }
    if (error.code === 'INTERNAL_ERROR') {
      loadStatus.value = 'internal-error';
      loadError.value = '简历版本存储暂时不可用，服务端没有返回底层数据库细节。';
      return;
    }
    loadStatus.value = 'error';
    loadError.value = error.message;
    return;
  }
  loadStatus.value = 'error';
  loadError.value = '读取简历版本失败，请检查临时联调服务。';
}

async function loadPage(): Promise<boolean> {
  const generation = ++readGeneration;
  readController?.abort();
  const controller = new AbortController();
  readController = controller;
  loadStatus.value = 'loading';
  loadError.value = '';
  try {
    const [nextSource, nextProfile] = await Promise.all([
      resumeVersionsApi.list({ signal: controller.signal }),
      profileApi.get({ signal: controller.signal }),
    ]);
    if (!alive || generation !== readGeneration) return false;
    source.value = nextSource;
    profile.value = nextProfile;
    loadStatus.value = 'ready';
    return true;
  } catch (error) {
    if (isAbortError(error) || !alive || generation !== readGeneration) return false;
    setLoadFailure(error);
    return false;
  }
}

async function reloadVersions(): Promise<boolean> {
  const generation = ++readGeneration;
  readController?.abort();
  const controller = new AbortController();
  readController = controller;
  try {
    const nextSource = await resumeVersionsApi.list({ signal: controller.signal });
    if (!alive || generation !== readGeneration) return false;
    source.value = nextSource;
    loadStatus.value = 'ready';
    loadError.value = '';
    return true;
  } catch (error) {
    if (isAbortError(error) || !alive || generation !== readGeneration) return false;
    setLoadFailure(error);
    return false;
  }
}

function replaceVersion(record: ResumeVersionRecord): void {
  if (source.value === null) return;
  const existing = source.value.resumeVersions.some((version) => version.id === record.id);
  source.value = {
    activeResumeVersionId: source.value.activeResumeVersionId,
    resumeVersions: existing
      ? source.value.resumeVersions.map((version) => version.id === record.id ? record : version)
      : [...source.value.resumeVersions, record],
  };
}

function applyActiveResult(result: ActiveResumeVersionResult): void {
  if (source.value === null) return;
  const existing = source.value.resumeVersions.some((version) => version.id === result.resumeVersion.id);
  source.value = {
    activeResumeVersionId: result.activeResumeVersionId,
    resumeVersions: existing
      ? source.value.resumeVersions.map((version) => (
        version.id === result.resumeVersion.id ? result.resumeVersion : version
      ))
      : [...source.value.resumeVersions, result.resumeVersion],
  };
}

function resetMessages(): void {
  actionError.value = '';
  notice.value = '';
  duplicateVersionId.value = null;
}

function openCreate(): void {
  resetMessages();
  const snapshot = currentProfileSnapshot.value;
  if (snapshot === null) {
    actionError.value = '尚未保存正式个人档案，不能创建简历版本。';
    return;
  }
  if (!hasResumeContent(snapshot)) {
    actionError.value = '个人档案的简历正文和项目经历均为空，不能创建空白版本。';
    return;
  }
  const name = defaultResumeVersionName();
  createDraft.idempotencyKey = createResumeIdempotencyKey();
  createDraft.name = name;
  createDraft.summary = '';
  createDraft.contentSnapshot = snapshot;
  createBaseline.value = { name, summary: '' };
  createOpen.value = true;
}

function requestCloseCreate(force = false): void {
  if (!force && createDirty.value && !navigationConfirm.confirmDiscardChanges('放弃尚未创建的简历版本草稿？')) {
    return;
  }
  createOpen.value = false;
}

async function reconcileUnknownCreate(snapshot: ResumeContentSnapshot): Promise<ResumeVersionRecord | null> {
  const expectedHash = await hashResumeContentSnapshot(snapshot);
  await reloadVersions();
  return source.value?.resumeVersions.find((version) => version.contentHash === expectedHash) ?? null;
}

async function submitCreate(): Promise<void> {
  if (submitting.value || createDraft.name.trim() === '') return;
  if (!window.confirm('确认冻结当前个人档案内容并创建简历版本？创建后内容不可修改。')) return;
  submitting.value = true;
  actionError.value = '';
  const snapshot = { ...createDraft.contentSnapshot };
  try {
    const created = await resumeVersionsApi.create({
      idempotencyKey: createDraft.idempotencyKey,
      name: createDraft.name,
      source: 'profile_snapshot',
      summary: createDraft.summary,
      contentSnapshot: snapshot,
    });
    if (!alive) return;
    replaceVersion(created);
    await reloadVersions();
    if (!alive) return;
    requestCloseCreate(true);
    duplicateVersionId.value = created.id;
    notice.value = '简历版本已创建，但不会自动激活。请检查后再手动激活。';
  } catch (error) {
    if (!alive) return;
    if (error instanceof ResumeVersionApiError && error.code === 'CONTENT_HASH_EXISTS') {
      await reloadVersions();
      duplicateVersionId.value = error.existingId ?? null;
      requestCloseCreate(true);
      notice.value = '相同内容的简历版本已存在，未重复创建。';
    } else if (error instanceof ResumeVersionApiError && error.code === 'NETWORK_ERROR') {
      try {
        const reconciled = await reconcileUnknownCreate(snapshot);
        if (!alive) return;
        if (reconciled !== null) {
          duplicateVersionId.value = reconciled.id;
          requestCloseCreate(true);
          notice.value = '网络结果曾不明确，已通过内容 hash 确认版本创建成功；未重复写入。';
        } else {
          actionError.value = '创建结果仍不明确。已先重新读取且未发现相同内容；可使用原命令再次提交。';
        }
      } catch {
        if (alive) actionError.value = '创建结果不明确，重新读取也失败；请勿生成新命令，稍后重试当前提交。';
      }
    } else {
      actionError.value = error instanceof ResumeVersionApiError ? error.message : '创建简历版本失败。';
    }
  } finally {
    if (alive) submitting.value = false;
  }
}

function openEdit(version: ResumeVersionRecord): void {
  resetMessages();
  editingSource.value = version;
  editDraft.name = version.name;
  editDraft.summary = version.summary;
  editConflictVersion.value = null;
}

function requestCloseEdit(force = false): void {
  if (!force && editDirty.value && !navigationConfirm.confirmDiscardChanges('放弃简历版本元数据修改？')) {
    return;
  }
  editingSource.value = null;
  editConflictVersion.value = null;
}

async function submitEdit(): Promise<void> {
  const current = editingSource.value;
  if (current === null || !editCanSubmit.value) return;
  if (!window.confirm('确认修改这个简历版本的名称和摘要？内容快照不会改变。')) return;
  submitting.value = true;
  actionError.value = '';
  try {
    const updated = await resumeVersionsApi.updateMetadata(current.id, {
      expectedVersion: current.rowVersion,
      name: editDraft.name,
      summary: editDraft.summary,
    });
    if (!alive) return;
    replaceVersion(updated);
    editingSource.value = updated;
    editDraft.name = updated.name;
    editDraft.summary = updated.summary;
    requestCloseEdit(true);
    notice.value = '名称和摘要已更新，内容快照保持不变。';
  } catch (error) {
    if (!alive) return;
    if (error instanceof ResumeVersionApiError && error.code === 'VERSION_CONFLICT') {
      editConflictVersion.value = error.currentVersion ?? null;
      actionError.value = '该版本已在其他页面发生变化。草稿已保留，请重新加载后核对。';
    } else {
      actionError.value = error instanceof ResumeVersionApiError ? error.message : '更新元数据失败。';
    }
  } finally {
    if (alive) submitting.value = false;
  }
}

async function reloadEditingVersion(): Promise<void> {
  const id = editingSource.value?.id;
  if (id === undefined) return;
  if (!await reloadVersions()) return;
  const latest = source.value?.resumeVersions.find((version) => version.id === id) ?? null;
  if (latest === null) {
    requestCloseEdit(true);
    actionError.value = '该简历版本已不存在。';
    return;
  }
  editingSource.value = latest;
  editConflictVersion.value = null;
  notice.value = '已加载服务端最新版本；你的名称和摘要草稿仍保留，请核对后再提交。';
}

async function activateVersion(version: ResumeVersionRecord): Promise<void> {
  if (submitting.value || version.archivedAt !== null || source.value?.activeResumeVersionId === version.id) return;
  if (!window.confirm(`确认将“${version.name}”设为当前使用的简历版本？`)) return;
  submitting.value = true;
  resetMessages();
  try {
    const result = await resumeVersionsApi.activate(version.id, { expectedVersion: version.rowVersion });
    if (!alive) return;
    applyActiveResult(result);
    notice.value = `已激活“${result.resumeVersion.name}”。`;
  } catch (error) {
    if (!alive) return;
    if (error instanceof ResumeVersionApiError && error.code === 'VERSION_CONFLICT') {
      await reloadVersions();
      actionError.value = '激活前版本已变化，已重新加载；没有自动重试写入。';
    } else {
      actionError.value = error instanceof ResumeVersionApiError ? error.message : '激活简历版本失败。';
    }
  } finally {
    if (alive) submitting.value = false;
  }
}

function openArchive(version: ResumeVersionRecord): void {
  resetMessages();
  if (source.value?.activeResumeVersionId !== version.id) {
    if (window.confirm(`确认归档“${version.name}”？归档不会删除历史。`)) {
      void performArchive(version, {});
    }
    return;
  }
  archiveTarget.value = version;
  archiveMode.value = '';
  replacementResumeVersionId.value = '';
}

function requestCloseArchive(force = false): void {
  if (!force && archiveDirty.value && !navigationConfirm.confirmDiscardChanges('放弃当前激活版本的归档选择？')) {
    return;
  }
  archiveTarget.value = null;
  archiveMode.value = '';
  replacementResumeVersionId.value = '';
}

async function performArchive(
  version: ResumeVersionRecord,
  activeChange: { replacementResumeVersionId?: string; clearActive?: boolean },
): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  actionError.value = '';
  try {
    const result = await resumeVersionsApi.archive(version.id, {
      expectedVersion: version.rowVersion,
      ...activeChange,
    });
    if (!alive) return;
    applyActiveResult(result);
    requestCloseArchive(true);
    notice.value = `已归档“${result.resumeVersion.name}”，历史记录仍保留。`;
  } catch (error) {
    if (!alive) return;
    if (error instanceof ResumeVersionApiError && error.code === 'VERSION_CONFLICT') {
      await reloadVersions();
      archiveTarget.value = source.value?.resumeVersions.find((item) => item.id === version.id) ?? null;
      actionError.value = '归档前版本已变化，已重新加载；没有自动重试写入。';
    } else {
      actionError.value = error instanceof ResumeVersionApiError ? error.message : '归档简历版本失败。';
    }
  } finally {
    if (alive) submitting.value = false;
  }
}

async function submitActiveArchive(): Promise<void> {
  const target = archiveTarget.value;
  if (target === null || !archiveCanSubmit.value) return;
  const replacement = selectableReplacements.value.find((version) => (
    version.id === replacementResumeVersionId.value
  ));
  const description = archiveMode.value === 'replacement'
    ? `并将“${replacement?.name ?? ''}”设为当前版本`
    : '并明确清空当前简历版本';
  if (!window.confirm(`确认归档“${target.name}”${description}？`)) return;
  if (archiveMode.value === 'replacement') {
    await performArchive(target, { replacementResumeVersionId: replacementResumeVersionId.value });
  } else {
    await performArchive(target, { clearActive: true });
  }
}

function setArchiveMode(mode: ArchiveMode): void {
  archiveMode.value = mode;
  if (mode !== 'replacement') replacementResumeVersionId.value = '';
}

function formatTime(timestamp: number): string {
  return formatDateTime(timestamp);
}

function toggleTechnicalInfo(versionId: string, open: boolean): void {
  const next = new Set(expandedTechnicalVersionIds.value);
  if (open) next.add(versionId);
  else next.delete(versionId);
  expandedTechnicalVersionIds.value = next;
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasDirtyDraft.value && !submitting.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onBeforeRouteLeave(() => {
  if (submitting.value) return false;
  if (!hasDirtyDraft.value) return true;
  return navigationConfirm.confirmDiscardChanges('页面上还有未提交的简历版本草稿，确认离开？');
});

onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload);
  void loadPage();
});

onBeforeUnmount(() => {
  alive = false;
  ++readGeneration;
  readController?.abort();
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <main class="resume-versions-page">
    <header class="page-head">
      <div>
        <h1>简历版本</h1>
        <p>简历版本是投递时快照，创建后内容不可修改。修改简历内容需要创建新版本。</p>
      </div>
      <button
        type="button"
        class="primary-btn"
        :disabled="loadStatus !== 'ready' || !profileHasResumeContent || submitting"
        @click="openCreate"
      >
        从当前个人档案创建版本
      </button>
    </header>

    <p v-if="notice" class="banner banner-success" role="status">
      {{ notice }}
      <button
        v-if="duplicateVersion && duplicateVersion.archivedAt === null && source?.activeResumeVersionId !== duplicateVersion.id"
        type="button"
        class="link-btn"
        @click="activateVersion(duplicateVersion)"
      >
        激活这个版本
      </button>
    </p>
    <p v-if="actionError" class="banner banner-error" role="alert">{{ actionError }}</p>

    <section v-if="loadStatus === 'loading' || loadStatus === 'idle'" class="state-card" role="status">
      正在读取个人档案与简历版本…
    </section>
    <section v-else-if="loadStatus !== 'ready'" class="state-card state-error" role="alert">
      <h2>{{ loadStatus === 'unavailable' ? '功能未启用' : '暂时无法读取简历版本' }}</h2>
      <p>{{ loadError }}</p>
      <button type="button" class="secondary-btn" @click="loadPage">重试</button>
    </section>

    <template v-else>
      <section class="profile-state" aria-label="当前个人档案状态">
        <strong>快照来源：当前正式个人档案</strong>
        <span v-if="profile === null" class="warning">尚未保存个人档案，不能创建版本。</span>
        <span v-else-if="!profileHasResumeContent" class="warning">
          简历正文和项目经历均为空，不能创建空白版本。
        </span>
        <span v-else>将冻结当前简历正文与项目经历。</span>
      </section>

      <section v-if="sortedVersions.length === 0" class="state-card empty-state" role="status">
        <h2>还没有简历版本</h2>
        <p>版本不会自动从个人档案生成。检查预览并确认后，才会创建不可变快照。</p>
      </section>

      <section v-else class="version-list" aria-label="简历版本列表">
        <article
          v-for="version in sortedVersions"
          :key="version.id"
          class="version-card"
          :class="{
            active: source?.activeResumeVersionId === version.id,
            archived: version.archivedAt !== null,
          }"
          :data-version-id="version.id"
        >
          <div class="version-main">
            <div class="version-title-row">
              <h2>{{ version.name }}</h2>
              <span v-if="source?.activeResumeVersionId === version.id" class="status-chip active-chip">当前激活</span>
              <span v-else-if="version.archivedAt !== null" class="status-chip archived-chip">已归档</span>
              <span v-else class="status-chip available-chip">可用</span>
            </div>
            <p class="summary">{{ version.summary || '暂无摘要' }}</p>
            <p class="metadata">
              {{ formatResumeVersionSourceLabel(version.source) }} · 创建于 {{ formatTime(version.createdAt) }}
            </p>
            <p v-if="version.archivedAt !== null" class="metadata">归档于 {{ formatTime(version.archivedAt) }}</p>
            <details class="technical-info" @toggle="toggleTechnicalInfo(version.id, ($event.target as HTMLDetailsElement).open)">
              <summary>查看技术信息</summary>
              <p v-if="expandedTechnicalVersionIds.has(version.id)" class="metadata">
                版本标识：{{ version.id }} · 内容摘要：{{ version.contentHash }} · 行版本：{{ version.rowVersion }}
              </p>
            </details>
          </div>
          <div class="card-actions">
            <button type="button" class="secondary-btn" :disabled="submitting" @click="openEdit(version)">
              编辑名称与摘要
            </button>
            <button
              v-if="version.archivedAt === null && source?.activeResumeVersionId !== version.id"
              type="button"
              class="secondary-btn"
              :disabled="submitting"
              @click="activateVersion(version)"
            >
              激活
            </button>
            <button
              v-if="version.archivedAt === null"
              type="button"
              class="danger-btn"
              :disabled="submitting"
              @click="openArchive(version)"
            >
              归档
            </button>
          </div>
        </article>
      </section>
    </template>

    <div v-if="createOpen" class="modal-backdrop" role="presentation" @click.self="requestCloseCreate()">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <header class="modal-head">
          <div>
            <h2 id="create-title">创建个人档案简历快照</h2>
            <p>请先检查将要冻结的真实内容。创建后只能修改名称和摘要。</p>
          </div>
          <button type="button" class="icon-btn" aria-label="关闭创建窗口" @click="requestCloseCreate()">×</button>
        </header>
        <label class="field">
          <span>版本名称</span>
          <input v-model="createDraft.name" type="text" maxlength="120" />
        </label>
        <label class="field">
          <span>摘要</span>
          <textarea v-model="createDraft.summary" rows="3" maxlength="500" />
        </label>
        <div class="field">
          <span>不可变内容预览</span>
          <pre class="snapshot-preview">{{ createSnapshotPreview }}</pre>
        </div>
        <footer class="modal-actions">
          <button type="button" class="secondary-btn" :disabled="submitting" @click="requestCloseCreate()">取消</button>
          <button
            type="button"
            class="primary-btn"
            :disabled="submitting || createDraft.name.trim() === ''"
            @click="submitCreate"
          >
            {{ submitting ? '正在创建…' : '确认创建快照' }}
          </button>
        </footer>
      </section>
    </div>

    <div v-if="editingSource" class="modal-backdrop" role="presentation" @click.self="requestCloseEdit()">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-title">
        <header class="modal-head">
          <div>
            <h2 id="edit-title">编辑名称与摘要</h2>
            <p>内容、来源、hash 和创建时间不可修改。</p>
          </div>
          <button type="button" class="icon-btn" aria-label="关闭编辑窗口" @click="requestCloseEdit()">×</button>
        </header>
        <p v-if="editConflictVersion !== null" class="banner banner-warning" role="alert">
          服务端当前版本号：{{ editConflictVersion }}。你的草稿已保留。
          <button type="button" class="link-btn" @click="reloadEditingVersion">重新加载</button>
        </p>
        <label class="field">
          <span>版本名称</span>
          <input v-model="editDraft.name" type="text" maxlength="120" />
        </label>
        <label class="field">
          <span>摘要</span>
          <textarea v-model="editDraft.summary" rows="4" maxlength="500" />
        </label>
        <footer class="modal-actions">
          <button type="button" class="secondary-btn" :disabled="submitting" @click="requestCloseEdit()">取消</button>
          <button type="button" class="primary-btn" :disabled="!editCanSubmit" @click="submitEdit">
            {{ submitting ? '正在保存…' : '确认保存元数据' }}
          </button>
        </footer>
      </section>
    </div>

    <div v-if="archiveTarget" class="modal-backdrop" role="presentation" @click.self="requestCloseArchive()">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="archive-title">
        <header class="modal-head">
          <div>
            <h2 id="archive-title">归档当前激活版本</h2>
            <p>归档不是删除。你必须选择替代版本，或明确允许清空 active pointer。</p>
          </div>
          <button type="button" class="icon-btn" aria-label="关闭归档窗口" @click="requestCloseArchive()">×</button>
        </header>
        <label v-if="selectableReplacements.length > 0" class="choice-row">
          <input
            type="radio"
            name="archive-mode"
            value="replacement"
            :checked="archiveMode === 'replacement'"
            @change="setArchiveMode('replacement')"
          />
          <span>激活其他可用版本</span>
        </label>
        <select
          v-if="selectableReplacements.length > 0"
          v-model="replacementResumeVersionId"
          :disabled="archiveMode !== 'replacement'"
          aria-label="替代简历版本"
        >
          <option value="">请选择替代版本</option>
          <option v-for="version in selectableReplacements" :key="version.id" :value="version.id">
            {{ version.name }}
          </option>
        </select>
        <label class="choice-row danger-choice">
          <input
            type="checkbox"
            :checked="archiveMode === 'clear'"
            @change="setArchiveMode(archiveMode === 'clear' ? '' : 'clear')"
          />
          <span>我明确允许清空当前简历版本</span>
        </label>
        <p v-if="selectableReplacements.length === 0" class="warning">
          当前没有其他可用版本；只有明确勾选清空后才能继续。
        </p>
        <footer class="modal-actions">
          <button type="button" class="secondary-btn" :disabled="submitting" @click="requestCloseArchive()">取消</button>
          <button type="button" class="danger-btn" :disabled="!archiveCanSubmit" @click="submitActiveArchive">
            {{ submitting ? '正在归档…' : '确认归档' }}
          </button>
        </footer>
      </section>
    </div>
  </main>
</template>

<style scoped>
.resume-versions-page { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; color: var(--of-ink); }
.page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 18px; }
.page-head h1 { margin: 0 0 6px; font-size: 24px; }
.page-head p, .modal-head p { margin: 0; color: var(--of-ink-2); font-size: 13px; line-height: 1.6; }
button, input, textarea, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.55; }
.primary-btn, .secondary-btn, .danger-btn { border-radius: 9px; padding: 8px 14px; font-size: 13px; font-weight: 600; }
.primary-btn { border: 1px solid var(--of-brand); background: var(--of-brand); color: #fff; }
.secondary-btn { border: 1px solid #cbd5e1; background: #fff; color: #334155; }
.danger-btn { border: 1px solid #fecaca; background: #fff1f2; color: #b91c1c; }
.link-btn { border: 0; padding: 0 0 0 8px; background: none; color: var(--of-brand); font-weight: 700; }
.banner, .state-card, .profile-state { padding: 13px 15px; border-radius: 11px; margin: 0 0 16px; font-size: 13px; }
.banner-success { background: #ecfdf5; color: #166534; }
.banner-error, .state-error { background: #fef2f2; color: #991b1b; }
.banner-warning { background: #fffbeb; color: #92400e; }
.state-card { border: 1px solid var(--of-line); background: #fff; text-align: center; }
.state-card h2 { margin: 0 0 6px; font-size: 17px; }
.state-card p { color: var(--of-ink-2); }
.profile-state { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; background: #eff6ff; color: #334155; }
.profile-state span { color: #475569; }
.warning { color: #b45309 !important; }
.empty-state { padding: 36px 20px; }
.version-list { display: flex; flex-direction: column; gap: 12px; }
.version-card { display: flex; justify-content: space-between; gap: 18px; padding: 18px; border: 1px solid var(--of-line); border-radius: 14px; background: #fff; box-shadow: var(--of-shadow); }
.version-card.active { border-color: rgba(37, 99, 235, 0.45); }
.version-card.archived { background: #f8fafc; opacity: 0.82; }
.version-main { min-width: 0; }
.version-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.version-title-row h2 { margin: 0; font-size: 17px; }
.status-chip { padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.active-chip { background: #dbeafe; color: #1d4ed8; }
.available-chip { background: #dcfce7; color: #166534; }
.archived-chip { background: #e2e8f0; color: #475569; }
.summary { margin: 8px 0 5px; color: #334155; font-size: 13px; white-space: pre-wrap; }
.metadata { margin: 3px 0 0; color: var(--of-muted); font-size: 12px; }
.card-actions { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; align-content: flex-start; gap: 8px; max-width: 300px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 24px; background: rgba(15, 23, 42, 0.38); }
.modal-card { width: min(680px, 100%); max-height: calc(100vh - 48px); overflow: auto; box-sizing: border-box; padding: 22px; border-radius: 16px; background: #fff; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.25); }
.modal-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.modal-head h2 { margin: 0 0 5px; font-size: 19px; }
.icon-btn { flex: none; width: 32px; height: 32px; border: 0; border-radius: 8px; background: #f1f5f9; color: #475569; font-size: 22px; }
.field { display: flex; flex-direction: column; gap: 7px; margin-bottom: 15px; font-size: 13px; font-weight: 600; }
.field input, .field textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 9px; padding: 9px 11px; background: #fff; }
.field textarea { resize: vertical; }
.snapshot-preview { max-height: 280px; overflow: auto; margin: 0; padding: 14px; border: 1px solid #dbe4f0; border-radius: 10px; background: #f8fafc; color: #334155; font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.choice-row { display: flex; align-items: center; gap: 9px; margin: 12px 0; font-size: 14px; }
.danger-choice { color: #b91c1c; }
@media (max-width: 720px) {
  .page-head, .version-card { flex-direction: column; }
  .card-actions { justify-content: flex-start; max-width: none; }
  .modal-backdrop { padding: 12px; }
}
</style>
