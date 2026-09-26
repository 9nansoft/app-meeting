<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'vue-sonner'
import { useNuxtApp } from '#imports'

const { $api } = useNuxtApp()

type User = { id: number; username: string; role: string }

const users = ref<User[]>([])
const isLoading = ref(true)

// Add / Edit State
const isDialogOpen = ref(false)
const editingId = ref<number | null>(null)
const formData = ref({ username: '', role: 'user' })

async function fetchUsers() {
  isLoading.value = true
  const { data, error } = await $api.users.get()
  
  if (error) {
    if (error.status !== 401) {
      toast.error('Failed to load users')
    }
  } else {
    users.value = data || []
  }
  isLoading.value = false
}

function openAddDialog() {
  editingId.value = null
  formData.value = { username: '', role: 'user' }
  isDialogOpen.value = true
}

function openEditDialog(user: User) {
  editingId.value = user.id
  formData.value = { username: user.username, role: user.role }
  isDialogOpen.value = true
}

async function saveUser() {
  if (editingId.value) {
    // Update
    const { error } = await $api.users({ id: editingId.value.toString() }).put({
      username: formData.value.username,
      role: formData.value.role
    })
    
    if (error) {
      toast.error(error.value?.error || 'Failed to update user')
    } else {
      toast.success('User updated successfully')
      isDialogOpen.value = false
      await fetchUsers()
    }
  } else {
    // Create
    const { error } = await $api.users.post({
      username: formData.value.username,
      role: formData.value.role
    })
    
    if (error) {
      toast.error(error.value?.error || 'Failed to create user')
    } else {
      toast.success('User created successfully')
      isDialogOpen.value = false
      await fetchUsers()
    }
  }
}

async function deleteUser(id: number) {
  const { error } = await $api.users({ id: id.toString() }).delete()
  
  if (error) {
    toast.error(error.value?.error || 'Failed to delete user')
  } else {
    toast.success('User deleted')
    await fetchUsers()
  }
}

onMounted(() => {
  fetchUsers()
})

// Expose fetchUsers to parent so it can dictate re-fetching on login
defineExpose({ fetchUsers })
</script>

<template>
  <Card class="w-full">
    <CardHeader class="flex flex-row items-center justify-between pb-2">
      <div class="space-y-1">
        <CardTitle>Users Management</CardTitle>
        <CardDescription>
          CRUD interface connected to Elysia API endpoints (requires authentication).
        </CardDescription>
      </div>
      <div>
        <Dialog v-model:open="isDialogOpen">
          <DialogTrigger as-child>
            <Button @click="openAddDialog">Add User</Button>
          </DialogTrigger>
          <DialogContent class="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{{ editingId ? 'Edit User' : 'Create User' }}</DialogTitle>
              <DialogDescription>
                Make changes to the user profile here. Click save when you're done.
              </DialogDescription>
            </DialogHeader>
            <div class="grid gap-4 py-4">
              <div class="grid grid-cols-4 items-center gap-4">
                <Label for="username" class="text-right">Username</Label>
                <Input id="username" v-model="formData.username" class="col-span-3" />
              </div>
              <div class="grid grid-cols-4 items-center gap-4">
                <Label for="role" class="text-right">Role</Label>
                <Select v-model="formData.role">
                  <SelectTrigger class="col-span-3">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Administrator</SelectItem>
                    <SelectItem value="user">Standard User</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" @click="saveUser">Save changes</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </CardHeader>
    <CardContent>
      <div v-if="isLoading" class="space-y-2 mt-4">
        <Skeleton class="h-10 w-full" />
        <Skeleton class="h-10 w-full" />
        <Skeleton class="h-10 w-full" />
      </div>
      <div v-else-if="users.length === 0" class="text-center py-8 text-muted-foreground border rounded-md mt-4">
        No users found or unauthorized. Please log in first.
      </div>
      <Table v-else class="mt-4 border rounded-md overflow-hidden">
        <TableHeader class="bg-muted/50">
          <TableRow>
            <TableHead class="w-[100px]">ID</TableHead>
            <TableHead>Username</TableHead>
            <TableHead>Role</TableHead>
            <TableHead class="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="user in users" :key="user.id">
            <TableCell class="font-medium">{{ user.id }}</TableCell>
            <TableCell>{{ user.username }}</TableCell>
            <TableCell>
              <Badge :variant="user.role === 'admin' ? 'default' : 'secondary'">
                {{ user.role }}
              </Badge>
            </TableCell>
            <TableCell class="text-right space-x-2">
              <Button variant="outline" size="sm" @click="openEditDialog(user)">
                Edit
              </Button>
              <Button variant="destructive" size="sm" @click="deleteUser(user.id)" :disabled="user.username === 'admin'">
                Delete
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
</template>
