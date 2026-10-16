// Cell declarations for a program's source table, the Float32Array that JavaScript
// writes before an evaluation and that next-state values are written back into.
// Each cell is declared once, with what happens to it around an evaluation, a range
// and an initial value, and cells nest into objects and lists. The table derives
// each cell's position (in declaration order), the circuit's range, grid, exact bit
// and one-hot declarations, the initial table, a validator, and the wire that holds
// each cell's next value.
//
// Building has two phases, since a Circuit needs its source size before the first
// operation exists: declare every cell and call createCircuit, then build behavior,
// pair each state cell with its next value through table.next, and call finish.
//
// A component exports its cell declarations as a plain object and a build function
// that takes the circuit, the table, its cells' wires and the parent's wires, e.g.
// counterCells and buildCounter in cells.test.ts, or photoCells and buildPhotos in
// photo-gallery.ts, which HandwiredOS includes. The parent declares the
// component's cells before createCircuit, either nested in its own declarations,
// e.g. {counters: list(2, () => counterCells)}, or with a second call, e.g.
// table.declare(counterCells, 'extra'), and calls the build function while building.
import {Circuit, type Wire, asWire, describeFirstNaN, invariant} from './numeric-ui-core.ts'

export type Range = readonly [minimum: number, maximum: number]

export const anyNumber: Range = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
export const unitInterval: Range = [0, 1]

// What happens to a cell around an evaluation:
// - constant: set once in the initial table, e.g. a margin of 12 px. The program keeps it.
// - input: JavaScript writes it before an evaluation, e.g. the viewport width. The program keeps it.
// - event: an exact bit that JavaScript sets to 1 when an event arrives, e.g. a pointer
//   press, next to input cells for the event's coordinates. The program resets it to 0.
// - state: the program computes its next value, which builder code pairs with the cell through table.next.
export type CellPolicy = 'constant' | 'input' | 'event' | 'state'

export type CellSpec = {
  readonly kind: 'cell'
  readonly policy: CellPolicy
  readonly range: Range
  readonly initial: number
  // The validator requires exactly 0 or 1.
  readonly exactBit: boolean
  // Every value is a multiple of this power of two, e.g. 1 / 64 for pointer
  // coordinates on a 1/64 px grid. createCircuit declares it with assumeGrid, so
  // emitCompare can build integer bits, and the validator checks it.
  readonly grid: number | undefined
}

export type CellOptions = {initial?: number, grid?: number}
// A bit's grid can only be 1. Declaring it lets sums and products that read the bit keep a grid, e.g. a window's left
// edge that its maximized bit selects, so emitCompare can build integer bits on them.
export type BitOptions = {grid?: 1}

function cell(policy: CellPolicy, range: Range, exactBit: boolean, options: CellOptions): CellSpec {
  invariant(range[0] <= range[1], `a cell's range is inverted: ${range[0]}..${range[1]}`)
  return {kind: 'cell', policy, range, initial: options.initial ?? 0, exactBit, grid: options.grid}
}

export const constant = (value: number, range: Range, options: {grid?: number} = {}): CellSpec =>
  cell('constant', range, false, {...options, initial: value})
export const input = (range: Range, options: CellOptions = {}): CellSpec => cell('input', range, false, options)
// An exact bit that JavaScript writes, e.g. the settle check bit that advanceFrame plans.
export const inputBit = (initial = 0): CellSpec => cell('input', unitInterval, true, {initial})
export const event = (options: BitOptions = {}): CellSpec => cell('event', unitInterval, true, options)
export const state = (range: Range, options: CellOptions = {}): CellSpec => cell('state', range, false, options)
// An exact bit that the program computes, e.g. whether a window is open.
export const stateBit = (initial = 0, options: BitOptions = {}): CellSpec => cell('state', unitInterval, true, {...options, initial})

export function list<Element>(count: number, make: (index: number) => Element): Element[] {
  return Array.from({length: count}, (_, index) => make(index))
}

export type OneHotSpec<Member extends CellSpec = CellSpec> = {
  readonly kind: 'oneHot'
  readonly members: readonly Member[]
  readonly allowAllZero: boolean
  // Whether createCircuit declares the group with assumeOneHot, which lets the
  // compiler turn masked sums over the group into gathers, or only the validator
  // checks it. Declaring a group can change the compiled program.
  readonly declareToCircuit: boolean
}

