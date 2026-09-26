<script setup lang="ts">
import type { DateValue } from "reka-ui"
import { toDate } from "reka-ui/date"
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const props = defineProps<{
  date: DateValue,
  yearRange: DateValue[],
  formatter: any
}>()

const emit = defineEmits<{
  (e: 'update:year', value: number): void
}>()
</script>

<template>
  <div class="**:data-[slot=native-select-icon]:right-1">
    <div class="relative">
      <div class="absolute inset-0 flex h-full items-center text-sm pl-2 pointer-events-none">
        {{ formatter.custom(toDate(date), { year: 'numeric' }) }}
      </div>
      <NativeSelect
        class="text-xs h-8 pr-6 pl-2 text-transparent relative"
        @change="(e: Event) => emit('update:year', Number((e.target as any).value))"
      >
        <NativeSelectOption v-for="(yearObj) in yearRange" :key="yearObj.toString()" :value="yearObj.year" :selected="date.year === yearObj.year">
          {{ formatter.custom(toDate(yearObj), { year: 'numeric' }) }}
        </NativeSelectOption>
      </NativeSelect>
    </div>
  </div>
</template>
