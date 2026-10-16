// Host timing for springs whose step matrix JavaScript writes into source cells.
//
// Everything here is float64 JavaScript that runs between evaluations. It never
// builds operations and never touches the DOM. numeric-ui-core.ts builds and
// runs the program, while this module decides what the host writes before each
// evaluation: times on a 1/64 ms grid, how many fixed 4 ms spring steps an
// evaluation runs, the spring matrix for that step count, when to evaluate
// between two frames so that springs are stepped to each event's timestamp
// before the event is applied, and settle at fixed simulated times, and when to
// snap every animated object onto its destination because a frame would need
// more steps than its static cap.
//
// Ported from lab/ui-exploration/event-time (spring-math.ts, from spring-bank: the
// step matrix, matrix powers, and the capped clock; commits at event timestamps,
// and settle checks at multiples of 16 steps),
// lab/ui-exploration/input (event times relative to the frame), and
// lab/ui-exploration/guide/examples/springs (frame-rate-check.ts: stepping to each
// event's timestamp before applying the event).
import {invariant} from './numeric-ui-core.ts'

export type SpringClockConfig = {
  // Times are rounded to multiples of 1 / timeGrid ms, e.g. 64 for a 1/64 ms grid.
  timeGrid: number
  // One spring step simulates this many milliseconds.
  stepMs: number
  // The most steps that the evaluations of one frame run together, e.g. 300 steps
  // (1,200 ms), like chenguini's ui.md. When a frame would need more, every
  // animated object snaps onto its destination instead, see advanceFrame.
  maxStepsPerFrame: number
  // Settling is checked every this many steps of simulated time, counted from
  // the moment the clock started.
  settleCheckSteps: number
}

export const defaultSpringClockConfig: SpringClockConfig = {
  timeGrid: 64,
  stepMs: 4,
  maxStepsPerFrame: 300,
  settleCheckSteps: 16,
}

export function validateSpringClockConfig(config: SpringClockConfig) {
  const {timeGrid, stepMs, maxStepsPerFrame, settleCheckSteps} = config
  invariant(
    Number.isInteger(timeGrid) && timeGrid >= 1 && Number.isInteger(Math.log2(timeGrid)),
    `the time grid must be a whole power of two, got ${timeGrid}`,
  )
  invariant(stepMs > 0 && Number.isInteger(stepMs * timeGrid), 'a spring step must be a positive multiple of the time grid')
  invariant(Number.isInteger(maxStepsPerFrame) && maxStepsPerFrame >= 1, 'maxStepsPerFrame must be a positive integer')
  invariant(Number.isInteger(settleCheckSteps) && settleCheckSteps >= 1, 'settleCheckSteps must be a positive integer')
  // quantizeFrameTiming's durations and event times are multiples of the grid
  // within maxStepsPerFrame × stepMs, which FP32 holds exactly while that span stays
  // within 2^24 grid steps. PlannedEvaluation.durationMs isn't clamped there.
  invariant(maxStepsPerFrame * stepMs * timeGrid <= 2 ** 24, 'maxStepsPerFrame × stepMs must stay within 2^24 grid steps')
}

// A timestamp rounded to the time grid, e.g. 16.6667 ms becomes 16.671875 ms on
// the 1/64 ms grid. Quantizing absolute timestamps before subtracting makes the
// durations of any split of a time span add up to the same number. `+ 0` turns
// -0 into +0.
export function quantizeTimeMs(timeStamp: number, config: SpringClockConfig = defaultSpringClockConfig): number {
  invariant(Number.isFinite(timeStamp), `a timestamp must be finite, got ${timeStamp}`)
  return Math.round(timeStamp * config.timeGrid) / config.timeGrid + 0
}

export type FrameTiming = {
  // The frame's own timestamp on the grid, never before the previous frame.
  frameTimeMs: number
  // Time since the previous frame, or 0 for the first frame after idle, i.e.
  // when previousFrameTimeMs is null. At most maxStepsPerFrame × stepMs, 1,200 ms
  // by default, since springs snap past that.
  durationMs: number
  // Each event's time relative to the frame, e.g. -3.5 for a press 3.5 ms before
  // the frame. Clamped to 0 for an event after the frame's timestamp. An older
  // event is clamped to the later of the previous frame and -maxStepsPerFrame ×
  // stepMs, or to -maxStepsPerFrame × stepMs after idle, like durationMs. E.g.
  // after a 100 s stall, a press 99 s before the frame reads -1,200, although it
  // came after the previous frame.
  eventTimesMs: number[]
}

