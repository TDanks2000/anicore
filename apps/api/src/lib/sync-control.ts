import {
  acknowledgeSyncMonitorControlState,
  readSyncMonitorControlState,
  type SyncMonitor,
} from "./sync-monitor";

export class SyncStoppedError extends Error {
  constructor() {
    super("Sync stopped by monitor request");
  }
}

/** Observe controls even while a batch is waiting on a provider or rate limit. */
export class SyncControl {
  private timer: ReturnType<typeof setInterval>;
  private monitor: SyncMonitor | null = null;
  private paused = false;
  private abort = new AbortController();

  constructor(private readonly pollMs = 100) {
    this.timer = setInterval(() => this.poll(), pollMs);
    this.timer.unref();
    this.poll();
  }

  get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  attach(monitor: SyncMonitor): void {
    this.monitor = monitor;
    if (this.stopped) monitor.stopping();
    else if (this.paused) monitor.pause();
    this.poll();
  }

  private poll(): void {
    const control = readSyncMonitorControlState();
    if (control.command === "stop") {
      if (!this.stopped) {
        this.abort.abort(new SyncStoppedError());
        this.monitor?.stopping(control.message ?? undefined);
      }
    } else if (!this.stopped && control.command === "pause") {
      if (!this.paused) {
        this.paused = true;
        this.monitor?.pause(control.message ?? undefined);
      }
    } else if (!this.stopped && this.paused) {
      this.paused = false;
      this.monitor?.resume(control.message ?? undefined);
    }
    if (control.command && !control.acknowledgedAt) acknowledgeSyncMonitorControlState();
  }

  async waitForRelease(): Promise<boolean> {
    this.poll();
    while (this.paused && !this.stopped) {
      await Bun.sleep(this.pollMs);
      this.poll();
    }
    return !this.stopped;
  }

  async sleep(milliseconds: number): Promise<void> {
    const deadline = Date.now() + milliseconds;
    do {
      if (!(await this.waitForRelease())) throw new SyncStoppedError();
      await Bun.sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    if (!(await this.waitForRelease())) throw new SyncStoppedError();
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
