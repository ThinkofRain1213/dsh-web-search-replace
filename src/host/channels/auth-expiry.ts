/** 四渠道统一的 access 临期窗口与 refresh 过期判断。 */

export const AUTH_ACCESS_EXPIRY_SKEW_MS = 60_000

export function readExpiryMs(
  secret: Readonly<Record<string, unknown>>,
  key: 'expiresAtMs' | 'refreshExpiresAtMs',
): number | undefined {
  const value = secret[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function accessNeedsRefresh(expiresAtMs: number | undefined, now: number): boolean {
  return expiresAtMs !== undefined && expiresAtMs <= now + AUTH_ACCESS_EXPIRY_SKEW_MS
}

export function refreshHasExpired(refreshExpiresAtMs: number | undefined, now: number): boolean {
  return refreshExpiresAtMs !== undefined && refreshExpiresAtMs <= now
}
