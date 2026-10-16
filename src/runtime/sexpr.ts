// A small S-expression language for numeric programs: the text is read, expanded and
// turned into the same builder calls that JavaScript builder code makes, and parse
// returns what table.finish() returns, plus the cells and the outputs by name, e.g.
//
//   const built = parse(`
//     (cell temp   (input -50 50 :grid 1/64))
//     (cell heater (state-bit))
//     (next heater (if (< temp 18) 1 (if (> temp 22) 0 heater)))
//     (output heater)
//   `)
//   const evaluate = createEvaluator(built)
//
// Top-level forms, in the order they're written:
// - (cell name (kind ...)): a cell of the source table, see cellSpec for the kinds.
//   Every cell is declared before any other form runs, wherever it's written.
// - (defn name (param ...) (let local expr) ... expr): a function, inlined at every
//   call, so a call appends its operations again with the arguments' wires.
// - (let name expr): a name for a wire.
// - (next name expr): the next value of a state cell, as table.next.
// - (output name ...): the evaluation's outputs. A state cell with a next value
//   outputs that value, and any other name outputs its wire.
// - (repeat i count form ...): the forms count times, with i replaced by 0, 1, ...
//   It works anywhere, and inside a list its copies are spliced into the list, e.g.
//   (+ (repeat i 3 open[i])) is (+ open[0] open[1] open[2]).
//
// A name in an expression reads the wire under that name, so a state cell's name reads
// the stored value, not the next one. To read a next value, name it with let first.
//
// In a symbol, an index in brackets is computed when repeat replaces its variable, e.g.
// row[i+1] is row[3] when i is 2. That's the only arithmetic on symbols, and repeat's
// replacement is textual, so a defn parameter shouldn't share a repeat variable's name.
//
// Expressions:
// - a number: circuit.constant, and a fraction is read as one number, e.g. 1/64
// - (+ a ...), (- a), (- a b ...): one weighted sum
// - (* a ...): numbers multiply into the sum's weight, and each other factor is an
//   emitMultiply, e.g. (* 2 x) is one weighted sum and (* x y) is a product
// - (/ a number): a weighted sum with the weight 1 / number
// - (< a b), (<= a b), (> a b), (>= a b), (= a b): emitCompare, an exact bit, which
//   needs finite declared ranges, see emitCompare
// - (if bit on off): emitSelect, which needs an exact bit
// - (not bit), (and bit ...), (or bit ...): sums and products of exact bits
// - (relu a), (min a b ...), (max a b ...), (clamp a minimum maximum): emitRelu and
//   the exact minimum, maximum and clamp
// - (f arg ...): a call of a function declared with defn

import {type BuiltProgram, type CellSpec, type Range, constant, createSourceTable, event, input, inputBit, state, stateBit} from './cells.ts'
import {
  type Relation,
  type Wire,
  emitClampExact,
  emitCompare,
  emitMaximumExact,
  emitMinimumExact,
  emitMultiply,
  emitRelu,
  emitSelect,
} from './numeric-ui-core.ts'

// A symbol is a string and a list is an array. A number is read as a number.
type Node = number | string | readonly Node[]

export type ParsedProgram = BuiltProgram & {
  // Each cell's wire by name, e.g. cells['open[2]'], where the host writes inputs and events.
  cells: Record<string, Wire>
  // The wires that createEvaluator returns the values of, by the names in (output ...).
  output: Record<string, Wire>
}

// A mistake in the program's text, with the form it was found in.
export class SexprError extends Error {
  override name = 'SexprError'
}

// A function call that calls itself would expand forever, so calls nest at most this deep.
const maxCallDepth = 64

const relations: {readonly [symbol: string]: Relation} = {'<': '<', '<=': '<=', '>': '>', '>=': '>=', '=': '==='}

