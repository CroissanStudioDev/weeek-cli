#!/usr/bin/env bun

/**
 * Re-extracts the WEEEK OpenAPI document from the public documentation bundle.
 *
 * WEEEK publishes no OpenAPI file. developers.weeek.net is a Zudoku SPA that inlines
 * the spec into a hashed build artifact, so getting it takes two hops:
 *
 *   1. GET /                       → find <script src="/assets/entry.client-<hash>.js">
 *   2. GET that bundle             → find the "./weeek.yaml-<hash>.js" chunk name
 *   3. GET /assets/weeek.yaml-*.js → an ES module holding a dehydrated spec object
 *                                    (a shared $ref table plus `const X = {openapi: ...}`)
 *   4. Evaluate it and serialise to JSON.
 *
 * Both hashes change on every docs deploy, which is exactly why this is a script and
 * not a stored URL. See spec/SPEC_PROVENANCE.md.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const DOCS_ORIGIN = 'https://developers.weeek.net'
const OUT = resolve(import.meta.dirname, '../spec/weeek-openapi.json')

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`)
  return res.text()
}

/** Hop 1: the SPA shell references a single hashed client entry bundle. */
function findEntryBundle(html: string): string {
  const m = html.match(/src="(\/assets\/entry\.client-[^"]+\.js)"/)
  if (!m?.[1]) {
    throw new Error(
      'Could not find the entry.client bundle in the docs HTML. ' +
        'The docs site layout changed — re-run the discovery by hand.',
    )
  }
  return `${DOCS_ORIGIN}${m[1]}`
}

/** Hop 2: the entry bundle lists its lazy chunks, one of which is the spec. */
function findSpecChunk(entryJs: string): string {
  const m = entryJs.match(/"\.\/(weeek\.yaml-[A-Za-z0-9_-]+\.js)"/)
  if (!m?.[1]) {
    throw new Error(
      'Could not find the weeek.yaml-*.js chunk in the entry bundle. ' +
        'The docs build may no longer inline the spec.',
    )
  }
  return `${DOCS_ORIGIN}/assets/${m[1]}`
}

/**
 * The chunk is an ES module: a `$ref` lookup table, the spec object, and an `export`.
 * We strip the export statement, run it in a bare VM context, and pull out the binding
 * whose initialiser starts with `{openapi`.
 */
function evaluateSpecChunk(chunkJs: string): unknown {
  const body = chunkJs.replace(/export\s*\{[\s\S]*$/, '')

  const binding = body.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*openapi/)?.[1]
  if (!binding) {
    throw new Error('Could not locate the spec binding (`… = {openapi …`) inside the chunk.')
  }

  const sandbox: Record<string, unknown> = {}
  const context = createContext(sandbox)
  runInContext(`${body}\n;globalThis.__spec = ${binding};`, context, { timeout: 10_000 })

  const spec = sandbox.__spec
  if (!spec || typeof spec !== 'object') throw new Error('Evaluated spec binding is not an object.')
  return spec
}

function assertLooksLikeWeeekSpec(spec: unknown): asserts spec is {
  openapi: string
  paths: Record<string, Record<string, unknown>>
} {
  const s = spec as { openapi?: unknown; paths?: unknown }
  if (typeof s.openapi !== 'string' || !s.openapi.startsWith('3.')) {
    throw new Error(`Unexpected openapi version: ${String(s.openapi)}`)
  }
  if (!s.paths || typeof s.paths !== 'object' || Object.keys(s.paths).length === 0) {
    throw new Error('Extracted document has no paths.')
  }
}

const html = await fetchText(`${DOCS_ORIGIN}/`)
const entryUrl = findEntryBundle(html)
console.info(`entry bundle: ${entryUrl}`)

const entryJs = await fetchText(entryUrl)
const chunkUrl = findSpecChunk(entryJs)
console.info(`spec chunk:   ${chunkUrl}`)

const spec = evaluateSpecChunk(await fetchText(chunkUrl))
assertLooksLikeWeeekSpec(spec)

const operations = Object.values(spec.paths).reduce(
  (n, item) =>
    n +
    Object.keys(item).filter((k) => ['get', 'post', 'put', 'patch', 'delete'].includes(k)).length,
  0,
)
console.info(`extracted:    ${Object.keys(spec.paths).length} paths, ${operations} operations`)

await writeFile(OUT, `${JSON.stringify(spec, null, 2)}\n`)
console.info(`written:      ${OUT}`)
