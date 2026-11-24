# 单账号能力测试契约（`accounts.test`）

> 本轮新增的用户显式管理 RPC；不是 Agent tool，不进入工具注册表，也不会在加载、切换渠道、刷新列表或开启开关时自动执行。当前自动化只使用内存 credentials 与 mock 厂商边界；真实厂商验收仍为 PENDING。

## 1. RPC 与 DTO

- 路径沿用 `POST /api/web-search-replace`，管理方法为 `accounts.test`。
- payload 严格为 `{ channel: 'buddy' | 'workbuddy' | 'qoder' | 'qodercn', accountId: string }`；拒绝未知字段、非法渠道和非法账号 ID。
- 成功结果为该账号的六字段 `AccountSummary`：`id / displayName / channelId / endpointLabel / status / maskedIdentifier`。
- 不存在的账号或错误渠道返回 `accounts/not-found`；非法 payload 返回 `accounts/invalid`；存储错误使用固定账号域错误。未装配 tester 的局部 Host 不提供此方法。
- RPC、错误、details、cause 和 Client 状态均不得包含 `accessToken`、`refreshToken`、`securityOauthToken`、`uid`、`machineId`、PKCE、厂商原始身份或上游正文。

## 2. Host 执行边界

1. `AccountService.resolveAccountCredential(channel, accountId)` 只读取该精确账号的 grant 快照，不读取 `currentAccountId`，不枚举其他渠道。
2. `AccountCapabilityTester` 复用根组合的 `createChannelCapabilityVerifiers`：腾讯渠道只走各自固定域；Qoder 中国版只走 `gateway.qoder.com.cn`；Qoder 国际版沿用当前 endpoint preference 和限定换域策略，probe 不写最近成功域、不发布 `actualHost`。
3. `runCapabilityVerifierWithDeadline` 的总 deadline 为 60 秒。caller abort 与 root dispose 都会中止 verifier，并由 lifecycle 等待其真正 settle。
4. 坏记录不调用网络，直接返回 `credential_unavailable` 的安全摘要。
5. 状态写入以启动时 refresh 快照做 CAS；测试期间重新登录或刷新产生的新 grant 不被迟到结果覆盖。取消与 dispose 不写最终状态。

| 结果 | 账号状态 |
|---|---|
| verifier 成功 | `ready` |
| 协议层明确的 HTTP 401 | `reauth_required` |
| 网络、限流、超时、5xx、其他服务/协议错误 | `temporarily_unavailable` |
| 记录损坏或执行期凭据缺字段 | `credential_unavailable` |

只有明确 401 进入重新登录分类；403、业务 unauthorized 文本或错误消息猜测均不算 401。测试只更新被测账号，绝不修改开关、`currentAccountId` 或其他账号。

## 3. Client 行为

- 每个当前/备选账号行都有独立「测试 / Test」按钮；点击后才调用 RPC。
- 测试与设当前、重登、删除复用同一 FIFO 队列、`busyAccountId` / `busyAction` 行锁、`actionGeneration` 和 action-scope `AbortController`。
- 活动测试显示 `checking` 与「测试中 / Testing」；排队或活动测试可点「取消测试 / Cancel test」。取消排队项不会执行；取消活动项会 abort RPC、使迟到回包失效并继续后续队列。
- 最终回包必须仍是同渠道、同账号、无额外字段的六字段摘要。成功时只替换该账号列表项；若它就是当前账号，只同步摘要，不改变当前账号 ID。
- `dispose` abort 活动测试并丢弃全部未开始队列；迟到结果不更新 UI、不通知订阅者。
- OFF 时测试按钮禁用，R52 仍只有「清除全部账号数据」及确认可用；只读同样禁用。不会自动测试。

## 4. 尚需真实验收

- 四个渠道分别用真实账号点击测试，确认实际厂商成功、401、限流、超时和网络故障分类。
- Qoder 国际版 auto 在真实网络下的限定第二域请求与配额影响；fixed 不读路由状态。
- 真实 Host Connection abort、插件卸载/HMR 的在飞 settle，以及真实页面按钮、行锁、OFF 灰化和中英文显示。
- 真实厂商结果不得用本轮 mock fetch/WASM 测试替代，也不得在报告中记录任何真实秘密。
