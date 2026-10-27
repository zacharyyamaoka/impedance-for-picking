#!/usr/bin/env node
// Serve the built site under a path prefix, the way GitHub Pages serves a project site, so the Playwright suite can prove every page,
// data file, model and wasm resolves under the base:
//
//   SITE_BASE=/impedance-for-picking/ pnpm --dir /home/bam/impedance-controller-website exec vitepress build site
//   node /home/bam/impedance-controller-website/scripts/serve_base.mjs --base /impedance-for-picking/ --port 4498
//
// What it mimics of GitHub Pages: only paths under the base exist (a request outside it is a 404, so a path that forgot the base
// fails loudly); a clean URL /x serves x.html, a folder serves its index.html; a miss serves 404.html with status 404. Standard
// library only. WHY not `vitepress preview --base`: it rewrites requests outside the base too, which would hide exactly the bug
// this server exists to catch.
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
)
const here = fileURLToPath(new URL('.', import.meta.url))
const DIR = resolve(args.dir ?? join(here, '..', 'site', '.vitepress', 'dist'))
const BASE = `/${String(args.base ?? process.env.SITE_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/')
const PORT = Number(args.port ?? 4498)
const HOST = args.host ?? '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json', '.base': 'text/plain; charset=utf-8',
}

function file(path) {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

function send(res, path, status, req) {
  const stat = file(path)
  const type = TYPES[extname(path)] ?? 'application/octet-stream'
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
  // WHY ranges: Chrome streams <video> with Range requests and needs 206 answers to seek and report a duration
  if (range && status === 200) {
    const start = range[1] ? Number(range[1]) : stat.size - Number(range[2])
    const end = range[1] && range[2] ? Number(range[2]) : stat.size - 1
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes' })
    createReadStream(path, { start, end }).pipe(res)
    return
  }
  res.writeHead(status, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') res.end()
  else createReadStream(path).pipe(res)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  let path = decodeURIComponent(url.pathname)
  const missing = join(DIR, '404.html')
  if (!(path === BASE.slice(0, -1) || path.startsWith(BASE))) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`404: ${path} is outside the base ${BASE}`)
    return
  }
  if (path === BASE.slice(0, -1)) {
    res.writeHead(301, { location: BASE })
    res.end()
    return
  }
  const rel = normalize(path.slice(BASE.length)).replace(/^(\.\.(\/|$))+/, '')
  const target = join(DIR, rel)
  for (const candidate of [target, join(target, 'index.html'), `${target}.html`]) {
    if (candidate.startsWith(DIR) && file(candidate)) return send(res, candidate, 200, req)
  }
  if (file(missing)) return send(res, missing, 404, req)
  res.writeHead(404)
  res.end()
})

server.listen(PORT, HOST, () => console.log(`serving ${DIR} at http://${HOST}:${PORT}${BASE}`))
