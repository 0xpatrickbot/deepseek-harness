import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VM_POLLUTION_MARKERS } from './helpers.ts'

const executeFile = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const repoTsconfig = join(repoRoot, 'tsconfig.json')
const scenarioFixture = fileURLToPath(new URL('./fixtures/ses-scenario.ts', import.meta.url))
const tsxLoader = import.meta.resolve('tsx')

/** Run one fixture scenario in its own process, failing the test on a non-zero exit. */
function runScenario(scenario: string): Promise<{ stdout: string }> {
  return executeFile(process.execPath, ['--import', tsxLoader, scenarioFixture, scenario], {
    cwd: repoRoot,
    env: { ...process.env, TSX_TSCONFIG_PATH: repoTsconfig },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  })
}

describe('experimental SES Host evaluator in isolated processes', () => {
  it.each(['security', 'compatibility', 'failure', 'ses-arguments'])('%s properties hold after process-global lockdown', async (scenario) => {
    await runScenario(scenario)
  }, 45_000)

  it.each(['vm-pollution', 'vm-arguments'])('%s measures the default evaluator the experiment is contrasted against', async (scenario) => {
    await runScenario(scenario)
    // The pollution scenario writes its Host-realm marker on a real `Array.prototype`. Reading
    // both markers back here is what proves the spawned process, not this one, absorbed it.
    for (const marker of Object.values(VM_POLLUTION_MARKERS)) {
      expect(([] as unknown as Record<string, unknown>)[marker]).toBeUndefined()
    }
  }, 45_000)

  it('uses the stable Plugin identity for the SES console tag', async () => {
    const { stdout } = await runScenario('identity')
    expect(stdout).toContain('[cordis:probe-1] SES_IDENTITY_TAG')
  }, 45_000)
})
