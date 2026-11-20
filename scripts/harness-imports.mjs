/** Harness Client 值导入的全形态扫描；用于最终构建产物，而非类型源码。 */

const PATTERNS = [
  /require\(\s*['"]@deepseek-ai\/[^'"]+['"]\s*\)/g,
  /\bfrom\s*['"]@deepseek-ai\/[^'"]+['"]/g,
  /\bimport\s*\(\s*['"]@deepseek-ai\/[^'"]+['"]\s*\)/g,
  /\bimport\s*['"]@deepseek-ai\/[^'"]+['"]/g,
]

/**
 * @param {string} code 最终 JavaScript 产物。
 * @returns {string[]} 命中的值导入文本；静态 import/from 与 re-export 共用 from 规则。
 */
export function findHarnessClientValueImports(code) {
  return PATTERNS.flatMap(pattern => [...code.matchAll(pattern)].map(match => match[0]))
}
