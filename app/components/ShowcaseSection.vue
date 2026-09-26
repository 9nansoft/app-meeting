<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <section class="py-12 border-b last:border-0 border-border">
    <div class="mb-8">
      <h2 class="text-3xl font-bold tracking-tight mb-2">{{ title }}</h2>
      <p v-if="description" class="text-muted-foreground">{{ description }}</p>
    </div>
    <div class="space-y-8">
      <slot />
    </div>
  </section>
</template>
