/**
 * houston/test/utility/database.ts
 * Usefull things for database usage in tests
 *
 * @exports {Function} migrate - Updates the database to the latest schemas
 * @exports {Function} seed - Adds basic data to the database for use in tests
 * @exports {Function} setup - Creates an in memory database for use in tests
 */

import { create } from './app'

import { Config } from '../../src/lib/config'
import { Database } from '../../src/lib/database/database'

/**
 * migrate
 * Updates the database to the latest schemas
 *
 * @async
 * @param {Database} database - The database connection to run migrations on
 * @return {void}
 */
export async function migrate (database: Database): Promise<void> {
  await database.knex.migrate.latest()
}

/**
 * seed
 * Adds basic data to the database for use in tests
 *
 * @async
 * @param {Database} database - The database connection to run migrations on
 * @return {void}
 */
export async function seed (database: Database): Promise<void> {
  await database.knex.seed.run()
}

/**
 * setup
 * Creates an in memory database for use in tests
 *
 * @async
 * @param {Config} config - Configuration to use for database setup
 * @return {Database} - A fully setup database connection
 */
export async function setup (config: Config): Promise<Database> {
  const app = await create()
  const database = app.get<Database>(Database)

  await migrate(database)
  await seed(database)

  return database
}
