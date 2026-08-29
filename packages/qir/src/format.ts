/** Angle rendering shared by every code generator. */

const PI = Math.PI;

/** Render an angle as a readable multiple of pi where one exists. */
export function angleLiteral(x: number, piToken = 'pi'): string {
  if (Object.is(x, -0) || x === 0) return '0';
  const ratio = x / PI;
  const denominators = [1, 2, 3, 4, 6, 8, 12, 16];
  for (const d of denominators) {
    const num = ratio * d;
    const rounded = Math.round(num);
    if (Math.abs(num - rounded) < 1e-12 && rounded !== 0) {
      const sign = rounded < 0 ? '-' : '';
      const a = Math.abs(rounded);
      if (d === 1) return a === 1 ? `${sign}${piToken}` : `${sign}${a}*${piToken}`;
      const numPart = a === 1 ? piToken : `${a}*${piToken}`;
      return `${sign}${numPart}/${d}`;
    }
  }
  return trimFloat(x);
}

export function trimFloat(x: number): string {
  if (Number.isInteger(x)) return x.toFixed(1);
  const s = x.toPrecision(12);
  return s.includes('e') ? s : s.replace(/0+$/, '').replace(/\.$/, '.0');
}

export function indent(lines: string[], by = '    '): string[] {
  return lines.map((l) => (l ? by + l : l));
}
