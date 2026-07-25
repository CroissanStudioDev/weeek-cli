/**
 * Public SDK surface — the same code the CLI runs on, importable as `weeek-cli/api`.
 *
 * Nothing here touches the terminal, argv, colour or process exit codes; that lives in
 * `src/cli` and is enforced by a lint rule rather than by convention.
 */

export type { ClientOptions, PageInfo, RequestOptions } from './api/client.ts'
export {
  buildPath,
  buildQuery,
  DEFAULT_BASE_URL,
  readPageInfo,
  unwrapEnvelope,
  WeeekClient,
} from './api/client.ts'
export type { ErrorKind, WeeekErrorInit } from './api/errors.ts'
export { messageFromBody, parseRetryAfter, WeeekError } from './api/errors.ts'
export type { HttpMethod, OperationMeta, ParamMeta } from './api/generated/operations.ts'
export { NAMESPACES, OPERATIONS, OPERATIONS_BY_ID } from './api/generated/operations.ts'
export { BODY_SCHEMAS } from './api/generated/schemas.ts'
export type { components, paths } from './api/generated/types.ts'
export {
  clearSecrets,
  redact,
  redactValue,
  registerSecret,
  tokenHint,
} from './auth/redact.ts'
export type { ResolvedToken, ResolveOptions, TokenSource } from './auth/resolve.ts'
export { readTokenFromStdin, resolveToken } from './auth/resolve.ts'
export type { TokenStore } from './auth/store.ts'
export { FileTokenStore, KeychainTokenStore, storeFor } from './auth/store.ts'
export type { ConfigFile, ProfileConfig } from './config.ts'
export {
  assertPrivate,
  configDir,
  configPath,
  DEFAULT_PROFILE,
  profileFrom,
  readConfig,
  TokenBackend,
  writeConfig,
} from './config.ts'
