export default defineNuxtRouteMiddleware(async (to) => {
  // Allow login page without auth
  if (to.path === '/login' || to.path === '/showcase') {
    return
  }

  const { user, fetchMe } = useAuth()

  // If we don't have user data yet, try to fetch
  if (!user.value) {
    await fetchMe()
  }

  // Still no user after fetch → redirect to login
  if (!user.value) {
    return navigateTo('/login')
  }
})
