// Optional drawing through the prismantis mod (github.com/NahumLitvin/prismantis), which adds
// `$.prismantis.markdown` in engine.create. It is not a dependency: without it `$.prismantis` is
// absent, and every caller falls back to its own drawing (or to a herdr pane for /omh plan).

// `$` may only be spelled `$.noun.method(...)` at a call site, so presence is found by calling:
// without prismantis the call throws (no such noun) and the answer is null.

type Markdown = { prismantis: { markdown: (args: { surface: unknown; text: string; columns: number }) => Promise<unknown> } }

/** The markdown drawn by prismantis, or null when it is not installed or declines the text. */
export async function drawMarkdown($: Markdown, surface: unknown, text: string, columns: number): Promise<unknown> {
  if (text.trim() === '') return null
  try {
    return (await $.prismantis.markdown({ surface, text, columns: Math.max(20, columns) })) ?? null
  } catch {
    return null
  }
}

/** Whether prismantis is loaded: it draws a one-word paragraph. */
export async function hasPrismantis($: Markdown, surface: unknown): Promise<boolean> {
  return (await drawMarkdown($, surface, 'plan', 40)) !== null
}

/** An omh_collect answer: the `===== id (file) =====` header, the worker's report, and the closing note. */
export function splitCollected(text: string): { header: string; body: string; footer: string } | null {
  const m = /^===== (.+?) =====\n([\s\S]*?)\n=====\n?([\s\S]*)$/.exec(text)
  return m ? { header: m[1]!, body: m[2]!, footer: m[3]!.trim() } : null
}

/** Whether a tool result reads better drawn as markdown: a table, a fenced block or headings. */
export function looksLikeMarkdown(text: string): boolean {
  return /^\|.*\|[ \t]*\n\|[ \t:|-]+\|[ \t]*$/m.test(text) || /^```/m.test(text) || /^#{1,4} \S/m.test(text)
}
