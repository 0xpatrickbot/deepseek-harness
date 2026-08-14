import assert from 'node:assert/strict'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId } from '../../src/types.ts'
import {
  AGENT_A,
  call,
  CONSUMER_CODE,
  CONTENT_OUTPUT_CODE,
  mount,
  PROVIDER_CODE,
  running,
  setup,
  text,
} from '../helpers.ts'

type Harness = Awaited<ReturnType<typeof setup>>

function activeRun(harness: Harness, pluginId: CordisDynamicPluginId): CordisDynamicPluginRunId {
  const run = harness.runner.snapshot(AGENT_A).find(row => row.pluginId === pluginId)?.activeRun
  assert(run !== undefined, `missing active run for ${pluginId}`)
  return run.pluginRunId
}

function latestPackage(harness: Harness, pluginId: CordisDynamicPluginId): CordisDynamicPackageId {
  const row = harness.runner.inventory().find(candidate => candidate.pluginId === pluginId)
  const packageId = row?.packages.at(-1)?.packageId
  assert(packageId !== undefined, `missing package for ${pluginId}`)
  return packageId
}

async function failedRun(harness: Harness, code: string, prefix = 'fail'): Promise<{
  pluginId: CordisDynamicPluginId
  pluginRunId: CordisDynamicPluginRunId
  message: string
}> {
  const definition = harness.runner.define({
    sessionId: AGENT_A.id,
    plugin: { kind: 'new', idPrefix: prefix },
    name: `${prefix}-fixture`,
    purpose: 'SES failure fixture',
    code: { host: code },
  })
  const receipt = await harness.runner.run(AGENT_A, definition.pluginId, definition.packageId, 'run')
  assert.equal(receipt.ok, false)
  const attempt = harness.runner.inventory()
    .find(row => row.pluginId === definition.pluginId)?.latestRun
  assert(attempt !== undefined)
  return { pluginId: definition.pluginId, pluginRunId: attempt.pluginRunId, message: receipt.message }
}

async function securityScenario(): Promise<void> {
  const harness = await setup({ experimentalHostEvaluator: 'ses' })
  try {
    const first = await mount(harness, `
      const dynamicType = Function('globalThis.__fromFunction = 17; return typeof process')()
      const indirectType = (0, eval)('globalThis.__fromEval = 23; typeof Buffer')
      let objectConstructorEscape
      try {
        objectConstructorEscape = ({}).constructor.constructor('return this')()
      } catch (error) {
        objectConstructorEscape = error.name + ': ' + error.message
      }
      let endowedConstructorEscape
      try {
        endowedConstructorEscape = console.log.constructor('return this')()
      } catch (error) {
        endowedConstructorEscape = error.name + ': ' + error.message
      }
      let intrinsicMutation
      try {
        Array.prototype.__sesSharedLeak = 'leaked'
        intrinsicMutation = 'accepted'
      } catch (error) {
        intrinsicMutation = error.name
      }
      let endowmentMutation
      try {
        harness.__sesEndowmentLeak = 'leaked'
        endowmentMutation = 'accepted'
      } catch (error) {
        endowmentMutation = error.name
      }
      globalThis.__sesCompartmentLeak = 'first'
      const plugin = { name: 'ses-security', apply(ctx) {} }
      harness.handle('security', () => ({
        globals: {
          process: typeof process,
          Buffer: typeof Buffer,
          require: typeof require,
          fetch: typeof fetch,
          global: typeof global,
          module: typeof module,
          setTimeout: typeof setTimeout,
        },
        dynamicType,
        indirectType,
        dynamicGlobal: globalThis.__fromFunction,
        indirectGlobal: globalThis.__fromEval,
        functionGlobalIsHost: Function('return this')() === globalThis,
        objectConstructorEscape,
        endowedConstructorEscape,
        intrinsicMutation,
        endowmentMutation,
        frozen: {
          plugin: Object.isFrozen(plugin),
          apply: Object.isFrozen(plugin.apply),
          harness: Object.isFrozen(harness),
          console: Object.isFrozen(console),
          textEncoder: Object.isFrozen(TextEncoder),
        },
      }))
      return plugin
    `)
    const firstResult = await harness.runner.invoke(first, activeRun(harness, first), 'security', null)
    assert.deepEqual(firstResult, {
      ok: true,
      value: {
        globals: {
          process: 'undefined',
          Buffer: 'undefined',
          require: 'undefined',
          fetch: 'undefined',
          global: 'undefined',
          module: 'undefined',
          setTimeout: 'undefined',
        },
        dynamicType: 'undefined',
        indirectType: 'undefined',
        dynamicGlobal: 17,
        indirectGlobal: 23,
        functionGlobalIsHost: false,
        objectConstructorEscape: 'TypeError: Function.prototype.constructor is not a valid constructor.',
        endowedConstructorEscape: 'TypeError: Function.prototype.constructor is not a valid constructor.',
        intrinsicMutation: 'TypeError',
        endowmentMutation: 'TypeError',
        frozen: { plugin: true, apply: true, harness: true, console: true, textEncoder: true },
      },
    })

    const second = await mount(harness, `
      harness.handle('isolation', () => ({
        compartmentLeak: typeof globalThis.__sesCompartmentLeak,
        dynamicLeak: typeof globalThis.__fromFunction,
        evalLeak: typeof globalThis.__fromEval,
        intrinsicLeak: typeof Array.prototype.__sesSharedLeak,
        endowmentLeak: typeof harness.__sesEndowmentLeak,
      }))
      return (ctx) => {}
    `)
    assert.deepEqual(
      await harness.runner.invoke(second, activeRun(harness, second), 'isolation', null),
      {
        ok: true,
        value: {
          compartmentLeak: 'undefined',
          dynamicLeak: 'undefined',
          evalLeak: 'undefined',
          intrinsicLeak: 'undefined',
          endowmentLeak: 'undefined',
        },
      },
    )

    await harness.ctx.plugin({
      name: 'foreign-context-fixture',
      apply(ctx: Context) {
        ctx.provide('foreignContextFixture', { direct: () => harness.ctx })
      },
    })
    const foreign = await failedRun(harness, `
      return {
        name: 'foreign-context-reader',
        inject: ['foreignContextFixture'],
        apply(ctx) { ctx.foreignContextFixture.direct() },
      }
    `, 'ctx')
    assert.match(foreign.message, /returned a cordis Context, which the sandbox does not expose/)
    assert.equal(harness.runner.snapshot(AGENT_A).find(row => row.pluginId === foreign.pluginId)?.activeRun, undefined)
  } finally {
    await harness.ctx.fiber.dispose()
  }
}

