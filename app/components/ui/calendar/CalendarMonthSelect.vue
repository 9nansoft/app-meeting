<script setup lang="ts">
import type { DateValue } from "reka-ui"
import { toDate, createYear } from "reka-ui/date"
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const props = defineProps<{
  date: DateValue,
  formatter: any
}>()

const emit = defineEmits<{
  (e: 'update:month', value: number): void
}>()
</script>

<template>
  <div class="**:data-[slot=native-select-icon]:right-1">
    <div class="relative">
      <div class="absolute inset-0 flex h-full items-center text-sm pl-2 pointer-events-none">
        {{ formatter.custom(toDate(date), { month: 'short' }) }}
      </div>
      <NativeSelect
        class="text-xs h-8 pr-6 pl-2 text-transparent relative"
        @change="(e: Event) => emit('update:month', Number((e.target as any).value))"
      >
        <NativeSelectOption v-for="(month) in createYear({ dateObj: date })" :key="month.toString()" :value="month.month" :selected="date.month === month.month">
          {{ formatter.custom(toDate(month), { month: 'short' }) }}
        </NativeSelectOption>
      </NativeSelect>
    </div>
  </div>
</template>
