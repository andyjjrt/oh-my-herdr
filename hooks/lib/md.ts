// Markdown for command answers and the lead. Claude Code draws a command's text as markdown (and
// prismantis, when installed, colours its tables), so answers are written as markdown. Pure.

/** One table cell: no pipe or line break may break the row. */
export const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim() || ' '

/** `code` that survives backticks in the text. */
export const code = (s: string): string => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``)

export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  return [`| ${head.map(cell).join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n')
}
