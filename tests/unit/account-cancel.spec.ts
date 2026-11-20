/** R39：delete/clearAll 的卸载代际门禁不得产生补偿性 config 写。 */
import { describe, expect, it } from 'vitest'

import { createAccountFixture } from './support/account-fixture.ts'

describe('AccountService delete/clearAll 取消边界', () => {
  it('删除失败后 signal 已 abort 时不再恢复 current，也不新增 configEditor 写', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'delete-cancel', secret: { accessToken: 'A', refreshToken: 'R' },
    })
    await fixture.service.setCurrent('buddy', account.accountId)
    const controller = new AbortController()
    fixture.store.deleteAccount = async () => {
      controller.abort()
      throw new Error('physical delete failed')
    }
    const editsBefore = fixture.settingsDouble.edits.length
    await expect(fixture.service.delete('buddy', account.accountId, null, controller.signal))
      .rejects.toThrow('physical delete failed')
    // 仅允许 abort 前已经开始的删除前切换；不得再出现第三次恢复写。
    expect(fixture.settingsDouble.edits).toHaveLength(editsBefore + 1)
    expect(fixture.settings.getSnapshot().buddy.currentAccountId).toBeNull()
  })

  it('clearAll 已取消时不写任何 current，也不删除记录', async () => {
    const fixture = createAccountFixture()
    const account = await fixture.store.saveAccount({
      channel: 'buddy', vendorAccountId: 'clear-cancel', secret: { accessToken: 'A', refreshToken: 'R' },
    })
    await fixture.service.setCurrent('buddy', account.accountId)
    const controller = new AbortController()
    controller.abort()
    const editsBefore = fixture.settingsDouble.edits.length
    await expect(fixture.service.clearAll(controller.signal)).rejects.toMatchObject({ code: 'accounts/cancelled' })
    expect(fixture.settingsDouble.edits).toHaveLength(editsBefore)
    expect(fixture.credentials.keys()).toHaveLength(1)
  })
})
