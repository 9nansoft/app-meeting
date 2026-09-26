<script setup lang="ts">
import ThemeToggle from './ThemeToggle.vue'
</script>

<template>
  <header class="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
    <div class="container mx-auto px-4 sm:px-8 flex h-16 items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="font-bold text-lg tracking-tight bg-gradient-to-r from-primary to-purple-500 bg-clip-text text-transparent">
          Shadcn-Vue
        </div>
        <div class="text-sm font-medium text-muted-foreground hidden sm:block">
          Showcase
        </div>
      </div>

      <nav class="flex items-center gap-4">
        <a href="https://nhanthinh1809.github.io/shadcn-vue/" target="_blank" class="text-sm font-medium hover:text-primary transition-colors">
          Documentation
        </a>
        <ThemeToggle />
      </nav>
    </div>
  </header>
</template>
