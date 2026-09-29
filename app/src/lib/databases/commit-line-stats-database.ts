import Dexie from 'dexie'
import { BaseDatabase } from './base-database'
import { ICommitLineStats } from '../../models/commit'

/**
 * How the stored counts were computed. Bump it whenever the git invocation
 * changes what a commit counts as, and rows of any other version are ignored.
 */
const LineStatsFormatVersion = 1

export interface ICommitLineStatsRow {
  readonly repositoryId: number
  readonly sha: string
  readonly version: number
  readonly added: number
  readonly deleted: number
}

/**
 * Line counts per commit, kept across restarts. A commit's counts never
 * change once computed, except through the repository's diff attributes, so
 * each commit is diffed once per repository.
 */
export class CommitLineStatsDatabase extends BaseDatabase {
  public declare lineStats: Dexie.Table<ICommitLineStatsRow, [number, string]>

  public constructor(name: string, schemaVersion?: number) {
    super(name, schemaVersion)

    this.conditionalVersion(1, {
      lineStats: '[repositoryId+sha]',
    })
  }

  /** The stored counts for whichever of `shas` have them. */
  public async getLineStats(
    repositoryId: number,
    shas: ReadonlyArray<string>
  ): Promise<Map<string, ICommitLineStats>> {
    const rows = await this.lineStats.bulkGet(
      shas.map(sha => [repositoryId, sha] as [number, string])
    )
    const stats = new Map<string, ICommitLineStats>()
    for (const row of rows) {
      if (row !== undefined && row.version === LineStatsFormatVersion) {
        stats.set(row.sha, { added: row.added, deleted: row.deleted })
      }
    }
    return stats
  }

  public async putLineStats(
    repositoryId: number,
    stats: ReadonlyMap<string, ICommitLineStats>
  ): Promise<void> {
    await this.lineStats.bulkPut(
      Array.from(stats, ([sha, { added, deleted }]) => ({
        repositoryId,
        sha,
        version: LineStatsFormatVersion,
        added,
        deleted,
      }))
    )
  }
}

let database: CommitLineStatsDatabase | null = null

/**
 * The app's one line stats database, opened on first use so the stores that
 * never show line stats never open it.
 */
export function getCommitLineStatsDatabase(): CommitLineStatsDatabase {
  database ??= new CommitLineStatsDatabase('CommitLineStatsDatabase')
  return database
}
