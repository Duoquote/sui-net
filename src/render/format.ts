import pc from 'picocolors';

export const c = pc;

export function header(title: string): string {
  return pc.bold(pc.cyan(title));
}

export function subheader(title: string): string {
  return pc.bold(title);
}

export function dim(s: string): string {
  return pc.dim(s);
}

export function label(s: string): string {
  return pc.dim(s);
}

/** A "key: value" line with aligned-ish label. */
export function kv(key: string, value: string | number | boolean, indent = 0): string {
  return `${' '.repeat(indent)}${pc.dim(key + ':')} ${value}`;
}

export function bullet(s: string, indent = 2): string {
  return `${' '.repeat(indent)}${pc.dim('•')} ${s}`;
}

export function rule(width = 60): string {
  return pc.dim('─'.repeat(width));
}

/** Group a list of [label, value] rows under a heading. */
export function block(title: string, rows: Array<[string, string | number | boolean]>): string {
  const lines = [header(title)];
  for (const [k, v] of rows) lines.push(kv(k, v, 2));
  return lines.join('\n');
}

/** Format a large integer with thousands separators. */
export function groupDigits(n: string | bigint | number): string {
  const s = typeof n === 'string' ? n : n.toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  if (!/^\d+$/.test(digits)) return s;
  return (neg ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Scale a raw integer amount by decimals into a human float string. */
export function fromUnits(raw: string | bigint, decimals: number): string {
  const v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${groupDigits(whole.toString())}${fracStr ? '.' + fracStr : ''}`;
}
