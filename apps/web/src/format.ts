export function money(value: number): string {
  return Math.round(value).toLocaleString('zh-CN');
}

export function wan(value: number): string {
  return `${(value / 10000).toLocaleString('zh-CN', {
    maximumFractionDigits: 1,
  })} 万`;
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function ratio(value: number): string {
  return value.toFixed(2);
}

export function dateCn(iso: string): string {
  return iso ? iso.replace(/-/g, '.') : '—';
}

export function signedMoney(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${money(Math.abs(value))}`;
}
