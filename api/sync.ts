import { BlobPreconditionFailedError, del, get, put } from '@vercel/blob'

/**
 * Encrypted sync storage for Qari.
 * The app encrypts everything on the device before upload, so this function only ever sees
 * scrambled bytes under a random "space" id. It never sees the sync code or any book text.
 *
 *   GET  /api/sync?space=<64 hex>&file=<name>   → the stored bytes (404 if none)
 *   PUT  /api/sync?space=<64 hex>&file=<name>   → stores the body; honours If-Match for safe updates
 *   DELETE /api/sync?space=<64 hex>&file=<name> → removes a deleted book's file (never the manifest)
 */

const SPACE = /^[0-9a-f]{64}$/
const FILE = /^(manifest|[cf]-[a-z0-9]{4,40}-\d{1,3})$/ // c- = book text, f- = original file
const MAX_BYTES = 4 * 1024 * 1024 // Vercel Functions accept request bodies up to 4.5 MB

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url)
    const space = url.searchParams.get('space') || ''
    const file = url.searchParams.get('file') || ''
    if (!SPACE.test(space) || !FILE.test(file)) return bad(400, 'Invalid space or file name.')
    if (!process.env.BLOB_READ_WRITE_TOKEN) return bad(503, 'Sync storage is not set up on this deployment.')
    const pathname = `qari/${space}/${file}`

    if (request.method === 'GET') {
      const res = await get(pathname, { access: 'private', useCache: false })
      if (!res || res.statusCode !== 200) return bad(404, 'Not found.')
      return new Response(res.stream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          ETag: res.blob.etag,
        },
      })
    }

    if (request.method === 'PUT') {
      const body = await request.arrayBuffer()
      if (body.byteLength > MAX_BYTES) return bad(413, 'Too large.')
      const ifMatch = request.headers.get('If-Match') || undefined
      try {
        const blob = await put(pathname, body, {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: 'application/octet-stream',
          cacheControlMaxAge: 60,
          ...(ifMatch && ifMatch !== '*' ? { ifMatch } : {}),
        })
        return Response.json({ etag: blob.etag }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (e) {
        if (e instanceof BlobPreconditionFailedError) return bad(412, 'Changed on another device.')
        return bad(500, 'Could not save.')
      }
    }

    if (request.method === 'DELETE') {
      if (file === 'manifest') return bad(400, 'The manifest can’t be deleted.')
      try {
        await del(pathname)
      } catch {
        /* already gone */
      }
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    }

    return bad(405, 'Method not allowed.')
  },
}
