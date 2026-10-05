<script setup lang="ts">
import { ref } from 'vue'
import { LOGIN_URL } from '@/api'
import { useConsole } from '@/composables/useConsole'

const c = useConsole()
const checking = ref(false)

async function recheck() {
  checking.value = true
  try {
    await c.init()
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <section class="login-required" data-testid="login-required" role="alert">
    <div class="wc-card box">
      <div class="icon"><el-icon><Lock /></el-icon></div>
      <h2>请先登录 Jenkins</h2>
      <p class="lead">
        <template v-if="c.sessionExpired">登录会话已过期。</template>
        <template v-else>没有检测到 Jenkins 登录状态。</template>
        控制台与 Jenkins 同源，直接使用你在 Jenkins 的登录会话，本页不会保存任何账号或令牌。
      </p>
      <ol class="steps">
        <li>点击下方按钮，在 Jenkins 登录页完成登录；</li>
        <li>登录成功后会自动回到本控制台（<code>/userContent/wealth/</code>）；</li>
        <li>如果没有自动回来，回到本页点「我已登录，重新检测」。</li>
      </ol>
      <div class="actions">
        <el-button type="primary" size="large" tag="a" :href="LOGIN_URL">
          <el-icon><Right /></el-icon>前往登录 Jenkins
        </el-button>
        <el-button size="large" :loading="checking" @click="recheck">我已登录，重新检测</el-button>
      </div>
      <p class="path muted">登录入口：<a :href="LOGIN_URL">{{ LOGIN_URL }}</a></p>
    </div>
  </section>
</template>

<style scoped>
.login-required {
  display: grid;
  place-items: start center;
  padding: 72px 20px;
}
.box {
  width: min(560px, 100%);
  padding: 32px 36px 28px;
  text-align: center;
}
.icon {
  width: 56px;
  height: 56px;
  margin: 0 auto 16px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 26px;
  color: var(--wc-warn);
  background: var(--wc-warn-bg);
}
h2 {
  margin: 0 0 10px;
  font-size: 22px;
  font-weight: 600;
}
.lead {
  margin: 0 0 18px;
  color: var(--wc-muted);
  line-height: 1.7;
}
.steps {
  margin: 0 auto 24px;
  padding: 14px 18px 14px 36px;
  text-align: left;
  line-height: 1.9;
  font-size: 13px;
  border: 1px solid var(--wc-line);
  border-radius: var(--wc-radius-md);
  background: var(--wc-bg);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
.path {
  margin: 18px 0 0;
  font-size: 12px;
}
</style>