// Exactly one member is 1, or none when allowAllZero is set, e.g. the selected tab.
export function oneHot<Member extends CellSpec>(
  members: readonly Member[],
  options: {allowAllZero?: boolean, declareToCircuit?: boolean} = {},
): OneHotSpec<Member> {
  invariant(members.every(member => member.exactBit), 'one-hot members must be exact bits, e.g. stateBit()')
  return {kind: 'oneHot', members, allowAllZero: options.allowAllZero ?? false, declareToCircuit: options.declareToCircuit ?? true}
}

export type PermutationSpec = {readonly kind: 'permutation', readonly cells: readonly (readonly CellSpec[])[]}

// A stacking order stored as a permutation matrix: cells[rank][item] is 1 when the
// item is at that rank. Every row and every column is a declared one-hot group.
// order[rank] is the item at that rank, e.g. permutation([2, 0, 1]) puts item 2 at rank 0.
export function permutation(order: readonly number[], options: BitOptions = {}): PermutationSpec {
  invariant([...order].sort((left, right) => left - right).every((item, index) => item === index), `${order.join(', ')} is not a permutation of 0..${order.length - 1}`)
  return {kind: 'permutation', cells: order.map(item => order.map((_, column) => stateBit(Number(column === item), options)))}
}

// The index of each field within a flat struct of cells, and the struct's cell count, e.g. {left: 0, top: 1, size: 2}
// for {left: state(pixel), top: state(pixel)}. For code that reads a struct's cells by index rather than by name.
export function fieldIndices<S extends {readonly [field: string]: CellSpec}>(struct: S): {-readonly [Field in keyof S]: number} & {size: number} {
  const fields = Object.keys(struct)
  return {...Object.fromEntries(fields.map((field, index) => [field, index])), size: fields.length} as {-readonly [Field in keyof S]: number} & {size: number}
}

export type Spec = CellSpec | OneHotSpec | PermutationSpec | readonly Spec[] | {readonly [field: string]: Spec}

// The wires of declared cells, in the declarations' own shape, e.g. {on: Wire, pointer: {x: Wire, y: Wire}}.
export type CellWires<S> =
  S extends CellSpec ? Wire
    : S extends PermutationSpec ? Wire[][]
      : S extends OneHotSpec ? Wire[]
        : {-readonly [Field in keyof S]: CellWires<S[Field]>}

// The numbers that an evaluation gives a struct of wires, in the struct's own shape, e.g. {on: number, pointer: {x: number}}.
export type WireValues<S> = S extends Wire ? number : {-readonly [Field in keyof S]: WireValues<S[Field]>}

type DeclaredCell = {name: string, spec: CellSpec, next: Wire | undefined}
type Rule = {name: string, rule: 'oneHot' | 'atMostOne', members: Wire[], allowAllZero: boolean, declareToCircuit: boolean}

export type SourceTable = {
  declare<S>(spec: S & Spec, name?: string): CellWires<S>
  atMostOne(name: string, members: readonly Wire[]): void
  readonly size: number
  nameOf: (wire: Wire) => string
  policyOf: (wire: Wire) => CellPolicy | undefined
  createCircuit(): Circuit
  next<S>(stored: S & WireStruct, next: NoInfer<S>): void
  finish(): BuiltProgram
}

// What finish returns: the circuit, the wire of each cell's next value, the initial table and its validator.
export type BuiltProgram = {
  circuit: Circuit
  nextSource: Wire[]
  initialSource: Float32Array<ArrayBuffer>
  validate: (source: Float32Array) => void
}

