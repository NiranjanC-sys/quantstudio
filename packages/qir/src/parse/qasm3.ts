/**
 * OpenQASM 3 parser: the code-to-builder direction.
 *
 * Deliberately a subset: declarations, gate calls with `ctrl @` modifiers,
 * measure, reset, barrier, and single-line `if` conditions. That is everything
 * the builder can express, so a round trip through QASM is lossless for any
 * circuit a learner can draw. Anything outside the subset raises a ParseError
 * carrying a line and column so the editor can underline it.
 */

import { GATES } from '../gates.js';
import { IR_VERSION, type Circuit, type Op, type Param } from '../types.js';

export class ParseError extends Error {
  constructor(message: string, readonly line: number, readonly column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'ParseError';
  }
}

/**
 * Angle constants the subset understands.
 *
 * Null-prototyped on purpose: a plain object literal would answer `'constructor'
 * in CONSTANTS` with `true`, which is exactly how a name-whitelist over an
 * object literal leaks the whole `Object.prototype` chain to a caller.
 */
const CONSTANTS: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, {
  pi: Math.PI,
  tau: 2 * Math.PI,
  euler: Math.E,
  e: Math.E,
});

/** Longest expression we will even tokenise. Angles are short; anything longer is not one. */
const MAX_EXPR_LENGTH = 512;

type Tok =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')' };

/**
 * Tokenise an angle expression.
 *
 * The grammar is closed: decimal numbers (with an optional exponent),
 * identifiers, the four arithmetic operators and parentheses. There is no
 * escape hatch — no strings, no property access, no call syntax — so nothing a
 * learner types can be interpreted as anything but arithmetic.
 */
function tokenise(src: string, line: number, col: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
      toks.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] !== undefined && src[i + 1]! >= '0' && src[i + 1]! <= '9')) {
      const start = i;
      while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i++;
      if (src[i] === '.') {
        i++;
        while (i < src.length && src[i]! >= '0' && src[i]! <= '9') i++;
      }
      // An exponent only counts as part of the number when it is well formed;
      // otherwise `e` is the Euler constant and `2*e` still means what it says.
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (src[j] !== undefined && src[j]! >= '0' && src[j]! <= '9') {
          j++;
          while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j++;
          i = j;
        }
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new ParseError(`unsupported expression '${src}'`, line, col);
      toks.push({ kind: 'num', value });
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = i;
      while (
        i < src.length &&
        ((src[i]! >= 'a' && src[i]! <= 'z') ||
          (src[i]! >= 'A' && src[i]! <= 'Z') ||
          (src[i]! >= '0' && src[i]! <= '9') ||
          src[i] === '_')
      ) {
        i++;
      }
      toks.push({ kind: 'ident', value: src.slice(start, i) });
      continue;
    }
    throw new ParseError(`unsupported expression '${src}'`, line, col);
  }
  return toks;
}

/**
 * Evaluate an arithmetic expression over numbers, pi, and declared symbols.
 *
 * A recursive-descent evaluator rather than `new Function`: the parser can only
 * ever produce a number, so a crafted angle has no reachable path to the JS
 * engine no matter what the surrounding statement parser lets through.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('+' | '-') unary | primary
 *   primary := number | identifier | '(' expr ')'
 */
