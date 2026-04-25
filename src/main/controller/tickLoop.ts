export type TickCallback = (now: number) => void

export class TickLoop {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly callbacks: TickCallback[] = []

  start(): void {
    if (this.timer) return
    // 60fps ≈ 16ms intervals; performance.now() for sub-millisecond timing
    this.timer = setInterval(() => {
      const now = performance.now()
      for (const cb of this.callbacks) {
        cb(now)
      }
    }, 16)
    // Allow Node to exit even if this interval is active
    if (this.timer.unref) this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  add(cb: TickCallback): void {
    this.callbacks.push(cb)
  }

  remove(cb: TickCallback): void {
    const idx = this.callbacks.indexOf(cb)
    if (idx !== -1) this.callbacks.splice(idx, 1)
  }
}
