import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const schemaFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'mariadb-schema.sql')
const writeLockName = 'vote_write_lock'
const transactionContext = new AsyncLocalStorage()

export function readDatabaseConfig(env = process.env) {
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

// Mirrors the small subset of node:sqlite used by the app (prepare().get/all/run, exec), but asynchronous.
export function createDatabase(config) {
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

export const isDuplicateKeyError = (error) => error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062
