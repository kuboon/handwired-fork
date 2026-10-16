# @kuboon/handwired

The runtime of [Handwired](https://github.com/chenglou/handwired), by Cheng Lou, published from the fork [kuboon/handwired-fork](https://github.com/kuboon/handwired-fork). With it you write a numeric program: a fixed list of weighted sums and products with a ReLU over 32-bit floats, which is evaluated once per frame on a `Float32Array`. The program has no branches, every evaluation runs the same operations, and it's differentiable. The repo's [docs](https://github.com/kuboon/handwired-fork/tree/main/docs) explain the model, starting with the tutorial.

- `@kuboon/handwired`: `Circuit` and the builder functions, e.g. `emitCompare` and `emitSelect` (numeric-ui-core.ts), the cell declarations and `createEvaluator` (cells.ts), the frame planning and spring matrices (host-timing.ts), and the prefix networks (prefix-networks.ts)
- `@kuboon/handwired/sexpr`: `parse`, which builds a program from S-expression text instead of builder code (sexpr.ts)

## Builder code

```ts
import {createEvaluator, createSourceTable, emitCompare, emitSelect, input, stateBit} from 'jsr:@kuboon/handwired'

const table = createSourceTable()
const cells = table.declare({temp: input([-50, 50], {grid: 1 / 64}), heater: stateBit()})
const circuit = table.createCircuit()
const cold = emitCompare(circuit, cells.temp, '<', circuit.constant(18))
const hot = emitCompare(circuit, cells.temp, '>', circuit.constant(22))
// cold ? 1 : hot ? 0 : heater
const heater = emitSelect(circuit, cold, emitSelect(circuit, hot, cells.heater, circuit.constant(0)), circuit.constant(1))
table.next(cells.heater, heater)
const evaluate = createEvaluator({...table.finish(), output: {heater}})
```

## The same program as text

```ts
import {createEvaluator} from 'jsr:@kuboon/handwired'
import {parse} from 'jsr:@kuboon/handwired/sexpr'

const built = parse(`
  (cell temp   (input -50 50 :grid 1/64))
  (cell heater (state-bit))
  (next heater (if (< temp 18) 1 (if (> temp 22) 0 heater)))
  (output heater)
`)
const evaluate = createEvaluator(built)

// The host writes inputs, evaluates, and copies the next state back.
const source = new Float32Array(built.initialSource)
source[built.cells['temp']!] = 17
const {nextValues, output} = evaluate(source)
source.set(nextValues)
console.log(output['heater']) // 1
```

`defn` declares a function that is inlined at each call, and `repeat` copies forms, with an index in brackets for the names, e.g. three switches and the number that are on:

```lisp
(repeat i 3
  (cell click[i] (event))
  (cell on[i] (state-bit)))
(defn toggle (on click) (if click (not on) on))
(repeat i 3
  (let next-on[i] (toggle on[i] click[i]))
  (next on[i] next-on[i]))
(let count (+ (repeat i 3 next-on[i])))
(output count)
```

The comment at the top of sexpr.ts lists every form and operator.
