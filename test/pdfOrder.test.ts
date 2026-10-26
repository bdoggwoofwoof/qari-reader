import { describe, expect, it } from 'vitest'
import { isRtlLine, rtlOrder } from '../src/lib/extract/pdf'

// Pieces as pdf.js returns them for a right-to-left line: in visual order, left to right.
const line = (pieces: [string, number][]) => pieces.map(([text, x]) => ({ text, x }))
const read = (pieces: [string, number][]) => rtlOrder(line(pieces)).map((p) => p.text).join('')

describe('right-to-left PDF lines', () => {
  it('reads Arabic pieces from right to left', () => {
    expect(read([['ول', 483], ['لأ', 512], ['ا', 526], [' ', 533], ['رس', 539], ['د', 579], ['ل', 592], ['ا', 599]])).toBe('الدرس الأول')
  })

  it('keeps Latin words and numbers inside the line left to right', () => {
    // "قريت Harry Potter الساعة 10" laid out visually: 10 الساعة Potter Harry قريت
    expect(read([['10', 0], [' ', 20], ['الساعة', 25], [' ', 80], ['Harry', 85], [' ', 130], ['Potter', 135], [' ', 190], ['قريت', 195]])).toBe('قريت Harry Potter الساعة 10')
  })

  it('tells right-to-left lines from left-to-right ones', () => {
    expect(isRtlLine('كيفك اليوم؟')).toBe(true)
    expect(isRtlLine('قريت كتاب Harry Potter امبارح')).toBe(true)
    expect(isRtlLine('The word كتاب means book')).toBe(false)
  })
})
