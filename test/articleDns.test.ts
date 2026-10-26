import { describe, expect, it, vi } from 'vitest'

// A public-looking name that resolves to a private address (the classic way around a name-only check).
vi.mock('node:dns', async (orig) => {
  const real = await orig<typeof import('node:dns')>()
  const lookup = (host: string, _opts: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) => {
    if (host === 'evil.example') return cb(null, [{ address: '127.0.0.1', family: 4 }])
    if (host === 'mixed.example') return cb(null, [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }])
    return real.lookup(host, { all: true }, cb as never)
  }
  return { ...real, default: { ...real, lookup }, lookup }
})

describe('Add web link: names resolving to private addresses', () => {
  it.each(['http://evil.example/', 'http://mixed.example/'])('refuses %s', async (u) => {
    const { default: handler } = await import('../api/article')
    const r = await handler.fetch(new Request('https://qari.test/api/article?url=' + encodeURIComponent(u)))
    expect(r.status).toBe(400)
  })
})
