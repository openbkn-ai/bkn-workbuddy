// User-facing states for gateway and platform failures. Business users see a plain
// Chinese message and one next step; technical codes stay in diagnostics.
import { GatewayCallError } from './gateway-client.js'

export type NextStep = 'reconnect' | 'retry-later' | 'contact-admin' | 'narrow-query' | 'reinstall' | 'none'

export interface UserState {
  readonly code: string
  readonly nextStep: NextStep
  readonly message: string
}

const STATES: Readonly<Record<string, Omit<UserState, 'code'>>> = {
  NOT_CONFIGURED: { nextStep: 'reconnect', message: '还没有连接 OpenBKN。请按安装说明登录后再试。' },
  AUTHENTICATION_REQUIRED: { nextStep: 'reconnect', message: 'OpenBKN 登录已失效（或插件升级后需要重新授权）。请重新登录后再试。' },
  CREDENTIAL_STORE_ERROR: { nextStep: 'reconnect', message: '无法读取本机保存的 OpenBKN 凭证。请重新登录；仍失败时联系管理员。' },
  PLATFORM_UNAVAILABLE: { nextStep: 'retry-later', message: 'OpenBKN 平台暂时无法访问。已选的业务范围保持不变，请稍后重试。' },
  GATEWAY_TIMEOUT: { nextStep: 'retry-later', message: 'OpenBKN 响应超时。请稍后重试；问题持续时请缩小查询范围。' },
  FORBIDDEN: { nextStep: 'contact-admin', message: '当前账号或业务域没有权限访问该内容。请联系 OpenBKN 管理员确认授权。' },
  NOT_DISCLOSED: { nextStep: 'none', message: '该记录不存在，或当前账号无权查看。' },
  OUTPUT_OVERFLOW: { nextStep: 'narrow-query', message: '查询结果过大。请缩小范围（例如增加筛选条件或减少返回条数）后重试。' },
  POLICY_REFUSED: { nextStep: 'none', message: '该操作不在本插件允许的只读范围内，未发送到平台。' },
  CERTIFICATE_ERROR: { nextStep: 'contact-admin', message: '无法验证 OpenBKN 平台的证书。请确认平台地址正确，并按安装说明配置平台的 CA 证书。' },
  REDIRECT_REFUSED: { nextStep: 'contact-admin', message: 'OpenBKN 地址返回了跳转，出于安全原因已拒绝。请联系管理员核对平台地址。' },
  INVALID_RESPONSE: { nextStep: 'contact-admin', message: 'OpenBKN 返回了无法识别的结果。请联系管理员检查平台版本。' },
  MCP_ERROR: { nextStep: 'contact-admin', message: 'OpenBKN 查询服务返回错误。请稍后重试；问题持续时联系管理员。' },
  PLATFORM_ERROR: { nextStep: 'retry-later', message: 'OpenBKN 平台处理请求时出错。请稍后重试。' },
  GATEWAY_EXITED: { nextStep: 'reinstall', message: '本机的 OpenBKN 组件意外退出。请重试；反复出现时请重新安装插件。' },
  GATEWAY_UNAVAILABLE: { nextStep: 'reinstall', message: '无法启动本机的 OpenBKN 组件。请重新安装插件。' },
}

const FALLBACK: Omit<UserState, 'code'> = { nextStep: 'contact-admin', message: 'OpenBKN 请求失败。请稍后重试；问题持续时联系管理员。' }

export function userStateOf(error: unknown): UserState {
  const code = error instanceof GatewayCallError ? error.code : 'INTERNAL'
  return { code, ...(STATES[code] ?? FALLBACK) }
}
