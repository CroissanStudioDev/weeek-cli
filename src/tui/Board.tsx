/**
 * Kanban board rendered in the terminal.
 *
 * Data flows one way: the caller supplies the columns and tasks plus an `onMove` callback, so
 * this component is pure enough to snapshot-test with `renderToString` and drive with
 * `ink-testing-library` — no network, no client, no auth.
 */

import { Box, Text, useApp, useInput } from 'ink'
import { useCallback, useMemo, useState } from 'react'

export interface BoardTask {
  id: number
  title: string
  boardColumnId: number | null
  isCompleted?: boolean | number
  priority?: number | null
}

export interface BoardColumn {
  id: number
  name: string
}

export interface BoardProps {
  columns: BoardColumn[]
  tasks: BoardTask[]
  /** Called when the user moves the selected task; may reject, which is surfaced inline. */
  onMove?: (taskId: number, columnId: number) => Promise<void>
  onComplete?: (taskId: number) => Promise<void>
  title?: string
}

const COLUMN_WIDTH = 26

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

export function Board({ columns, tasks, onMove, onComplete, title }: BoardProps) {
  const { exit } = useApp()
  const [columnIndex, setColumnIndex] = useState(0)
  const [taskIndex, setTaskIndex] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [moved, setMoved] = useState<Record<number, number>>({})

  const byColumn = useMemo(() => {
    const map = new Map<number, BoardTask[]>()
    for (const column of columns) map.set(column.id, [])
    for (const task of tasks) {
      const columnId = moved[task.id] ?? task.boardColumnId
      if (columnId !== null && map.has(columnId)) map.get(columnId)?.push(task)
    }
    return map
  }, [columns, tasks, moved])

  const currentColumn = columns[columnIndex]
  const currentTasks = currentColumn ? (byColumn.get(currentColumn.id) ?? []) : []
  const currentTask = currentTasks[Math.min(taskIndex, currentTasks.length - 1)]

  const move = useCallback(
    async (direction: -1 | 1) => {
      const target = columns[columnIndex + direction]
      if (!currentTask || !target) return

      setMoved((prev) => ({ ...prev, [currentTask.id]: target.id }))
      setStatus(`Moving “${truncate(currentTask.title, 30)}” → ${target.name}…`)

      try {
        await onMove?.(currentTask.id, target.id)
        setStatus(`Moved to ${target.name}`)
      } catch (error) {
        // Roll the optimistic update back rather than showing a board that lies.
        setMoved((prev) => {
          const next = { ...prev }
          delete next[currentTask.id]
          return next
        })
        setStatus(`Could not move: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [columns, columnIndex, currentTask, onMove],
  )

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit()
      return
    }
    if (input === '?') {
      setShowHelp((v) => !v)
      return
    }
    if (key.leftArrow || input === 'h') {
      setColumnIndex((i) => Math.max(0, i - 1))
      setTaskIndex(0)
      return
    }
    if (key.rightArrow || input === 'l') {
      setColumnIndex((i) => Math.min(columns.length - 1, i + 1))
      setTaskIndex(0)
      return
    }
    if (key.downArrow || input === 'j') {
      setTaskIndex((i) => Math.min(currentTasks.length - 1, i + 1))
      return
    }
    if (key.upArrow || input === 'k') {
      setTaskIndex((i) => Math.max(0, i - 1))
      return
    }
    if (input === 'H') {
      void move(-1)
      return
    }
    if (input === 'L') {
      void move(1)
      return
    }
    if (input === 'c' && currentTask) {
      setStatus(`Completing “${truncate(currentTask.title, 30)}”…`)
      void onComplete?.(currentTask.id)
        .then(() => setStatus('Completed'))
        .catch((error: unknown) =>
          setStatus(
            `Could not complete: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
    }
  })

  if (columns.length === 0) {
    return <Text color="yellow">This board has no columns.</Text>
  }

  return (
    <Box flexDirection="column">
      {title ? (
        <Box marginBottom={1}>
          <Text bold>{title}</Text>
        </Box>
      ) : null}

      <Box>
        {columns.map((column, index) => {
          const columnTasks = byColumn.get(column.id) ?? []
          const active = index === columnIndex
          return (
            <Box
              key={column.id}
              flexDirection="column"
              width={COLUMN_WIDTH}
              marginRight={1}
              borderStyle={active ? 'round' : 'single'}
              borderColor={active ? 'cyan' : 'gray'}
              paddingX={1}
            >
              <Text bold {...(active ? { color: 'cyan' as const } : {})}>
                {truncate(column.name, COLUMN_WIDTH - 6)} ({columnTasks.length})
              </Text>

              {columnTasks.length === 0 ? <Text dimColor>—</Text> : null}

              {columnTasks.map((task, row) => {
                const selected = active && row === Math.min(taskIndex, columnTasks.length - 1)
                const done = task.isCompleted === true || task.isCompleted === 1
                return (
                  <Text key={task.id} inverse={selected} dimColor={done} strikethrough={done}>
                    {truncate(task.title, COLUMN_WIDTH - 4)}
                  </Text>
                )
              })}
            </Box>
          )
        })}
      </Box>

      {status ? (
        <Box marginTop={1}>
          <Text dimColor>{status}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {showHelp
            ? 'h/l or ←/→ column · j/k or ↑/↓ task · H/L move task · c complete · ? help · q quit'
            : '? help · q quit'}
        </Text>
      </Box>
    </Box>
  )
}
