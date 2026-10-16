import {expect, test} from 'bun:test'
import {createEvaluator, createSourceTable, event, input, list, stateBit} from '../../src/runtime/cells.ts'
import {emitCompare, emitSelect} from '../../src/runtime/numeric-ui-core.ts'
import {SexprError, parse} from '../../src/runtime/sexpr.ts'

const thermostat = `
  ; on below 18, off above 22, and otherwise as it was
  (cell temp   (input -50 50 :grid 1/64))
  (cell heater (state-bit))
  (let cold (< temp 18))
  (let hot  (> temp 22))
  (next heater (if cold 1 (if hot 0 heater)))
  (output heater)
`

test('the thermostat matches plain JavaScript and the same program written as builder code', () => {
  const built = parse(thermostat)
  const evaluate = createEvaluator(built)
  const source = new Float32Array(built.initialSource)

  const table = createSourceTable()
  const cells = table.declare({temp: input([-50, 50], {grid: 1 / 64}), heater: stateBit()})
  const circuit = table.createCircuit()
  const cold = emitCompare(circuit, cells.temp, '<', circuit.constant(18))
  const hot = emitCompare(circuit, cells.temp, '>', circuit.constant(22))
  const heater = emitSelect(circuit, cold, emitSelect(circuit, hot, cells.heater, circuit.constant(0)), circuit.constant(1))
  table.next(cells.heater, heater)
  table.finish()
  expect(built.circuit.operations.length).toBe(circuit.operations.length)

  let expected = 0
  for (const temp of [20, 17, 19, 21, 23, 20, 17.5, 22, 22.015625, -50, 50]) {
    source[built.cells['temp']!] = temp
    const {nextValues, output} = evaluate(source)
    source.set(nextValues)
    expected = temp < 18 ? 1 : temp > 22 ? 0 : expected
    expect(output['heater']).toBe(expected)
  }
})

test('arithmetic, events and clamp: a counter from 0 to 10', () => {
  const built = parse(`
    (cell inc   (event))
    (cell dec   (event))
    (cell count (state 0 10 :grid 1 :init 3))
    (let n (clamp (+ count inc (- dec)) 0 10))
    (next count n)
    (let half (/ n 2))
    (let big (>= n 5))
    (let score (* 2 n (+ big 1)))
    (output count half big score)
  `)
  const evaluate = createEvaluator(built)
  const source = new Float32Array(built.initialSource)
  let count = 3
  for (const key of ['inc', 'inc', 'inc', 'inc', 'inc', 'inc', 'inc', 'inc', 'dec', 'dec', 'dec', 'dec', 'dec', 'dec', 'dec', 'dec', 'dec', 'dec', 'dec']) {
    source[built.cells[key]!] = 1
    const {nextValues, output} = evaluate(source)
    source.set(nextValues)
    count = Math.min(10, Math.max(0, count + (key === 'inc' ? 1 : -1)))
    const big = Number(count >= 5)
    expect(output).toEqual({count, half: count / 2, big, score: 2 * count * (big + 1)})
  }
})

