<script setup lang="ts">
import { computed } from 'vue'
import type { HistoryItem } from '@/api'
import { useConsole } from '@/composables/useConsole'
import { fullTime, shortSha } from '@/utils/format'

const props = defineProps<{ modelValue: boolean; item: HistoryItem | null; busy?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; confirm: [] }>()
const c = useConsole()

const runningTag = computed(() => c.history.find((h) => h.running)?.imageTag ?? '—')
const isProd = computed(() => c.overlay === 'prod')
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})
</script>

<template>
  <el-dialog v-model="open" title="确认回滚到历史版本" width="520px" align-center append-to-body :close-on-click-modal="false">
    <div v-if="item" class="body">
      <p class="lead">
        将模块 <strong>{{ c.current.title }}</strong> 切换到下列镜像版本。<br />
        <span class="muted">不拉代码、不重新编译，只执行 <code>kubectl set image</code> + <code>rollout status</code>，通常几十秒完成。</span>
      </p>

      <dl class="kv">
        <dt>目标模块</dt>
        <dd>{{ c.current.title }} <code>{{ c.current.job }}</code></dd>
        <dt>IMAGE_TAG</dt>
        <dd><code class="hl">{{ item.imageTag }}</code></dd>
        <dt>完整 SHA</dt>
        <dd><code class="sha">{{ item.sha || '无 SHA' }}</code> <span v-if="item.sha" class="muted">（{{ shortSha(item.sha) }}）</span></dd>
        <dt>分支 / 构建</dt>
        <dd>{{ item.branch || '—' }} · #{{ item.number }} · {{ fullTime(item.timestamp) }}</dd>
        <dt>部署环境</dt>
        <dd>
          <span class="env" :class="{ prod: isProd }">{{ c.overlay }}</span>
          <span v-if="c.registry" class="muted"> · {{ c.registry }}</span>
        </dd>
        <dt>当前运行（推断）</dt>
        <dd><code>{{ runningTag }}</code> <span class="muted">→</span> <code class="hl">{{ item.imageTag }}</code></dd>
      </dl>

      <el-alert
        v-if="isProd"
        type="error"
        :closable="false"
        show-icon
        title="目标环境是 prod：回滚会立即影响线上服务。"
      />
      <p class="mode-line muted">将触发 <code>MODE=rollback</code> · <code>IMAGE_TAG={{ item.imageTag }}</code></p>
    </div>

    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button :type="isProd ? 'danger' : 'primary'" :loading="busy" @click="emit('confirm')">
        确认回滚{{ isProd ? '（PROD）' : '' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.lead {
  margin: 0 0 16px;
  line-height: 1.7;
}
.kv {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 10px 12px;
  margin: 0 0 16px;
  padding: 14px 16px;
  background: var(--wc-bg);
  border: 1px solid var(--wc-line);
  border-radius: var(--wc-radius-md);
  font-size: 13px;
}
.kv dt {
  color: var(--wc-muted);
}
.kv dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
code {
  font-family: var(--wc-font-mono);
  font-size: 12px;
}
.hl {
  color: var(--wc-accent);
  font-weight: 600;
}
.sha {
  color: var(--wc-text);
}
.env {
  padding: 1px 10px;
  border-radius: var(--wc-radius-pill);
  background: var(--wc-chip-bg);
  font-size: 12px;
}
.env.prod {
  background: var(--wc-bad-bg);
  color: var(--wc-bad);
  font-weight: 600;
}
.mode-line {
  margin: 12px 0 0;
  font-size: 12px;
}
</style>