export function parse(text: string): ParsedProgram {
  const forms = read(text).flatMap(form => expand(form, new Map()))
  const table = createSourceTable()

  // A Circuit needs the number of cells before its first operation, so every cell is declared first.
  const cells: Record<string, Wire> = {}
  for (const form of forms) {
    if (!isList(form) || form[0] !== 'cell') continue
    const [, name, spec, ...extra] = form
    if (typeof name !== 'string' || spec === undefined || extra.length > 0) fail('expected (cell name (kind ...))', form)
    if (name in cells) fail(`the cell ${name} is declared twice`, form)
    cells[name] = table.declare(cellSpec(spec), name)
  }

  const circuit = table.createCircuit()
  const globals: Scope = {names: new Map(Object.entries(cells)), parent: undefined}
  const functions = new Map<string, {params: string[], body: readonly Node[]}>()
  const nexts = new Map<string, Wire>()
  const output: Record<string, Wire> = {}
  let depth = 0

  function expression(node: Node, scope: Scope): Wire {
    if (typeof node === 'number') return circuit.constant(node)
    if (typeof node === 'string') return lookup(scope, node) ?? fail(`unknown name ${node}`, node)
    const [head, ...args] = node
    if (typeof head !== 'string') fail('a call starts with a name', node)
    const wires = () => args.map(arg => expression(arg, scope))
    const arity = (minimum: number, maximum = minimum) => {
      if (args.length < minimum || args.length > maximum) {
        fail(`${head} takes ${minimum === maximum ? minimum : maximum === Infinity ? `${minimum} or more` : `${minimum} to ${maximum}`} arguments, got ${args.length}`, node)
      }
    }
    const relation = relations[head]
    if (relation !== undefined) {
      arity(2)
      const [a, b] = wires()
      return emitCompare(circuit, a!, relation, b!)
    }
    switch (head) {
      case '+':
        arity(1, Infinity)
        return circuit.affine(wires().map(wire => [wire, 1] as const))
      case '-': {
        arity(1, Infinity)
        const [first, ...rest] = wires()
        return rest.length === 0 ? circuit.affine([[first!, -1]]) : circuit.affine([[first!, 1], ...rest.map(wire => [wire, -1] as const)])
      }
      case '*': {
        arity(1, Infinity)
        let weight = 1
        const factors: Wire[] = []
        for (const arg of args) {
          if (typeof arg === 'number') weight *= arg
          else factors.push(expression(arg, scope))
        }
        if (factors.length === 0) return circuit.constant(weight)
        const product = factors.slice(1).reduce((left, right) => emitMultiply(circuit, left, right), factors[0]!)
        return weight === 1 ? product : circuit.affine([[product, weight]])
      }
      case '/': {
        arity(2)
        const divisor = args[1]
        if (typeof divisor !== 'number' || divisor === 0) fail('/ divides by a nonzero number', node)
        return circuit.affine([[expression(args[0]!, scope), 1 / divisor]])
      }
      case 'if': {
        arity(3)
        const [bit, on, off] = wires()
        return emitSelect(circuit, bit!, off!, on!)
      }
      case 'not':
        arity(1)
        return circuit.affine([[expression(args[0]!, scope), -1]], 1)
      case 'and':
        arity(1, Infinity)
        return wires().reduce((left, right) => emitMultiply(circuit, left, right))
      case 'or':
        arity(1, Infinity)
        // a + b - ab is 1 when either exact bit is.
        return wires().reduce((left, right) => circuit.affine([[left, 1], [right, 1], [emitMultiply(circuit, left, right), -1]]))
      case 'relu':
        arity(1)
        return emitRelu(circuit, expression(args[0]!, scope))
      case 'min':
        arity(1, Infinity)
        return wires().reduce((left, right) => emitMinimumExact(circuit, left, right))
      case 'max':
        arity(1, Infinity)
        return wires().reduce((left, right) => emitMaximumExact(circuit, left, right))
      case 'clamp': {
        arity(3)
        const [value, minimum, maximum] = wires()
        return emitClampExact(circuit, value!, minimum!, maximum!)
      }
      default:
        break
    }
    const called = functions.get(head) ?? fail(`unknown function ${head}`, node)
    arity(called.params.length)
    if (depth >= maxCallDepth) fail(`calls nest more than ${maxCallDepth} deep, e.g. a function that calls itself`, node)
    const local: Scope = {names: new Map(), parent: globals}
    const values = wires()
    called.params.forEach((param, index) => local.names.set(param, values[index]!))
    depth++
    try {
      for (const form of called.body.slice(0, -1)) {
        if (!isList(form) || form[0] !== 'let') fail('a function body is (let name expr) forms and then an expression', form)
        bind(local, form)
      }
      return expression(called.body.at(-1)!, local)
    } finally {
      depth--
    }
  }

  function bind(scope: Scope, form: readonly Node[]) {
    const [, name, body, ...extra] = form
    if (typeof name !== 'string' || body === undefined || extra.length > 0) fail('expected (let name expr)', form)
    if (scope.names.has(name)) fail(`${name} is already defined`, form)
    scope.names.set(name, expression(body, scope))
  }

  for (const form of forms) {
    if (!isList(form)) fail('a top-level form is a list', form)
    switch (form[0]) {
      case 'cell':
        break
      case 'defn': {
        const [, name, params, ...body] = form
        if (typeof name !== 'string' || !isList(params) || !params.every(param => typeof param === 'string') || body.length === 0) {
          fail('expected (defn name (param ...) body)', form)
        }
        if (functions.has(name)) fail(`the function ${name} is defined twice`, form)
        functions.set(name, {params: params as string[], body})
        break
      }
      case 'let':
        bind(globals, form)
        break
      case 'next': {
        const [, name, body, ...extra] = form
        if (typeof name !== 'string' || body === undefined || extra.length > 0) fail('expected (next name expr)', form)
        const stored = cells[name] ?? fail(`${name} is not a cell`, form)
        const wire = expression(body, globals)
        table.next(stored, wire)
        nexts.set(name, wire)
        break
      }
      case 'output':
        for (const name of form.slice(1)) {
          if (typeof name !== 'string') fail('(output name ...) takes names', form)
          output[name] = nexts.get(name) ?? lookup(globals, name) ?? fail(`unknown name ${name}`, form)
        }
        break
      default:
        fail(`unknown top-level form ${show(form[0] ?? '()')}`, form)
    }
  }
  return {cells, output, ...table.finish()}
}

