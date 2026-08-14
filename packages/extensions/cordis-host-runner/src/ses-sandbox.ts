/**
 * Experimental SES evaluator for dynamic Host halves. SES initializes and locks down the process
 * only when this evaluator handles its first package; every package then receives a fresh
 * Compartment with a hardened, package-local set of endowments.
 * @module @deepseek-ai/dsh-cordis-host-runner/ses-sandbox
 */

import type {} from 'ses'
import type { Plugin } from '@deepseek-ai/cordis'
import { sandboxDefineTool, sandboxRegisterTool } from './guard.ts'
import { taggedConsole } from './sandbox.ts'

let lockdownPromise: Promise<void> | undefined

/** Import SES and run its process-global lockdown exactly once before creating a Compartment. */
function ensureSesLockdown(): Promise<void> {
  lockdownPromise ??= import('ses').then(() => { lockdown() })
  return lockdownPromise
}

/** Build the hardened facilities endowed to one package Compartment. */
function hostEndowments(id: string, harnessExtras: Record<string, unknown>): Record<string, unknown> {
  const btoa = (value: string): string => Buffer.from(value, 'utf-8').toString('base64')
  const atob = (value: string): string => Buffer.from(value, 'base64').toString('utf-8')
  return harden({
    console: taggedConsole(id),
    harness: { defineTool: sandboxDefineTool, registerTool: sandboxRegisterTool, ...harnessExtras },
    btoa,
    atob,
    TextEncoder,
    TextDecoder,
  })
}

/**
 * Evaluate one Host half in a fresh SES Compartment. Unlike `node:vm`, `Compartment.evaluate`
 * provides no synchronous timeout, so this function deliberately accepts no `vmTimeoutMs`.
 * @param code - model-authored async-function body that must return a Cordis Plugin.
 * @param id - package identity used for the Compartment name, console tag, and source URL.
 * @param harnessExtras - package-local harness verbs, currently `handle`.
 * @returns the unvalidated Compartment result.
 */
export async function evaluateSesHostCode(
  code: string,
  id: string,
  harnessExtras: Record<string, unknown>,
): Promise<unknown> {
  await ensureSesLockdown()
  const compartment = new Compartment({
    name: `cordis-dyn-${id}`,
    globals: hostEndowments(id, harnessExtras),
    __options__: true,
  })
  return await compartment.evaluate(`(async () => {\n${code}\n})()\n//# sourceURL=cordis-dyn-${id}.js`)
}

/**
 * Harden a plugin after the caller validates its function or object form.
 * @param plugin - validated plugin returned by {@link evaluateSesHostCode}.
 * @returns the same plugin with an immutable reachable surface.
 */
export function hardenSesPlugin(plugin: Plugin): Plugin {
  return harden(plugin)
}
