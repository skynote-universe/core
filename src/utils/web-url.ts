/** 解析可交给宿主打开的绝对 HTTP(S) 链接，拒绝凭据和不可见控制字符。 */
export function parseWebUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f\\]/u.test(value)) return undefined;
  const input = value.trim();
  if (!/^https?:\/\/[^/]/i.test(input)) return undefined;
  try {
    const url = new URL(input);
    if (!url.hostname || url.username || url.password || url.href.length > 4096) return undefined;
    return url;
  } catch {
    return undefined;
  }
}
