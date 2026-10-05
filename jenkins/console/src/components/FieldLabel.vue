<script setup lang="ts">
defineProps<{
  label: string
  /** Jenkins 参数名，显示为 code */
  param?: string
  /** 长说明，放在问号图标的提示里 */
  tip?: string
}>()
</script>

<template>
  <div class="field-label">
    <span class="name">{{ label }}</span>
    <code v-if="param" class="param">{{ param }}</code>
    <el-tooltip v-if="tip" :content="tip" placement="top" :show-after="150" effect="dark" popper-class="wc-tip">
      <el-icon class="help" tabindex="0"><QuestionFilled /></el-icon>
    </el-tooltip>
    <slot />
  </div>
</template>

<style scoped>
.field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--wc-muted);
}
.name {
  color: var(--wc-text);
  font-weight: 500;
}
.param {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--wc-chip-bg);
  color: var(--wc-muted);
  font-size: 11px;
}
.help {
  cursor: help;
  font-size: 15px;
  color: var(--wc-muted);
  outline: none;
}
.help:hover,
.help:focus-visible {
  color: var(--wc-accent);
}
</style>

<style>
.wc-tip {
  max-width: 320px;
  line-height: 1.55;
}
</style>
