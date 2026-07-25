/**
 * The only place process exit codes are defined.
 *
 * Scripts branch on these, so they are part of the public contract and are documented in
 * `--help`. Keeping the numbers in one file is what stops them drifting apart as commands are
 * added.
 */

import { WeeekError } from '../core/api/errors.ts'

export const EXIT = {
  /** Success, including a successful command that found nothing. */
  ok: 0,
  /** Anything unclassified. */
  failure: 1,
  /** Bad usage or input rejected before the request went out. */
  usage: 2,
  /** Missing, invalid or rejected credentials. */
  auth: 3,
  /** The addressed resource does not exist. */
  notFound: 4,
  /** The API answered with an error. */
  api: 5,
  /** The API could not be reached, or the request timed out. */
  network: 6,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export function exitCodeFor(error: unknown): ExitCode {
  if (!(error instanceof WeeekError)) return EXIT.failure

  switch (error.kind) {
    case 'auth':
      return EXIT.auth
    case 'not-found':
      return EXIT.notFound
    case 'validation':
    case 'input':
      return EXIT.usage
    case 'network':
      return EXIT.network
    case 'rate-limit':
    case 'api':
      return EXIT.api
  }
}

/** Rendered under `weeek --help` so the contract is discoverable, not folklore. */
export const EXIT_CODE_HELP = [
  '  0  success',
  '  1  unexpected failure',
  '  2  invalid usage or input',
  '  3  authentication problem',
  '  4  not found',
  '  5  API error',
  '  6  network error or timeout',
].join('\n')
