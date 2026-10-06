<script setup lang="ts">
import { computed } from 'vue'
import { useConsole } from '@/composables/useConsole'
import { shortSha } from '@/utils/format'

const props = defineProps<{ modelValue: boolean; busy?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; confirm: [] }>()
const c = useConsole()

const isProd = computed(() => c.overlay === 'prod')
const byCommit = computed(() => c.flow === 'commit')
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})
</script>

<template>
  <el-dialog v-model="open" title="确认构建部署" width="520px" align-center append-to-body :close-on-click-modal="false">
    <div class="body">
      <p class="lead">
        即将构建 <strong>{{ c.current.title }}</strong> 并滚动更新到
        <span class="env" :class="{ prod: isProd }">{{ c.overlay }}</span>。<br />
        <span class="muted">确认后才会提交 Jenkins，取消不会产生任何构建。</span>
      </p>

      <dl class="kv">
        <dt>目标模块</dt>
        <dd>{{ c.current.title }} <code>{{ c.current.job }}</code></dd>
        <template v-if="byCommit">
          <dt>完整 SHA</dt>
          <dd>
            <code class="sha">{{ c.sha }}</code>
            <span v-if="c.sha.length === 40" class="muted">（{{ shortSha(c.sha) }}）</span>
          </dd>
        </template>
        <template v-else>
          <dt>分支</dt>
          <dd><code class="hl">{{ c.branch || '—' }}</code></dd>
        </template>
        <dt>部署环境</dt>
        <dd>
          <span class="env" :class="{ prod: isProd }">{{ c.overlay }}</span>
          <span v-if="c.registry" class="muted"> · {{ c.registry }}</span>
        </dd>
        <dt>代码来源</dt>
        <dd><code>{{ c.source }}</code></dd>
        <template v-if="c.current.java && c.skipMvn">
          <dt>Maven</dt>
          <dd>跳过编译（SKIP_MVN）</dd>
        </template>
        <template v-else-if="c.current.java && c.current.supportsCommit">
          <dt>Maven</dt>
          <dd>{{ c.onlyCurrentModule ? '只构建当前模块' : '全量依赖（-am）' }}</dd>
        </template>
      </dl>

      <el-alert
        v-if="isProd"
        type="error"
        :closable="false"
        show-icon
        title="目标环境是 prod：构建完成后会立即滚动更新线上服务。"
      />
      <p class="mode-line muted">
        将触发 <code>MODE=build-deploy</code>
        <template v-if="byCommit"> · <code>GIT_SHA={{ c.sha }}</code></template>
        <template v-else> · <code>BRANCH={{ c.branch }}</code></template>
        · <code>OVERLAY={{ c.overlay }}</code>
      </p>
    </div>

    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button :type="isProd ? 'danger' : 'primary'" :loading="busy" @click="emit('confirm')">
        确认构建部署{{ isProd ? '（PROD）' : '' }}
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