test('defn and repeat: three switches and the number that are on, as builder code with a loop and a function', () => {
  const built = parse(`
    (repeat i 3
      (cell click[i] (event))
      (cell on[i] (state-bit (= i 1))))
    (defn toggle (on click)
      (let flipped (not on))
      (if click flipped on))
    (repeat i 3
      (let next-on[i] (toggle on[i] click[i]))
      (next on[i] next-on[i]))
    (let count (+ (repeat i 3 next-on[i])))
    (let all (and (repeat i 3 next-on[i])))
    (let any (or (repeat i 3 next-on[i])))
    (output count all any (repeat i 3 on[i]))
  `)

  const table = createSourceTable()
  const cells = table.declare({switches: list(3, index => ({click: event(), on: stateBit(Number(index === 1))}))})
  const circuit = table.createCircuit()
  const toggle = (on: typeof cells.switches[number]['on'], click: typeof on) => emitSelect(circuit, click, on, circuit.affine([[on, -1]], 1))
  const nextOn = cells.switches.map(({on, click}) => toggle(on, click))
  cells.switches.forEach(({on}, index) => table.next(on, nextOn[index]!))
  circuit.affine(nextOn.map(wire => [wire, 1] as const))
  table.finish()
  // The same program up to count appends the same operations as the builder code.
  const upToCount = parse(`
    (repeat i 3 (cell click[i] (event)) (cell on[i] (state-bit (= i 1))))
    (defn toggle (on click) (if click (not on) on))
    (repeat i 3 (let next-on[i] (toggle on[i] click[i])) (next on[i] next-on[i]))
    (let count (+ (repeat i 3 next-on[i])))
    (output count)
  `)
  expect(upToCount.circuit.operations.length).toBe(circuit.operations.length)
  expect(Object.keys(built.cells)).toEqual(['click[0]', 'on[0]', 'click[1]', 'on[1]', 'click[2]', 'on[2]'])

  const evaluate = createEvaluator(built)
  const source = new Float32Array(built.initialSource)
  const on = [0, 1, 0]
  for (const clicks of [[0], [2], [1], [0, 2], [], [1], [0, 1, 2]]) {
    for (const index of clicks) source[built.cells[`click[${index}]`]!] = 1
    const {nextValues, output} = evaluate(source)
    source.set(nextValues)
    for (const index of clicks) on[index] = 1 - on[index]!
    expect(output).toEqual({
      count: on[0]! + on[1]! + on[2]!,
      all: Number(on.every(bit => bit === 1)),
      any: Number(on.some(bit => bit === 1)),
      'on[0]': on[0]!,
      'on[1]': on[1]!,
      'on[2]': on[2]!,
    })
  }
})

test('an index in brackets takes arithmetic: a shift register', () => {
  const built = parse(`
    (cell in (input-bit))
    (repeat i 4 (cell r[i] (state-bit)))
    (next r[0] in)
    (repeat i 3 (next r[i+1] r[i]))
    (output (repeat i 4 r[i]))
  `)
  const evaluate = createEvaluator(built)
  const source = new Float32Array(built.initialSource)
  const bits = [1, 0, 1, 1, 0, 0, 0]
  const register = [0, 0, 0, 0]
  for (const bit of bits) {
    source[built.cells['in']!] = bit
    const {nextValues, output} = evaluate(source)
    source.set(nextValues)
    register.unshift(bit)
    register.pop()
    expect(Object.values(output)).toEqual(register)
  }
})

test('mistakes are named', () => {
  const error = (text: string) => {
    try {
      parse(text)
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(SexprError)
      return (thrown as Error).message
    }
    throw new Error('parse accepted the text')
  }
  expect(error('(cell x (input 0 1)')).toContain('line 1: this ( is never closed')
  expect(error('(cell x (input 0 1)))')).toContain('line 1: a ) without its (')
  expect(error('(cell x (input 0 1)) (output y)')).toContain('unknown name y')
  expect(error('(cell x (input 0 1)) (let y (frob x))')).toContain('unknown function frob')
  expect(error('(cell x (input 0 1)) (let y (if x 1))')).toContain('if takes 3 arguments, got 2')
  expect(error('(cell x (sometimes))')).toContain('unknown cell kind sometimes')
  expect(error('(cell x (input 0 1 :step 2))')).toContain('unknown option :step')
  expect(error('(cell x (input 0 1)) (cell x (input 0 1))')).toContain('the cell x is declared twice')
  expect(error('(cell x (input 0 1)) (let y x) (next y x)')).toContain('y is not a cell')
  expect(error('(repeat i -1 (cell x (event)))')).toContain('whole number')
  expect(error('(cell x (input 0 1)) (defn f (a) (f a)) (let y (f x))')).toContain('calls nest more than 64 deep')
  expect(error('(cell x (input 0 1)) (let y (/ x 0))')).toContain('nonzero')
  // The runtime's own checks still apply, e.g. a state cell that never gets a next value.
  expect(() => parse('(cell s (state-bit))')).toThrow('s never received a next value')
})
