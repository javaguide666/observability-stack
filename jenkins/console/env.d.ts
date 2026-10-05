/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 是否使用 mock 假数据。未设置时：dev 默认 true，生产构建默认 false；显式 "true"/"false" 优先 */
  readonly VITE_USE_MOCK?: string
  /** mock 偶发失败概率 0~1，默认 0.08 */
  readonly VITE_MOCK_FAIL_RATE?: string
  /** Jenkins 基础路径（real 模式），默认空 = 同源 */
  readonly VITE_JENKINS_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
