// The TUI side of OmhRpc: an OmhApi over `context.client.rpc(OmhRpc)`.

import { OmhRpc, type CommandInput, type CommandOutput, type OmhApi, type PlanOutput, type Snapshot } from './protocol'

/** The one call of the TUI context this needs; tests never reach it (they use a fake OmhApi). */
export type RpcCapable = { client: { rpc: (definition: typeof OmhRpc) => any } }

export function rpcApi(context: RpcCapable): OmhApi {
  const client = () => context.client.rpc(OmhRpc)
  return {
    command: async (input: CommandInput) => (await client().command(input)) as CommandOutput,
    snapshot: async () => (await client().snapshot({})) as Snapshot,
    plan: async () => (await client().plan({})) as PlanOutput,
  }
}
