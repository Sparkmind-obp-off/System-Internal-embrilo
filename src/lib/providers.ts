import { buildPrompt, promptDigest, TEMPLATE_VERSION, type PromptBrief } from './prompt'

/**
 * Provider adapter interface. Every production run goes through one adapter so the
 * job record always captures provider, mode, template version and input provenance.
 *
 * VERIFICATION STATUS (see docs/08-implementation-status.md):
 *   No Genspark generation API, connector or MCP endpoint callable from this Worker
 *   has been verified. Therefore only MANUAL-ASSISTED adapters are registered.
 *   Do not add an `api`/`mcp` adapter until a real, documented integration has passed
 *   an end-to-end test with least-privilege credentials stored as Worker secrets.
 */
export type ProviderMode = 'manual' | 'api' | 'mcp'

export interface ProviderAdapter {
  id: string
  label: string
  mode: ProviderMode
  verified: boolean // true only for automated integrations proven end-to-end
  description: string
  prepare(brief: PromptBrief): Promise<{ prompt: string; digest: string; templateVersion: string }>
  /** Automated adapters implement this; manual adapters leave it undefined (operator handoff). */
  execute?: (prompt: string) => Promise<{ text: string; costCents?: number }>
}

const prepare = async (brief: PromptBrief) => {
  const prompt = buildPrompt(brief)
  return { prompt, digest: await promptDigest(prompt), templateVersion: TEMPLATE_VERSION }
}

export const gensparkManual: ProviderAdapter = {
  id: 'genspark-manual',
  label: 'Genspark (manual-assisted)',
  mode: 'manual',
  verified: false,
  description:
    'Operator copies the sanitized prompt into their own Genspark workspace, reviews the output, then pastes/uploads it here. No automated call is made.',
  prepare
}

export const manualWriter: ProviderAdapter = {
  id: 'manual-writer',
  label: 'Human writer (no AI)',
  mode: 'manual',
  verified: false,
  description: 'Operator writes the deliverable directly, using the brief as reference.',
  prepare
}

export const PROVIDERS: ProviderAdapter[] = [gensparkManual, manualWriter]

export function getProvider(id: string): ProviderAdapter | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export const PROVIDER_ERROR_CODES = [
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_QUOTA',
  'OUTPUT_UNUSABLE',
  'SAFETY_REFUSAL',
  'BRIEF_INSUFFICIENT',
  'OTHER'
] as const
