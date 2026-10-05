/**
 * 会话事件：real.ts 在确认「未登录 / 会话过期」时通知界面层（useConsole），
 * 由界面层重新检测 whoAmI 并展示「请先登录 Jenkins」引导。mock 不会触发。
 */
let handler: (() => void) | null = null

export function setAuthLostHandler(fn: (() => void) | null): void {
  handler = fn
}

export function notifyAuthLost(): void {
  handler?.()
}

/** 登录页（登录后回到控制台） */
export const LOGIN_URL = '/login?from=/userContent/wealth/'
