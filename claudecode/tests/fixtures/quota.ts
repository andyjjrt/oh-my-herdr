// Usage API responses captured 2026-11-14, cut down to the fields the parsers read (no account
// identifiers; the Claude response's other fields are left out).
export const CLAUDE_USAGE = {
  "five_hour": { "utilization": 29.0, "resets_at": "2026-11-13T20:20:00.208789+00:00" },
  "seven_day": { "utilization": 4.0, "resets_at": "2026-11-20T12:00:00.208812+00:00" },
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "limits": [
    { "kind": "session", "percent": 29, "resets_at": "2026-11-13T20:20:00.208789+00:00", "scope": null },
    { "kind": "weekly_all", "percent": 4, "resets_at": "2026-11-20T12:00:00.208812+00:00", "scope": null },
    {
      "kind": "weekly_scoped",
      "percent": 5,
      "resets_at": "2026-11-20T12:00:00.209075+00:00",
      "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }
    }
  ]
} as const

export const OPENCODE_GO_USAGE = {
  "usage": {
    "rolling": {
      "status": "ok",
      "percent": 0,
      "resetsAt": "2026-11-13T21:15:50.000Z"
    },
    "weekly": {
      "status": "ok",
      "percent": 3,
      "resetsAt": "2026-11-16T00:00:00.000Z"
    },
    "monthly": {
      "status": "ok",
      "percent": 1,
      "resetsAt": "2026-12-12T02:22:24.000Z"
    }
  }
} as const
