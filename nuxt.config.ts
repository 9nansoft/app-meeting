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
  nuxtElysia: {
    path: '/api'
  },
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true }
})