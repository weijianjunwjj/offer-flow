<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { syncApi, type SyncStatus } from '../api/syncApi';

const status = ref<SyncStatus | null>(null);
const loading = ref(false);
const error = ref('');
const feedback = ref('');

const healthText = computed(() => {
  if (status.value === null) {
    return '检查中';
  }
  return status.value.doctor.ok ? '健康' : '异常';
});

const tableCountText = computed(() => {
  const counts = status.value?.tableCounts;
  if (counts === null || counts === undefined) {
    return '-';
  }
  return Object.entries(counts)
    .map(([table, count]) => `${table}:${count}`)
    .join(' / ');
});

function formatTime(value: string | null): string {
  return value === null ? '-' : new Date(value).toLocaleString();
}

async function refreshStatus(): Promise<void> {
  status.value = await syncApi.status();
}

async function runAction(label: string, action: () => Promise<unknown>): Promise<void> {
  loading.value = true;
  error.value = '';
  feedback.value = '';
  try {
    await action();
    await refreshStatus();
    feedback.value = `${label}完成`;
  } catch (caught) {
    error.value = (caught as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    await refreshStatus();
  } catch (caught) {
    error.value = (caught as Error).message;
  }
});
</script>

<template>
  <section class="sync-center">
    <div class="sync-head">
      <div>
        <h2>同步中心</h2>
        <p>SQLite 本机运行 · JSON 快照同步</p>
      </div>
      <span class="health" :class="{ bad: status !== null && !status.doctor.ok }">
        {{ healthText }}
      </span>
    </div>

    <div class="sync-grid">
      <div>
        <span class="metric-label">Device ID</span>
        <strong>{{ status?.deviceId ?? '-' }}</strong>
      </div>
      <div>
        <span class="metric-label">最近同步</span>
        <strong>{{ formatTime(status?.lastSyncAt ?? null) }}</strong>
      </div>
      <div>
        <span class="metric-label">Snapshot</span>
        <strong>{{ status?.snapshotExists ? '存在' : '不存在' }}</strong>
      </div>
      <div>
        <span class="metric-label">Hash</span>
        <strong>{{ status?.shortSnapshotHash ?? '-' }}</strong>
      </div>
      <div class="wide">
        <span class="metric-label">表计数</span>
        <strong>{{ tableCountText }}</strong>
      </div>
      <div>
        <span class="metric-label">Lock</span>
        <strong>{{ status?.activeLock ? '运行中' : '空闲' }}</strong>
      </div>
    </div>

    <p v-if="error" class="sync-message error" role="alert">{{ error }}</p>
    <p v-else-if="feedback" class="sync-message ok" role="status">{{ feedback }}</p>
    <ul v-if="status?.warnings.length" class="warnings">
      <li v-for="warning in status.warnings" :key="warning">{{ warning }}</li>
    </ul>

    <div class="sync-actions">
      <button type="button" :disabled="loading" @click="runAction('立即同步', syncApi.run)">
        立即同步
      </button>
      <button type="button" :disabled="loading" @click="runAction('检查数据库', syncApi.doctor)">
        检查数据库
      </button>
      <button type="button" :disabled="loading" @click="runAction('导出快照', syncApi.export)">
        导出快照
      </button>
      <button type="button" :disabled="loading" @click="runAction('从快照合并', syncApi.import)">
        从快照合并
      </button>
    </div>
  </section>
</template>

<style scoped>
.sync-center {
  margin-top: 20px;
  padding: 18px;
  border: 1px solid var(--of-line);
  border-radius: var(--of-radius);
  background: var(--of-card);
  box-shadow: var(--of-shadow);
}
.sync-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.sync-head h2 {
  margin: 0;
  font-size: 18px;
}
.sync-head p {
  margin: 4px 0 0;
  color: #647084;
  font-size: 12px;
}
.health {
  flex: none;
  padding: 4px 10px;
  border-radius: 999px;
  color: #166534;
  background: #dcfce7;
  font-size: 12px;
  font-weight: 700;
}
.health.bad {
  color: #991b1b;
  background: #fee2e2;
}
.sync-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.sync-grid > div {
  min-width: 0;
  padding: 10px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 8px;
  background: #f8fafc;
}
.sync-grid .wide {
  grid-column: span 2;
}
.metric-label {
  display: block;
  margin-bottom: 4px;
  color: #647084;
  font-size: 12px;
}
.sync-grid strong {
  display: block;
  overflow-wrap: anywhere;
  color: #1f2937;
  font-size: 13px;
}
.sync-message {
  margin: 12px 0 0;
  padding: 9px 10px;
  border-radius: 8px;
  font-size: 13px;
}
.sync-message.ok {
  color: #166534;
  background: #dcfce7;
}
.sync-message.error {
  color: #991b1b;
  background: #fee2e2;
}
.warnings {
  margin: 12px 0 0;
  padding-left: 18px;
  color: #92400e;
  font-size: 12px;
}
.sync-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}
.sync-actions button {
  padding: 8px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
  color: #1f2937;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.sync-actions button:hover:not(:disabled) {
  border-color: var(--of-brand);
  color: var(--of-brand);
}
.sync-actions button:disabled {
  cursor: wait;
  opacity: 0.6;
}
@media (max-width: 720px) {
  .sync-grid {
    grid-template-columns: 1fr;
  }
  .sync-grid .wide {
    grid-column: span 1;
  }
}
</style>
