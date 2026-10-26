import { describe, expect, it } from 'vitest'
import handler, { isPrivateAddress, isPrivateName } from '../api/article'

describe('private address check for Add web link', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fe90::1', 'febf::1', 'fec0::1', 'fd12::1', '64:ff9b::7f00:1', '2002:7f00:1::'])(
    'refuses %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  )
  it.each(['93.184.215.14', '8.8.8.8', '2606:4700::6810:84e5', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false))
  it.each(['localhost', 'localhost.', 'printer.local', 'db.internal', 'intranet', '[::ffff:7f00:1]', '127.0.0.1'])('refuses the name %s', (h) =>
    expect(isPrivateName(h)).toBe(true),
  )
  it('allows ordinary site names', () => expect(isPrivateName('www.bbc.co.uk')).toBe(false))

  it.each(['http://[::ffff:127.0.0.1]/', 'http://localhost./', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd'])('the endpoint refuses %s', async (u) => {
    const r = await handler.fetch(new Request('https://qari.test/api/article?url=' + encodeURIComponent(u)))
    expect(r.status).toBe(400)
  })
})
