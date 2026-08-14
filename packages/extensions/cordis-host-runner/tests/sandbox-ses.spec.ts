import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const executeFile = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const repoTsconfig = join(repoRoot, 'tsconfig.json')
const scenarioFixture = fileURLToPath(new URL('./fixtures/ses-scenario.ts', import.meta.url))
const tsxLoader = import.meta.resolve('tsx')

describe('experimental SES Host evaluator in isolated processes', () => {
  it.each(['security', 'compatibility', 'failure'])('%s properties hold after process-global lockdown', async (scenario) => {
    await executeFile(process.execPath, ['--import', tsxLoader, scenarioFixture, scenario], {
      cwd: repoRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: repoTsconfig },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
  }, 45_000)

  it('uses the stable Plugin identity for the SES console tag', async () => {
    const { stdout } = await executeFile(process.execPath, ['--import', tsxLoader, scenarioFixture, 'identity'], {
      cwd: repoRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: repoTsconfig },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(stdout).toContain('[cordis:probe-1] SES_IDENTITY_TAG')
  }, 45_000)
})
