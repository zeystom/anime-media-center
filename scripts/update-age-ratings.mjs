import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_URL = 'https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/search-index.json'
const OUTPUT_PATH = path.join(ROOT, 'src', 'data', 'age-ratings.json')

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(60_000) })
if (!response.ok) throw new Error(`Age-rating source returned HTTP ${response.status}`)

const source = await response.json()
if (!Array.isArray(source)) throw new Error('Age-rating source did not return an anime index')

const ratings = Object.create(null)
for (const anime of source) {
  const id = Number(anime?.id)
  const sourceRating = typeof anime?.r === 'string' ? anime.r.trim().toUpperCase() : ''
  if (!Number.isSafeInteger(id) || id <= 0 || !sourceRating) continue

  let rating = null
  if (/^PG\s*-\s*13\b/.test(sourceRating)) rating = 'PG-13'
  else if (/^R\s*\+/.test(sourceRating)) rating = 'R+'
  else if (/^R\s*-\s*17\+/.test(sourceRating) || sourceRating === 'R') rating = 'R-17+'
  else if (/^RX\b/.test(sourceRating)) rating = 'Rx'
  else if (/^PG\b/.test(sourceRating)) rating = 'PG'
  else if (/^G\b/.test(sourceRating)) rating = 'G'

  if (rating) ratings[id] = ['G', 'PG', 'PG-13', 'R-17+', 'R+', 'Rx'].indexOf(rating)
}

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
await writeFile(OUTPUT_PATH, `${JSON.stringify(ratings)}\n`, 'utf8')
console.log(`Wrote ${Object.keys(ratings).length.toLocaleString()} ratings to ${path.relative(ROOT, OUTPUT_PATH)}`)
