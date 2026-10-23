// Hedged request racing: start task #1; if it has not finished after `hedgeMs` (or it fails), start the next
// one WITHOUT cancelling the first. The first success wins. Cuts tail latency and survives dead/busy models.
export interface RaceTask<T> { name: string; run: () => Promise<T>; }
export interface RaceFailure { name: string; code: string; message: string; }

export function errorCode(err: any): string {
  if (err?.code === "timeout") return "timeout";
  const m = String(err?.message || err);
  return String(err?.status || m.match(/"code":\s*(\d{3})/)?.[1] || m.match(/\b(4\d\d|5\d\d)\b/)?.[1] || err?.code || "unknown");
}

export function hedgedRace<T>(
  tasks: RaceTask<T>[],
  opts: { hedgeMs: number; timeoutMs: number; onFail?: (f: RaceFailure) => void }
): Promise<{ value: T; name: string; failures: RaceFailure[] }> {
  return new Promise((resolve, reject) => {
    const failures: RaceFailure[] = [];
    let next = 0, pending = 0, done = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const launch = () => {
      if (done || next >= tasks.length) return;
      const t = tasks[next++];
      pending++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error(`Timeout of ${opts.timeoutMs}ms exceeded on ${t.name}`), { code: "timeout" })), opts.timeoutMs);
      });
      let p: Promise<T>;
      try { p = t.run(); } catch (e) { p = Promise.reject(e); }
      Promise.race([p, timeout]).then(
        (value) => {
          clearTimeout(timer);
          if (done) return;
          done = true; clearTimeout(hedgeTimer);
          resolve({ value, name: t.name, failures });
        },
        (err) => {
          clearTimeout(timer);
          pending--;
          const f = { name: t.name, code: errorCode(err), message: String(err?.message || err).slice(0, 200) };
          failures.push(f); opts.onFail?.(f);
          if (done) return;
          if (next < tasks.length) launch();
          else if (pending === 0) { done = true; clearTimeout(hedgeTimer); reject(Object.assign(new Error("all attempts failed"), { failures })); }
        }
      );
      if (next < tasks.length && !done) {
        clearTimeout(hedgeTimer);
        hedgeTimer = setTimeout(launch, opts.hedgeMs);
      }
    };
    if (tasks.length === 0) return reject(Object.assign(new Error("no tasks"), { failures }));
    launch();
  });
}

// Models that answered 404 ("no longer available") are skipped for a while so every request does not pay for them again.
export class DeadList {
  private until = new Map<string, number>();
  private ttlMs: number;
  constructor(ttlMs: number = 30 * 60 * 1000) { this.ttlMs = ttlMs; }
  mark(name: string) { this.until.set(name, Date.now() + this.ttlMs); }
  isDead(name: string) { const u = this.until.get(name); return !!u && u > Date.now(); }
  live<T extends { name: string }>(items: T[]): T[] {
    const alive = items.filter(i => !this.isDead(i.name));
    return alive.length ? alive : items; // if everything is marked dead, try them all again
  }
}
