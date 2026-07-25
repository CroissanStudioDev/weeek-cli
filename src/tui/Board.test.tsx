import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { Board, type BoardColumn, type BoardTask } from './Board.tsx'

const columns: BoardColumn[] = [
  { id: 1, name: 'To do' },
  { id: 2, name: 'Doing' },
  { id: 3, name: 'Done' },
]

const tasks: BoardTask[] = [
  { id: 10, title: 'Fix the font', boardColumnId: 1 },
  { id: 11, title: 'Rewrite docs', boardColumnId: 1 },
  { id: 12, title: 'Ship release', boardColumnId: 2 },
]

/** Ink renders asynchronously; let effects and state updates settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('board rendering', () => {
  it('shows every column with its task count', async () => {
    const { lastFrame } = render(<Board columns={columns} tasks={tasks} />)
    await settle()

    const frame = lastFrame() ?? ''
    expect(frame).toContain('To do (2)')
    expect(frame).toContain('Doing (1)')
    expect(frame).toContain('Done (0)')
    expect(frame).toContain('Fix the font')
  })

  it('renders a title when given one', async () => {
    const { lastFrame } = render(
      <Board columns={columns} tasks={tasks} title="Website · Sprint 4" />,
    )
    await settle()
    expect(lastFrame()).toContain('Website · Sprint 4')
  })

  it('says so rather than rendering an empty frame when there are no columns', async () => {
    const { lastFrame } = render(<Board columns={[]} tasks={[]} />)
    await settle()
    expect(lastFrame()).toContain('no columns')
  })

  it('marks an empty column instead of leaving a silent gap', async () => {
    const { lastFrame } = render(<Board columns={columns} tasks={[]} />)
    await settle()
    expect(lastFrame()).toContain('—')
  })
})

describe('moving a task', () => {
  it('calls onMove with the selected task and the neighbouring column', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    const { stdin } = render(<Board columns={columns} tasks={tasks} onMove={onMove} />)
    await settle()

    stdin.write('L') // move right
    await settle()

    expect(onMove).toHaveBeenCalledWith(10, 2)
  })

  it('moves the task the cursor is actually on', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    const { stdin } = render(<Board columns={columns} tasks={tasks} onMove={onMove} />)
    await settle()

    stdin.write('j') // second task in the first column
    await settle()
    stdin.write('L')
    await settle()

    expect(onMove).toHaveBeenCalledWith(11, 2)
  })

  it('rolls the card back when the API rejects the move', async () => {
    // A board that kept showing the optimistic position would be lying about server state.
    const onMove = vi.fn().mockRejectedValue(new Error('boardColumnId is invalid'))
    const { stdin, lastFrame } = render(<Board columns={columns} tasks={tasks} onMove={onMove} />)
    await settle()

    stdin.write('L')
    await settle()

    const frame = lastFrame() ?? ''
    expect(frame).toContain('Could not move')
    expect(frame).toContain('boardColumnId is invalid')
    // Counts are back to where they started.
    expect(frame).toContain('To do (2)')
    expect(frame).toContain('Doing (1)')
  })

  it('does nothing at the left edge', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    const { stdin } = render(<Board columns={columns} tasks={tasks} onMove={onMove} />)
    await settle()

    stdin.write('H') // already in the first column
    await settle()

    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('completing a task', () => {
  it('reports the failure inline instead of crashing the app', async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error('already completed'))
    const { stdin, lastFrame } = render(
      <Board columns={columns} tasks={tasks} onComplete={onComplete} />,
    )
    await settle()

    stdin.write('c')
    await settle()

    expect(onComplete).toHaveBeenCalledWith(10)
    expect(lastFrame()).toContain('already completed')
  })
})

describe('help', () => {
  it('toggles the key reference', async () => {
    const { stdin, lastFrame } = render(<Board columns={columns} tasks={tasks} />)
    await settle()

    expect(lastFrame()).toContain('? help')
    stdin.write('?')
    await settle()

    expect(lastFrame()).toContain('H/L move task')
  })
})
