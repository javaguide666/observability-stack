<script setup lang="ts">
import { computed } from 'vue'
import { OVERLAYS, SOURCES, type Overlay, type Source } from '@/api'
import { useConsole } from '@/composables/useConsole'
import FieldLabel from './FieldLabel.vue'

defineProps<{ showSource?: boolean; showSkip?: boolean }>()
const c = useConsole()

function tip(name: string, fallback: string): string {
  return c.paramDefs.find((p) => p.name === name)?.description ?? fallback
}
const registryTip = computed(() => tip('REGISTRY', '镜像仓库前缀。本机 Desktop 留空；测试/生产填如 registry.example.com/wealth'))
</script>

<template>
  <div class="fields">
    <div class="col">
      <FieldLabel label="部署环境" param="OVERLAY" :tip="tip('OVERLAY', '部署环境：dev / test / prod / local')" />
      <el-segmented
        :model-value="c.overlay"
        :options="OVERLAYS.map((o) => ({ label: o, value: o }))"
        @update:model-value="(v: string | number | boolean) => (c.overlay = v as Overlay)"
      />
    </div>

    <div v-if="showSource" class="col">
      <FieldLabel label="代码来源" param="SOURCE" :tip="tip('SOURCE', 'github=clone/fetch；local-mount=用 /gitee 挂载仓，不会切换分支/SHA')" />
      <el-segmented
        :model-value="c.source"
        :options="SOURCES.map((o) => ({ label: o, value: o }))"
        @update:model-value="(v: string | number | boolean) => (c.source = v as Source)"
      />
    </div>
  </div>

  <div v-if="showSkip && c.current.java && c.current.supportsCommit" class="only-mod">
    <el-checkbox v-model="c.onlyCurrentModule" :disabled="c.skipMvn">只构建当前模块</el-checkbox>
    <p class="hint">
      默认勾选：Maven 只打包本模块，依赖用本地已 install 的 jar。取消勾选则连同 common 等一起全量编译。
    </p>
  </div>

  <div class="advanced">
    <button type="button" class="adv-toggle" :aria-expanded="c.registryOpen" @click="c.registryManualOpen = !c.registryManualOpen">
      <el-icon class="chev" :class="{ open: c.registryOpen }"><ArrowRight /></el-icon>
      高级
      <span class="muted">REGISTRY<template v-if="showSkip && c.current.java"> · SKIP_MVN</template></span>
      <span v-if="c.registryRequired" class="req">{{ c.overlay }} 需要填写</span>
    </button>
    <el-collapse-transition>
      <div v-show="c.registryOpen" class="adv-body">
        <FieldLabel label="镜像仓库前缀" param="REGISTRY" :tip="registryTip" />
        <el-input
          v-model="c.registry"
          :class="{ need: c.registryRequired && !c.registry.trim() }"
          placeholder="registry.example.com/wealth"
          clearable
          spellcheck="false"
        />
        <p v-if="c.registryRequired" class="hint">{{ c.overlay }} 环境需填写仓库前缀，构建后会 docker push 并以全名 set image。</p>
        <div v-if="showSkip && c.current.java" class="skip">
          <el-switch v-model="c.skipMvn" />
          <FieldLabel label="跳过 Maven" param="SKIP_MVN" :tip="tip('SKIP_MVN', '跳过 Maven（仅重打镜像，需已有 jar）')" />
        </div>
      </div>
    </el-collapse-transition>
  </div>
</template>

<style scoped>
.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 20px 32px;
  margin-top: 20px;
}
.col {
  min-width: 0;
}
.only-mod {
  margin-top: 16px;
}
.only-mod .hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--wc-muted);
  line-height: 1.5;
}
.advanced {
  margin-top: 16px;
  border-top: 1px dashed var(--wc-line);
  padding-top: 12px;
}
.adv-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: 0;
  color: var(--wc-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  padding: 2px 0;
}
.adv-toggle .muted {
  font-size: 12px;
  font-family: var(--wc-font-mono);
}
.chev {
  transition: transform 0.2s;
}
.chev.open {
  transform: rotate(90deg);
}
.req {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: var(--wc-radius-pill);
  background: var(--wc-warn-bg);
  color: var(--wc-warn);
}
.adv-body {
  padding-top: 12px;
  max-width: 520px;
}
.need :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--wc-warn) inset;
}
.skip {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}
.skip :deep(.field-label) {
  margin: 0;
}
</style>
