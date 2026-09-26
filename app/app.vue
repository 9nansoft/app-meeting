<script setup lang="ts">
import 'vue-sonner/style.css';
import { Toaster } from '@/components/ui/sonner';
</script>

<template>
  <div class="min-h-screen bg-background text-foreground font-sans antialiased selection:bg-primary/30">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <Toaster />
  </div>
</template>

<style>
@reference "./assets/css/tailwind.css";

/* Base typography and smooth scrolling setup */
html {
  scroll-behavior: smooth;
}
body {
  @apply bg-background text-foreground;
}
</style>