async function compatibilityScenario(): Promise<void> {
  const harness = await setup({ experimentalHostEvaluator: 'ses', vmTimeoutMs: 1 })
  try {
    const objectPlugin = await mount(harness, `
      return { name: 'object-plugin', apply(ctx) { ctx.provide('objectPluginService', 'object') } }
    `)
    assert.equal(harness.ctx.get('objectPluginService'), 'object')
    const functionPlugin = await mount(harness, `
      return function functionPlugin(ctx) { ctx.provide('functionPluginService', 'function') }
    `)
    assert.equal(harness.ctx.get('functionPluginService'), 'function')
    await harness.runner.stop(AGENT_A, objectPlugin)
    await harness.runner.stop(AGENT_A, functionPlugin)
    assert.equal(harness.ctx.get('objectPluginService'), undefined)
    assert.equal(harness.ctx.get('functionPluginService'), undefined)

    const consumer = await mount(harness, CONSUMER_CODE)
    assert.equal(harness.ctx.tools.get('greet'), undefined)
    const provider = await mount(harness, PROVIDER_CODE)
    assert.equal(text(await call(harness.ctx, 'greet', { name: 'ses' })), 'hi ses')
    await harness.runner.stop(AGENT_A, provider)
    assert.equal(harness.ctx.tools.get('greet'), undefined)
    await harness.runner.run(AGENT_A, provider, latestPackage(harness, provider), 'run')
    assert.equal(text(await call(harness.ctx, 'greet', { name: 'again' })), 'hi again')
    assert.deepEqual(running(harness.runner, AGENT_A).find(row => row.id === consumer), { id: consumer, running: true })

    let ticks = 0
    let activeEffects = 0
    await harness.ctx.plugin({
      name: 'ses-audit-fixture',
      apply(ctx: Context) {
        ctx.provide('sesAuditFixture', {
          tick: () => { ticks += 1 },
          activate: () => { activeEffects += 1 },
          deactivate: () => { activeEffects -= 1 },
        })
      },
    })
    const lifecycle = await mount(harness, `
      harness.handle('echo', (args) => ({ args, nested: { ok: true } }))
      return {
        name: 'ses-lifecycle',
        inject: ['timer', 'tools', 'sesAuditFixture'],
        apply(ctx) {
          ctx.effect(() => {
            ctx.sesAuditFixture.activate()
            return () => ctx.sesAuditFixture.deactivate()
          })
          ctx.setInterval(() => ctx.sesAuditFixture.tick(), 5)
          harness.registerTool(ctx, harness.defineTool({
            name: 'ses_cross_realm',
            description: 'Return supported cross-realm data.',
            parameters: {
              items: { type: 'array', required: true, items: { type: 'string' } },
            },
            output: {
              schema: { type: 'json' },
              render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
            },
            async execute(args) {
              return {
                items: args.items,
                checks: { array: args.items instanceof Array, object: args instanceof Object },
                bytes: Array.from(new TextEncoder().encode(args.items.join('-'))),
              }
            },
          }))
        },
      }
    `)
    const lifecycleRun = activeRun(harness, lifecycle)
    assert.equal(activeEffects, 1)
    const toolResult = await call(harness.ctx, 'ses_cross_realm', { items: ['a', 'b'] })
    assert.deepEqual(JSON.parse(text(toolResult)), {
      items: ['a', 'b'],
      checks: { array: true, object: true },
      bytes: [97, 45, 98],
    })
    assert.deepEqual(await harness.runner.invoke(lifecycle, lifecycleRun, 'echo', { value: ['x'] }), {
      ok: true,
      value: { args: { value: ['x'] }, nested: { ok: true } },
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert(ticks > 0)
    await harness.runner.stop(AGENT_A, lifecycle)
    const stoppedTicks = ticks
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(ticks, stoppedTicks)
    assert.equal(activeEffects, 0)
    assert.equal(harness.ctx.tools.get('ses_cross_realm'), undefined)
    assert.deepEqual(await harness.runner.invoke(lifecycle, lifecycleRun, 'echo', null), {
      ok: false,
      code: 'plugin-not-running',
      message: `dynamic plugin "${lifecycle}" is not running`,
    })
  } finally {
    await harness.ctx.fiber.dispose()
  }
}

async function failureScenario(): Promise<void> {
  const harness = await setup({ experimentalHostEvaluator: 'ses' })
  try {
    let activeEffects = 0
    let failedFiber: Fiber | undefined
    harness.ctx.on('internal/plugin', (fiber) => {
      if (fiber.runtime?.name === 'activation-failure') failedFiber = fiber
    })
    await harness.ctx.plugin({
      name: 'ses-failure-audit-fixture',
      apply(ctx: Context) {
        ctx.provide('sesFailureAudit', {
          activate: () => { activeEffects += 1 },
          deactivate: () => { activeEffects -= 1 },
        })
      },
    })

    const evaluation = await failedRun(harness, `
      harness.handle('evaluation-leak', () => null)
      throw new Error('ses evaluation exploded')
    `, 'eval')
    assert.match(evaluation.message, /ses evaluation exploded/)
    assert.deepEqual(await harness.runner.invoke(evaluation.pluginId, evaluation.pluginRunId, 'evaluation-leak', null), {
      ok: false,
      code: 'plugin-not-running',
      message: `dynamic plugin "${evaluation.pluginId}" is not running`,
    })

    const activation = await failedRun(harness, `
      harness.handle('activation-leak', () => null)
      return {
        name: 'activation-failure',
        inject: ['tools', 'sesFailureAudit'],
        apply(ctx) {
          ctx.effect(() => {
            ctx.sesFailureAudit.activate()
            return () => ctx.sesFailureAudit.deactivate()
          })
          harness.registerTool(ctx, harness.defineTool({
            name: 'ses_failed_tool',
            description: 'Must roll back.',
            parameters: {},
            ${CONTENT_OUTPUT_CODE}
            async execute() { return [] },
          }))
          throw new Error('ses activation exploded')
        },
      }
    `, 'apply')
    assert.match(activation.message, /ses activation exploded/)
    assert(failedFiber !== undefined)
    assert.equal(failedFiber.uid, null)
    assert.equal(activeEffects, 0)
    assert.equal(harness.ctx.tools.get('ses_failed_tool'), undefined)
    assert.deepEqual(await harness.runner.invoke(activation.pluginId, activation.pluginRunId, 'activation-leak', null), {
      ok: false,
      code: 'plugin-not-running',
      message: `dynamic plugin "${activation.pluginId}" is not running`,
    })
    for (const pluginId of [evaluation.pluginId, activation.pluginId]) {
      const row = harness.runner.snapshot(AGENT_A).find(candidate => candidate.pluginId === pluginId)
      assert.equal(row?.activeRun, undefined)
    }

    assert.throws(() => harness.runner.define({
      sessionId: AGENT_A.id,
      plugin: { kind: 'new', idPrefix: 'syntax' },
      name: 'syntax-diagnostic',
      purpose: 'syntax diagnostic fixture',
      code: { host: "const value: string = 'syntax'; return { name: value, apply(ctx) {} }" },
    }), /failed to parse:[\s\S]*SyntaxError:[\s\S]*BODY of an async function/)
  } finally {
    await harness.ctx.fiber.dispose()
  }
}

const scenarios: Record<string, () => Promise<void>> = {
  security: securityScenario,
  compatibility: compatibilityScenario,
  failure: failureScenario,
}

const scenario = scenarios[process.argv[2] ?? '']
if (scenario === undefined) throw new Error(`unknown SES scenario ${JSON.stringify(process.argv[2])}`)
await scenario()
