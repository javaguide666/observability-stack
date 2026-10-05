import { mockApi } from './mock'
import { realApi } from './real'
import type { JenkinsApi } from './types'

/**
 * 是否使用 mock 假数据：
 *   VITE_USE_MOCK=true  -> mock
 *   VITE_USE_MOCK=false -> real（真实 Jenkins）
 *   未设置             -> dev 服务器默认 mock；生产构建（vite build）默认 real
 */
const flag = import.meta.env.VITE_USE_MOCK
export const USE_MOCK = flag === 'true' ? true : flag === 'false' ? false : import.meta.env.DEV

export const api: JenkinsApi = USE_MOCK ? mockApi : realApi

export * from './types'
export * from './constants'
export { LOGIN_URL } from './session'
