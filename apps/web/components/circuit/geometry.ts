/** Canvas geometry. Values come straight from DESIGN.md's circuit canvas spec. */
export const WIRE_PITCH = 48;
export const COL_W = 56;
export const TILE = 36;
export const LEFT_GUTTER = 76;
export const TOP_PAD = 24;
export const CLBIT_GAP = 20;

export const wireY = (q: number) => TOP_PAD + q * WIRE_PITCH + WIRE_PITCH / 2;
export const colX = (c: number) => LEFT_GUTTER + c * COL_W + COL_W / 2;
export const clbitY = (qubits: number) => wireY(qubits - 1) + WIRE_PITCH / 2 + CLBIT_GAP;

/** Columns always drawn, so an empty circuit still shows full-length wires. */
export const MIN_COLUMNS = 14;

export function canvasSize(qubits: number, columns: number, hasClbits: boolean) {
  return {
    width: LEFT_GUTTER + Math.max(columns, MIN_COLUMNS) * COL_W + COL_W,
    height: (hasClbits ? clbitY(qubits) + 24 : wireY(qubits - 1) + WIRE_PITCH / 2) + TOP_PAD,
  };
}

/** Which (qubit, column) a pointer is over, or null when outside the grid. */
export function hitTest(
  x: number,
  y: number,
  qubits: number,
): { qubit: number; column: number } | null {
  if (x < LEFT_GUTTER) return null;
  const column = Math.floor((x - LEFT_GUTTER) / COL_W);
  const qubit = Math.floor((y - TOP_PAD) / WIRE_PITCH);
  if (qubit < 0 || qubit >= qubits || column < 0) return null;
  return { qubit, column };
}
