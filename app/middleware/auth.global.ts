export default defineNuxtRouteMiddleware(async (to) => {
  // หน้าที่เข้าได้โดยไม่ต้อง login: หน้าจอ TV display และหน้า login
  if (to.path === '/login' || to.path.startsWith('/display')) {
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
