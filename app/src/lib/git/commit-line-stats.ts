import { ChildProcess } from 'child_process'
import { readFile } from 'fs/promises'
import * as Path from 'path'
import { git } from './core'
import { spawnGit } from './spawn'
import { Repository } from '../../models/repository'
import { ICommitLineStats } from '../../models/commit'

/**
 * Echoed back by `diff-tree --stdin` because it is not an object name; it
 * marks where the answer for the line before it ends.
 */
const EndOfAnswer = '--done--'
const EndOfAnswerPattern = /--done--\r?\n/

/** An idle worker's git process exits after this long, in ms. */
const WorkerIdleTimeout = 30_000

/**
 * A long-lived `git diff-tree --stdin` process that answers one commit at a
 * time with the lines it added and deleted.
 *
 * Counts use copy and rename detection like the changeset view. The caller
 * passes a merge's first parent, so merges are measured against it, and no
 * parent for a root commit, which `--root` measures against the empty tree.
 * Binary files count as 0 lines. The process starts on the first request and
 * exits after sitting idle, so it never holds the repository open for long.
 */
export class CommitLineStatsWorker {
  private child: ChildProcess | null = null
  private busy = false
  private pending: {
    readonly resolve: (stats: ICommitLineStats | null) => void
    readonly reject: (error: Error) => void
  } | null = null
  private stdout = ''
  private stderr = ''
  private idleTimer: number | null = null

  public constructor(private readonly repositoryPath: string) {}

  public get isBusy() {
    return this.busy
  }

  /**
   * The line stats of `sha`, or null if git does not know the commit. One
   * request at a time: check `isBusy` first.
   */
  public async request(
    sha: string,
    firstParent: string | undefined
  ): Promise<ICommitLineStats | null> {
    if (this.busy) {
      throw new Error('CommitLineStatsWorker takes one request at a time')
    }
    this.busy = true
    this.clearIdleTimer()

    try {
      const child = this.child ?? (await this.start())
      return await new Promise<ICommitLineStats | null>((resolve, reject) => {
        this.pending = { resolve, reject }
        const line = firstParent === undefined ? sha : `${sha} ${firstParent}`
        child.stdin?.write(`${line}\n${EndOfAnswer}\n`)
      })
    } finally {
      this.pending = null
      this.busy = false
      this.idleTimer = window.setTimeout(this.stop, WorkerIdleTimeout)
    }
  }

  /** End the git process; the next request starts a new one. */
  public stop = () => {
    this.clearIdleTimer()
    this.child?.stdin?.end()
    this.child = null
  }

  private async start(): Promise<ChildProcess> {
    const child = await spawnGit(
      [
        'diff-tree',
        '--stdin',
        '-r',
        '--shortstat',
        '-C',
        '-M',
        '--root',
        '--always',
        '--no-color',
        '--format=%x00%H',
      ],
      this.repositoryPath,
      'commitLineStatsWorker',
      { isBackgroundTask: true }
    )

    this.stdout = ''
    this.stderr = ''
    // A stopped process may still exit or flush after its successor started;
    // only the current one may answer or fail a request.
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (this.child === child) {
        this.onStdout(chunk)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (this.child === child) {
        this.stderr += chunk
      }
    })

    const fail = (error: Error) => {
      if (this.child === child) {
        this.child = null
        this.pending?.reject(error)
      }
    }
    // A write after git has exited surfaces here rather than as a close.
    child.stdin?.on('error', fail)
    child.on('error', fail)
    child.on('close', code =>
      fail(
        new Error(
          `git diff-tree exited with ${code}: ${this.stderr.trim()}`.trim()
        )
      )
    )

    this.child = child
    return child
  }

  private onStdout(chunk: string) {
    this.stdout += chunk
    const match = EndOfAnswerPattern.exec(this.stdout)
    if (match === null) {
      return
    }
    const answer = this.stdout.slice(0, match.index)
    this.stdout = this.stdout.slice(match.index + match[0].length)
    this.pending?.resolve(parseLineStatsAnswer(answer))
  }

  private clearIdleTimer() {
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

/**
 * Parse one answer: a NUL, the SHA, then a shortstat line unless the commit
 * changed nothing. An unknown commit produces no output at all.
 */
function parseLineStatsAnswer(answer: string): ICommitLineStats | null {
  const header = /\0([0-9a-f]+)/.exec(answer)
  if (header === null) {
    return null
  }
  const added = /(\d+) insertions?\(\+\)/.exec(answer)
  const deleted = /(\d+) deletions?\(-\)/.exec(answer)
  return {
    added: added === null ? 0 : parseInt(added[1], 10),
    deleted: deleted === null ? 0 : parseInt(deleted[1], 10),
  }
}

/**
 * The absolute path of the repository's shallow file, which exists only while
 * the clone is shallow. The path is fixed for a repository; its contents are
 * not, so callers may keep the path but should read the file each time.
 */
export async function getShallowFilePath(
  repository: Repository
): Promise<string> {
  const { stdout } = await git(
    ['rev-parse', '--git-path', 'shallow'],
    repository.path,
    'getShallowFilePath'
  )
  return Path.resolve(repository.path, stdout.trim())
}

/**
 * The commits at the boundary of a shallow clone, read from the file at
 * `shallowFilePath`. Git has no parents for them and would diff them against
 * the empty tree, so their line counts are wrong.
 */
export async function readShallowBoundary(
  shallowFilePath: string
): Promise<ReadonlySet<string>> {
  let contents
  try {
    contents = await readFile(shallowFilePath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set()
    }
    throw e
  }

  return new Set(
    contents
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  )
}
