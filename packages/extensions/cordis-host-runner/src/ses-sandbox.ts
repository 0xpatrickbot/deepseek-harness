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
  // Cache a rejection too: lockdown is process-global and can fail after partial mutation, so a
  // retry in the same process would not start from a known pre-lockdown state.
  lockdownPromise ??= import('ses').then(() => { lockdown() })
  return lockdownPromise
}

/** Build the hardened facilities endowed to one package Compartment. */
function hostEndowments(id: string, harnessExtras: Record<string, unknown>): Record<string, unknown> {
  const btoa = (value: string): string => Buffer.from(value, 'utf-8').toString('base64')
  const atob = (value: string): string => Buffer.from(value, 'base64').toString('utf-8')
  // harden traverses these Host constructors and their prototypes, freezing the process-global
  // TextEncoder and TextDecoder objects rather than Compartment-local copies.
  return harden({
    console: taggedConsole(id),
    harness: { defineTool: sandboxDefineTool, registerTool: sandboxRegisterTool, ...harnessExtras },
    btoa,
    atob,
    TextEncoder,
    TextDecoder,
  })
}

/** Convert SES's conservative source-censor errors into Host-half activation diagnostics. */
function sesSourceRejection(error: unknown): Error | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') {
    return undefined
  }
  if (error.message.includes('(SES_IMPORT_REJECTED)')) {
    return new Error(
      `dynamic package \`code.host\` passed the define-time JavaScript syntax check but SES rejected it during activation:\n${error.message}\n`
      + 'The SES evaluator does not support module loading and rejects `import(...)` text anywhere in Host source, '
      + 'including strings and comments. Remove that token sequence and keep the Host half self-contained.',
      { cause: error },
    )
  }
  if (error.message.includes('(SES_HTML_COMMENT_REJECTED)')) {
    return new Error(
      `dynamic package \`code.host\` passed the define-time JavaScript syntax check but SES rejected it during activation:\n${error.message}\n`
      + 'SES rejects HTML-comment tokens anywhere in Host source, including strings and comments. '
      + 'Remove the `<!--` or `-->` token sequence.',
      { cause: error },
    )
  }
  return undefined
}

/**
 * Evaluate one Host half in a fresh SES Compartment. Unlike `node:vm`, `Compartment.evaluate`
 * provides no synchronous timeout, so this function deliberately accepts no `vmTimeoutMs`.
 * @param code - model-authored async-function body that must return a Cordis Plugin.
 * @param packageId - Package identity used for the Compartment name and source URL.
 * @param pluginId - stable Plugin identity used for the console tag, matching the VM evaluator.
 * @param harnessExtras - package-local harness verbs, currently `handle`.
 * @returns the unvalidated Compartment result.
 */
export async function evaluateSesHostCode(
  code: string,
  packageId: string,
  pluginId: string,
  harnessExtras: Record<string, unknown>,
): Promise<unknown> {
  await ensureSesLockdown()
  const compartment = new Compartment({
    name: `cordis-dyn-${packageId}`,
    globals: hostEndowments(pluginId, harnessExtras),
    __options__: true,
  })
  let evaluated: unknown
  try {
    evaluated = compartment.evaluate(`(async () => {\n${code}\n})()\n//# sourceURL=cordis-dyn-${packageId}.js`)
  } catch (error) {
    throw sesSourceRejection(error) ?? error
  }
  return await evaluated
}

/**
 * Harden a plugin after the caller validates its function or object form.
 * @param plugin - validated plugin returned by {@link evaluateSesHostCode}.
 * @returns the same plugin with an immutable reachable surface.
 */
export function hardenSesPlugin(plugin: Plugin): Plugin {
  return harden(plugin)
}
