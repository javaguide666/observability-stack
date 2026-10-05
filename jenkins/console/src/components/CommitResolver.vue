<script setup lang="ts">
import { computed } from 'vue'
import { useConsole } from '@/composables/useConsole'
import FieldLabel from './FieldLabel.vue'

const c = useConsole()

const EXAMPLES: { label: string; sha: string; tone?: 'bad' }[] = [
  { label: '多分支', sha: '3c9a41f07be2d8a15f6e0c4b92d7a1e5380f6b24' },
  { label: '仅 dev', sha: '7e12b8c4d95a60f3e1a7b2c8d4f09e63a5b17c80' },
  { label: '不存在', sha: '0'.repeat(40), tone: 'bad' },
  { label: '识别失败', sha: 'bad0c0ffee1234567890abcdef1234567890abcd', tone: 'bad' },
]

const tip = computed(
  () =>
    c.paramDefs.find((p) => p.name === 'GIT_SHA')?.description ??
    '完整 GIT_SHA（40 位）。点击开始构建部署时会先更新一次代码再核对是否存在',
)
const counter = computed(() => `${c.sha.length}/40`)
const state = computed(() => (c.shaError ? 'invalid' : c.shaValid ? 'valid' : 'empty'))
</script>

<template>
  <div class="resolver">
    <FieldLabel label="完整 GIT_SHA" param="GIT_SHA" :tip="tip" />
    <el-input
      :model-value="c.sha"
      placeholder="粘贴 40 位十六进制 SHA，例如 3c9a41f0…"
      clearable
      maxlength="64"
      :class="['sha-input', state]"
      spellcheck="false"
      @update:model-value="(v: string) => c.setSha(v)"
    >
      <template #prefix><el-icon><Key /></el-icon></template>
      <template #suffix><span class="counter" :class="state">{{ counter }}</span></template>
    </el-input>
    <p v-if="c.shaError" class="inline-err">
      <el-icon><CircleCloseFilled /></el-icon>{{ c.shaError }}
    </p>
    <p v-else class="hint">
      只需填写完整 GIT_SHA。点击「开始构建部署」会先更新一次代码，再核对仓库里是否存在该 GIT_SHA；不存在则不会构建。
    </p>

    <div class="examples">
      <span class="muted">示例：</span>
      <button v-for="e in EXAMPLES" :key="e.label" type="button" :class="e.tone" @click="c.setSha(e.sha)">
        {{ e.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.resolver {
  margin-top: 0;
}
.sha-input :deep(.el-input__inner) {
  font-family: var(--wc-font-mono);
  font-size: 13px;
}
.sha-input.invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--wc-bad) inset;
}
.sha-input.valid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--wc-ok) inset;
}
.counter {
  font-family: var(--wc-font-mono);
  font-size: 11px;
  color: var(--wc-muted);
}
.counter.invalid {
  color: var(--wc-bad);
}
.counter.valid {
  color: var(--wc-ok);
}
.inline-err {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--wc-bad);
}
.examples {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
}
.examples button {
  border: 1px dashed var(--wc-line);
  background: transparent;
  color: var(--wc-muted);
  border-radius: var(--wc-radius-pill);
  padding: 2px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.examples button:hover {
  color: var(--wc-accent);
  border-color: var(--wc-accent);
}
.examples button.bad:hover {
  color: var(--wc-bad);
  border-color: var(--wc-bad);
}
</style>
