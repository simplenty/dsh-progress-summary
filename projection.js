/**
 * The `progressSummary` session projection — the transport that makes one
 * narrator line visible to the Web client.
 *
 * A projection folds committed session events, so a value that exists only in
 * host memory (the narrator's latest line) needs a committed carrier. That
 * carrier is `plugin:progress-summary/line`, an *ignorable* plugin record: it
 * streams to clients in real time, survives resume, and is skipped by readers
 * that do not know it. The record is small (one line, a turn number, a few
 * scalars), written once per accepted summary — capped by the narrator policy.
 * @module dsh-progress-summary/projection
 */

/** Projection key the browser reads: `useProjection('progressSummary')`. */
export const PROGRESS_PROJECTION_KEY = 'progressSummary'

/** Committed carrier of one narrator line. */
export const PROGRESS_RECORD_TYPE = 'plugin:progress-summary/line'

/** Bumped when the folded state or the wire value changes shape. */
export const PROGRESS_STATE_VERSION = 1

/**
 * The projection's fold state is already the wire value. The registry calls
 * `viewSchema.parse` on every publication, so this pass-through schema keeps
 * the value JSON as committed without adding a schema dependency.
 */
const passThroughSchema = { parse: value => value }

/**
 * Build the projection definition registered on `ctx.sessionProjections`.
 * @param {object} [options] - overrides used by tests.
 * @param {() => number} [options.now] - clock for the idle timestamp.
 * @returns {object} a `ProjectionDefinition` for `progressSummary`.
 */
export function createProgressProjection(options = {}) {
  const now = options.now ?? Date.now
  return {
    key: PROGRESS_PROJECTION_KEY,
    stateSchema: passThroughSchema,
    stateVersion: PROGRESS_STATE_VERSION,
    init: () => ({
      line: '',
      state: 'idle',
      turn: 0,
      at: 0,
      calls: 0,
    }),
    apply: (state, event) => {
      // A turn boundary is authoritative even without a narrator record: on a
      // cold read (resume / restart) the last record of a finished turn must
      // not resurrect a line that says "running".
      if (event.type === 'turn/start') {
        const turn = Number(event.data?.turn ?? 0)
        if (state.state === 'idle' && state.line === '' && state.turn === turn) return state
        return { ...state, line: '', state: 'idle', turn }
      }
      if (event.type === 'turn/end') {
        if (state.state === 'idle' && state.line === '') return state
        return { ...state, line: '', state: 'idle' }
      }
      if (event.type !== PROGRESS_RECORD_TYPE) return state
      const data = event.data ?? {}
      return {
        line: typeof data.line === 'string' ? data.line : '',
        state: data.state === 'running' ? 'running' : 'idle',
        turn: Number.isFinite(data.turn) ? data.turn : 0,
        at: Number.isFinite(data.at) ? data.at : Number(now()),
        calls: Number.isFinite(data.calls) ? data.calls : 0,
      }
    },
    wire: {
      viewSchema: passThroughSchema,
      view: state => state,
    },
  }
}
