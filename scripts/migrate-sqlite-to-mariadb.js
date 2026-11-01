import { constants, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path, { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, readDatabaseConfig } from '../server/db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceFile = path.resolve(process.env.SQLITE_PATH || path.join(root, 'data', 'roomvote.sqlite'))
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
  'ad_videos',
]

if (!existsSync(sourceFile)) {
  throw new Error(`SQLite database not found: ${sourceFile}`)
}

const sqlite = new DatabaseSync(sourceFile, { readOnly: true })
const sourceTables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
const database = createDatabase(readDatabaseConfig())
const copiedAssets = []

try {
  await database.initializeSchema()

  for (const tableName of tableNames) {
    const { count } = await database.prepare(`SELECT count(*) AS count FROM \`${tableName}\``).get()
    if (count !== 0 && tableName !== 'theme_settings' && tableName !== 'game_theme_settings') {
      throw new Error(`Destination table "${tableName}" is not empty. Use a fresh MariaDB database for this one-time import.`)
    }
  }

  const assetRows = sourceTables.has('theme_assets') ? sqlite.prepare('SELECT file_name FROM theme_assets').all() : []
  const assetDestination = process.env.THEME_ASSETS_DESTINATION
  if (assetRows.length && !assetDestination) {
    throw new Error('Set THEME_ASSETS_DESTINATION to a persistent destination directory for theme image files.')
  }
  if (assetRows.length && !existsSync(themeAssetsSource)) {
    throw new Error(`Theme asset source directory not found: ${themeAssetsSource}`)
  }
  if (assetRows.length) mkdirSync(assetDestination, { recursive: true })

  const importedCounts = {}
  await database.transaction(async () => {
    await database.prepare('SET FOREIGN_KEY_CHECKS = 0').run()
    for (const tableName of tableNames) {
      if (!sourceTables.has(tableName)) continue
      const destinationColumns = new Set((await database.prepare('SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?').all(tableName)).map((column) => column.name))
      const sourceColumns = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all().map((column) => column.name)
      const columns = sourceColumns.filter((column) => destinationColumns.has(column))
      if (columns.length === 0) {
        importedCounts[tableName] = 0
        continue
      }

      const order = tableName === 'poll_voters' ? ' ORDER BY rowid' : ''
      const rows = sqlite.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${tableName}"${order}`).all()
      const verb = tableName === 'theme_settings' || tableName === 'game_theme_settings' ? 'REPLACE' : 'INSERT'
      const insert = database.prepare(`${verb} INTO \`${tableName}\` (${columns.map((column) => `\`${column}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      for (const row of rows) {
        await insert.run(...columns.map((column) => (row[column] instanceof Uint8Array ? Buffer.from(row[column]) : row[column])))
      }
      importedCounts[tableName] = rows.length
    }
    await database.prepare('SET FOREIGN_KEY_CHECKS = 1').run()

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
  })

  console.log('SQLite data imported into MariaDB:')
  for (const [tableName, count] of Object.entries(importedCounts)) {
    console.log(`  ${tableName}: ${count} row(s)`)
  }
  if (copiedAssets.length) console.log(`Copied ${copiedAssets.length} theme image file(s) to ${assetDestination}`)
} catch (error) {
  for (const file of copiedAssets) rmSync(file, { force: true })
  throw error
} finally {
  sqlite.close()
  await database.close()
}
