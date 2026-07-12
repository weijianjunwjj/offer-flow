<script setup lang="ts">
import { useInjectedDetailScope } from './sectionScope';
const props = defineProps<{ scopeRequired: boolean }>();
const scope = useInjectedDetailScope(props.scopeRequired);
</script>
<template><div class="jd-input-section" :data-scope-id="scope?.$id"><slot /></div></template>
