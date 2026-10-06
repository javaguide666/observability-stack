/** Jenkins timestamps() 写在行首的 UTC 时间，界面改成本地 HH:mm:ss */
const LINE_TS = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s?([\s\S]*)$/

export function splitLogLine(raw: string): { time: string; text: string } {
  const text0 = raw.replace(/ha:\/\/\/\/\S*/g, '').replace(/[ \t]+$/g, '')
  const m = text0.match(LINE_TS)
  if (!m) return { time: '', text: text0 }
  const d = new Date(m[1])
  if (Number.isNaN(d.getTime())) return { time: '', text: text0 }
  const time = d.toLocaleTimeString('sv-SE', { hour12: false })
  return { time, text: m[2] }
}
