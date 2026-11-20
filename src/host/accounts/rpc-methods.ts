/**
 * 账号管理 RPC 的 Host 分派。
 *
 * 传输/信封由 `src/host/rpc.ts` 负责；这里只做严格的账号 payload 校验并把
 * 调用映射到 {@link AccountService}。成功结果只含共享 DTO，不返回秘密。
 */
import {
  assertAccountRpcPayload,
  type AccountRpcMethod,
  type AccountRpcPayloads,
} from '../../shared/accounts.ts'
import type { AccountService } from './service.ts'
import { accountCancelled } from './errors.ts'
import { waitWithAuthAbort } from '../channels/auth-abort.ts'

/**
 * 执行一次账号 RPC。
 *
 * @throws {AccountRpcValidationError} payload 非法时（RPC 映射为 accounts/invalid）。
 * @throws {AccountError} 账号域失败时。
 */
export async function dispatchAccountRpc(
  accounts: AccountService,
  method: AccountRpcMethod,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  assertAccountRpcPayload(method, payload)
  const read = async <T>(operation: Promise<T>): Promise<T> => signal === undefined
    ? await operation
    : await waitWithAuthAbort(operation, signal, accountCancelled)
  switch (method) {
    case 'accounts.list':
      return await read(accounts.list((payload as AccountRpcPayloads['accounts.list']).channel))
    case 'accounts.current':
      return await read(accounts.getCurrent((payload as AccountRpcPayloads['accounts.current']).channel))
    case 'accounts.setCurrent': {
      const request = payload as AccountRpcPayloads['accounts.setCurrent']
      return accounts.setCurrent(request.channel, request.accountId, signal)
    }
    case 'accounts.delete': {
      const request = payload as AccountRpcPayloads['accounts.delete']
      return accounts.delete(request.channel, request.accountId, request.replacementAccountId, signal)
    }
    case 'accounts.clearAll':
      return accounts.clearAll(signal)
  }
}
