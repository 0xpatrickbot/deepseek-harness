import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const repoTsconfig = join(repoRoot, 'tsconfig.json')
const headlessMock = fileURLToPath(new URL('./fixtures/ses-headless-mock-llm.ts', import.meta.url))
const headlessPatch = fileURLToPath(new URL('./fixtures/ses-headless.cordis.yml', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/src/bin.ts')
const requiredArtifacts = [
  'apps/cli/lib/bin.js',
  'packages/interaction/commands/lib/typert.host.js',
  'packages/goal/goal/lib/typert.host.js',
  'packages/extensions/cordis-host-runner/lib/typert.host.js',
].every(path => existsSync(join(repoRoot, path)))

/**
 * The assembled headless profile imports generated Typert contributors. The artifact lane runs
 * this suite after `build`; the ordinary clean-tree e2e command skips it with those files absent.
 */
describe.skipIf(!requiredArtifacts)('experimental SES Host evaluator through the built product profile', () => {
  it('defines, activates, calls, stops, and tears down an SES package', async () => {
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
          writeFile(
            join(fixtureDir, 'ses-headless-mock-llm.ts'),
            `export * from ${JSON.stringify(pathToFileURL(headlessMock).href)}\n`,
          ),
          writeFile(join(fixtureDir, 'package.json'), '{"type":"module"}\n'),
        ])
      },
    })
    expect(result.stdout).toBe('SES_HEADLESS_OK\n')
    expect(result.stderr).toBe('')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
