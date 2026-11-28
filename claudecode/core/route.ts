// GENERATED FILE - do not edit; source: /core/route.ts
// Regenerate with: bun scripts/sync.ts
// Claude Code needs real files in the plugin; this header also keeps the generated copy
// distinct from the source in Git rename detection, so the source keeps its history.
// Category → profile. Pure.
//
// Rules, in order: walk the category's profiles in their configured order (as `rank` orders them),
// skip undefined profiles and any whose provider is out of quota (hard rule), prefer one whose
// family is not avoided (soft rule: falls back with a warning).

import type { Config } from './config'
import { unknownCategory } from './plan'

export type Intent = 'explore' | 'research' | 'implement' | 'fix' | 'review' | 'plan' | 'write'

export const INTENTS: readonly Intent[] = ['explore', 'research', 'implement', 'fix', 'review', 'plan', 'write']

/** The Intent Gate's usual categories per intent; other pairs need a stated reason. */
export const INTENT_CATEGORIES: Record<Intent, readonly string[]> = {
  explore: ['explore'],
  research: ['librarian'],
  implement: ['deep', 'quick', 'visual-engineering'],
  fix: ['deep', 'quick'],
  review: ['reviewer', 'oracle'],
  plan: ['oracle'],
  write: ['writing'],
}

export function isUsualPair(intent: Intent, category: string): boolean {
  return INTENT_CATEGORIES[intent].includes(category)
}

/**
 * Where a decision model will reorder candidates from the history log (future work). For now the
 * configured order stands.
 */
export function rank(_category: string, _intent: Intent | null, candidates: readonly string[]): string[] {
  return [...candidates]
}

export type RouteResult =
  | { ok: true; profile: string; family: string; warnings: string[] }
  | { ok: false; error: string; skipped: string[] }

export function pickProfile(
  cfg: Config,
  category: string,
  opts: { intent: Intent | null; avoidFamilies: readonly string[]; quotaOk: (profile: string) => boolean | string; unusable?: Set<string> },
): RouteResult {
  const cat = cfg.categories[category]
  if (!cat) {
    return { ok: false, error: unknownCategory(category, Object.keys(cfg.categories)), skipped: [] }
  }
  const warnings: string[] = []
  const skipped: string[] = []
  const usable: string[] = []
  for (const p of rank(category, opts.intent, cat.profiles)) {
    if (!cfg.profiles[p]) {
      warnings.push(`category '${category}' lists undefined profile '${p}'`)
      continue
    }
    if (opts.unusable?.has(p)) {
      skipped.push(`${p}: its agent cannot report status on this backend`)
      continue
    }
    const q = opts.quotaOk(p)
    if (q !== true) {
      skipped.push(`${p}: ${q === false ? 'out of quota' : q}`)
      continue
    }
    usable.push(p)
  }
  const preferred = usable.find(p => !opts.avoidFamilies.includes(cfg.profiles[p]!.family))
  const chosen = preferred ?? usable[0]
  if (chosen === undefined) {
    return {
      ok: false,
      error: `no usable profile for '${category}': every candidate (${cat.profiles.join(', ')}) is out of quota or undefined`,
      skipped,
    }
  }
  if (preferred === undefined && opts.avoidFamilies.length > 0) {
    warnings.push(`no '${category}' profile outside families [${opts.avoidFamilies.join(', ')}] has quota; using '${chosen}'`)
  }
  for (const s of skipped) warnings.push(`skipped ${s}`)
  return { ok: true, profile: chosen, family: cfg.profiles[chosen]!.family, warnings }
}
