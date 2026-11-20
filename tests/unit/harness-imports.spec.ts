/** B8：Harness Client 值导入的全形态扫描契约。 */
import { describe, expect, it } from 'vitest'

import { findHarnessClientValueImports } from '../../scripts/harness-imports.mjs'

describe('findHarnessClientValueImports', () => {
  it.each([
    ['require()', 'require("@deepseek-ai/dsh-client-ui-settings")'],
    ['静态 import', 'import value from "@deepseek-ai/dsh-client-ui-settings"'],
    ['side-effect import', 'import "@deepseek-ai/dsh-client-ui-settings"'],
    ['动态 import()', 'await import("@deepseek-ai/dsh-client-ui-settings")'],
    ['re-export', 'export * from "@deepseek-ai/dsh-client-ui-settings"'],
  ])('%s 必须被识别', (_label, source) => {
    expect(findHarnessClientValueImports(source)).not.toHaveLength(0)
  })

  it('普通 external React/其他包与类型注释文本不构成 Harness 值导入', () => {
    expect(findHarnessClientValueImports(`
      import * as React from "react";
      import value from "other-package";
      require("other-package");
    `)).toEqual([])
  })
})