export function evalExpr(src: string, symbols: Set<string>, line: number, col: number): Param {
  const trimmed = src.trim();
  if (symbols.has(trimmed)) return { symbol: trimmed };
  if (trimmed.length > MAX_EXPR_LENGTH) {
    throw new ParseError(`expression is too long (${trimmed.length} characters)`, line, col);
  }

  const toks = tokenise(trimmed, line, col);
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const fail: () => never = () => {
    throw new ParseError(`cannot evaluate '${trimmed}'`, line, col);
  };

  const lookup = (name: string): number => {
    if (symbols.has(name)) {
      throw new ParseError(`parameter '${name}' cannot be combined with arithmetic here`, line, col);
    }
    if (!Object.prototype.hasOwnProperty.call(CONSTANTS, name)) {
      throw new ParseError(`unknown identifier '${name}'`, line, col);
    }
    return CONSTANTS[name]!;
  };

  const parseExpr = (depth: number): number => {
    if (depth > 32) fail();
    let value = parseTerm(depth);
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        pos++;
        const rhs = parseTerm(depth);
        value = t.value === '+' ? value + rhs : value - rhs;
      } else return value;
    }
  };

  const parseTerm = (depth: number): number => {
    let value = parseUnary(depth);
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '*' || t.value === '/')) {
        pos++;
        const rhs = parseUnary(depth);
        value = t.value === '*' ? value * rhs : value / rhs;
      } else return value;
    }
  };

  const parseUnary = (depth: number): number => {
    const t = peek();
    if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
      pos++;
      const v = parseUnary(depth + 1);
      return t.value === '-' ? -v : v;
    }
    return parsePrimary(depth);
  };

  const parsePrimary = (depth: number): number => {
    const t = peek();
    if (t === undefined) fail();
    if (t.kind === 'num') {
      pos++;
      return t.value;
    }
    if (t.kind === 'ident') {
      pos++;
      return lookup(t.value);
    }
    if (t.value === '(') {
      pos++;
      const v = parseExpr(depth + 1);
      const close = peek();
      if (close?.kind !== 'op' || close.value !== ')') fail();
      pos++;
      return v;
    }
    return fail();
  };

  const value = parseExpr(0);
  if (pos !== toks.length) fail();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ParseError(`expression '${trimmed}' is not a finite number`, line, col);
  }
  return value;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

interface RegInfo {
  name: string;
  size: number;
  offset: number;
}

