import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const schemaFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'mariadb-schema.sql')
const writeLockName = 'vote_write_lock'
const transactionContext = new AsyncLocalStorage()

export function readDatabaseConfig(env = process.env) {
  if (String(env.DB_DRIVER || '').toLowerCase() === 'sqlite') {
    return {
      driver: 'sqlite',
      filename: path.resolve(env.SQLITE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'roomvote-local.sqlite')),
    }
  }

  const base = {
    charset: 'utf8mb4',
    connectionLimit: Number(env.DB_CONNECTION_LIMIT || 10),
    // Report matched rows (like SQLite) rather than only changed rows.
    flags: ['+FOUND_ROWS'],
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    enableKeepAlive: true,
  }
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL)
    if (!['mysql:', 'mariadb:'].includes(url.protocol)) throw new Error('DATABASE_URL must start with mysql:// or mariadb://.')
    return {
      ...base,
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
    }
  }

  if (!env.DB_NAME || !env.DB_USER) {
    throw new Error('Set DATABASE_URL (mysql://user:password@host:3306/database) or DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME.')
  }
  return {
    ...base,
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME,
  }
}

function normalizeSQLiteType(definition) {
      return definition
        .replace(/\bLONGBLOB\b/gi, 'BLOB')
        .replace(/\bMEDIUMTEXT\b/gi, 'TEXT')
        .replace(/\bVARBINARY\s*\(\s*\d+\s*\)/gi, 'BLOB')
        .replace(/\bVARCHAR\s*\(\s*\d+\s*\)/gi, 'TEXT')
        .replace(/\bCHAR\s*\(\s*\d+\s*\)/gi, 'TEXT')
        .replace(/\bTINYINT\s*\(\s*1\s*\)/gi, 'INTEGER')
        .replace(/\bTINYINT\b/gi, 'INTEGER')
        .replace(/\bBIGINT\b/gi, 'INTEGER')
        .replace(/\bDOUBLE\b/gi, 'REAL')
        .replace(/\bCOLLATE\s+utf8mb4_unicode_ci\b/gi, 'COLLATE NOCASE')
        .replace(/\bCOLLATE\s+utf8mb4_bin\b/gi, '')
    }

    function translateSQLiteSchema(source) {
      const statements = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean)
      const translated = []

      for (const statement of statements) {
        const alter = statement.match(/^ALTER TABLE\s+([\w]+)\s+ADD COLUMN IF NOT EXISTS\s+([\s\S]+)$/i)
        if (alter) {
          translated.push({ alterTable: alter[1], columnDefinition: normalizeSQLiteType(alter[2]) })
          continue
        }

        const createTable = statement.match(/^CREATE TABLE IF NOT EXISTS\s+([\w]+)\s*\(([\s\S]*)\)\s*ENGINE\s*=\s*InnoDB[\s\S]*$/i)
        if (!createTable) throw new Error(`SQLite local mode cannot translate schema statement: ${statement.slice(0, 100)}`)

        const tableName = createTable[1]
        let columns = createTable[2]
        const indexes = []
        columns = columns.replace(/,\s*(UNIQUE\s+)?INDEX\s+([\w]+)\s*\(([^)]*)\)/gi, (_match, unique, indexName, indexColumns) => {
          indexes.push(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${indexColumns})`)
          return ''
        })
        columns = columns.replace(/UNIQUE\s+KEY\s+[\w]+\s*\(([^)]*)\)/gi, 'UNIQUE ($1)')

        if (tableName === 'poll_voters') {
          columns = columns.replace(/\bseq\s+BIGINT\s+NOT NULL\s+AUTO_INCREMENT\b/i, 'seq INTEGER PRIMARY KEY AUTOINCREMENT')
          columns = columns.replace(/PRIMARY KEY\s*\(\s*poll_id\s*,\s*voter_id\s*\)/i, 'UNIQUE (poll_id, voter_id)')
        }

        columns = normalizeSQLiteType(columns)
        translated.push(`CREATE TABLE IF NOT EXISTS ${tableName} (${columns})`)
        translated.push(...indexes)
      }

      return translated
    }

    function translateSQLiteQuery(sql) {
      let translated = sql.replace(/\bINSERT\s+IGNORE\s+INTO\b/gi, 'INSERT OR IGNORE INTO')
      const duplicateUpdate = translated.match(/\s+ON DUPLICATE KEY UPDATE\s+([\s\S]+)$/i)
      if (duplicateUpdate) {
        const assignments = duplicateUpdate[1].replace(/VALUES\s*\(\s*([\w]+)\s*\)/gi, 'excluded.$1')
        translated = `${translated.slice(0, duplicateUpdate.index)} ON CONFLICT(kind) DO UPDATE SET ${assignments}`
      }
      return translated
    }

    function openSQLiteConnection(filename, DatabaseSync) {
      const database = new DatabaseSync(filename)
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
      database.function('CONCAT', (first, second, third) => `${first ?? ''}${second ?? ''}${third ?? ''}`)
      return database
    }

    function createSQLiteDatabase(config, DatabaseSync) {
      mkdirSync(path.dirname(config.filename), { recursive: true })
      const database = openSQLiteConnection(config.filename, DatabaseSync)
      database.exec('PRAGMA journal_mode = WAL;')
      const connection = () => transactionContext.getStore() ?? database

      function prepare(sql) {
        const translated = translateSQLiteQuery(sql)
        return {
          get: async (...params) => connection().prepare(translated).get(...params),
          all: async (...params) => connection().prepare(translated).all(...params),
          run: async (...params) => {
            const result = connection().prepare(translated).run(...params)
            return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
          },
        }
      }

      async function transaction(action) {
        if (transactionContext.getStore()) return action()
        const transactionDatabase = openSQLiteConnection(config.filename, DatabaseSync)
        transactionDatabase.exec('BEGIN IMMEDIATE')
        try {
          const result = await transactionContext.run(transactionDatabase, action)
          transactionDatabase.exec('COMMIT')
          return result
        } catch (error) {
          transactionDatabase.exec('ROLLBACK')
          throw error
        } finally {
          transactionDatabase.close()
        }
      }

      async function initializeSchema() {
        const statements = translateSQLiteSchema(readFileSync(schemaFile, 'utf8'))
        for (const statement of statements) {
          if (typeof statement === 'string') {
            database.exec(statement)
            continue
          }

          const existingColumns = database.prepare(`PRAGMA table_info(${statement.alterTable})`).all()
          const columnName = statement.columnDefinition.match(/^([\w]+)/)?.[1]
          if (columnName && !existingColumns.some((column) => column.name === columnName)) {
            database.exec(`ALTER TABLE ${statement.alterTable} ADD COLUMN ${statement.columnDefinition}`)
          }
        }
      }

      return { prepare, transaction, initializeSchema, close: () => database.close() }
}

// Mirrors the small subset of node:sqlite used by the app (prepare().get/all/run, exec), but asynchronous.
export async function createDatabase(config) {
  if (config.driver === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite')
    return createSQLiteDatabase(config, DatabaseSync)
  }

  const pool = mysql.createPool(config)
  const connection = () => transactionContext.getStore() ?? pool

  async function query(sql, params = []) {
    const [result] = await connection().query(sql, params)
    return result
  }

  function prepare(sql) {
    return {
      get: async (...params) => (await query(sql, params))[0],
      all: async (...params) => query(sql, params),
      run: async (...params) => {
        const result = await query(sql, params)
        return { changes: result.affectedRows, lastInsertRowid: result.insertId }
      },
    }
  }

  // Serialises write transactions across all server processes (the equivalent of SQLite's BEGIN IMMEDIATE),
  // so read-then-write checks such as "one vote per session" cannot race.
  async function transaction(action) {
    if (transactionContext.getStore()) return action()
    const lease = await pool.getConnection()
    try {
      const [[lock]] = await lease.query('SELECT GET_LOCK(?, 30) AS acquired', [writeLockName])
      if (Number(lock.acquired) !== 1) throw new Error('The database is busy. Please try again.')
      try {
        await lease.beginTransaction()
        try {
          const result = await transactionContext.run(lease, action)
          await lease.commit()
          return result
        } catch (error) {
          await lease.rollback().catch(() => {})
          throw error
        }
      } finally {
        await lease.query('SELECT RELEASE_LOCK(?)', [writeLockName]).catch(() => {})
      }
    } finally {
      lease.release()
    }
  }

  async function initializeSchema() {
    const statements = readFileSync(schemaFile, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
    for (const statement of statements) await pool.query(statement)
  }

  return { prepare, transaction, initializeSchema, close: () => pool.end() }
}

export const isDuplicateKeyError = (error) => error?.code === 'ER_DUP_ENTRY'
  || error?.errno === 1062
  || [1555, 2067].includes(error?.errcode)
  || ['ERR_SQLITE_CONSTRAINT_UNIQUE', 'ERR_SQLITE_CONSTRAINT_PRIMARYKEY'].includes(error?.code)
