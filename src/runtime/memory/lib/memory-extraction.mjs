// Single source of truth: lib/text-utils.cjs (also required by hooks/session-start.cjs).
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
const { cleanMemoryText: _cleanMemoryText } = _require('../../../lib/text-utils.cjs')
export const cleanMemoryText = _cleanMemoryText
