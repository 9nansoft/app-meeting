<script setup lang="ts">
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useNuxtApp } from '#imports'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Loader2, Hospital, Eye, EyeOff } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

definePageMeta({
  layout: false // Use raw layout with no sidebar or header
})

const { $api } = useNuxtApp()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const isLoading = ref(false)
const showPassword = ref(false)

async function handleLogin() {
  if (!username.value || !password.value) {
    toast.error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน')
    return
  }

  isLoading.value = true
  try {
    const { data, error, status } = await $api.auth.login.post({
      username: username.value,
      password: password.value
    })

    if (error || status !== 200) {
      toast.error('เข้าสู่ระบบไม่สำเร็จ', { 
        description: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือบัญชีถูกระงับการใช้งาน' 
      })
    } else {
      toast.success('เข้าสู่ระบบสำเร็จ', {
        description: `ยินดีต้อนรับ ${data.user?.name || ''}`
      })
      const redirectPath = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
        ? route.query.redirect
        : '/dashboard'

      router.push(redirectPath)
    }
  } catch (err) {
    toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อระบบ')
    console.error(err)
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-muted/30 p-4">
    <div class="w-full max-w-md">
      <!-- Logo / Header -->
      <div class="mb-8 text-center flex flex-col items-center">
        <div class="h-16 w-16 bg-primary/10 text-primary rounded-full flex items-center justify-center mb-4 ring-8 ring-primary/5">
          <Hospital class="w-8 h-8" />
        </div>
        <h1 class="text-2xl font-bold tracking-tight text-primary">HIS Management</h1>
        <p class="text-muted-foreground mt-1">HIS User Management</p>
      </div>

      <!-- Login Card -->
      <Card class="border-t-4 border-t-primary shadow-lg">
        <CardHeader class="space-y-1">
          <CardTitle class="text-xl">เข้าสู่ระบบพนักงาน</CardTitle>
          <CardDescription>
            กรุณากรอก Username และ Password เพื่อเข้าสู่ระบบ
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form @submit.prevent="handleLogin" class="space-y-4">
            <div class="space-y-2">
              <Label for="username">ชื่อผู้ใช้ (Username)</Label>
              <Input 
                id="username" 
                type="text" 
                placeholder="ระบุ login name" 
                v-model="username"
                :disabled="isLoading"
                autocomplete="username"
                required
              />
            </div>
            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <Label for="password">รหัสผ่าน (Password)</Label>
              </div>
              <InputGroup>
                <InputGroupInput 
                  id="password" 
                  :type="showPassword ? 'text' : 'password'" 
                  v-model="password"
                  :disabled="isLoading"
                  autocomplete="current-password"
                  required
                />
                <InputGroupAddon align="inline-end">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <InputGroupButton
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          @click="showPassword = !showPassword"
                        >
                          <Eye v-if="!showPassword" class="h-4 w-4" />
                          <EyeOff v-else class="h-4 w-4" />
                        </InputGroupButton>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{{ showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน' }}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </InputGroupAddon>
              </InputGroup>
            </div>
            <Button type="submit" class="w-full mt-6" :disabled="isLoading">
              <Loader2 v-if="isLoading" class="mr-2 h-4 w-4 animate-spin" />
              {{ isLoading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ' }}
            </Button>
          </form>
        </CardContent>
      </Card>
      
      <!-- Footer -->
      <div class="mt-8 text-center text-xs text-muted-foreground">
        &copy; {{ new Date().getFullYear() }} Nan Hospital. All rights reserved.
      </div>
    </div>
  </div>
</template>