export function createSourceTable(): SourceTable {
  const cells: DeclaredCell[] = []
  const rules: Rule[] = []
  let circuit: Circuit | null = null
  let finished = false

  function declareSpec(name: string, spec: Spec): unknown {
    if (Array.isArray(spec)) return (spec as readonly Spec[]).map((element, index) => declareSpec(`${name}[${index}]`, element))
    const tagged = spec as {kind?: unknown}
    if (tagged.kind === 'cell') {
      cells.push({name, spec: spec as CellSpec, next: undefined})
      return asWire(cells.length - 1)
    }
    if (tagged.kind === 'oneHot') {
      const group = spec as OneHotSpec
      const members = group.members.map((member, index) => declareSpec(`${name}[${index}]`, member) as Wire)
      rules.push({name, rule: 'oneHot', members, allowAllZero: group.allowAllZero, declareToCircuit: group.declareToCircuit})
      return members
    }
    if (tagged.kind === 'permutation') {
      const matrix = (spec as PermutationSpec).cells.map((row, rank) =>
        row.map((member, item) => declareSpec(`${name}[${rank}][${item}]`, member) as Wire))
      matrix.forEach((row, rank) => rules.push({name: `${name} rank ${rank}`, rule: 'oneHot', members: row, allowAllZero: false, declareToCircuit: true}))
      matrix.forEach((_, item) => rules.push({
        name: `${name} item ${item}`, rule: 'oneHot', members: matrix.map(row => row[item]!), allowAllZero: false, declareToCircuit: true,
      }))
      return matrix
    }
    const result: Record<string, unknown> = {}
    for (const [field, fieldSpec] of Object.entries(spec as Record<string, Spec>)) {
      result[field] = declareSpec(name === '' ? field : `${name}.${field}`, fieldSpec)
    }
    return result
  }

  return {
    // Declares cells after the ones declared so far, in the order they're written.
    // `name` prefixes the cells' names in errors, e.g. 'photos' gives 'photos.focus[3]'.
    declare<S>(spec: S & Spec, name = ''): CellWires<S> {
      invariant(circuit === null, 'declare every cell before createCircuit')
      return declareSpec(name, spec) as CellWires<S>
    },
    // A rule that only the validator checks: the members add up to at most 1, e.g. at
    // most one of four pointer event cells that have coordinate cells between them.
    atMostOne(name: string, members: readonly Wire[]) {
      invariant(circuit === null, 'add rules before createCircuit')
      invariant(members.every(member => cells[member]?.spec.exactBit === true), `${name}: members must be exact bits`)
      rules.push({name, rule: 'atMostOne', members: [...members], allowAllZero: true, declareToCircuit: false})
    },
    get size() {
      return cells.length
    },
    nameOf: (wire: Wire) => cells[wire]?.name ?? `wire ${wire}`,
    // What happens to a cell around an evaluation, e.g. 'state', for a host that lists
    // the table, or undefined for a wire that isn't a cell.
    policyOf: (wire: Wire) => cells[wire]?.spec.policy,
    createCircuit() {
      invariant(circuit === null, 'createCircuit may only run once')
      const created = new Circuit(cells.length)
      cells.forEach(({spec}, index) => {
        const wire = created.source(index)
        created.assumeRange(wire, spec.range[0], spec.range[1])
        if (spec.grid !== undefined) created.assumeGrid(wire, spec.grid)
        // The circuit keeps the declaration and builds nothing differently for it, see Circuit.exactBits.
        if (spec.exactBit) created.assumeBit(wire)
      })
      for (const rule of rules) {
        if (rule.declareToCircuit) created.assumeOneHot(rule.members, rule.allowAllZero)
      }
      circuit = created
      return created
    },
    // Pairs every state cell in `stored` with the wire under the same field name or
    // index in `next`, e.g. table.next(cells.spring, {velocity, position}), in any
    // field order. The whole shape is checked before any cell is paired. Both sides
    // hold wires, and the type of `next` comes from `stored` alone, so a plain number
    // on either side doesn't type-check, e.g. table.next(cells.on, 3) or
    // table.next(1, on), while the runtime check only requires 3 to be a wire of the
    // circuit and 1 to be a state cell.
    next<S>(stored: S & WireStruct, next: NoInfer<S>) {
      invariant(circuit !== null, 'call createCircuit before table.next')
      invariant(!finished, 'table.next after finish has no effect')
      const width = circuit.sourceSize + circuit.operations.length
      const pairs: [stored: Wire, next: Wire][] = []
      pairLeaves(stored, next, '', pairs)
      const paired = new Set<Wire>()
      for (const [wire, nextWire] of pairs) {
        const declared = cells[wire]
        invariant(declared !== undefined, `wire ${wire} is not a source cell`)
        invariant(declared.spec.policy === 'state', `${declared.name} is not a state cell`)
        invariant(declared.next === undefined && !paired.has(wire), `${declared.name} already has a next value`)
        invariant(Number.isInteger(nextWire) && nextWire >= 0 && nextWire < width, `the next value of ${declared.name} is not a wire of the circuit`)
        paired.add(wire)
      }
      for (const [wire, nextWire] of pairs) cells[wire]!.next = nextWire
    },
    // Returns the circuit, the wire that holds each cell's next value (a constant or
    // input cell holds itself, and an event holds 0), the initial table, and the
    // validator. Throws when a state cell never received a next value.
    finish() {
      invariant(circuit !== null, 'call createCircuit before finish')
      invariant(!finished, 'finish may only run once')
      const missing = cells.filter(declared => declared.spec.policy === 'state' && declared.next === undefined)
      invariant(missing.length === 0, `${missing.map(declared => declared.name).join(', ')} never received a next value`)
      finished = true
      const built = circuit
      const zero = cells.some(declared => declared.spec.policy === 'event') ? built.constant(0) : undefined
      const nextSource = cells.map((declared, index) => declared.spec.policy === 'event' ? zero! : declared.next ?? built.source(index))
      const initialSource = Float32Array.from(cells, ({spec}) => spec.initial)
      const validate = createValidator(cells, rules)
      validate(initialSource)
      return {circuit: built, nextSource, initialSource, validate}
    },
  }
}

