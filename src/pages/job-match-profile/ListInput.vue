<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue: string[];
  label: string;
  placeholder?: string;
  multiline?: boolean;
}>(), { placeholder: '每行一项', multiline: false });

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

function update(value: string): void {
  emit('update:modelValue', value.split(props.multiline ? /\r?\n/ : /[,，\n]/)
    .map((item) => item.trim()).filter(Boolean));
}
</script>

<template>
  <label class="list-field">
    <span>{{ label }}</span>
    <textarea
      v-if="multiline"
      rows="3"
      :value="modelValue.join('\n')"
      :placeholder="placeholder"
      @input="update(($event.target as HTMLTextAreaElement).value)"
    />
    <input
      v-else
      type="text"
      :value="modelValue.join('、')"
      :placeholder="placeholder"
      @input="update(($event.target as HTMLInputElement).value)"
    />
  </label>
</template>

<style scoped>
.list-field { display: grid; gap: 6px; min-width: 0; color: #334155; font-size: 12px; font-weight: 650; }
input, textarea { box-sizing: border-box; width: 100%; border: 1px solid #d9e2ef; border-radius: 9px; padding: 9px 10px; color: #0f172a; background: #fff; font: 13px/1.5 inherit; }
textarea { resize: vertical; }
input:focus, textarea:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .1); }
</style>
