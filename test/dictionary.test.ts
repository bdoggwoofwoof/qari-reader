import { describe, expect, it } from 'vitest'
import { externalLinks } from '../src/lib/dictionary'

describe('external dictionary links', () => {
  it('offers Lughatuna for Arabic, copying the word without vowel marks', () => {
    const l = externalLinks('كَيْفَكْ', 'ar', 'كَيْفَكْ يا صاحبي؟').find((x) => x.label === 'Lughatuna')
    expect(l?.url).toBe('https://livingarabic.com/')
    expect(l?.copy).toBe('كيفك')
  })

  it('does not offer Lughatuna for other languages', () => {
    expect(externalLinks('bonjour', 'fr', 'Bonjour.').some((x) => x.label === 'Lughatuna')).toBe(false)
  })
})
