<script setup lang="ts">
import Header from '@/components/Header.vue'
</script>

<template>
  <div>
    <Header />
    <main class="container mx-auto px-4 sm:px-8 py-8 w-full max-w-7xl">
      <slot />
    </main>
  </div>
</template>
