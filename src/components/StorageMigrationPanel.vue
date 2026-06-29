<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { runControlledLocalStorageToSqliteMigration } from '../app/controlledSqliteMigration';
import {
  backendLabel,
  buildMigrationResultView,
  canRunSqliteMigration,
  canShowSqliteMigrationAction,
  getLocalStorageMigrationOverview,
  runtimeLabel,
  sqliteStateLabel,
  storageResolutionSummary,
  type LocalStorageMigrationOverview,
  type StorageMigrationResultView,
} from '../app/storageMigrationUiState';
import {
  BrowserStorageDriver,
  TauriSQLiteClient,
  detectStorageRuntime,
  resolveStorageBackend,
  type StorageBackendResolution,
  type StorageRuntime,
} from '../storage';

const runtime = ref<StorageRuntime>(detectStorageRuntime());
const resolution = ref<StorageBackendResolution | null>(null);
const overview = ref<LocalStorageMigrationOverview | null>(null);
const resultView = ref<StorageMigrationResultView | null>(null);
const checking = ref(true);
const migrating = ref(false);
const errorText = ref('');

const activeBackendLabel = computed(() =>
  backendLabel(resolution.value?.activeBackend ?? 'localStorage'),
);
const preferredBackendLabel = computed(() =>
  backendLabel(resolution.value?.preferredBackend ?? 'localStorage'),
);
const sqliteStatusLabel = computed(() =>
  sqliteStateLabel(resolution.value?.state ?? null, runtime.value),
);
const canShowMigrationButton = computed(() =>
  canShowSqliteMigrationAction(runtime.value),
);
const canClickMigration = computed(
  () =>
    canRunSqliteMigration(runtime.value, checking.value || migrating.value) &&
    resolution.value?.state !== 'sqlite_active',
);
const migrationButtonText = computed(() =>
  resolution.value?.state === 'sqlite_ready' ||
  resolution.value?.state === 'already_migrated'
    ? '启用 SQLite backend'
    : '备份并迁移到 SQLite',
);

onMounted(() => {
  void refreshStatus();
});

async function refreshStatus(): Promise<void> {
  checking.value = true;
  errorText.value = '';

  try {
    const nextRuntime = detectStorageRuntime();
    const driver = new BrowserStorageDriver();
    runtime.value = nextRuntime;
    overview.value = getLocalStorageMigrationOverview(driver);
    resolution.value = await resolveStorageBackend({
      driver,
      runtime: nextRuntime,
      sqliteClient: nextRuntime.isTauri ? new TauriSQLiteClient() : undefined,
    });
  } catch (error) {
    errorText.value = errorMessage(error);
  } finally {
    checking.value = false;
  }
}

async function handleMigration(): Promise<void> {
  if (!runtime.value.isTauri) {
    errorText.value = 'Web 浏览器模式不能执行 SQLite 迁移。';
    return;
  }

  const accepted = window.confirm(
    '确认开始迁移？OfferFlow 会先生成一份 localStorage JSON 备份，再把数据写入本机 SQLite 文件。旧 localStorage 数据不会删除，可作为兜底。',
  );
  if (!accepted) {
    return;
  }

  migrating.value = true;
  errorText.value = '';
  resultView.value = null;

  try {
    const driver = new BrowserStorageDriver();
    const snapshot = getLocalStorageMigrationOverview(driver);
    overview.value = snapshot;
    const result = await runControlledLocalStorageToSqliteMigration({
      driver,
      runtime: runtime.value,
      sqliteClient: new TauriSQLiteClient(),
    });
    resultView.value = buildMigrationResultView(result, snapshot);
    await refreshStatus();
  } catch (error) {
    errorText.value = errorMessage(error);
  } finally {
    migrating.value = false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === 'string') {
      return value;
    }
  }
  return '存储状态检查失败。';
}
</script>

