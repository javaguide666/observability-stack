<script setup lang="ts">
import { computed } from 'vue'
import type { BuildResult } from '@/api'

const props = withDefaults(
  defineProps<{
    result?: BuildResult
    building?: boolean
    size?: number
  }>(),
  { result: null, building: false, size: 10 },
)

const kind = computed(() => {
  if (props.building) return 'building'
  if (props.result === 'SUCCESS') return 'ok'
  if (props.result === 'FAILURE') return 'bad'
  if (props.result === 'ABORTED' || props.result === 'UNSTABLE') return 'warn'
  return 'idle'
})
const label = computed(
  () =>
    ({ building: '构建中', ok: '成功', bad: '失败', warn: '已中止', idle: '暂无构建' })[kind.value],
)
</script>

<template>
  <span
    class="dot"
    :class="kind"
    :style="{ width: size + 'px', height: size + 'px' }"
    :title="label"
    role="img"
    :aria-label="label"
  />
</template>

<style scoped>
.dot {
  display: inline-block;
  flex: none;
  border-radius: 50%;
  background: var(--wc-idle);
}
.ok {
  background: var(--wc-ok);
  box-shadow: 0 0 0 3px rgba(61, 214, 140, 0.14);
}
.bad {
  background: var(--wc-bad);
  box-shadow: 0 0 0 3px rgba(240, 113, 120, 0.14);
}
.warn {
  background: var(--wc-warn);
  opacity: 0.7;
}
.building {
  background: var(--wc-warn);
  animation: wc-pulse 1.4s ease-out infinite;
}
</style>
