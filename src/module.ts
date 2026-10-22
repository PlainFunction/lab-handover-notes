import { Module, Port, activeTelemetry, bindTelemetry, type Manifest, type Registry } from '#capabilities'
import { ACTIONS, ActionError, perform, type Ctx, type Result } from './actions'
import { tidyConverted } from './markdown'
import type { Env } from './worker'

// The Worker is wired in a registry, like every lab: each port it builds runs
// in a span, and logs go to Loki tied to their trace.

export const VERSION = '0.1.0'

/** Every action, from the page, the API and MCP alike. A port, so each run is traced. */
export abstract class Actions extends Port {
  abstract perform(name: string, raw: unknown, ctx: Ctx): Promise<Result>
}

export class D1Actions extends Actions {
  async perform(name: string, raw: unknown, ctx: Ctx): Promise<Result> {
    // Only our own names: anything else could be anything.
    activeTelemetry()?.span?.setAttribute('pf.action', ACTIONS.some(a => a.name === name) ? name : 'unknown')
    activeTelemetry()?.span?.setAttribute('pf.via', ctx.via)
    // Awaited, not returned: a refusal would otherwise reject a promise the span
    // isn't holding yet, and workerd reports it as unhandled.
    return await perform(name, raw, ctx)
  }

  describe(): Manifest {
    return { name: 'Handover notes actions', use: 'Documents, versions and questions, for people and agents', personalInfo: ['name'], usesAi: true, checkedBy: 'A writer publishes every draft and can reply to any answer', storesIn: 'Cloudflare D1' }
  }
}

/** A file that isn't Markdown, turned into Markdown for a draft. */
export abstract class Converter extends Port {
  abstract toMarkdown(file: File): Promise<string>
}

export class WorkersAiConverter extends Converter {
  readonly #ai: Ai
  readonly #gateway?: string
  constructor(ai: Ai, gateway?: string) {
    super()
    this.#ai = ai
    this.#gateway = gateway
  }

  async toMarkdown(file: File): Promise<string> {
    const out = await this.#ai.toMarkdown({ name: file.name, blob: file }, this.#gateway ? { gateway: { id: this.#gateway, collectLog: false } } : undefined)
    if (out.format === 'error') throw new ActionError(400, `Nothing added: ${file.name} couldn't be turned into Markdown (${out.error}).`)
    return tidyConverted(out.data)
  }

  describe(): Manifest {
    return { name: 'Workers AI toMarkdown', use: 'Turns uploaded files into Markdown drafts', personalInfo: ['whatever the file holds'], usesAi: true, checkedBy: 'A writer reads and publishes every draft', storesIn: 'Nothing but the Markdown, in Cloudflare D1' }
  }
}

export class RoomModule extends Module {
  readonly #env: Env
  constructor(env: Env) {
    super()
    this.#env = env
  }

  register(c: Registry) {
    bindTelemetry(c, this.#env, { serviceName: 'pf-handover-notes', serviceVersion: VERSION, client: 'handover-notes' })
    c.bind(Actions, () => new D1Actions())
    const ai = this.#env.AI
    if (ai) c.bind(Converter, () => new WorkersAiConverter(ai, this.#env.AI_GATEWAY_ID || undefined))
  }
}
