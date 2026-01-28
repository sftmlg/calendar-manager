# Calendar Manager Skill

Google Calendar CLI for fetching and managing events across personal/business accounts.

## Quick Commands

```bash
cd claude-code-cli-tools/calendar-manager

# View events
pnpm today business       # Today's events
pnpm tomorrow business    # Tomorrow's events
pnpm week business        # This week's events
pnpm list business        # List all calendars

# Sync to LLM-friendly JSON (calendar-index/)
pnpm sync business                                    # Default ±4 weeks
pnpm sync business -- --from 2025-10-01 --to 2026-01-05  # Custom range
pnpm sync all                                         # All accounts + combined

# Create event
pnpm create business "Meeting" "2026-01-10T14:00" "2026-01-10T15:00" "Notes"
```

## LLM Context Integration

Synced events are stored in `calendar-index/` at repo root:

| File | Content |
|------|---------|
| `calendar-index/business/upcoming.json` | Business calendar events |
| `calendar-index/personal/upcoming.json` | Personal calendar events |
| `calendar-index/combined.json` | All accounts merged + sorted |

### JSON Structure
```json
{
  "synced_at": "2026-01-05T10:17:43.250Z",
  "account": "business",
  "range": { "from": "2025-12-07", "to": "2026-02-01" },
  "total_events": 26,
  "days": [
    {
      "date": "2025-12-09",
      "weekday": "Dienstag",
      "events": [
        {
          "time": "08:15 - 09:15",
          "startTime": "08:15",
          "endTime": "09:15",
          "title": "Meeting Name",
          "location": "Address or URL",
          "allDay": false
        }
      ]
    }
  ]
}
```

## Event Creation Rules

**CRITICAL**: When creating events from external sources (websites, emails, invitations):

1. **Always include registration/event link** in description with `🔗 REGISTRATION:` prefix
2. **Fetch the source** to find the actual registration URL before creating
3. **Include full program/agenda** if available
4. **Add organizer contact** (email/phone) when provided

Example description format:
```
Event description here.

🔗 REGISTRATION: https://example.com/register

PROGRAMM:
- 16:00 Welcome
- 17:00 Talk
- 18:00 Networking

Kontakt: Name, email@example.com
```

## Workflow

1. **Auth once**: `pnpm auth business` (OAuth flow, token saved)
2. **Daily sync**: `pnpm sync business` (updates calendar-index/)
3. **Read context**: Agent reads `calendar-index/business/upcoming.json`
4. **Schedule aware**: Agent knows upcoming meetings, availability

## Setup

Requires `credentials.json` at repo root (Google Cloud OAuth Desktop credentials).
OAuth redirect must be `http://localhost:8847`.