export function fromQasm3(source: string): Circuit {
  const rawLines = source.split('\n');
  const symbols = new Set<string>();
  const qregs: RegInfo[] = [];
  const cregs: RegInfo[] = [];
  let qubits = 0;
  let clbits = 0;
  const ops: Op[] = [];
  let counter = 0;
  const nextId = () => `op${(counter++).toString(36)}`;

  const resolve = (regs: RegInfo[], token: string, line: number, col: number): number[] => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\s*(\d+)\s*\])?$/.exec(token.trim());
    if (!m) throw new ParseError(`cannot parse register reference '${token}'`, line, col);
    const reg = regs.find((r) => r.name === m[1]);
    if (!reg) throw new ParseError(`unknown register '${m[1]}'`, line, col);
    if (m[2] === undefined) {
      return Array.from({ length: reg.size }, (_, i) => reg.offset + i);
    }
    const idx = Number(m[2]);
    if (idx >= reg.size) throw new ParseError(`index ${idx} out of range for '${reg.name}'`, line, col);
    return [reg.offset + idx];
  };

  for (let li = 0; li < rawLines.length; li++) {
    const lineNo = li + 1;
    let text = rawLines[li]!;
    const commentAt = text.indexOf('//');
    if (commentAt >= 0) text = text.slice(0, commentAt);
    text = text.trim();
    if (!text) continue;
    if (text.startsWith('OPENQASM') || text.startsWith('include')) continue;
    if (!text.endsWith(';') && !text.includes(')')) {
      throw new ParseError('statement must end with a semicolon', lineNo, text.length);
    }
    const stmt = text.replace(/;\s*$/, '');

    // input float[64] theta;
    let m = /^(?:input\s+)?(?:float|angle)(?:\[\d+\])?\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(stmt);
    if (m) {
      symbols.add(m[1]!);
      continue;
    }
    // qubit[3] q;   /  bit[3] c;
    m = /^qubit\s*\[\s*(\d+)\s*\]\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(stmt);
    if (m) {
      qregs.push({ name: m[2]!, size: Number(m[1]), offset: qubits });
      qubits += Number(m[1]);
      continue;
    }
    m = /^qubit\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(stmt);
    if (m) {
      qregs.push({ name: m[1]!, size: 1, offset: qubits });
      qubits += 1;
      continue;
    }
    m = /^bit\s*\[\s*(\d+)\s*\]\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(stmt);
    if (m) {
      cregs.push({ name: m[2]!, size: Number(m[1]), offset: clbits });
      clbits += Number(m[1]);
      continue;
    }
    m = /^bit\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(stmt);
    if (m) {
      cregs.push({ name: m[1]!, size: 1, offset: clbits });
      clbits += 1;
      continue;
    }

    // if (c[0] == 1) x q[1];
    let condition: Op['condition'];
    let body = stmt;
    m = /^if\s*\(([^)]*)\)\s*(.*)$/.exec(stmt);
    if (m) {
      const inner = m[1]!;
      const cm = /^(.*?)==\s*(\d+)$/.exec(inner);
      if (!cm) throw new ParseError(`only '== <int>' conditions are supported`, lineNo, 0);
      const bits = splitTopLevel(cm[1]!, ',').flatMap((t) => resolve(cregs, t, lineNo, 0));
      condition = { bits, value: Number(cm[2]) };
      body = m[2]!.trim();
    }

    // c[0] = measure q[0];
    m = /^(.*?)\s*=\s*measure\s+(.*)$/.exec(body);
    if (m) {
      const cbits = resolve(cregs, m[1]!, lineNo, 0);
      const qs = resolve(qregs, m[2]!, lineNo, 0);
      qs.forEach((q, i) => {
        ops.push({ id: nextId(), gate: 'measure', targets: [q], cbits: [cbits[i] ?? cbits[0]!], ...(condition ? { condition } : {}) });
      });
      continue;
    }
    m = /^measure\s+(.*?)\s*->\s*(.*)$/.exec(body);
    if (m) {
      const qs = resolve(qregs, m[1]!, lineNo, 0);
      const cbits = resolve(cregs, m[2]!, lineNo, 0);
      qs.forEach((q, i) => ops.push({ id: nextId(), gate: 'measure', targets: [q], cbits: [cbits[i] ?? cbits[0]!] }));
      continue;
    }
    if (/^reset\s+/.test(body)) {
      const qs = resolve(qregs, body.slice(5), lineNo, 0);
      qs.forEach((q) => ops.push({ id: nextId(), gate: 'reset', targets: [q] }));
      continue;
    }
    if (/^barrier\b/.test(body)) {
      const rest = body.slice(7).trim();
      const qs = rest ? splitTopLevel(rest, ',').flatMap((t) => resolve(qregs, t, lineNo, 0)) : Array.from({ length: qubits }, (_, i) => i);
      ops.push({ id: nextId(), gate: 'barrier', targets: qs });
      continue;
    }

    // [ctrl @]* name[(params)] operands
    let extraControls = 0;
    while (/^(ctrl|negctrl)\s*@\s*/.test(body)) {
      if (body.startsWith('negctrl')) throw new ParseError('negctrl is not supported by the builder', lineNo, 0);
      extraControls++;
      body = body.replace(/^ctrl\s*@\s*/, '');
    }

    m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s+(.*)$/.exec(body);
    if (!m) throw new ParseError(`cannot parse statement '${body}'`, lineNo, 0);
    const name = m[1]!;
    const def = GATES[name];
    if (!def) throw new ParseError(`unknown gate '${name}'`, lineNo, 0);
    const params: Param[] = m[2]
      ? splitTopLevel(m[2], ',').map((p) => evalExpr(p, symbols, lineNo, 0))
      : [];
    if (params.length !== def.paramNames.length) {
      throw new ParseError(
        `${name} expects ${def.paramNames.length} parameter(s), got ${params.length}`,
        lineNo,
        0,
      );
    }
    const operands = splitTopLevel(m[3]!, ',').flatMap((t) => resolve(qregs, t, lineNo, 0));
    const declaredControls = def.controlledForm && def.controlledForm.controls > 0 ? def.controlledForm.controls : 0;
    const totalControls = extraControls + declaredControls;
    const controls = operands.slice(0, totalControls);
    const targets = operands.slice(totalControls);
    const base = def.controlledForm && def.controlledForm.controls !== 0 ? def.controlledForm.base : name;

    ops.push({
      id: nextId(),
      gate: base,
      targets,
      ...(controls.length ? { controls } : {}),
      ...(params.length ? { params } : {}),
      ...(condition ? { condition } : {}),
    });
  }

  if (qubits === 0) throw new ParseError('no qubit register declared', 1, 0);
  return { version: IR_VERSION, name: 'parsed', qubits, clbits, ops };
}
