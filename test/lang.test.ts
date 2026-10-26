import { describe, expect, it } from 'vitest'
import { detectLang } from '../src/lib/lang'

describe('detectLang', () => {
  it.each([
    ['Bonjour, je vais bien. Merci beaucoup.', 'fr'],
    ['Ça va très bien, merci.', 'fr'],
    ["C'est l'homme qui parle.", 'fr'],
    ['Ich bin heute sehr müde, danke.', 'de'],
    ['Schön, danke. Wie geht es dir?', 'de'],
    ['I am reading a book about history.', 'en'],
    ['The quick brown fox jumps over the lazy dog.', 'en'],
    ['Ik ben het niet eens met de keuze van het team.', 'nl'],
    ['El niño está en la casa con su madre.', 'es'],
    ['كيفك اليوم؟ أنا منيح، الحمد لله', 'ar'],
  ])('%s → %s', (text, lang) => {
    expect(detectLang(text, 'en')).toBe(lang)
  })
})
