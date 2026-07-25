/**
 * `weeek ui` — the interactive board.
 *
 * Ink and React are imported only here, and only when the command actually runs, so the 153
 * generated commands and `--help` never pay for a React renderer.
 */

import { Command } from 'commander'
import { WeeekError } from '../core/api/errors.ts'
import type { CommandDeps } from './auth.ts'

interface Project {
  id: number
  name: string
}

interface Board {
  id: number
  name: string
  projectId?: number
}

export function uiCommand(deps: () => CommandDeps): Command {
  return new Command('ui')
    .description('interactive kanban board in the terminal')
    .option('--board <id>', 'open a specific board')
    .option('--project <id>', 'restrict to one project')
    .action(async (options: { board?: string; project?: string }) => {
      const { global } = deps()

      // Never start a full-screen app without a terminal: in a pipe or CI it would either hang
      // waiting for keys or emit escape codes into someone's log.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new WeeekError({
          kind: 'input',
          message:
            '`weeek ui` needs an interactive terminal. ' +
            'For scripts use `weeek task list --json` and the other commands.',
        })
      }

      const { resolveToken } = await import('../core/auth/resolve.ts')
      const { WeeekClient } = await import('../core/api/client.ts')
      const { OPERATIONS_BY_ID } = await import('../core/api/generated/operations.ts')

      const resolveOptions: Parameters<typeof resolveToken>[0] = {}
      if (global.profile !== undefined) resolveOptions.profile = global.profile
      if (global.tokenFile !== undefined) resolveOptions.tokenFile = global.tokenFile
      const auth = await resolveToken(resolveOptions)

      const baseUrl = global.baseUrl ?? auth.baseUrl
      const client = new WeeekClient({
        token: auth.token,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      })

      const operation = (id: string) => {
        const found = OPERATIONS_BY_ID.get(id)
        if (!found) throw new WeeekError({ kind: 'api', message: `Missing operation ${id}` })
        return found
      }

      const boards =
        (await client.call<Board[]>(operation('board.list'), {
          path: {},
          query: {},
        })) ?? []

      if (boards.length === 0) {
        throw new WeeekError({
          kind: 'not-found',
          message: 'No boards found in this workspace.',
        })
      }

      const board = options.board ? boards.find((b) => String(b.id) === options.board) : boards[0]

      if (!board) {
        throw new WeeekError({
          kind: 'not-found',
          message: `No board with id ${options.board}. Try \`weeek board list\`.`,
        })
      }

      const [columns, tasks, projects] = await Promise.all([
        client.call<{ id: number; name: string; boardId?: number }[]>(
          operation('board-column.list'),
          {
            path: {},
            query: { boardId: board.id },
          },
        ),
        client.call<{ id: number; title: string; boardColumnId: number | null }[]>(
          operation('task.list'),
          {
            path: {},
            query: {
              boardId: board.id,
              ...(options.project ? { projectId: Number(options.project) } : {}),
            },
          },
        ),
        client.call<Project[]>(operation('project.list'), { path: {}, query: {} }),
      ])

      const project = projects?.find((p) => p.id === board.projectId)
      const title = `${project ? `${project.name} · ` : ''}${board.name}`

      const [{ render }, { createElement }, { Board: BoardView }] = await Promise.all([
        import('ink'),
        import('react'),
        import('../tui/Board.tsx'),
      ])

      const instance = render(
        createElement(BoardView, {
          title,
          columns: (columns ?? []).map((c) => ({ id: c.id, name: c.name })),
          tasks: tasks ?? [],
          onMove: async (taskId: number, columnId: number) => {
            await client.call(operation('task.set-column'), {
              path: { id: taskId },
              query: {},
              body: { boardColumnId: columnId },
            })
          },
          onComplete: async (taskId: number) => {
            await client.call(operation('task.complete'), { path: { id: taskId }, query: {} })
          },
        }),
      )

      await instance.waitUntilExit()
    })
}
