<script setup lang="ts">
import { ref } from 'vue'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { toast } from 'vue-sonner'
import { useNuxtApp } from '#imports'

const { $api } = useNuxtApp()

const emit = defineEmits<{ (e: 'logged-in'): void }>()
const props = defineProps<{ currentUser?: { id: number; username: string; role: string } | null }>()

// Auth State
const loginData = ref({ username: '', password: '' })
const registerData = ref({ username: '', password: '' })
const isLoading = ref(false)

async function handleLogin() {
  isLoading.value = true
  const { data, error } = await $api.auth.login.post({
    username: loginData.value.username,
    password: loginData.value.password
  })
  isLoading.value = false

  if (error) {
    toast.error('Login Failed', { description: error.value?.error || 'Invalid credentials' })
    return
  }

  toast.success(`Welcome back ${data?.user.username}!`)
  emit('logged-in')
}

async function handleRegister() {
  isLoading.value = true
  const { data, error } = await $api.auth.register.post({
    username: registerData.value.username,
    password: registerData.value.password
  })
  isLoading.value = false

  if (error) {
    toast.error('Registration Failed', { description: error.value?.error || 'Registration failed' })
    return
  }

  toast.success('Registration successful!', { description: 'You can now log in.' })
  registerData.value = { username: '', password: '' }
  // Optionally auto-login, but we'll force them to use the login tab to show off state
}

async function handleLogout() {
  await $api.auth.logout.post()
  emit('logged-in') // Trigger refresh
  toast.info('Logged out')
}
</script>

<template>
  <div class="max-w-md mx-auto">
    <Card v-if="currentUser" class="border-primary/50 shadow-lg shadow-primary/10">
      <CardHeader>
        <CardTitle>Authenticated Profile</CardTitle>
        <CardDescription>You are currently logged in via an HTTP-Only secure cookie.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="bg-muted p-4 rounded-md">
          <pre class="text-xs break-all"><code>{{ currentUser }}</code></pre>
        </div>
      </CardContent>
      <CardFooter>
        <Button class="w-full" variant="destructive" @click="handleLogout">
          Log out
        </Button>
      </CardFooter>
    </Card>

    <Tabs v-else default-value="login" class="w-full">
      <TabsList class="grid w-full grid-cols-2">
        <TabsTrigger value="login">Login</TabsTrigger>
        <TabsTrigger value="register">Register</TabsTrigger>
      </TabsList>
      
      <!-- Login -->
      <TabsContent value="login">
        <Card>
          <CardHeader>
            <CardTitle>Login</CardTitle>
            <CardDescription>Enter your credentials to receive an auth cookie.</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="space-y-1">
              <Label for="l-username">Username</Label>
              <Input id="l-username" v-model="loginData.username" placeholder="Demo user: 'admin'" />
            </div>
            <div class="space-y-1">
              <Label for="l-password">Password</Label>
              <Input id="l-password" v-model="loginData.password" type="password" placeholder="Demo pass: 'password'" />
            </div>
          </CardContent>
          <CardFooter>
            <Button class="w-full" :disabled="isLoading" @click="handleLogin">
              {{ isLoading ? 'Logging in...' : 'Sign in' }}
            </Button>
          </CardFooter>
        </Card>
      </TabsContent>

      <!-- Register -->
      <TabsContent value="register">
        <Card>
          <CardHeader>
            <CardTitle>Create Account</CardTitle>
            <CardDescription>Accounts are saved in the Elysia memory DB.</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="space-y-1">
              <Label for="r-username">Username</Label>
              <Input id="r-username" v-model="registerData.username" />
            </div>
            <div class="space-y-1">
              <Label for="r-password">Password</Label>
              <Input id="r-password" v-model="registerData.password" type="password" />
            </div>
          </CardContent>
          <CardFooter>
            <Button class="w-full" :disabled="isLoading" @click="handleRegister">
              {{ isLoading ? 'Registering...' : 'Register' }}
            </Button>
          </CardFooter>
        </Card>
      </TabsContent>
    </Tabs>
  </div>
</template>
