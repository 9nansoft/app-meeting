import { useState, useNuxtApp, navigateTo } from '#imports'

export interface AuthUser {
  id: number
  username: string
  role: string
  name?: string | null
  doctorcode?: string | null
  depcode?: string | null
}

export const useAuth = () => {
  const user = useState<AuthUser | null>('auth-user', () => null)
  const isLoading = useState<boolean>('auth-loading', () => false)
  const { $api } = useNuxtApp()

  const fetchMe = async () => {
    isLoading.value = true
    try {
      const { data, error } = await $api.auth.me.get()
      if (!error && data && 'user' in data && data.user) {
        user.value = data.user
        return data.user
      } else {
        user.value = null
        return null
      }
    } catch {
      user.value = null
      return null
    } finally {
      isLoading.value = false
    }
  }

  const logout = async () => {
    try {
      await $api.auth.logout.post()
    } finally {
      user.value = null
      await navigateTo('/login')
    }
  }

  return {
    user,
    isLoading,
    fetchMe,
    logout
  }
}
