import { Database } from "bun:sqlite"
import { dirname, resolve } from "node:path"
import { mkdirSync } from "node:fs"
import { runMigrations } from "./migrations.ts"

export interface DatabaseConfig {
  readonly path: string
  readonly createParentDirectory?: boolean
}

export interface DatabaseConnection {
  readonly path: string
  readonly db: Database
  close(): void
}

export function resolveDatabasePath(config: DatabaseConfig): string {
  if (config.path.trim() === "") throw new Error("database path must not be empty")
  return resolve(config.path)
}

export function openDatabase(config: DatabaseConfig): DatabaseConnection {
  const path = resolveDatabasePath(config)
  if (config.createParentDirectory) mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  try {
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA foreign_keys = ON")
    return { path, db, close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}

export function migrateDatabase(connection: DatabaseConnection): readonly string[] {
  return runMigrations(connection.db)
}

export function openMigratedDatabase(config: DatabaseConfig): DatabaseConnection {
  const connection = openDatabase(config)
  try {
    migrateDatabase(connection)
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
}

export type { Database }
