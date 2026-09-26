<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{
  error: NuxtError
}>()

const statusCode = computed(() => props.error?.statusCode ?? 500)
const statusMessage = computed(() => props.error?.statusMessage || 'Unexpected Error')
const message = computed(() => props.error?.message || 'Something went wrong. Please try again.')
const statusTag = computed(() => {
  if (statusCode.value === 404) {
    return 'Resource Missing'
  }

  if (statusCode.value >= 500) {
    return 'Server Side Fault'
  }

  return 'Request Failed'
})

function handleError() {
  clearError({ redirect: '/' })
}

function goBack() {
  if (import.meta.client && window.history.length > 1) {
    window.history.back()
    return
  }

  handleError()
}
</script>

<template>
  <main class="relative min-h-screen overflow-hidden bg-background px-6 py-16">
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute left-[-8rem] top-[-8rem] h-64 w-64 rounded-full bg-primary/15 blur-3xl orb" />
      <div class="absolute bottom-[-10rem] right-[-6rem] h-72 w-72 rounded-full bg-destructive/15 blur-3xl orb-delayed" />
      <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,hsl(var(--foreground)/0.05)_1px,transparent_1px)] [background-size:20px_20px]" />
    </div>

    <section class="relative mx-auto grid min-h-[75vh] w-full max-w-4xl place-items-center">
      <div class="w-full rounded-3xl border border-border/80 bg-card/80 p-8 shadow-2xl backdrop-blur md:p-10">
        <div class="mb-7 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          {{ statusTag }}
        </div>

        <h1 class="text-6xl font-black leading-none tracking-tight text-foreground md:text-8xl">
          {{ statusCode }}
        </h1>

        <h2 class="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
          {{ statusMessage }}
        </h2>

        <p class="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
          {{ message }}
        </p>

        <div class="mt-9 flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
            @click="handleError"
          >
            Go Home
          </button>

          <button
            type="button"
            class="inline-flex items-center rounded-md border border-border bg-background/60 px-5 py-2.5 text-sm font-semibold transition hover:bg-muted"
            @click="goBack"
          >
            Go Back
          </button>

          <button
            type="button"
            class="inline-flex items-center rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:text-foreground"
            @click="reloadNuxtApp({ force: true })"
          >
            Reload App
          </button>
        </div>

        <p class="mt-8 text-xs uppercase tracking-[0.18em] text-muted-foreground/90">
          If this persists, check server logs and recent deploy changes.
        </p>
      </div>
    </section>
  </main>
</template>

<style scoped>
.orb {
  animation: float 8s ease-in-out infinite;
}

.orb-delayed {
  animation: float 9s ease-in-out 1.5s infinite;
}

@keyframes float {
  0%,
  100% {
    transform: translate3d(0, 0, 0);
  }
  50% {
    transform: translate3d(0, -12px, 0);
  }
}
</style>