// What JavaScript writes into a program's time cells for one frame: the frame's
// duration and its events' times relative to the frame, on the time grid.
// Absolute timestamps stay in float64 here, since an FP32 cell holding
// performance.now() stores it on a 0.5 ms grid from about 70 minutes into a session.
/** @public */
export function quantizeFrameTiming(
  frameTimeStamp: number,
  previousFrameTimeMs: number | null,
  eventTimeStamps: readonly number[],
  config: SpringClockConfig = defaultSpringClockConfig,
): FrameTiming {
  validateSpringClockConfig(config)
  const capMs = config.maxStepsPerFrame * config.stepMs
  let frameTimeMs = quantizeTimeMs(frameTimeStamp, config)
  if (previousFrameTimeMs !== null) frameTimeMs = Math.max(frameTimeMs, previousFrameTimeMs)
  const durationMs = previousFrameTimeMs === null ? 0 : Math.min(capMs, frameTimeMs - previousFrameTimeMs)
  const earliestEventMs = previousFrameTimeMs === null
    ? -capMs
    : Math.max(-capMs, previousFrameTimeMs - frameTimeMs)
  const eventTimesMs = eventTimeStamps.map(timeStamp =>
    Math.min(0, Math.max(earliestEventMs, quantizeTimeMs(timeStamp, config) - frameTimeMs)) + 0)
  return {frameTimeMs, durationMs, eventTimesMs}
}

export type StepCount = {
  // floor(pendingMs / stepMs), or 0 when snapping.
  steps: number
  // Pending time that these steps don't simulate, less than one step, carried
  // into a later evaluation. 0 when snapping.
  leftoverMs: number
  // true when more than stepBudget steps are pending. The host then snaps every
  // animated object onto its destination with zero velocity instead of stepping,
  // and drops the pending time.
  snap: boolean
}

// How many steps an evaluation runs. pendingMs is the time since the springs last
// stepped, on the time grid, and stepBudget is what's left of the frame's
// maxStepsPerFrame. E.g. 17.5 ms pending runs 4 steps and carries 1.5 ms, and
// 1,300 ms pending with a budget of 300 snaps. ui.md's
// Math.min(300, Math.floor((now - animatedUntilTime) / 4)) carries the time past
// the cap into later frames instead, and chenglou.github.io's index.ts runs every
// pending step with no cap.
export function countSpringSteps(
  pendingMs: number,
  stepBudget: number,
  config: SpringClockConfig = defaultSpringClockConfig,
): StepCount {
  invariant(Number.isInteger(pendingMs * config.timeGrid) && pendingMs >= 0, `pending time must lie on the time grid and be nonnegative, got ${pendingMs}`)
  invariant(Number.isInteger(stepBudget) && stepBudget >= 0, 'the step budget must be a nonnegative integer')
  const steps = Math.floor(pendingMs / config.stepMs)
  if (steps > stepBudget) return {steps: 0, leftoverMs: 0, snap: true}
  return {steps, leftoverMs: pendingMs - steps * config.stepMs, snap: false}
}

export type SpringConstants = {stiffness: number, damping: number}

// (displacement, velocity) after the steps, as
//   displacement' = m[0] * displacement + m[1] * velocity
//   velocity'     = m[2] * displacement + m[3] * velocity
export type SpringMatrix = readonly [
  displacementFromDisplacement: number,
  displacementFromVelocity: number,
  velocityFromDisplacement: number,
  velocityFromVelocity: number,
]

export const identitySpringMatrix: SpringMatrix = [1, 0, 0, 1]

// One semi-implicit Euler step of index.ts's stepSpringTo as a matrix:
//   velocity' = velocity + (-stiffness * displacement - damping * velocity) * dt
//   displacement' = displacement + velocity' * dt
export function springStepMatrix(constants: SpringConstants, stepMs: number = defaultSpringClockConfig.stepMs): SpringMatrix {
  invariant(
    Number.isFinite(constants.stiffness) && constants.stiffness >= 0
      && Number.isFinite(constants.damping) && constants.damping >= 0,
    'stiffness and damping must be finite and nonnegative',
  )
  const dt = stepMs / 1000
  const velocityKeep = 1 - constants.damping * dt
  return [1 - constants.stiffness * dt * dt, dt * velocityKeep, -constants.stiffness * dt, velocityKeep]
}

