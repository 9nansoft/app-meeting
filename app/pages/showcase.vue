<script setup lang="ts">
import { ref } from 'vue'
import { toast } from 'vue-sonner'

// Core Components
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// Overlays & Feedback
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'

// Data Display
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'

// Navigation
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Pagination, PaginationEllipsis, PaginationFirst, PaginationLast, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious } from '@/components/ui/pagination'

// Specialized
import { Calendar } from '@/components/ui/calendar'
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/components/ui/input-otp'
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from '@/components/ui/carousel'

// Icons
import { Icon } from '@iconify/vue'

// Wrapper
import ShowcaseSection from '@/components/ShowcaseSection.vue'

// Custom Elysia Components
import AuthShowcase from '@/components/AuthShowcase.vue'
import UsersCrud from '@/components/UsersCrud.vue'
import { useNuxtApp } from '#imports'

import { type DateValue } from 'reka-ui'
import { getLocalTimeZone, today } from '@internationalized/date'

const { $api } = useNuxtApp()

// Local State
const progressVal = ref(13)
const date = ref(today(getLocalTimeZone())) as Ref<DateValue>
const switchVal = ref(true)
const sliderVal = ref([50])
const otpVal = ref('')
const emotionCardClass = ref('')
const emotionPulseClass = ref('')

// Elysia Auth State
const currentUser = ref<{ id: number; username: string; role: string } | null>(null)
const crudTableRef = ref<InstanceType<typeof UsersCrud> | null>(null)

async function fetchMe() {
  const { data, error } = await $api.auth.me.get()
  if (error || !data?.user) {
    currentUser.value = null
  } else {
    currentUser.value = data.user
  }
  
  // Refresh CRUD table if it exists
  if (crudTableRef.value) {
    crudTableRef.value.fetchUsers()
  }
}

onMounted(() => {
  fetchMe()

  const emotion = useEmotion()
  const glow = emotion.keyframes({
    '0%, 100%': {
      boxShadow: '0 0 0 0 rgba(59, 130, 246, 0.35)'
    },
    '50%': {
      boxShadow: '0 0 0 12px rgba(59, 130, 246, 0)'
    }
  })

  emotionCardClass.value = emotion.css({
    borderRadius: '1rem',
    border: '1px solid hsl(var(--border))',
    background: 'linear-gradient(120deg, hsl(var(--card)) 0%, hsl(var(--muted) / 0.45) 100%)',
    padding: '1.25rem'
  })

  emotionPulseClass.value = emotion.css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    borderRadius: '9999px',
    border: '1px solid hsl(var(--primary) / 0.35)',
    padding: '0.375rem 0.75rem',
    color: 'hsl(var(--primary))',
    animation: `${glow} 2.2s ease-in-out infinite`
  })
})

setTimeout(() => { progressVal.value = 66 }, 1000)

function showToast() {
  toast('Event has been created', {
    description: 'Sunday, February 23, 2026 at 9:00 AM',
    action: { label: 'Undo', onClick: () => console.log('Undo') }
  })
}
</script>

