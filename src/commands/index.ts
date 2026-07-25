/**
 * Hand-written commands that sit alongside the 153 generated ones.
 *
 * These are the ones that are not API operations at all — authentication, diagnostics,
 * introspection, the raw escape hatch and the TUI.
 */

import type { Command } from 'commander'
import type { CommandDeps } from './auth.ts'
import { authCommand } from './auth.ts'
import { completionCommand } from './completion.ts'
import { doctorCommand } from './doctor.ts'
import { apiCommand, schemaCommand } from './schema.ts'
import { uiCommand } from './ui.ts'

export function registerExtraCommands(program: Command, deps: () => CommandDeps): void {
  program.addCommand(authCommand(deps))
  program.addCommand(doctorCommand(deps))
  program.addCommand(schemaCommand(deps))
  program.addCommand(apiCommand(deps))
  program.addCommand(completionCommand())
  program.addCommand(uiCommand(deps))
}
