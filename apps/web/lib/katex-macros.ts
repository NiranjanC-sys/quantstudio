/**
 * Dirac notation macros.
 *
 * KaTeX ships no \ket, \bra or \braket, and the entire curriculum is written in
 * bra-ket notation, so they are defined once here rather than in every lesson.
 * Sizing uses \left...\right so that a ket around a fraction grows with it.
 */
export const KATEX_MACROS: Record<string, string> = {
  '\\ket': '\\left|#1\\right\\rangle',
  '\\bra': '\\left\\langle#1\\right|',
  '\\braket': '\\left\\langle#1\\middle|#2\\right\\rangle',
  '\\ketbra': '\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|',
  '\\expect': '\\left\\langle#1\\right\\rangle',
  '\\tr': '\\operatorname{Tr}',
  '\\Hgate': '\\mathrm{H}',
  '\\CNOT': '\\mathrm{CNOT}',
  '\\dg': '^{\\dagger}',
  '\\half': '\\tfrac{1}{2}',
  '\\isqrt': '\\tfrac{1}{\\sqrt{2}}',
  '\\C': '\\mathbb{C}',
  '\\R': '\\mathbb{R}',
  '\\Z': '\\mathbb{Z}',
  '\\N': '\\mathbb{N}',
};