<template>
  <div class="space-y-16">
    <!-- Hero Header -->
    <div class="flex flex-col items-center text-center space-y-6 py-16">
      <Badge variant="secondary" class="px-4 py-1.5 rounded-full text-sm">
        ✨ Beta Showcase
      </Badge>
      <h1 class="text-5xl md:text-7xl font-extrabold tracking-tighter">
        Build <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary to-blue-600">Beautiful</span> Interfaces.
      </h1>
      <p class="text-xl text-muted-foreground max-w-2xl">
        A comprehensive collection of Radix Vue components styled with Tailwind CSS. Accessible, customizable, and ready for production.
      </p>
      <div class="flex items-center gap-4 mt-8">
        <Button size="lg" class="rounded-full shadow-lg as-child">
          <a href="#components">View Components</a>
        </Button>
        <Button size="lg" variant="outline" class="rounded-full" @click="showToast">
          Trigger Toast
        </Button>
      </div>
    </div>

    <!-- Components Anchor -->
    <div id="components" class="scroll-m-24" />

    <!-- Section: Emotion -->
    <ShowcaseSection title="Emotion Runtime Styling" description="Generate scoped classes at runtime with the injected Emotion instance.">
      <div :class="emotionCardClass || 'rounded-2xl border p-5 bg-card'">
        <p class="text-sm text-muted-foreground mb-3">This block is styled from Emotion in onMounted.</p>
        <div :class="emotionPulseClass || 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm text-primary'">
          Runtime CSS active
        </div>
      </div>
    </ShowcaseSection>

    <!-- Section: Typography & Badges -->
    <ShowcaseSection title="Buttons & Badges" description="Essential interactive elements and status indicators.">
      <div class="flex flex-wrap gap-4 items-center">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button size="icon"><Icon icon="lucide:settings" class="w-4 h-4" /></Button>
        <Button disabled>
          <Icon icon="lucide:loader-2" class="w-4 h-4 mr-2 animate-spin" />
          Loading
        </Button>
      </div>
      <div class="flex flex-wrap gap-4 items-center mt-6">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge variant="outline">Outline</Badge>
      </div>
    </ShowcaseSection>

    <!-- Section: Inputs & Forms -->
    <ShowcaseSection title="Forms & Inputs" description="Components for capturing user input.">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8 lg:grid-cols-3">
        <!-- Text Input -->
        <div class="space-y-2">
          <Label for="email">Email Address</Label>
          <Input id="email" type="email" placeholder="m@example.com" />
          <p class="text-[0.8rem] text-muted-foreground">We won't share your email.</p>
        </div>

        <!-- Textarea -->
        <div class="space-y-2">
          <Label for="bio">Biography</Label>
          <Textarea id="bio" placeholder="Tell us about yourself..." />
        </div>

        <!-- Select -->
        <div class="space-y-2">
          <Label>Framework</Label>
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Select a framework" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Frontend</SelectLabel>
                <SelectItem value="nuxt">Nuxt</SelectItem>
                <SelectItem value="next">Next.js</SelectItem>
                <SelectItem value="svelte">SvelteKit</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <!-- Switches, Checkboxes, Radios -->
        <Card class="col-span-1 md:col-span-2 lg:col-span-1 bg-muted/20">
          <CardContent class="grid gap-6 pt-6">
            <div class="flex items-center space-x-2">
              <Switch id="airplane-mode" v-model:checked="switchVal" />
              <Label for="airplane-mode">Airplane Mode ({{ switchVal ? 'On' : 'Off' }})</Label>
            </div>
            
            <div class="flex items-center space-x-2">
              <Checkbox id="terms" />
              <Label for="terms" class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                Accept terms and conditions
              </Label>
            </div>

            <RadioGroup default-value="comfortable">
              <div class="flex items-center space-x-2">
                <RadioGroupItem id="r1" value="default" />
                <Label for="r1">Default View</Label>
              </div>
              <div class="flex items-center space-x-2">
                <RadioGroupItem id="r2" value="comfortable" />
                <Label for="r2">Comfortable View</Label>
              </div>
            </RadioGroup>
          </CardContent>
        </Card>

        <!-- Slider & OTP -->
        <div class="col-span-1 md:col-span-2 space-y-8">
          <div class="space-y-4">
            <Label>Volume: {{ sliderVal[0] }}%</Label>
            <Slider v-model="sliderVal" :max="100" :step="1" />
          </div>

          <div class="space-y-4">
            <Label>One-Time Password</Label>
            <InputOTP v-model="otpVal" :maxlength="6">
              <InputOTPGroup>
                <InputOTPSlot :index="0" />
                <InputOTPSlot :index="1" />
                <InputOTPSlot :index="2" />
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup>
                <InputOTPSlot :index="3" />
                <InputOTPSlot :index="4" />
                <InputOTPSlot :index="5" />
              </InputOTPGroup>
            </InputOTP>
          </div>
        </div>
      </div>
    </ShowcaseSection>

    <!-- Section: Overlays -->
    <ShowcaseSection title="Overlays & Dialogs" description="Popovers, dialogs, and contextual information.">
      <div class="flex flex-wrap gap-4 items-center">
        <!-- Alert Dialog -->
        <AlertDialog>
          <AlertDialogTrigger as-child>
            <Button variant="outline">Show Alert Dialog</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete your
                account and remove your data from our servers.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Continue</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <!-- Popover -->
        <Popover>
          <PopoverTrigger as-child>
            <Button variant="outline">Open Popover</Button>
          </PopoverTrigger>
          <PopoverContent class="w-80">
            <div class="grid gap-4">
              <div class="space-y-2">
                <h4 class="font-medium leading-none">Dimensions</h4>
                <p class="text-sm text-muted-foreground">Set the dimensions for the layer.</p>
              </div>
              <div class="grid gap-2">
                <div class="grid grid-cols-3 items-center gap-4">
                  <Label for="width">Width</Label>
                  <Input id="width" default-value="100%" class="col-span-2 h-8" />
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <!-- Hover Card -->
        <HoverCard>
          <HoverCardTrigger as-child>
            <Button variant="link">@vuejs</Button>
          </HoverCardTrigger>
          <HoverCardContent class="w-80">
            <div class="flex justify-between space-x-4">
              <Avatar>
                <AvatarImage src="https://github.com/vuejs.png" />
                <AvatarFallback>VJ</AvatarFallback>
              </Avatar>
              <div class="space-y-1">
                <h4 class="text-sm font-semibold">@vuejs</h4>
                <p class="text-sm">The Progressive JavaScript Framework.</p>
                <div class="flex items-center pt-2 gap-2 text-xs text-muted-foreground">
                  <Icon icon="lucide:calendar-days" class="w-4 h-4" />
                  Joined January 2014
                </div>
              </div>
            </div>
          </HoverCardContent>
        </HoverCard>

        <!-- Tooltip -->
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="outline" size="icon">
                <Icon icon="lucide:plus" class="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Add to library</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <!-- Alerts -->
      <div class="grid gap-4 mt-8 md:grid-cols-2">
        <Alert>
          <Icon icon="lucide:terminal" class="h-4 w-4" />
          <AlertTitle>Heads up!</AlertTitle>
          <AlertDescription>
            You can add components to your app using the cli.
          </AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <Icon icon="lucide:triangle-alert" class="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Your session has expired. Please log in again.
          </AlertDescription>
        </Alert>
      </div>
    </ShowcaseSection>

    <!-- Section: Data Display -->
    <ShowcaseSection title="Data Display" description="Components for presenting information clearly.">
      <div class="grid md:grid-cols-2 gap-8">
        
        <!-- Accordion & Scroll Area -->
        <Card>
          <CardHeader>
            <CardTitle>FAQ</CardTitle>
            <CardDescription>Frequently asked questions</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea class="h-64 w-full pr-4">
              <Accordion type="single" collapsible class="w-full">
                <AccordionItem value="item-1">
                  <AccordionTrigger>Is it accessible?</AccordionTrigger>
                  <AccordionContent>Yes. It adheres to the WAI-ARIA design pattern.</AccordionContent>
                </AccordionItem>
                <AccordionItem value="item-2">
                  <AccordionTrigger>Is it styled?</AccordionTrigger>
                  <AccordionContent>Yes. It comes with default styles that match the other components' aesthetic.</AccordionContent>
                </AccordionItem>
                <AccordionItem value="item-3">
                  <AccordionTrigger>Is it animated?</AccordionTrigger>
                  <AccordionContent>Yes. It's animated by default, but you can disable it if you prefer.</AccordionContent>
                </AccordionItem>
              </Accordion>
            </ScrollArea>
          </CardContent>
        </Card>

        <!-- Complex Card -->
        <Card>
          <CardHeader>
            <CardTitle>Create project</CardTitle>
            <CardDescription>Deploy your new project in one-click.</CardDescription>
          </CardHeader>
          <CardContent>
            <form>
              <div class="grid items-center w-full gap-4">
                <div class="flex flex-col space-y-1.5">
                  <Label for="name">Name</Label>
                  <Input id="name" placeholder="Name of your project" />
                </div>
                <div class="flex flex-col space-y-1.5">
                  <Label for="framework">Framework</Label>
                  <Select>
                    <SelectTrigger id="framework">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="nuxt">Nuxt.js</SelectItem>
                      <SelectItem value="sveltekit">SvelteKit</SelectItem>
                      <SelectItem value="astro">Astro</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </form>
          </CardContent>
          <CardFooter class="flex justify-between">
            <Button variant="outline">Cancel</Button>
            <Button>Deploy</Button>
          </CardFooter>
        </Card>
      </div>
      
      <!-- Progress & Skeleton -->
      <div class="grid md:grid-cols-2 gap-8 mt-8">
        <div class="space-y-4">
          <Label>System Update Progress</Label>
          <Progress :model-value="progressVal" />
          <p class="text-sm text-muted-foreground">{{ progressVal }}% completed</p>
        </div>
        
        <div class="space-y-4">
          <Label>Skeleton Loading State</Label>
          <div class="flex items-center space-x-4">
            <Skeleton class="h-12 w-12 rounded-full" />
            <div class="space-y-2">
              <Skeleton class="h-4 w-[250px]" />
              <Skeleton class="h-4 w-[200px]" />
            </div>
          </div>
        </div>
      </div>
    </ShowcaseSection>

    <!-- Section: Advanced -->
    <ShowcaseSection title="Advanced Interactions" description="Complex components with rich interactivity.">
      <div class="grid lg:grid-cols-2 gap-8 items-start">
        
        <!-- Tabs & Pagination -->
        <div class="space-y-8">
          <Tabs default-value="account" class="w-[400px]">
            <TabsList class="grid w-full grid-cols-2">
              <TabsTrigger value="account">Account</TabsTrigger>
              <TabsTrigger value="password">Password</TabsTrigger>
            </TabsList>
            <TabsContent value="account">
              <Card>
                <CardHeader>
                  <CardTitle>Account</CardTitle>
                  <CardDescription>Make changes to your account here. Click save when you're done.</CardDescription>
                </CardHeader>
                <CardContent class="space-y-2">
                  <div class="space-y-1">
                    <Label for="name">Name</Label>
                    <Input id="name" default-value="Pedro Duarte" />
                  </div>
                </CardContent>
                <CardFooter>
                  <Button>Save changes</Button>
                </CardFooter>
              </Card>
            </TabsContent>
            <TabsContent value="password">
              <Card>
                <CardHeader>
                  <CardTitle>Password</CardTitle>
                  <CardDescription>Change your password here.</CardDescription>
                </CardHeader>
                <CardContent class="space-y-2">
                  <div class="space-y-1">
                    <Label for="current">Current password</Label>
                    <Input id="current" type="password" />
                  </div>
                </CardContent>
                <CardFooter>
                  <Button>Save password</Button>
                </CardFooter>
              </Card>
            </TabsContent>
          </Tabs>
          
          <Pagination v-slot="{ page }" :total="100" :items-per-page="10" :sibling-count="1" show-edges :default-page="2">
            <PaginationContent v-slot="{ items }" class="flex items-center gap-1">
              <PaginationFirst />
              <PaginationPrevious />
              <template v-for="(item, index) in items">
                <PaginationItem v-if="item.type === 'page'" :key="index" :value="item.value" as-child>
                  <Button class="w-9 h-9 p-0" :variant="item.value === page ? 'default' : 'outline'">
                    {{ item.value }}
                  </Button>
                </PaginationItem>
                <PaginationEllipsis v-else :key="item.type" :index="index" />
              </template>
              <PaginationNext />
              <PaginationLast />
            </PaginationContent>
          </Pagination>
        </div>

        <!-- Carousel & Calendar -->
        <div class="space-y-8">
          <div>
            <Label class="mb-4 block">Calendar Widget</Label>
            <Calendar v-model="date" class="border rounded-md w-fit inline-block bg-card text-card-foreground shadow-sm" />
          </div>

          <div class="px-12">
            <Label class="mb-4 block">Carousel</Label>
            <Carousel class="w-full max-w-xs">
              <CarouselContent>
                <CarouselItem v-for="(_, index) in 5" :key="index">
                  <div class="p-1">
                    <Card>
                      <CardContent class="flex aspect-square items-center justify-center p-6">
                        <span class="text-4xl font-semibold">{{ index + 1 }}</span>
                      </CardContent>
                    </Card>
                  </div>
                </CarouselItem>
              </CarouselContent>
              <CarouselPrevious />
              <CarouselNext />
            </Carousel>
          </div>
        </div>

      </div>
    </ShowcaseSection>

    <!-- Section: Elysia Integration -->
    <ShowcaseSection title="Elysia Full-Stack Integration" description="Showcasing end-to-end type safety, Cookie Auth, and CRUD operations with Elysia & Nuxt via Eden Treaty.">
      <div class="grid lg:grid-cols-12 gap-8 items-start">
        <div class="lg:col-span-4">
          <AuthShowcase :current-user="currentUser" @logged-in="fetchMe" />
        </div>
        <div class="lg:col-span-8">
          <UsersCrud ref="crudTableRef" />
        </div>
      </div>
    </ShowcaseSection>

    <!-- Footer -->
    <footer class="py-6 flex items-center justify-center text-sm text-muted-foreground border-t border-border mt-16">
      Built with ❤️ using Nuxt, Elysia, and Shadcn-Vue.
    </footer>
  </div>
</template>
