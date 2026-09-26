import createEmotion from '@emotion/css/create-instance'

export default defineNuxtPlugin(() => {
  const emotion = createEmotion({
    key: 'es',
    prepend: true
  })

  return {
    provide: {
      emotion,
      emotionCache: emotion.cache
    }
  }
})