// Wires, and lists and objects of them, e.g. {thumbOffset: Wire, switches: [{on: Wire}]}.
export type WireStruct = Wire | readonly WireStruct[] | {readonly [field: string]: WireStruct}

// Compiles the program for the next-state values and the outputs, and returns a
// function that checks a source table, evaluates it, checks the next-state values
// and that every output is finite, and returns them with the outputs in the output's
// own shape, e.g. {thumbLeft: 614}. An output holds wires, so a plain number, e.g.
// {thumbLeft: 7}, doesn't type-check. When a check after the evaluation fails on a
// NaN value, it runs the same program again and keeps every wire, so the error also
// names the operation that produced the first NaN among the wires that value reads.
// A check that fails on another value, e.g. a next value past its range next to a
// NaN output, throws its own message only. The host decides whether to write
// nextValues back, and the next call overwrites them.
export function createEvaluator<Output>(program: {
  circuit: Circuit
  nextSource: readonly Wire[]
  validate: (source: Float32Array) => void
  // An intersection instead of a constraint on Output: a refused output keeps its own type, e.g. {typo: number},
  // instead of WireStruct, whose WireValues never ends.
  output: Output & WireStruct
}): (source: Float32Array) => {nextValues: Float32Array, output: WireValues<Output>} {
  const {circuit, nextSource, validate, output} = program
  const outputLeaves = collectLeaves(output, '', [])
  const roots = [...nextSource, ...outputLeaves.map(([, wire]) => wire)]
  const tensorProgram = circuit.compileTensorProgram(roots)
  const evaluateRoots = circuit.createTensorProgramEvaluator(tensorProgram)

  // Adds the operation that produced the first NaN to an error about roots[index], when that root's value is NaN.
  function withFirstNaN(error: Error, index: number, source: Float32Array, values: Float32Array): Error {
    if (!Number.isNaN(values[index])) return error
    // The same program again. evaluateTensor leaves the wires that the program removed at 0, so the message names an
    // operation that ran.
    const firstNaN = describeFirstNaN(circuit, circuit.evaluateTensor(source, tensorProgram), [roots[index]!])
    return firstNaN === null ? error : new Error(`${error.message}. ${firstNaN}`)
  }

  return source => {
    validate(source)
    const values = evaluateRoots(source)
    const nextValues = values.subarray(0, nextSource.length)
    try {
      validate(nextValues)
    } catch (error) {
      // A cell's position in the table is also its next value's index in roots. A rule's error names no single value.
      throw error instanceof CellValueError ? withFirstNaN(error, error.position, source, values) : error
    }
    outputLeaves.forEach(([path], index) => {
      const value = values[nextSource.length + index]!
      if (!Number.isFinite(value)) throw withFirstNaN(new Error(`output ${path} must be finite, got ${value}`), nextSource.length + index, source, values)
    })
    let position = nextSource.length
    return {nextValues, output: mapLeaves(output, () => values[position++]!) as WireValues<Output>}
  }
}

// Every wire of a struct of wires, lists and objects, with its path, e.g. ['thumb.offset', 27].
function collectLeaves(struct: unknown, path: string, leaves: [path: string, wire: Wire][]) {
  if (typeof struct === 'number') {
    leaves.push([path, struct as Wire])
  } else if (Array.isArray(struct)) {
    (struct as unknown[]).forEach((element, index) => collectLeaves(element, `${path}[${index}]`, leaves))
  } else {
    invariant(typeof struct === 'object' && struct !== null, 'an output holds wires, lists and objects')
    for (const [field, value] of Object.entries(struct)) collectLeaves(value, path === '' ? field : `${path}.${field}`, leaves)
  }
  return leaves
}