type Scope = {names: Map<string, Wire>, parent: Scope | undefined}

function lookup(scope: Scope | undefined, name: string): Wire | undefined {
  for (let current = scope; current !== undefined; current = current.parent) {
    const wire = current.names.get(name)
    if (wire !== undefined) return wire
  }
  return undefined
}

// (input minimum maximum :grid g :init v), (state minimum maximum ...), (input-bit initial?),
// (state-bit initial?), (event) or (constant value :grid g), with the options of cells.ts.
function cellSpec(node: Node): CellSpec {
  if (!isList(node) || typeof node[0] !== 'string') fail('a cell kind is a list, e.g. (input 0 100)', node)
  const [kind, ...rest] = node
  const positional: number[] = []
  const options: {initial?: number, grid?: number} = {}
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]!
    if (typeof item === 'string' && item.startsWith(':')) {
      const value = rest[++index]
      if (value === undefined) fail(`${item} needs a value`, node)
      if (item === ':init') options.initial = constantValue(value)
      else if (item === ':grid') options.grid = constantValue(value)
      else fail(`unknown option ${item}`, node)
    } else {
      positional.push(constantValue(item))
    }
  }
  const takes = (count: number, optional = 0) => {
    if (positional.length < count || positional.length > count + optional) fail(`${kind} takes ${count + optional === count ? count : `${count} to ${count + optional}`} numbers`, node)
  }
  const range = (): Range => [positional[0]!, positional[1]!]
  const noOptions = (allowed: readonly string[]) => {
    for (const key of Object.keys(options)) if (!allowed.includes(key)) fail(`${kind} takes no ${key === 'initial' ? ':init' : ':grid'}`, node)
  }
  switch (kind) {
    case 'input':
      takes(2)
      return input(range(), options)
    case 'state':
      takes(2)
      return state(range(), options)
    case 'input-bit':
      takes(0, 1)
      noOptions([])
      return inputBit(positional[0] ?? 0)
    case 'state-bit':
      takes(0, 1)
      noOptions([])
      return stateBit(positional[0] ?? 0)
    case 'event':
      takes(0)
      noOptions([])
      return event()
    case 'constant':
      takes(1)
      noOptions(['grid'])
      return constant(positional[0]!, [positional[0]!, positional[0]!], options.grid === undefined ? {} : {grid: options.grid})
    default:
      return fail(`unknown cell kind ${kind}`, node)
  }
}