<template>
  <section class="migration-panel" aria-labelledby="storage-migration-title">
    <div class="panel-head">
      <div>
        <h2 id="storage-migration-title">本地数据存储</h2>
        <p>
          升级为本地 SQLite 数据库后，OfferFlow 会先生成一份 localStorage JSON
          备份，再把数据写入本机 SQLite 文件。旧 localStorage 数据不会删除，可作为兜底。
        </p>
      </div>
      <button type="button" class="ghost-btn" :disabled="checking" @click="refreshStatus">
        {{ checking ? '检查中...' : '检查本地存储状态' }}
      </button>
    </div>

    <dl class="status-grid">
      <div>
        <dt>运行环境</dt>
        <dd>{{ runtimeLabel(runtime) }}</dd>
      </div>
      <div>
        <dt>当前 backend</dt>
        <dd>{{ activeBackendLabel }}</dd>
      </div>
      <div>
        <dt>backend 标记</dt>
        <dd>{{ preferredBackendLabel }}</dd>
      </div>
      <div>
        <dt>SQLite 状态</dt>
        <dd>{{ sqliteStatusLabel }}</dd>
      </div>
      <div>
        <dt>profile</dt>
        <dd>{{ overview?.profileExists ? '已存在' : '未检测到' }}</dd>
      </div>
      <div>
        <dt>jobs</dt>
        <dd>{{ overview?.jobCount ?? 0 }}</dd>
      </div>
    </dl>

    <p class="state-note">{{ storageResolutionSummary(resolution, runtime) }}</p>

    <p v-if="overview && overview.warningCount > 0" class="warning-line">
      localStorage 检查发现 {{ overview.warningCount }} 条 warning，其中
      {{ overview.parseErrorCount }} 条为 JSON parse warning；迁移不会静默修复坏数据。
    </p>

    <p v-if="!canShowMigrationButton" class="web-note">
      Web 浏览器模式继续使用 localStorage，不提供 SQLite 迁移按钮。
    </p>

    <div v-else class="actions">
      <button
        type="button"
        class="primary-btn"
        :disabled="!canClickMigration"
        @click="handleMigration"
      >
        {{ migrating ? '迁移中...' : migrationButtonText }}
      </button>
      <span class="safety-note">
        失败会回退 localStorage，不会删除旧数据。
      </span>
    </div>

    <div
      v-if="resultView"
      class="result-box"
      :class="{ failed: resultView.backend !== 'sqlite' }"
    >
      <strong>{{ resultView.backendSwitchedToSqlite ? 'SQLite backend 已启用' : '迁移未切换 backend' }}</strong>
      <dl>
        <div>
          <dt>backup 路径</dt>
          <dd>{{ resultView.backupPath ?? '无' }}</dd>
        </div>
        <div>
          <dt>migration id</dt>
          <dd>{{ resultView.migrationId ?? '无' }}</dd>
        </div>
        <div>
          <dt>profile / jobs</dt>
          <dd>{{ resultView.profileCount ?? 0 }} / {{ resultView.jobCount ?? 0 }}</dd>
        </div>
        <div>
          <dt>warning / error</dt>
          <dd>
            {{ resultView.warningCount }}
            <span v-if="resultView.errorCode"> / {{ resultView.errorCode }}</span>
          </dd>
        </div>
      </dl>
      <p>{{ resultView.message }}</p>
      <ul v-if="resultView.warnings.length > 0">
        <li v-for="warning in resultView.warnings.slice(0, 3)" :key="warning">
          {{ warning }}
        </li>
      </ul>
    </div>

    <p v-if="errorText" class="error-line" role="alert">{{ errorText }}</p>
  </section>
</template>

<style scoped>
.migration-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 20px;
  padding: 22px;
  border: 1px solid var(--of-line);
  border-radius: var(--of-radius);
  background: var(--of-card);
  box-shadow: var(--of-shadow);
}
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.panel-head h2 {
  margin: 0 0 6px;
  font-size: 18px;
}
.panel-head p,
.state-note,
.web-note,
.safety-note,
.warning-line,
.error-line,
.result-box p {
  margin: 0;
  color: #647084;
  font-size: 13px;
  line-height: 1.6;
}
.status-grid,
.result-box dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}
.status-grid div,
.result-box dl div {
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}
dt {
  margin-bottom: 4px;
  color: #647084;
  font-size: 12px;
}
dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: #0f172a;
  font-size: 13px;
  font-weight: 600;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.primary-btn,
.ghost-btn {
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.primary-btn {
  padding: 10px 16px;
  border: none;
  background: #2563eb;
  color: #fff;
}
.primary-btn:hover:not(:disabled) {
  background: #1d4ed8;
}
.ghost-btn {
  flex: none;
  padding: 8px 12px;
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #1f2937;
}
.primary-btn:disabled,
.ghost-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.warning-line {
  color: #9a6700;
}
.error-line {
  color: #b42318;
}
.result-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid #bbf7d0;
  border-radius: 8px;
  background: #f0fdf4;
}
.result-box.failed {
  border-color: #fed7aa;
  background: #fff7ed;
}
.result-box strong {
  color: #166534;
  font-size: 14px;
}
.result-box.failed strong {
  color: #9a3412;
}
.result-box ul {
  margin: 0;
  padding-left: 18px;
  color: #647084;
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 720px) {
  .panel-head {
    flex-direction: column;
  }
  .ghost-btn {
    width: 100%;
  }
  .status-grid,
  .result-box dl {
    grid-template-columns: 1fr;
  }
}
</style>