export function multiplySpringMatrices(left: SpringMatrix, right: SpringMatrix): SpringMatrix {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
  ]
}

// matrix^count by repeated squaring, e.g. the spring matrix of 4 steps is
// springMatrixPower(springStepMatrix(constants), 4). Every power of one matrix
// commutes, so the result is the same real matrix as `count` single steps, within
// float64 rounding.
export function springMatrixPower(matrix: SpringMatrix, count: number): SpringMatrix {
  invariant(Number.isInteger(count) && count >= 0, `a step count must be a nonnegative integer, got ${count}`)
  let result = identitySpringMatrix
  let square = matrix
  let remaining = count
  while (remaining > 0) {
    if (remaining % 2 === 1) result = multiplySpringMatrices(result, square)
    remaining = Math.floor(remaining / 2)
    if (remaining > 0) square = multiplySpringMatrices(square, square)
  }
  return result
}

// The magnitude to declare on the 4 matrix cells before building, e.g. 10.4 for
// stiffness 650 and damping 45: the largest |entry| of M^n for n = 0..maxStepsPerFrame,
// with a little headroom so the FP32 value of every entry the host writes stays
// within it. Throws for a spring whose powers overflow, e.g. an unstable
// stiffness far above 250,000 with 4 ms steps.
export function springMatrixBound(constants: SpringConstants, config: SpringClockConfig = defaultSpringClockConfig): number {
  const step = springStepMatrix(constants, config.stepMs)
  let power = identitySpringMatrix
  let bound = 1
  for (let steps = 1; steps <= config.maxStepsPerFrame; steps++) {
    power = multiplySpringMatrices(power, step)
    for (const entry of power) bound = Math.max(bound, Math.abs(entry))
  }
  // Rounding is monotone, so f(entry) <= f(bound) for every |entry| <= bound.
  const declared = Math.fround(bound * (1 + 1e-6))
  invariant(Number.isFinite(declared), 'the spring matrix overflows FP32 within maxStepsPerFrame steps')
  return declared
}

// index.ts's animatedUntilTime plus what planning between frames needs.
export type SpringClock = {
  // How far springs have stepped, on the time grid, or null while the clock is
  // stopped because the last evaluation reported that nothing animates.
  animatedUntilMs: number | null
  // Settle checks run at checkOriginMs + k × settleCheckSteps × stepMs, where
  // checkOriginMs is the time the clock last started.
  checkOriginMs: number
  // The time of the last evaluation that wrote state back, or null after idle.
  lastEvaluationMs: number | null
}

export const stoppedSpringClock: SpringClock = {animatedUntilMs: null, checkOriginMs: 0, lastEvaluationMs: null}

// 'settle check': runs steps up to a fixed simulated time and checks settling
// there, with no events. 'events': runs steps up to the events' timestamp, then
// applies every event with that timestamp. 'frame': runs steps up to the frame's
// timestamp for what's on screen. 'snap': runs no steps and snaps every animated
// object onto its destination with zero velocity, because stepping to the next
// evaluation's time would run more steps than what's left of the frame's
// maxStepsPerFrame.
export type EvaluationKind = 'settle check' | 'events' | 'frame' | 'snap'

// 'every evaluation': every evaluation writes next state back.
// 'events and settle checks': only 'events', 'settle check' and 'snap' evaluations
// write state back, and a 'frame' evaluates a copy of the table, so stored state
// doesn't depend on which frames ran (event-time's commits).
export type WriteBack = 'every evaluation' | 'events and settle checks'

// Checked at runtime too, since JavaScript callers can pass any string, and
// every policy other than 'every evaluation' would otherwise read as commits.
const writeBackPolicies: ReadonlySet<string> = new Set<WriteBack>(['every evaluation', 'events and settle checks'])

