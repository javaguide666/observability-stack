/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 说明：
// - base: './'：产物可放在 Jenkins userContent/wealth/ 任意子目录；
// - VITE_USE_MOCK 未设置时：`vite`(dev) 默认 mock，`vite build` 默认 real（见 src/api/index.ts）；
// - 开发代理：real 模式下把 Jenkins REST 转发到本机 Jenkins（docker compose 暴露的 18080）。
//   Jenkins 会话 Cookie 不区分端口，先在 http://localhost:18080 登录，再开 http://localhost:5173 即带登录态。
const JENKINS = process.env.VITE_JENKINS_URL || 'http://localhost:18080'

export default defineConfig({
  // 相对路径：产物可以放在 Jenkins userContent/wealth/ 任意子目录下
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/job': { target: JENKINS, changeOrigin: true },
      '/crumbIssuer': { target: JENKINS, changeOrigin: true },
      '/whoAmI': { target: JENKINS, changeOrigin: true },
      '/queue': { target: JENKINS, changeOrigin: true },
      // getJobs 用的 /api/json；登录引导页的 /login?from=… 在 dev 下也能走通
      '/api': { target: JENKINS, changeOrigin: true },
      '/login': { target: JENKINS, changeOrigin: true },
      // wfapi 在 /job/<名>/<n>/wfapi/ 下，已被 '/job' 覆盖
    },
  },
  build: {
    target: 'es2020',
    // 不把资源内联成 data: URI，也不生成内联脚本，兼容 Jenkins 默认 CSP
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
