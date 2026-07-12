<script setup lang="ts">
import { useInjectedDetailScope } from './sectionScope';
const props = defineProps<{ scopeRequired: boolean }>();
const scope = useInjectedDetailScope(props.scopeRequired);
</script>
<template><section :data-scope-id="scope?.$id"><slot /></section></template>
