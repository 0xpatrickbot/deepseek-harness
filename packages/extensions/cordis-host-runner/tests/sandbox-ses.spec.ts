import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const executeFile = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const repoTsconfig = join(repoRoot, 'tsconfig.json')
const scenarioFixture = fileURLToPath(new URL('./fixtures/ses-scenario.ts', import.meta.url))
const headlessMock = fileURLToPath(new URL('./fixtures/ses-headless-mock-llm.ts', import.meta.url))
const headlessPatch = fileURLToPath(new URL('./fixtures/ses-headless.cordis.yml', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/src/bin.ts')
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

  it('activates, calls, and tears down an SES package through the product headless profile', async () => {
    const result = await runLoaderSmoke({
      label: 'SES Host runner headless profile smoke',
      tempDirPrefix: 'ses-host-headless-',
      binScript: dshBin,
      configPath: headlessPatch,
      binArgs: ['--profile', 'headless', '--patch', headlessPatch, 'Exercise the SES Host runner.'],
      tsconfigPath: repoTsconfig,
      env: { DSH_TELEMETRY_DISABLED: '1' },
      prepare: async (cwd) => {
        const fixtureDir = join(cwd, '.dsh', 'profiles', 'headless', 'ses-fixtures')
        await mkdir(fixtureDir, { recursive: true })
        await Promise.all([
          copyFile(headlessMock, join(fixtureDir, 'ses-headless-mock-llm.ts')),
          writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
        ])
      },
    })
    expect(result.stdout).toBe('SES_HEADLESS_OK\n')
    expect(result.stderr).toBe('')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
