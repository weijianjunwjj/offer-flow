<script setup lang="ts">
import type { JobMatchRoleBand } from '../../domain/job-match-profile';

defineProps<{ title: string; tone: 'stretch' | 'primary' | 'safe'; band: JobMatchRoleBand }>();
</script>

<template>
  <article class="band-card" :data-tone="tone">
    <header><span class="dot" /><h3>{{ title }}</h3></header>
    <div class="roles">
      <span v-for="role in band.roleTitles" :key="role">{{ role }}</span>
      <span v-if="band.roleTitles.length === 0" class="muted">尚待补充</span>
    </div>
    <p class="salary">
      <strong>薪资范围</strong>
      <span v-if="band.salaryRange.minK !== null || band.salaryRange.maxK !== null">
        {{ band.salaryRange.minK ?? '待定' }}–{{ band.salaryRange.maxK ?? '待定' }}K
      </span>
      <span>{{ band.salaryRange.note || '尚无充分证据' }}</span>
    </p>
    <dl>
      <div><dt>适配公司</dt><dd>{{ [...band.companySizes, ...band.companyTypes].join(' · ') || '尚待验证' }}</dd></div>
      <div><dt>技术定位</dt><dd>{{ band.technicalFocus.join(' · ') || '尚待验证' }}</dd></div>
      <div><dt>适配原因</dt><dd>{{ band.suitableReasons.join('；') || '尚待验证' }}</dd></div>
      <div><dt>风险</dt><dd>{{ band.risks.join('；') || '暂无明确风险证据' }}</dd></div>
    </dl>
  </article>
</template>

<style scoped>
.band-card { padding: 18px; border: 1px solid #e2e8f0; border-radius: 16px; background: #fff; box-shadow: 0 12px 28px -26px #0f172a; }
.band-card[data-tone='stretch'] { border-top: 3px solid #8b5cf6; }
.band-card[data-tone='primary'] { border-top: 3px solid #2563eb; }
.band-card[data-tone='safe'] { border-top: 3px solid #0f9f6e; }
header { display: flex; align-items: center; gap: 8px; }
h3 { margin: 0; color: #0f172a; font-size: 15px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.roles { display: flex; flex-wrap: wrap; gap: 7px; margin: 14px 0; }
.roles span { padding: 5px 9px; border-radius: 999px; color: #1e3a8a; background: #eff6ff; font-size: 12px; font-weight: 650; }
.roles .muted { color: #64748b; background: #f1f5f9; }
.salary { display: grid; gap: 3px; margin: 0 0 12px; padding: 10px; border-radius: 10px; color: #475569; background: #f8fafc; font-size: 12px; }
.salary strong { color: #0f172a; }
dl { display: grid; gap: 9px; margin: 0; }
dl div { display: grid; gap: 2px; }
dt { color: #64748b; font-size: 11px; font-weight: 700; }
dd { margin: 0; color: #334155; font-size: 12px; line-height: 1.55; }
</style>
