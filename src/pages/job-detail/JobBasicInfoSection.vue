<script setup lang="ts">
import { useInjectedDetailScope } from './sectionScope';

const props = defineProps<{ scopeRequired: boolean }>();
const emit = defineEmits<{ submit: [] }>();
const scope = useInjectedDetailScope(props.scopeRequired);
</script>

<template>
  <form :data-scope-id="scope?.$id" @submit.prevent="emit('submit')"><slot /></form>
</template>
