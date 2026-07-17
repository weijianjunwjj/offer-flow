<script setup lang="ts">
import { ref } from 'vue';
import { NAlert, NButton, NSpace, NTabPane, NTabs } from 'naive-ui';
import type { MarketPositionCityCode, MarketPositionDraft } from '../../domain/market-position';
import { MARKET_POSITION_CITY_CODES } from '../../domain/market-position';
import { MARKET_POSITION_CITY_LABELS } from '../../domain/presentation';
import MarketPositionScopeProfileEditor from './MarketPositionScopeProfileEditor.vue';

const props = defineProps<{
  modelValue: MarketPositionDraft;
  submitLabel: string;
}>();
const emit = defineEmits<{ submit: [payload: MarketPositionDraft]; cancel: [] }>();

const activeTab = ref<'global' | MarketPositionCityCode>('global');
const globalEditor = ref<InstanceType<typeof MarketPositionScopeProfileEditor> | null>(null);
const cityEditors = ref<Record<string, InstanceType<typeof MarketPositionScopeProfileEditor> | null>>({});

function setCityEditorRef(city: string, el: InstanceType<typeof MarketPositionScopeProfileEditor> | null): void {
  cityEditors.value[city] = el;
}

function submit(): void {
  if (globalEditor.value === null) return;
  const global = globalEditor.value.buildProfile();
  const cityProfiles = MARKET_POSITION_CITY_CODES.map((city) => {
    const editor = cityEditors.value[city];
    const original = props.modelValue.cityProfiles.find((profile) => profile.scope.city === city);
    if (editor === null || editor === undefined || original === undefined) {
      throw new Error(`缺少城市 ${city} 的编辑器状态`);
    }
    return editor.buildProfile();
  });
  emit('submit', {
    ...props.modelValue,
    global,
    cityProfiles,
  });
}
</script>

<template>
  <div class="draft-editor" data-testid="mp-draft-editor">
    <NAlert type="warning" style="margin-bottom: 12px">
      每个城市的证据必须来自该城市自身的投递/回复/面试记录，不得借用其它城市或全局数据作为该城市的市场验证。
    </NAlert>
    <NTabs v-model:value="activeTab" type="line" animated>
      <NTabPane name="global" tab="全局" display-directive="show">
        <MarketPositionScopeProfileEditor
          ref="globalEditor"
          :model-value="modelValue.global"
          title="全局市场位置"
        />
      </NTabPane>
      <NTabPane
        v-for="city in MARKET_POSITION_CITY_CODES"
        :key="city"
        :name="city"
        :tab="MARKET_POSITION_CITY_LABELS[city]"
        display-directive="show"
      >
        <MarketPositionScopeProfileEditor
          :ref="(el) => setCityEditorRef(city, el as InstanceType<typeof MarketPositionScopeProfileEditor> | null)"
          :model-value="modelValue.cityProfiles.find((profile) => profile.scope.city === city)!"
          :title="`${MARKET_POSITION_CITY_LABELS[city]} 市场位置`"
        />
      </NTabPane>
    </NTabs>
    <NSpace style="margin-top: 16px" justify="end">
      <NButton @click="emit('cancel')">取消</NButton>
      <NButton type="primary" data-testid="mp-draft-submit" @click="submit">{{ submitLabel }}</NButton>
    </NSpace>
  </div>
</template>

<style scoped>
.draft-editor { display: flex; flex-direction: column; }
</style>