export type PlannedEvaluation<Event> = {
  kind: EvaluationKind
  // On the time grid.
  timeMs: number
  // How far springs have stepped after this evaluation, e.g. a settle check's
  // fixed simulated time. Equals timeMs for a settle check or a snap, or while the
  // clock is stopped, and is up to 4 ms before timeMs otherwise.
  simulatedTimeMs: number
  // Time since the last evaluation that wrote state back, or 0 after idle, on the
  // time grid. Not clamped, e.g. 2,000 ms for the snap after a 2 s stall, so a
  // program cell holding it needs a declared range of its own, and FP32 holds it
  // exactly only within 2^24 grid steps, e.g. 262,144 ms on the 1/64 ms grid.
  durationMs: number
  // Write springMatrixPower(springStepMatrix(constants), steps) into each
  // stiffness and damping pair's 4 matrix cells.
  steps: number
  // Write 1 into the program's settle check cell when true, 0 otherwise.
  settleCheck: boolean
  // Write 1 into the program's snap cells when true, e.g. the cell read by the snap
  // option of every emitAnimatedObject, and 0 otherwise. true only for a 'snap'.
  snap: boolean
  // The events this evaluation applies, all at timeMs, in delivery order.
  events: readonly Event[]
  // false for a frame with 'events and settle checks': evaluate a copy of the table.
  writesBack: boolean
}

type TimedEvent = {readonly timeStamp: number}