// A number written as a number or as arithmetic on numbers, e.g. (+ i 1) after repeat replaced i.
function constantValue(node: Node): number {
  if (typeof node === 'number') return node
  if (!isList(node)) fail(`expected a number, got ${node}`, node)
  const [head, ...args] = node
  const values = args.map(constantValue)
  switch (head) {
    case '+': return values.reduce((sum, value) => sum + value, 0)
    case '-': return values.length === 1 ? -values[0]! : values.slice(1).reduce((difference, value) => difference - value, values[0]!)
    case '*': return values.reduce((product, value) => product * value, 1)
    case '/': return values.slice(1).reduce((quotient, value) => quotient / value, values[0]!)
    case '=': return Number(values.length === 2 && values[0] === values[1])
    default: return fail(`expected a number, got ${show(node)}`, node)
  }
}

// Replaces repeat variables and splices repeat's copies into the enclosing list.
function expand(node: Node, variables: ReadonlyMap<string, number>): Node[] {
  if (typeof node === 'number') return [node]
  if (typeof node === 'string') return [substitute(node, variables)]
  if (node[0] === 'repeat') {
    const [, variable, count, ...body] = node
    if (typeof variable !== 'string' || count === undefined || body.length === 0) fail('expected (repeat name count form ...)', node)
    const times = constantValue(expand(count, variables)[0]!)
    if (!Number.isInteger(times) || times < 0) fail(`repeat needs a count that is a whole number, got ${times}`, node)
    const copies: Node[] = []
    for (let index = 0; index < times; index++) {
      const inner = new Map(variables).set(variable, index)
      for (const form of body) copies.push(...expand(form, inner))
    }
    return copies
  }
  return [node.flatMap(child => expand(child, variables))]
}

// i -> 2, and row[i+1] -> row[3], when i is 2.
function substitute(symbol: string, variables: ReadonlyMap<string, number>): Node {
  const value = variables.get(symbol)
  if (value !== undefined) return value
  return symbol.replace(/\[([A-Za-z_][\w-]*)([+-]\d+)?\]/g, (whole, name: string, offset: string | undefined) => {
    const base = variables.get(name)
    return base === undefined ? whole : `[${base + Number(offset ?? 0)}]`
  })
}

// Tokens are parentheses and runs of anything else. A ; starts a comment until the end of the line.
function read(text: string): Node[] {
  const tokens: {text: string, line: number}[] = []
  text.split('\n').forEach((line, index) => {
    for (const match of line.replace(/;.*/, '').matchAll(/[()]|[^\s()]+/g)) tokens.push({text: match[0], line: index + 1})
  })
  let position = 0
  function form(): Node {
    // Both callers check that a token is left.
    const token = tokens[position++]!
    if (token.text === ')') throw new SexprError(`line ${token.line}: a ) without its (`)
    if (token.text !== '(') return atom(token.text)
    const list: Node[] = []
    while (tokens[position]?.text !== ')') {
      if (position >= tokens.length) throw new SexprError(`line ${token.line}: this ( is never closed`)
      list.push(form())
    }
    position++
    return list
  }
  const forms: Node[] = []
  while (position < tokens.length) forms.push(form())
  return forms
}

function atom(token: string): Node {
  const fraction = /^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(token)
  if (fraction !== null) return Number(fraction[1]) / Number(fraction[2])
  if (/^[+-]?(\d|\.\d)/.test(token)) {
    const value = Number(token)
    if (Number.isNaN(value)) throw new SexprError(`${token} is not a number`)
    return value
  }
  return token
}

function isList(node: Node | undefined): node is readonly Node[] {
  return Array.isArray(node)
}

function show(node: Node): string {
  return isList(node) ? `(${node.map(show).join(' ')})` : String(node)
}

function fail(message: string, node: Node): never {
  throw new SexprError(`${message}, in ${show(node)}`)
}
