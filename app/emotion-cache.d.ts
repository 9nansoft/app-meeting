import type { EmotionCache } from '@emotion/cache'
import type { Emotion } from '@emotion/css/create-instance'

declare module '#app' {
  interface NuxtApp {
    $emotion: Emotion
    $emotionCache: EmotionCache
  }
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $emotion: Emotion
    $emotionCache: EmotionCache
  }
}

export {}
