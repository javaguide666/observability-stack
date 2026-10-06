import { describe, expect, it } from 'vitest'
import { splitLogLine } from './logline'

describe('splitLogLine', () => {
  it('把 UTC 行首时间转成本地 HH:mm:ss', () => {
    const row = splitLogLine('[2026-10-05T23:09:22.849Z] ==> STAGE 1/4 checkout')
    const expected = new Date('2026-10-05T23:09:22.849Z').toLocaleTimeString('sv-SE', { hour12: false })
    expect(row.time).toBe(expected)
    expect(row.text).toBe('==> STAGE 1/4 checkout')
  })

  it('没有时间戳的行只留正文，并去掉 ha://// 书签', () => {
    expect(splitLogLine('Finished: SUCCESS ha:////abcd')).toEqual({ time: '', text: 'Finished: SUCCESS' })
  })
})