// Plans and runs one frame's evaluations. `evaluate` writes the evaluation's
// matrices, settle check bit, snap bit and events into the table, runs the program,
// writes next state back when `writesBack` is true, and returns whether anything
// still animates. Returns the clock after the frame; the host keeps requesting
// frames while clock.animatedUntilMs isn't null.
//
// The ordering rule: before an event with timestamp T is applied, springs step to
// T toward the destinations that were in effect before T, so a new destination
// starts pulling within 4 ms of T at any frame rate. chenguini's ui.md orders a
// frame as handle inputs, new layout, animation tick, so a frame's catch-up steps
// all pull toward the new destination, starting from up to one frame plus 4 ms
// before the event, and an animation from rest starts at the frame's timestamp,
// up to one frame after the event. Both depend on the frame rate.
//
// Settling is checked only by 'settle check' evaluations, at simulated times
// checkOriginMs + 64 k ms by default, and by an evaluation while the clock is
// stopped, which starts the clock at its own time. A settle check at simulated
// time c runs before events with timestamps at or after c, so every frame rate
// checks the same state against the same destinations.
//
// Static bounds, and what happens past them:
// - A frame's evaluations run at most maxStepsPerFrame steps together, 300 by
//   default. Before each 'events' or 'frame' evaluation, when stepping to its time
//   would run more steps than what's left of that budget, a 'snap' evaluation first
//   snaps every animated object onto its destination with zero velocity and stops
//   the clock, which drops the backlog, and the evaluation then runs with the
//   clock stopped. E.g. the first frame after a 2 s stall shows every object at
//   its destination. An event during such a stall still applies at its own
//   timestamp, after springs snap onto the destinations in effect before it, so
//   its animation starts at its timestamp. When stepping from the event to the
//   next evaluation runs past what's left of the budget, springs snap again, onto
//   the event's destinations.
// - The steps count from animatedUntilMs, where springs last stepped in state that
//   was written back. With 'every evaluation', that's less than 4 ms before the
//   previous frame, so a frame gap of at most 1,200 ms never snaps. With 'events
//   and settle checks', a frame evaluates a copy, so the steps count from the last
//   event or settle check, which is less than 64 ms before the previous frame, and
//   a frame gap from just above 1,140 ms can snap, depending on where the last
//   settle check landed. So whether a snap runs can differ across frame rates, and
//   so can the stored state after it.
// - An event with a timestamp before the last evaluation that wrote state back is
//   applied at that evaluation's time, and one after the frame's timestamp at the frame's.
export function advanceFrame<Event extends TimedEvent>(
  clock: SpringClock,
  frameTimeStamp: number,
  events: readonly Event[],
  evaluate: (evaluation: PlannedEvaluation<Event>) => boolean,
  writeBack: WriteBack = 'every evaluation',
  config: SpringClockConfig = defaultSpringClockConfig,
): SpringClock {
  validateSpringClockConfig(config)
  invariant(writeBackPolicies.has(writeBack), `writeBack must be 'every evaluation' or 'events and settle checks', got ${String(writeBack)}`)
  const checkIntervalMs = config.stepMs * config.settleCheckSteps
  let {animatedUntilMs, checkOriginMs, lastEvaluationMs} = clock
  let stepBudget = config.maxStepsPerFrame
  const earliestMs = lastEvaluationMs ?? Number.NEGATIVE_INFINITY
  const frameTimeMs = Math.max(quantizeTimeMs(frameTimeStamp, config), earliestMs)

  const run = (kind: EvaluationKind, timeMs: number, steps: number, settleCheck: boolean, eventsHere: readonly Event[]) => {
    const writesBack = kind !== 'frame' || writeBack === 'every evaluation'
    const simulatedTimeMs = animatedUntilMs === null ? timeMs : animatedUntilMs + steps * config.stepMs
    const animating = evaluate({
      kind,
      timeMs,
      simulatedTimeMs,
      durationMs: lastEvaluationMs === null ? 0 : timeMs - lastEvaluationMs,
      steps,
      settleCheck,
      snap: kind === 'snap',
      events: eventsHere,
      writesBack,
    })
    // A frame on a copy runs at most what's left of the budget, and leaves it and
    // the clock unchanged.
    if (!writesBack) return
    stepBudget -= steps
    if (animatedUntilMs === null && animating) {
      // A stopped clock counts no time. An evaluation that finds something
      // animating starts the clock at its own time.
      checkOriginMs = timeMs
    }
    animatedUntilMs = animating ? simulatedTimeMs : null
    // Idle starts as soon as an evaluation reports that nothing animates, e.g. at
    // a settle check in the middle of a 10 fps frame, so the next evaluation's
    // duration is 0 whichever frame it lands in.
    lastEvaluationMs = animating ? timeMs : null
  }

  // Read through a function, since run() can stop the clock inside a loop that
  // started with it running.
  const readAnimatedUntilMs = (): number | null => animatedUntilMs

  const stepTo = (targetMs: number, kind: 'events' | 'frame', eventsHere: readonly Event[]) => {
    if (animatedUntilMs !== null && countSpringSteps(targetMs - animatedUntilMs, stepBudget, config).snap) {
      // Past the budget: stop the clock, which drops the backlog, and snap. Like any
      // evaluation while the clock is stopped, the snap checks settling, and starts
      // the clock at its own time if something still animates.
      animatedUntilMs = null
      run('snap', targetMs, 0, true, [])
    }
    if (animatedUntilMs !== null) {
      // Settle checks at every fixed simulated time up to the target, including one
      // that lands exactly where the target evaluation ends. Together with the
      // target's own steps they fit what's left of the budget, since the steps up to
      // the target did.
      for (let untilMs = readAnimatedUntilMs(); untilMs !== null; untilMs = readAnimatedUntilMs()) {
        const reachableMs = untilMs + countSpringSteps(targetMs - untilMs, stepBudget, config).steps * config.stepMs
        const nextCheckMs = checkOriginMs
          + (Math.floor((untilMs - checkOriginMs) / checkIntervalMs) + 1) * checkIntervalMs
        if (nextCheckMs > reachableMs) break
        run('settle check', Math.max(nextCheckMs, lastEvaluationMs ?? nextCheckMs), (nextCheckMs - untilMs) / config.stepMs, true, [])
      }
    }
    if (animatedUntilMs === null) {
      run(kind, targetMs, 0, true, eventsHere)
      return
    }
    run(kind, targetMs, countSpringSteps(targetMs - animatedUntilMs, stepBudget, config).steps, false, eventsHere)
  }

  const timedEvents = events
    .map((event, index) => ({event, index, timeMs: Math.min(frameTimeMs, Math.max(earliestMs, quantizeTimeMs(event.timeStamp, config)))}))
    .sort((left, right) => left.timeMs - right.timeMs || left.index - right.index)
  for (let start = 0; start < timedEvents.length;) {
    const {timeMs} = timedEvents[start]!
    let end = start
    while (end < timedEvents.length && timedEvents[end]!.timeMs === timeMs) end++
    stepTo(timeMs, 'events', timedEvents.slice(start, end).map(({event}) => event))
    start = end
  }
  stepTo(frameTimeMs, 'frame', [])
  return {animatedUntilMs, checkOriginMs, lastEvaluationMs}
}
