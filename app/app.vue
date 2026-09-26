<script setup lang="ts">
import 'vue-sonner/style.css';
import { Toaster } from '@/components/ui/sonner';
import Header from '@/components/Header.vue';
</script>

<template>
  <div class="min-h-screen bg-background text-foreground font-sans antialiased selection:bg-primary/30">
    <Header />
    <main class="container mx-auto px-4 sm:px-8 py-8 w-full max-w-7xl">
      <NuxtPage />
    </main>
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
