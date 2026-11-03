// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss', 'nuxt-elysia', 'shadcn-nuxt', '@nuxtjs/color-mode'],
  shadcn: {
    /**
     * Prefix for all the imported component.
     * @default "Ui"
     */
    prefix: '',
    /**
     * Directory that the component lives in.
     * Will respect the Nuxt aliases.
     * @link https://nuxt.com/docs/api/nuxt-config#alias
     * @default "@/components/ui"
     */
    componentDir: '@/components/ui'
  },
  colorMode: {
    classSuffix: ''
  },
  nitro: {
    preset: 'Bun',
  },
  // HTTP security headers ของหน้าเว็บ (API ตั้งเองใน api/index.ts)
  routeRules: {
    '/**': {
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
        'Cross-Origin-Opener-Policy': 'same-origin',
        ...(process.env.NODE_ENV === 'production'
          ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
          : {}),
      },
    },
  },
  nuxtElysia: {
    path: '/api'
  },
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true }
})