/**
 * houston/src/process/process.e2e.ts
 * Runs some repositories through tests for end to end testing
 */

import * as os from 'os'
import * as path from 'path'
import * as uuid from 'uuid/v4'

import * as fsHelper from '../lib/helper/fs'
import { Repository as GithubRepository } from '../lib/service/github/repository'
import { Process } from './process'

import { setup as setupConfig } from '../../test/utility/config'

let config = null
const testingDir = path.resolve(os.tmpdir(), 'houston-test', 'process', uuid())

// Extend the default timeout time due to long running tests
jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000

// Change the default workspace location for testing
Process.tempDir = testingDir

beforeEach(async () => {
  config = await setupConfig()
})

afterAll(async () => {
  await fsHelper.rmr(testingDir)
})

test('needle-and-thread/vocal passes release process', async () => {
  const repo = new GithubRepository('needle-and-thread', 'vocal')
  repo.reference = 'refs/tags/2.0.19'

  const proc = new Process(config, repo)

  await proc.setup()
  await proc.teardown()
})

test('Philip-Scott/Spice-up passes release process', async () => {
  const repo = new GithubRepository('Philip-Scott', 'Spice-up')
  repo.reference = 'refs/tags/0.6.0'

  const proc = new Process(config, repo)

  await proc.setup()
  await proc.teardown()
})
