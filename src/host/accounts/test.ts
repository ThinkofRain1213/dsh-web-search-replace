/** 用户显式触发的单账号真实 Search 能力测试；不是 Agent tool。 */
import type { AccountSummary, PersistedAccountStatus } from '../../shared/accounts.ts'
import type { ChannelId } from '../../shared/channels.ts'
import { waitWithAuthAbort } from '../channels/auth-abort.ts'
import {
  runCapabilityVerifierWithDeadline,
  type ChannelCapabilityVerifiers,
} from '../channels/capability.ts'
import { QoderEndpointUnavailableError } from '../channels/qoder/endpoint-policy.ts'
import { QoderSearchProtocolError } from '../channels/qoder/protocol.ts'
import { TencentSearchProtocolError } from '../channels/tencent/protocol.ts'
import { ChannelSearchError } from '../search/errors.ts'
import { accountCancelled, accountNotFound } from './errors.ts'
import type { AccountGrantSnapshot, AccountService, ResolvedChannelCredential } from './service.ts'
import type { AccountStore } from './store.ts'

export const ACCOUNT_TEST_DEADLINE_MS = 60_000

/** 管理 RPC 使用的最小账号测试端口。 */
export interface AccountTestPort {
  test(channel: ChannelId, accountId: string, signal: AbortSignal): Promise<AccountSummary>
}

export interface AccountCapabilityTesterOptions {
  readonly accounts: AccountService
  readonly store: AccountStore
  readonly verifiers: ChannelCapabilityVerifiers
  readonly now?: () => number
}

/** 精确账号测试器；snapshot 只留在 Host 进程内。 */
export class AccountCapabilityTester implements AccountTestPort {
  constructor(private readonly options: AccountCapabilityTesterOptions) {}

  async test(channel: ChannelId, accountId: string, signal: AbortSignal): Promise<AccountSummary> {
    const snapshot = await waitWithAuthAbort(
      this.options.accounts.resolveAccountCredential(channel, accountId),
      signal,
      accountCancelled,
    )
    if (snapshot === null) throw accountNotFound()
    if (snapshot.credential === null) return snapshot.summary

    let status: PersistedAccountStatus = 'ready'
    try {
      const now = this.options.now ?? Date.now
      await runCapabilityVerifierWithDeadline(
        async (probeSignal) => { await this.verify(snapshot, probeSignal) },
        signal,
        now() + ACCOUNT_TEST_DEADLINE_MS,
        now,
      )
    } catch (error) {
      if (signal.aborted) throw accountCancelled()
      status = isExplicitHttp401(error) ? 'reauth_required' : 'temporarily_unavailable'
    }
    return await this.finish(snapshot, status, signal)
  }

  private async verify(snapshot: AccountGrantSnapshot, signal: AbortSignal): Promise<void> {
    const credential = snapshot.credential
    if (credential === null || snapshot.vendorAccountId === null) return
    switch (credential.channelId) {
      case 'buddy':
        await this.options.verifiers.buddy({
          channelId: 'buddy',
          accessToken: accessToken(credential),
          vendorAccountId: snapshot.vendorAccountId,
        }, signal)
        return
      case 'workbuddy':
        await this.options.verifiers.workbuddy({
          channelId: 'workbuddy',
          accessToken: accessToken(credential),
          vendorAccountId: snapshot.vendorAccountId,
        }, signal)
        return
      case 'qoder':
        await this.options.verifiers.qoder({
          channelId: 'qoder',
          credential: signingCredential(credential),
          vendorAccountId: snapshot.vendorAccountId,
        }, signal)
        return
      case 'qodercn':
        await this.options.verifiers.qodercn({
          channelId: 'qodercn',
          credential: signingCredential(credential),
          vendorAccountId: snapshot.vendorAccountId,
        }, signal)
    }
  }

  /** 状态写入按启动时 refresh 快照 CAS；重新登录/刷新后的新 grant 不被迟到结果覆盖。 */
  private async finish(
    snapshot: AccountGrantSnapshot,
    status: PersistedAccountStatus,
    signal: AbortSignal,
  ): Promise<AccountSummary> {
    if (snapshot.credential === null || snapshot.expectedRefreshToken === null) return snapshot.summary
    if (signal.aborted) throw accountCancelled()
    const channel = snapshot.credential.channelId
    await this.options.store.rotateSecret({
      channel,
      accountId: snapshot.credential.accountId,
      expectedRefreshToken: snapshot.expectedRefreshToken,
      status,
      signal,
    })
    const summary = await waitWithAuthAbort(
      this.options.accounts.getAccount(channel, snapshot.credential.accountId),
      signal,
      accountCancelled,
    )
    if (summary === null) throw accountNotFound()
    return summary
  }
}

function accessToken(credential: ResolvedChannelCredential): string {
  if (credential.kind !== 'tencent-access-token') throw new TypeError('invalid account credential projection')
  return credential.accessToken
}

function signingCredential(credential: ResolvedChannelCredential) {
  if (credential.kind !== 'qoder-signing') throw new TypeError('invalid account credential projection')
  return credential.credential
}

/** 只接受协议层证明的 HTTP 401；403、业务 unauthorized 与文本猜测均不算。 */
function isExplicitHttp401(error: unknown): boolean {
  if (error instanceof ChannelSearchError) {
    return error.code === 'UNAUTHORIZED' && error.httpStatus === 401
  }
  if (error instanceof TencentSearchProtocolError) {
    return error.code === 'UNAUTHORIZED' && error.status === 401
  }
  if (error instanceof QoderSearchProtocolError) {
    return error.code === 'UNAUTHORIZED' && error.status === 401
  }
  if (error instanceof QoderEndpointUnavailableError) {
    return error.code === 'UNAUTHORIZED' && error.httpStatus === 401
  }
  return false
}
