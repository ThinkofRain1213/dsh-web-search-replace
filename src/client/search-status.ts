/** §5.5 搜索状态：只由 settings.enabled 与同渠道 AccountsController 真源推导。 */
import type { AccountSummary } from '../shared/accounts.ts'
import type { AccountsState } from './controllers/accounts.ts'

export type SearchStatusKind =
  | 'off'
  | 'loading'
  | 'ready'
  | 'no-account'
  | 'no-current'
  | 'reauth_required'
  | 'temporarily_unavailable'
  | 'credential_error'

export interface SearchStatusView {
  readonly kind: SearchStatusKind
  readonly account?: AccountSummary
}

export function deriveSearchStatus(
  enabled: boolean,
  accounts: AccountsState | undefined,
): SearchStatusView {
  if (!enabled) return { kind: 'off' }
  if (accounts === undefined || accounts.status === 'loading') return { kind: 'loading' }
  if (accounts.status === 'error') return { kind: 'credential_error' }
  const current = accounts.current
  if (current === null) return { kind: accounts.accounts.length === 0 ? 'no-account' : 'no-current' }
  switch (current.status) {
    case 'ready': return { kind: 'ready', account: current }
    case 'checking':
    case 'refreshing': return { kind: 'loading' }
    case 'reauth_required': return { kind: 'reauth_required', account: current }
    case 'temporarily_unavailable': return { kind: 'temporarily_unavailable', account: current }
    case 'credential_unavailable': return { kind: 'credential_error', account: current }
  }
}
