import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evalExpr, fromQasm3 } from '../src/parse/qasm3.js';

/**
 * Security regression tests for the QASM 3 angle evaluator.
 *
 * `evalExpr` used to build a `new Function` from learner-supplied text and
 * guard it with a character regex plus an identifier whitelist checked with
 * `id in CONSTANTS`. `in` walks the prototype chain, so every name on
 * `Object.prototype` — `constructor` above all — passed the whitelist and
 * reached the JS engine. These tests pin the closed grammar that replaced it.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../src/parse/qasm3.ts', import.meta.url)), 'utf8');

const GLOBAL_MARKERS = ['QASM_PWNED', 'QASM_PWNED_2'] as const;

afterEach(() => {
  for (const m of GLOBAL_MARKERS) delete (globalThis as Record<string, unknown>)[m];
});

describe('evalExpr does not reach the JS engine', () => {
  it('never constructs a function from source text', () => {
    expect(SOURCE).not.toMatch(/new Function\s*\(/);
    expect(SOURCE).not.toMatch(/\beval\s*\(/);
  });

  it('rejects Object.prototype names that the `in` check used to admit', () => {
    // Each of these satisfied the old `id in CONSTANTS` whitelist.
    const inherited = [
      'constructor',
      '__proto__',
      'hasOwnProperty',
      'valueOf',
      'toString',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__defineGetter__',
      '__defineSetter__',
      '__lookupGetter__',
      '__lookupSetter__',
    ];
    for (const name of inherited) {
      expect(() => evalExpr(`pi.${name}`, new Set(), 1, 0)).toThrow(/unsupported expression|unknown identifier/);
      expect(() => evalExpr(name, new Set(), 1, 0)).toThrow(new RegExp(`unknown identifier '${name.replace(/[$^]/g, '\\$&')}'`));
    }
  });

  it('cannot reach the Function constructor through a property chain', () => {
    expect(() => evalExpr('pi.constructor.constructor', new Set(), 1, 0)).toThrow(
      /unsupported expression/,
    );
  });

  it('cannot execute a call, even when parentheses are available', () => {
    // The statement parser cannot deliver a ')' today, so call this the way a
    // future caller might: directly, with a fully formed payload.
    const payloads = [
      'pi.constructor.constructor("globalThis.QASM_PWNED=1")()',
      'pi.constructor.constructor(pi.toString(36))()',
      'globalThis.QASM_PWNED=1',
      'process.env.DATABASE_URL',
      'globalThis.process.mainModule.require("child_process").execSync("id")',
      '(function(){globalThis.QASM_PWNED=1})()',
      '`${globalThis.QASM_PWNED=1}`',
      'this.constructor.constructor("return process")()',
    ];
    for (const p of payloads) {
      expect(() => evalExpr(p, new Set(), 1, 0)).toThrow();
    }
    for (const m of GLOBAL_MARKERS) {
      expect((globalThis as Record<string, unknown>)[m]).toBeUndefined();
    }
  });

  it('rejects a runaway expression instead of tokenising it', () => {
    expect(() => evalExpr('1+'.repeat(400) + '1', new Set(), 1, 0)).toThrow(/too long/);
  });

  it('rejects deeply nested parentheses rather than recursing without bound', () => {
    const deep = '('.repeat(60) + '1' + ')'.repeat(60);
    expect(() => evalExpr(deep, new Set(), 1, 0)).toThrow(/cannot evaluate/);
  });

  it('rejects a trailing token instead of silently ignoring it', () => {
    expect(() => evalExpr('1 2', new Set(), 1, 0)).toThrow(/cannot evaluate/);
    expect(() => evalExpr('pi pi', new Set(), 1, 0)).toThrow(/cannot evaluate/);
    expect(() => evalExpr('', new Set(), 1, 0)).toThrow(/cannot evaluate/);
  });
});

describe('a crafted QASM 3 program cannot execute JavaScript', () => {
  const hostile = [
    'qubit[1] q;\nrx(pi.constructor.constructor) q[0];',
    'qubit[1] q;\nrx(pi.constructor.constructor(1) q[0];',
    'qubit[1] q;\nrx(pi.__proto__) q[0];',
    'qubit[1] q;\nrx(globalThis) q[0];',
    'qubit[1] q;\nrx(process) q[0];',
    'input float[64] constructor;\nqubit[1] q;\nrx(constructor+pi) q[0];',
  ];

  for (const src of hostile) {
    it(`refuses ${JSON.stringify(src.split('\n').at(-1))}`, () => {
      expect(() => fromQasm3(src)).toThrow();
      for (const m of GLOBAL_MARKERS) {
        expect((globalThis as Record<string, unknown>)[m]).toBeUndefined();
      }
    });
  }

  it('leaves Object.prototype unpolluted after parsing hostile input', () => {
    for (const src of hostile) {
      try {
        fromQasm3(src);
      } catch {
        /* expected */
      }
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });
});

describe('the closed grammar still evaluates every angle the emitter produces', () => {
  const cases: [string, number][] = [
    ['0', 0],
    ['pi', Math.PI],
    ['-pi', -Math.PI],
    ['3*pi', 3 * Math.PI],
    ['pi/4', Math.PI / 4],
    ['-3*pi/8', (-3 * Math.PI) / 8],
    ['2*pi/3', (2 * Math.PI) / 3],
    ['tau', 2 * Math.PI],
    ['euler', Math.E],
    ['2*e', 2 * Math.E],
    ['1.0', 1],
    ['0.700000000000', 0.7],
    ['1.5e-13', 1.5e-13],
    ['1.00000000000e-13', 1e-13],
    ['2.5E+3', 2500],
    ['(pi+pi)/2', Math.PI],
    ['-(pi)', -Math.PI],
    ['+pi', Math.PI],
    ['--pi', Math.PI],
    ['  pi / 2  ', Math.PI / 2],
    ['.5', 0.5],
  ];

  for (const [src, want] of cases) {
    it(`evaluates ${JSON.stringify(src)}`, () => {
      expect(evalExpr(src, new Set(), 1, 0)).toBeCloseTo(want, 15);
    });
  }

  it('keeps a declared parameter symbolic', () => {
    expect(evalExpr('theta', new Set(['theta']), 1, 0)).toEqual({ symbol: 'theta' });
  });

  it('still refuses to fold a parameter into arithmetic', () => {
    expect(() => evalExpr('theta/2', new Set(['theta']), 1, 0)).toThrow(
      /parameter 'theta' cannot be combined with arithmetic here/,
    );
  });

  it('still names an unbound identifier', () => {
    expect(() => evalExpr('alpha', new Set(), 1, 0)).toThrow(/unknown identifier 'alpha'/);
  });

  it('rejects a division that is not finite', () => {
    expect(() => evalExpr('1/0', new Set(), 1, 0)).toThrow(/is not a finite number/);
  });

  it('round trips a real program', () => {
    const c = fromQasm3('OPENQASM 3.0;\nqubit[1] q;\nrz(pi/8) q[0];\nrx(-3*pi/4) q[0];\n');
    expect(c.ops[0]!.params![0]).toBeCloseTo(Math.PI / 8, 12);
    expect(c.ops[1]!.params![0]).toBeCloseTo((-3 * Math.PI) / 4, 12);
  });
});
