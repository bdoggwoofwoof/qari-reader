import { describe, expect, it } from 'vitest'
import { arabicCandidates, sentences } from '../src/lib/lang'

describe('arabicCandidates', () => {
  it('strips stacked prefixes', () => {
    expect(arabicCandidates('وَبِالكِتَابِ')).toContain('كتاب')
    expect(arabicCandidates('فللبيت')).toContain('بيت')
    expect(arabicCandidates('والمدرسة')).toContain('مدرسة')
  })
  it('keeps the word itself first', () => {
    expect(arabicCandidates('كتاب')[0]).toBe('كتاب')
  })
})

describe('sentences', () => {
  it('splits a long sentence with no punctuation into speakable chunks', () => {
    const text = Array.from({ length: 100 }, (_, i) => 'word' + i).join(' ') + '.'
    const spans = sentences(text, 'en')
    expect(spans.length).toBeGreaterThan(1)
    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(220)
    expect(spans.map((s) => text.slice(s.start, s.end)).join('')).toBe(text)
  })
  it('leaves normal sentences alone', () => {
    const text = 'كيفك اليوم؟ أنا منيح، الحمد لله. شو عم تعمل هلق؟'
    expect(sentences(text, 'ar').map((s) => text.slice(s.start, s.end).trim())).toEqual(['كيفك اليوم؟', 'أنا منيح، الحمد لله.', 'شو عم تعمل هلق؟'])
  })
})
