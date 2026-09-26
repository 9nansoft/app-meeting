export default defineNuxtPlugin((nuxtApp) => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (input, init) => {
    // Call the original fetch
    const res = await originalFetch(input, init)

    // Ensure we only intercept /api/ calls
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
    
    if (res.status === 401 && url.includes('/api/')) {
      nuxtApp.runWithContext(() => {
        const { user } = useAuth()
        if (user.value) {
          user.value = null
        }
        const router = useRouter()
        if (router.currentRoute.value.path !== '/login') {
          router.push('/login')
        }
      })
    }

    return res
  }
})
