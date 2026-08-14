import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

function toolCall(name: string, args: unknown, suffix: string): StreamChunk[] {
  const id = CallId(`ses-headless-${suffix}`)
  const raw = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Keyless adapter that defines, activates, calls, and stops one SES Host package. */
class SesHeadlessAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const results = options.messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
    let chunks: StreamChunk[]
    if (results.length === 0) {
      chunks = toolCall('cordis_define', {
        plugin: { kind: 'new', idPrefix: 'sesrun' },
        name: 'SES headless package',
        purpose: 'Prove SES activation and teardown through the headless profile.',
        code: {
          host: `return {
            name: 'ses-headless-package',
            inject: ['tools'],
            apply(ctx) {
              harness.registerTool(ctx, harness.defineTool({
                name: 'ses_headless_probe',
                description: 'Return data from the SES package.',
                parameters: { value: { type: 'string', required: true } },
                output: {
                  schema: { type: 'json' },
                  render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
                },
                async execute(args) {
                  return {
                    echoed: args.value,
                    bytes: Array.from(new TextEncoder().encode(args.value)),
                  }
                },
              }))
            },
          }`,
        },
      }, 'define')
    } else if (results.length === 1) {
      chunks = toolCall('cordis_run', { pluginId: 'sesrun-1', packageId: 'pkg-1', mode: 'run' }, 'run')
    } else if (results.length === 2) {
      if (!options.tools?.some(tool => tool.name === 'ses_headless_probe')) {
        throw new Error('SES headless package did not register its dynamic tool')
      }
      chunks = toolCall('ses_headless_probe', { value: 'assembled' }, 'probe')
    } else if (results.length === 3) {
      chunks = toolCall('cordis_stop', { pluginId: 'sesrun-1' }, 'stop')
    } else {
      if (options.tools?.some(tool => tool.name === 'ses_headless_probe')) {
        throw new Error('SES headless package tool survived cordis_stop')
      }
      const reply = 'SES_HEADLESS_OK'
      chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: reply },
        { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
        { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    }
    for (const chunk of chunks) yield chunk
  }
}

export const name = 'ses-headless-mock-llm'
export const inject = ['llm']

/** Register the keyless SES headless adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['ses-headless'], new SesHeadlessAdapter())
}
