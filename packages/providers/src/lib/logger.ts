// Pure ANSI terminal logger with animated in-place progress bars.
// Zero external dependencies — raw escape sequences only.

const IS_TTY = Boolean(process.stdout.isTTY);

// ── ANSI palette ──────────────────────────────────────────────────────────────

const R = '\x1b[0m';

export const A = {
  bold:          '\x1b[1m',
  dim:           '\x1b[2m',
  red:           '\x1b[31m',
  green:         '\x1b[32m',
  yellow:        '\x1b[33m',
  blue:          '\x1b[34m',
  magenta:       '\x1b[35m',
  cyan:          '\x1b[36m',
  gray:          '\x1b[90m',
  brightRed:     '\x1b[91m',
  brightGreen:   '\x1b[92m',
  brightYellow:  '\x1b[93m',
  brightBlue:    '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan:    '\x1b[96m',
  brightWhite:   '\x1b[97m',
} as const;

/** Wrap `text` in ANSI codes. No-op when stdout is not a TTY. */
export const paint = (text: string, ...codes: string[]): string =>
  IS_TTY ? `${codes.join('')}${text}${R}` : text;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

let _bar: ProgressBar | null = null;

const BAR_FILLED = '█';
const BAR_EMPTY  = '░';
const BAR_WIDTH  = 24;

export type ProgressStats = Record<string, string | number>;

export class ProgressBar {
  private n      = 0;
  private start  = Date.now();
  private ticks: number[] = [];
  private _stage = '';
  private _stats: ProgressStats = {};
  private _drawn = false;

  constructor(private readonly total: number, private readonly label = '') {
    _bar = this;
    if (IS_TTY) this._draw();
  }

  tick(n = 1): this {
    this.ticks.push(Date.now());
    if (this.ticks.length > 30) this.ticks.shift();
    const prev = this.n;
    this.n = Math.min(this.n + n, this.total);

    if (!IS_TTY) {
      if (this.n !== prev && (this.n % 50 === 0 || this.n === this.total)) this._fallback();
      return this;
    }
    this._draw();
    return this;
  }

  setStage(stage: string): this {
    this._stage = stage;
    if (IS_TTY && this._drawn) this._draw();
    return this;
  }

  setStats(stats: ProgressStats): this {
    Object.assign(this._stats, stats);
    if (IS_TTY && this._drawn) this._draw();
    return this;
  }

  clear(): void {
    if (!IS_TTY || !this._drawn) return;
    process.stdout.write('\r\x1b[2K');
    this._drawn = false;
  }

  /** Redraw — also used by writeLog after printing a message. */
  redraw(): void {
    if (IS_TTY) this._draw();
  }

  finish(msg?: string): void {
    this.clear();
    _bar = null;
    if (msg) log.success(msg);
  }

  private _draw(): void {
    if (!IS_TTY) return;
    if (this._drawn) process.stdout.write('\r\x1b[2K');

    const { n, total, _stage, _stats, label } = this;
    const pct    = total > 0 ? n / total : 0;
    const filled = Math.round(pct * BAR_WIDTH);
    const barStr = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
    const bar    = paint(`[${barStr}]`, pct >= 1 ? A.brightGreen : A.cyan);
    const pctStr = paint(`${String(Math.floor(pct * 100)).padStart(3)}%`, A.brightYellow);
    const prog   = paint(String(n), A.brightWhite)
                 + paint('/', A.dim)
                 + paint(String(total), A.gray);

    let etaPart = '';
    if (this.ticks.length >= 2) {
      const span   = this.ticks[this.ticks.length - 1]! - this.ticks[0]!;
      const msPerN = span / (this.ticks.length - 1);
      etaPart = `  ${paint('ETA', A.dim)} ${paint(fmtDuration((total - n) * msPerN), A.brightCyan)}`;
    }

    const stagePart = _stage
      ? `  ${paint('▶', A.brightMagenta)} ${paint(_stage, A.magenta)}`
      : '';

    const statsPart = Object.keys(_stats).length > 0
      ? '  ' + Object.entries(_stats)
          .map(([k, v]) => `${paint(k, A.gray)}=${paint(String(v), A.brightWhite)}`)
          .join(' ')
      : '';

    const elapsed = paint(` +${fmtDuration(Date.now() - this.start)}`, A.dim);
    const lbl     = label ? paint(`${label} `, A.bold) : '';

    process.stdout.write(
      `${lbl}${bar} ${pctStr}  ${prog}${stagePart}${statsPart}${etaPart}${elapsed}`,
    );
    this._drawn = true;
  }

  private _fallback(): void {
    const pct   = this.total > 0 ? Math.floor((this.n / this.total) * 100) : 0;
    const stats = Object.entries(this._stats).map(([k, v]) => `${k}=${v}`).join(' ');
    process.stdout.write(`[${pct}%] ${this.n}/${this.total}  ${stats}\n`);
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────

type Level = 'debug' | 'info' | 'success' | 'warn' | 'error';

const LEVEL_CFG: Record<Level, { icon: string; color: string; textColor: string }> = {
  debug:   { icon: '○', color: A.gray,          textColor: A.dim         },
  info:    { icon: '◆', color: A.brightCyan,    textColor: A.brightWhite },
  success: { icon: '✔', color: A.brightGreen,   textColor: A.brightGreen },
  warn:    { icon: '⚠', color: A.brightYellow,  textColor: A.yellow      },
  error:   { icon: '✖', color: A.brightRed,     textColor: A.red         },
};

function writeLog(level: Level, ns: string | undefined, msg: string): void {
  const bar = _bar;
  bar?.clear();

  const cfg  = LEVEL_CFG[level];
  const time = paint(fmtTime(), A.dim);
  const icon = paint(` ${cfg.icon} `, cfg.color, A.bold);
  const pfx  = ns ? paint(`[${ns}] `, A.magenta, A.dim) : '';
  const text = paint(msg, cfg.textColor);

  process.stdout.write(`${time}${icon}${pfx}${text}\n`);

  if (bar && _bar === bar) bar.redraw();
}

export class Logger {
  constructor(private readonly _ns?: string) {}

  child(ns: string): Logger {
    return new Logger(this._ns ? `${this._ns}:${ns}` : ns);
  }

  debug(msg: string):   void { writeLog('debug',   this._ns, msg); }
  info(msg: string):    void { writeLog('info',     this._ns, msg); }
  success(msg: string): void { writeLog('success',  this._ns, msg); }
  warn(msg: string):    void { writeLog('warn',     this._ns, msg); }
  error(msg: string):   void { writeLog('error',    this._ns, msg); }

  divider(char = '─', width = 60): void {
    const bar = _bar;
    bar?.clear();
    process.stdout.write(paint(char.repeat(width), A.dim) + '\n');
    if (bar && _bar === bar) bar.redraw();
  }

  progress(total: number, label?: string): ProgressBar {
    return new ProgressBar(total, label);
  }
}

export const log = new Logger();
