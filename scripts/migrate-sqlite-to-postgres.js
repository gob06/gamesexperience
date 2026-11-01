import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path, { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

const { Pool } = pg
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceFile = path.resolve(process.env.SQLITE_PATH || path.join(root, 'data', 'roomvote.sqlite'))
const schemaFile = path.join(root, 'db', 'postgres-schema.sql')
const themeAssetsSource = path.join(path.dirname(sourceFile), 'theme-assets')
const tableNames = [
  'polls',
  'poll_options',
  'poll_voting_sessions',
  'poll_voters',
  'ad_playbacks',
  'audit_logs',
  'users',
  'sessions',
  'game_rooms',
  'theme_settings',
  'game_theme_settings',
  'selfie_sessions',
  'selfie_submissions',
  'theme_assets',
  'theme_audit_logs',
]

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to the destination PostgreSQL connection string.')
}
if (!existsSync(sourceFile)) {
  throw new Error(`SQLite database not found: ${sourceFile}`)
}

const sqlite = new DatabaseSync(sourceFile, { readOnly: true })
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const copiedAssets = []
let client

try {
  client = await pool.connect()
  await client.query('BEGIN')
  await client.query(readFileSync(schemaFile, 'utf8'))

  for (const tableName of tableNames) {
    const destinationCount = await client.query(`SELECT count(*)::integer AS count FROM "${tableName}"`)
    if (destinationCount.rows[0].count !== 0) {
      throw new Error(`Destination table "${tableName}" is not empty. Use a fresh PostgreSQL database for this one-time import.`)
    }
  }

  const assetRows = sqlite.prepare('SELECT file_name FROM theme_assets').all()
  const assetDestination = process.env.THEME_ASSETS_DESTINATION
  if (assetRows.length && !assetDestination) {
    throw new Error('Set THEME_ASSETS_DESTINATION to a persistent destination directory for theme image files.')
  }
  if (assetRows.length && !existsSync(themeAssetsSource)) {
    throw new Error(`Theme asset source directory not found: ${themeAssetsSource}`)
  }
  if (assetRows.length) mkdirSync(assetDestination, { recursive: true })

  const destinationColumns = new Map()
  for (const tableName of tableNames) {
    const result = await client.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
      [tableName],
    )
    destinationColumns.set(tableName, new Set(result.rows.map((row) => row.column_name)))
  }

  const importedCounts = {}
  for (const tableName of tableNames) {
    const sourceColumns = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all().map((column) => column.name)
    const allowedColumns = destinationColumns.get(tableName)
    const columns = sourceColumns.filter((column) => allowedColumns.has(column) && column !== 'phone_hash')
    if (columns.length === 0) {
      importedCounts[tableName] = 0
      continue
    }

    const rows = sqlite.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${tableName}"`).all()
    for (const row of rows) {
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
      const values = columns.map((column) => row[column])
      await client.query(
        `INSERT INTO "${tableName}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders})`,
        values,
      )
    }
    importedCounts[tableName] = rows.length
  }

  for (const row of assetRows) {
    if (basename(row.file_name) !== row.file_name) {
      throw new Error(`Invalid theme asset filename in SQLite database: ${row.file_name}`)
    }
    const from = path.join(themeAssetsSource, row.file_name)
    const to = path.join(assetDestination, row.file_name)
    if (!existsSync(from)) throw new Error(`Theme asset file not found: ${from}`)
    copyFileSync(from, to, constants.COPYFILE_EXCL)
    copiedAssets.push(to)
  }

  await client.query('COMMIT')
  console.log('SQLite data imported into PostgreSQL:')
  for (const [tableName, count] of Object.entries(importedCounts)) {
    console.log(`  ${tableName}: ${count} row(s)`)
  }
  if (copiedAssets.length) console.log(`Copied ${copiedAssets.length} theme image file(s) to ${assetDestination}`)
} catch (error) {
  if (client) await client.query('ROLLBACK')
  for (const file of copiedAssets) rmSync(file, { force: true })
  throw error
} finally {
  sqlite.close()
  client?.release()
  await pool.end()
}