// Replaces every wire with a number, visiting leaves in collectLeaves' order.
function mapLeaves(struct: unknown, map: (wire: Wire) => number): unknown {
  if (typeof struct === 'number') return map(struct as Wire)
  if (Array.isArray(struct)) return (struct as unknown[]).map(element => mapLeaves(element, map))
  const result: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(struct as Record<string, unknown>)) result[field] = mapLeaves(value, map)
  return result
}

// Walks two structs together by field name and index, collecting leaf pairs.
function pairLeaves(stored: unknown, next: unknown, path: string, pairs: [Wire, Wire][]) {
  const at = path === '' ? '' : ` at ${path}`
  if (typeof stored === 'number') {
    invariant(typeof next === 'number', `next state${at} must be a wire`)
    pairs.push([stored as Wire, next as Wire])
  } else if (Array.isArray(stored)) {
    invariant(Array.isArray(next) && next.length === stored.length, `next state${at} must be a list of ${stored.length}`)
    ;(stored as unknown[]).forEach((element, index) => pairLeaves(element, (next as unknown[])[index], `${path}[${index}]`, pairs))
  } else {
    invariant(typeof stored === 'object' && stored !== null, 'stored state holds wires, lists and objects')
    invariant(typeof next === 'object' && next !== null && !Array.isArray(next), `next state${at} must be an object`)
    const storedFields = Object.keys(stored).sort()
    const nextFields = Object.keys(next).sort()
    invariant(storedFields.join() === nextFields.join(), `next state${at} has fields ${nextFields.join(', ')} but the stored struct has ${storedFields.join(', ')}`)
    for (const field of storedFields) {
      pairLeaves((stored as Record<string, unknown>)[field], (next as Record<string, unknown>)[field], path === '' ? field : `${path}.${field}`, pairs)
    }
  }
}

// An error about one cell's value, with the cell's position in the table, so that
// createEvaluator can tell whether the value that failed is NaN.
class CellValueError extends Error {
  readonly position: number
  constructor(message: string, position: number) {
    super(message)
    this.position = position
  }
}

// Checks a table against every declaration: finite and within range, exact bits,
// grids, then one-hot and at-most-one rules. Errors name the cell or rule.
function createValidator(cells: readonly DeclaredCell[], rules: readonly Rule[]) {
  const minimums = Float64Array.from(cells, ({spec}) => spec.range[0])
  const maximums = Float64Array.from(cells, ({spec}) => spec.range[1])
  const bitWires = Int32Array.from(cells.flatMap(({spec}, wire) => spec.exactBit ? [wire] : []))
  // Each cell's grid step sits next to its wire in two typed arrays rather than in {wire, grid} objects. With the objects,
  // V8 kept deoptimizing this validator, most likely because a step is a small integer in some cells and a double in
  // others, e.g. 1 and 1 / 64.
  const gridWires = Int32Array.from(cells.flatMap(({spec}, wire) => spec.grid === undefined ? [] : [wire]))
  const gridSteps = Float64Array.from(gridWires, wire => cells[wire]!.spec.grid!)
  return (source: Float32Array) => {
    invariant(source.length === cells.length, `the table holds ${source.length} numbers, but ${cells.length} cells are declared`)
    for (let wire = 0; wire < source.length; wire++) {
      const value = source[wire]!
      if (!(value >= minimums[wire]! && value <= maximums[wire]! && Number.isFinite(value))) {
        throw new CellValueError(`${cells[wire]!.name} must be finite and within ${minimums[wire]}..${maximums[wire]}, got ${value}`, wire)
      }
    }
    for (let index = 0; index < bitWires.length; index++) {
      const wire = bitWires[index]!
      if (source[wire] !== 0 && source[wire] !== 1) throw new CellValueError(`${cells[wire]!.name} must be exactly 0 or 1, got ${source[wire]}`, wire)
    }
    for (let index = 0; index < gridWires.length; index++) {
      const wire = gridWires[index]!
      const grid = gridSteps[index]!
      if (!Number.isInteger(source[wire]! / grid)) throw new CellValueError(`${cells[wire]!.name} must be a multiple of ${grid}, got ${source[wire]}`, wire)
    }
    for (const rule of rules) {
      let mass = 0
      for (const member of rule.members) mass += source[member]!
      const valid = rule.rule === 'atMostOne' ? mass <= 1 : mass === 1 || (rule.allowAllZero && mass === 0)
      if (!valid) throw new Error(`${rule.name} breaks its ${rule.rule} rule with mass ${mass}`)
    }
  }
}
