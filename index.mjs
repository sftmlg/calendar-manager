#!/usr/bin/env node
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createServer } from 'http';
import { URL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Centralized tokens location (sibling folder in parent repo)
const TOKENS_DIR = join(__dirname, '..', 'tokens', 'calendar-manager');
const CREDENTIALS_PATH = join(__dirname, '..', 'tokens', 'credentials.json');
// Local config (stays in tool repo)
const CALENDAR_INDEX_DIR = join(__dirname, 'calendar-index');
const CALENDARS_CONFIG_PATH = join(__dirname, 'calendars.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const VALID_ACCOUNTS = ['personal', 'business'];

// Ensure directories exist
if (!existsSync(TOKENS_DIR)) mkdirSync(TOKENS_DIR, { recursive: true });
if (!existsSync(CALENDAR_INDEX_DIR)) mkdirSync(CALENDAR_INDEX_DIR, { recursive: true });

// Get token path for account
function getTokenPath(account) {
  return join(TOKENS_DIR, `${account}.json`);
}

// Get calendar index path for account
function getCalendarIndexPath(account) {
  const dir = join(CALENDAR_INDEX_DIR, account);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'upcoming.json');
}

// Load/save calendars config (aliases)
function loadCalendarsConfig() {
  if (existsSync(CALENDARS_CONFIG_PATH)) {
    return JSON.parse(readFileSync(CALENDARS_CONFIG_PATH, 'utf8'));
  }
  return { aliases: {} };
}

function saveCalendarsConfig(config) {
  writeFileSync(CALENDARS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Resolve calendar ID from alias or direct ID
function resolveCalendarId(calendarIdOrAlias) {
  const config = loadCalendarsConfig();
  return config.aliases[calendarIdOrAlias] || calendarIdOrAlias || 'primary';
}

// Load credentials
function loadCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) {
    console.error('❌ credentials.json not found at', CREDENTIALS_PATH);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
}

// Get OAuth2 client
function getOAuth2Client() {
  const credentials = loadCredentials();
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// Authenticate for specific account
async function authenticate(account) {
  if (!VALID_ACCOUNTS.includes(account)) {
    console.error(`❌ Invalid account: ${account}. Use: ${VALID_ACCOUNTS.join(', ')}`);
    process.exit(1);
  }

  const oauth2Client = getOAuth2Client();
  const tokenPath = getTokenPath(account);

  if (existsSync(tokenPath)) {
    const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  console.error(`❌ Not authenticated for ${account}. Run: pnpm run auth ${account}`);
  process.exit(1);
}

// Auth flow
async function authFlow(account) {
  if (!VALID_ACCOUNTS.includes(account)) {
    console.error(`❌ Invalid account: ${account}. Use: ${VALID_ACCOUNTS.join(', ')}`);
    process.exit(1);
  }

  const oauth2Client = getOAuth2Client();
  const tokenPath = getTokenPath(account);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account',
  });

  console.log(`\n🔐 Authenticating: ${account.toUpperCase()}\n`);
  console.log('🔗 Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n⏳ Waiting for authorization...');

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>✅ ${account.toUpperCase()} authorized!</h1><p>You can close this window.</p>`);

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
        console.log(`✅ Token saved for ${account} to`, tokenPath);

        server.close();
        resolve(oauth2Client);
      }
    }).listen(8847, () => {
      console.log('🌐 Listening on http://localhost:8847 for callback...');
    });
  });
}

// List calendars
async function listCalendars(auth, account) {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.calendarList.list();
  const config = loadCalendarsConfig();

  console.log(`\n📅 Calendars for ${account.toUpperCase()}:\n`);
  res.data.items.forEach((cal, i) => {
    const alias = Object.entries(config.aliases).find(([k, v]) => v === cal.id)?.[0];
    const aliasStr = alias ? ` [alias: ${alias}]` : '';
    console.log(`${i + 1}. ${cal.summary}${aliasStr}`);
    console.log(`   ID: ${cal.id}`);
  });
}

// Set calendar alias
async function setCalendarAlias(alias, calendarId) {
  const config = loadCalendarsConfig();
  config.aliases[alias] = calendarId;
  saveCalendarsConfig(config);
  console.log(`✅ Alias set: ${alias} → ${calendarId}`);
}

// List aliases
function listAliases() {
  const config = loadCalendarsConfig();
  console.log('\n📋 Calendar Aliases:\n');
  if (Object.keys(config.aliases).length === 0) {
    console.log('  No aliases configured.');
    console.log('  Use: node index.mjs alias set <name> <calendar-id>');
  } else {
    Object.entries(config.aliases).forEach(([alias, id]) => {
      console.log(`  ${alias} → ${id}`);
    });
  }
}

// Get events for date range
async function getEvents(auth, timeMin, timeMax, calendarId = 'primary') {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId: resolveCalendarId(calendarId),
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

// Format event for display
function formatEvent(event) {
  const start = event.start.dateTime || event.start.date;
  const end = event.end.dateTime || event.end.date;
  const startDate = new Date(start);
  const endDate = new Date(end);

  const isAllDay = !event.start.dateTime;
  const timeStr = isAllDay
    ? 'Ganztägig'
    : `${startDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} - ${endDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;

  return {
    id: event.id,
    summary: event.summary || '(Kein Titel)',
    time: timeStr,
    startTime: isAllDay ? null : startDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
    endTime: isAllDay ? null : endDate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
    date: startDate.toISOString().split('T')[0],
    weekday: startDate.toLocaleDateString('de-DE', { weekday: 'long' }),
    dateFormatted: startDate.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }),
    location: event.location || '',
    description: event.description || '',
    allDay: isAllDay,
  };
}

// Display events for a period
async function displayEvents(auth, account, startDate, endDate, label, calendarId = 'primary') {
  const events = await getEvents(auth, startDate, endDate, calendarId);

  console.log(`\n📅 ${label} (${account.toUpperCase()}):\n`);

  if (events.length === 0) {
    console.log('  Keine Termine.');
    return;
  }

  let currentDate = '';
  events.forEach(event => {
    const e = formatEvent(event);
    if (e.dateFormatted !== currentDate) {
      currentDate = e.dateFormatted;
      console.log(`\n  ${currentDate}:`);
    }
    console.log(`    ⏰ ${e.time} | ${e.summary}`);
    if (e.location) console.log(`       📍 ${e.location}`);
  });
}

// Today's events
async function todayEvents(auth, account) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  await displayEvents(auth, account, startOfDay, endOfDay, `Heute (${now.toLocaleDateString('de-DE')})`);
}

// Week events
async function weekEvents(auth, account) {
  const now = new Date();
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
  await displayEvents(auth, account, startOfWeek, endOfWeek, 'Diese Woche');
}

// Sync to calendar-index (LLM-friendly format)
async function syncCalendar(auth, account, customFrom = null, customTo = null) {
  const now = new Date();
  const startDate = customFrom ? new Date(customFrom) : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 28);
  const endDate = customTo ? new Date(customTo) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 28);

  const events = await getEvents(auth, startDate, endDate);
  const formatted = events.map(formatEvent);

  const byDate = {};
  formatted.forEach(event => {
    if (!byDate[event.date]) {
      byDate[event.date] = { date: event.date, weekday: event.weekday, events: [] };
    }
    byDate[event.date].events.push({
      time: event.time,
      startTime: event.startTime,
      endTime: event.endTime,
      title: event.summary,
      location: event.location,
      allDay: event.allDay,
    });
  });

  const output = {
    synced_at: new Date().toISOString(),
    account: account,
    range: { from: startDate.toISOString().split('T')[0], to: endDate.toISOString().split('T')[0] },
    total_events: events.length,
    days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
  };

  const outputPath = getCalendarIndexPath(account);
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`✅ Synced ${events.length} events for ${account} → ${outputPath}`);

  return output;
}

// Sync all accounts
async function syncAll() {
  const combined = { synced_at: new Date().toISOString(), accounts: [], all_events: [] };

  for (const account of VALID_ACCOUNTS) {
    const tokenPath = getTokenPath(account);
    if (existsSync(tokenPath)) {
      try {
        const auth = await authenticate(account);
        const data = await syncCalendar(auth, account);
        combined.accounts.push(account);
        data.days.forEach(day => {
          day.events.forEach(event => {
            combined.all_events.push({ ...event, date: day.date, weekday: day.weekday, account });
          });
        });
      } catch (e) {
        console.error(`⚠️ Could not sync ${account}:`, e.message);
      }
    } else {
      console.log(`⏭️ Skipping ${account} (not authenticated)`);
    }
  }

  combined.all_events.sort((a, b) => {
    const dateComp = a.date.localeCompare(b.date);
    if (dateComp !== 0) return dateComp;
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    return (a.startTime || '').localeCompare(b.startTime || '');
  });

  const combinedPath = join(CALENDAR_INDEX_DIR, 'combined.json');
  writeFileSync(combinedPath, JSON.stringify(combined, null, 2));
  console.log(`\n✅ Combined calendar → ${combinedPath}`);
}

// Parse options from args
function parseOptions(args) {
  const options = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      options[key] = value;
    }
    i++;
  }
  return options;
}

// Create event (enhanced)
async function createEvent(auth, account, options) {
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = resolveCalendarId(options.calendar);

  const isAllDay = options.allday || (!options.start?.includes('T') && !options.end?.includes('T'));

  const event = {
    summary: options.title,
    description: options.description || '',
    location: options.location || '',
    transparency: options.free ? 'transparent' : 'opaque',
  };

  if (isAllDay) {
    // All-day event (can be multi-day)
    event.start = { date: options.start };
    // For multi-day: end date is exclusive in Google Calendar
    if (options.end) {
      const endDate = new Date(options.end);
      endDate.setDate(endDate.getDate() + 1);
      event.end = { date: endDate.toISOString().split('T')[0] };
    } else {
      const endDate = new Date(options.start);
      endDate.setDate(endDate.getDate() + 1);
      event.end = { date: endDate.toISOString().split('T')[0] };
    }
  } else {
    event.start = { dateTime: new Date(options.start).toISOString() };
    event.end = { dateTime: new Date(options.end).toISOString() };
  }

  const res = await calendar.events.insert({ calendarId, resource: event });
  console.log(`✅ Event created in ${account}:`, res.data.htmlLink);
  return res.data;
}

// Delete event
async function deleteEvent(auth, account, eventId, calendarIdOrAlias = 'primary') {
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = resolveCalendarId(calendarIdOrAlias);
  await calendar.events.delete({ calendarId, eventId });
  console.log(`✅ Event deleted: ${eventId}`);
}

// Move event to another calendar
async function moveEvent(auth, account, eventId, fromCalendar, toCalendar) {
  const calendar = google.calendar({ version: 'v3', auth });
  const fromId = resolveCalendarId(fromCalendar);
  const toId = resolveCalendarId(toCalendar);

  const res = await calendar.events.move({
    calendarId: fromId,
    eventId,
    destination: toId,
  });
  console.log(`✅ Event moved to ${toCalendar}:`, res.data.htmlLink);
  return res.data;
}

// Show event details including attendees
async function showEvent(auth, eventId, calendarIdOrAlias = 'primary') {
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = resolveCalendarId(calendarIdOrAlias);

  const res = await calendar.events.get({
    calendarId,
    eventId,
  });

  const event = res.data;
  console.log('\n📅 Event Details:\n');
  console.log(`  Title: ${event.summary || 'No title'}`);
  console.log(`  ID: ${event.id}`);

  if (event.start?.dateTime) {
    console.log(`  Start: ${new Date(event.start.dateTime).toLocaleString('de-DE')}`);
    console.log(`  End: ${new Date(event.end.dateTime).toLocaleString('de-DE')}`);
  } else if (event.start?.date) {
    console.log(`  Date: ${event.start.date} (all-day)`);
  }

  if (event.location) console.log(`  Location: ${event.location}`);
  if (event.description) console.log(`  Description: ${event.description}`);

  if (event.organizer) {
    console.log(`\n  Organizer: ${event.organizer.displayName || ''} <${event.organizer.email}>`);
  }

  if (event.attendees?.length > 0) {
    console.log('\n  Attendees:');
    event.attendees.forEach(a => {
      const status = a.responseStatus === 'accepted' ? '✅' : a.responseStatus === 'declined' ? '❌' : '⏳';
      console.log(`    ${status} ${a.displayName || ''} <${a.email}>`);
    });
  }

  console.log(`\n  Link: ${event.htmlLink || 'N/A'}`);
  return event;
}

// Search events
async function searchEvents(auth, account, query, calendarIdOrAlias = 'primary', options = {}) {
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = resolveCalendarId(calendarIdOrAlias);

  const now = new Date();
  const timeMin = options.from ? new Date(options.from) : new Date(now.getFullYear() - 1, 0, 1);
  const timeMax = options.to ? new Date(options.to) : new Date(now.getFullYear() + 1, 11, 31);

  const res = await calendar.events.list({
    calendarId,
    q: query,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: options.limit || 20,
  });

  console.log(`\n🔍 Search results for "${query}":\n`);
  if (!res.data.items?.length) {
    console.log('  No events found.');
    return [];
  }

  res.data.items.forEach(event => {
    const e = formatEvent(event);
    console.log(`  ${e.dateFormatted} | ${e.time} | ${e.summary}`);
    console.log(`    ID: ${event.id}`);
    if (e.location) console.log(`    📍 ${e.location}`);
  });

  return res.data.items;
}

// Update event
async function updateEvent(auth, account, eventId, calendarIdOrAlias, updates) {
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = resolveCalendarId(calendarIdOrAlias);

  // Get existing event
  const existing = await calendar.events.get({ calendarId, eventId });
  const event = existing.data;

  // Apply updates
  if (updates.title) event.summary = updates.title;
  if (updates.description) event.description = updates.description;
  if (updates.location) event.location = updates.location;
  if (updates.free !== undefined) event.transparency = updates.free ? 'transparent' : 'opaque';
  if (updates.attendees) {
    // Add new attendees to existing ones
    const existingEmails = (event.attendees || []).map(a => a.email);
    const newAttendees = updates.attendees.split(',').map(e => e.trim()).filter(e => !existingEmails.includes(e));
    event.attendees = [...(event.attendees || []), ...newAttendees.map(email => ({ email }))];
  }

  const res = await calendar.events.update({
    calendarId,
    eventId,
    resource: event,
    sendUpdates: updates.attendees ? 'all' : 'none',
  });

  console.log(`✅ Event updated:`, res.data.htmlLink);
  if (updates.attendees) console.log(`📧 Invitations sent to: ${updates.attendees}`);
  return res.data;
}

// Create calendar
async function createCalendar(auth, name, description = '') {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.calendars.insert({
    requestBody: {
      summary: name,
      description,
      timeZone: 'Europe/Vienna',
    },
  });
  console.log(`✅ Calendar created: ${res.data.summary}`);
  console.log(`   ID: ${res.data.id}`);
  return res.data;
}

// Delete calendar
async function deleteCalendar(auth, calendarIdOrAlias) {
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = resolveCalendarId(calendarIdOrAlias);
  await calendar.calendars.delete({ calendarId });
  console.log(`✅ Calendar deleted: ${calendarIdOrAlias}`);
}

// Show help
function showHelp() {
  console.log(`
Calendar Manager - Multi-Account Google Calendar CLI

AUTHENTICATION:
  node index.mjs auth <account>              Authenticate (personal|business)

CALENDARS:
  node index.mjs list <account>              List all calendars
  node index.mjs calendar create <account> "Name" ["Description"]
  node index.mjs calendar delete <account> <calendar-id|alias>

ALIASES (shortcuts for calendar IDs):
  node index.mjs alias list                  Show all aliases
  node index.mjs alias set <name> <id>       Set alias for calendar ID
  node index.mjs alias remove <name>         Remove alias

VIEW EVENTS:
  node index.mjs today <account>             Today's events
  node index.mjs week <account>              This week's events
  node index.mjs search <account> "query" [--calendar <id|alias>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]

CREATE EVENTS:
  node index.mjs create <account> --title "Title" --start YYYY-MM-DD [options]

  Options:
    --title "Event Title"          Required
    --start YYYY-MM-DD[THH:MM]     Required (date or datetime)
    --end YYYY-MM-DD[THH:MM]       Optional (defaults to same day/+1h)
    --calendar <id|alias>          Target calendar (default: primary)
    --description "Description"    Event description
    --location "Location"          Event location
    --free                         Show as free (not blocking)
    --allday                       Force all-day event

MODIFY EVENTS:
  node index.mjs update <account> <event-id> [--calendar <id|alias>] [--title "New Title"] [--free]
  node index.mjs delete <account> <event-id> [--calendar <id|alias>]
  node index.mjs move <account> <event-id> --from <calendar> --to <calendar>

SYNC (for LLM context):
  node index.mjs sync <account>              Sync to calendar-index/ (±4 weeks)
  node index.mjs sync all                    Sync all accounts

EXAMPLES:
  # Create all-day free event in specific calendar
  node index.mjs create business --title "Messe" --start 2026-01-30 --end 2026-02-01 --calendar messen --free

  # Set alias for easier calendar access
  node index.mjs alias set messen "c_abc123@group.calendar.google.com"

  # Search and delete
  node index.mjs search business "Messe" --calendar messen
  node index.mjs delete business abc123 --calendar messen

  # Move event between calendars
  node index.mjs move business eventId123 --from primary --to messen
`);
}

// Main
async function main() {
  const [,, command, accountOrArg, ...args] = process.argv;
  const options = parseOptions(args);

  if (!command) {
    showHelp();
    return;
  }

  switch (command) {
    case 'auth':
      if (!accountOrArg) {
        console.error('Usage: node index.mjs auth <personal|business>');
        process.exit(1);
      }
      await authFlow(accountOrArg);
      break;

    case 'list':
      if (!accountOrArg) {
        console.error('Usage: node index.mjs list <personal|business>');
        process.exit(1);
      }
      const authList = await authenticate(accountOrArg);
      await listCalendars(authList, accountOrArg);
      break;

    case 'calendar':
      if (accountOrArg === 'create') {
        const account = args[0];
        const name = args[1];
        const desc = args[2] || '';
        const authCalCreate = await authenticate(account);
        await createCalendar(authCalCreate, name, desc);
      } else if (accountOrArg === 'delete') {
        const account = args[0];
        const calId = args[1];
        const authCalDelete = await authenticate(account);
        await deleteCalendar(authCalDelete, calId);
      } else {
        console.error('Usage: node index.mjs calendar <create|delete> <account> ...');
      }
      break;

    case 'alias':
      if (accountOrArg === 'list') {
        listAliases();
      } else if (accountOrArg === 'set') {
        const alias = args[0];
        const calId = args[1];
        if (!alias || !calId) {
          console.error('Usage: node index.mjs alias set <name> <calendar-id>');
          process.exit(1);
        }
        await setCalendarAlias(alias, calId);
      } else if (accountOrArg === 'remove') {
        const alias = args[0];
        const config = loadCalendarsConfig();
        delete config.aliases[alias];
        saveCalendarsConfig(config);
        console.log(`✅ Alias removed: ${alias}`);
      } else {
        console.error('Usage: node index.mjs alias <list|set|remove> ...');
      }
      break;

    case 'today':
      if (!accountOrArg) {
        console.error('Usage: node index.mjs today <personal|business>');
        process.exit(1);
      }
      const authToday = await authenticate(accountOrArg);
      await todayEvents(authToday, accountOrArg);
      break;

    case 'week':
      if (!accountOrArg) {
        console.error('Usage: node index.mjs week <personal|business>');
        process.exit(1);
      }
      const authWeek = await authenticate(accountOrArg);
      await weekEvents(authWeek, accountOrArg);
      break;

    case 'search':
      if (!accountOrArg || !args[0]) {
        console.error('Usage: node index.mjs search <account> "query" [--calendar <id>]');
        process.exit(1);
      }
      const authSearch = await authenticate(accountOrArg);
      await searchEvents(authSearch, accountOrArg, args[0], options.calendar, options);
      break;

    case 'sync':
      if (accountOrArg === 'all') {
        await syncAll();
      } else if (accountOrArg) {
        const authSync = await authenticate(accountOrArg);
        await syncCalendar(authSync, accountOrArg, options.from, options.to);
      } else {
        console.error('Usage: node index.mjs sync <personal|business|all>');
        process.exit(1);
      }
      break;

    case 'create':
      if (!accountOrArg || !options.title || !options.start) {
        console.error('Usage: node index.mjs create <account> --title "Title" --start YYYY-MM-DD [--end ...] [--calendar ...] [--free]');
        process.exit(1);
      }
      const authCreate = await authenticate(accountOrArg);
      await createEvent(authCreate, accountOrArg, options);
      break;

    case 'update':
      if (!accountOrArg || !args[0]) {
        console.error('Usage: node index.mjs update <account> <event-id> [--calendar <id>] [--title "..."]');
        process.exit(1);
      }
      const authUpdate = await authenticate(accountOrArg);
      await updateEvent(authUpdate, accountOrArg, args[0], options.calendar, options);
      break;

    case 'delete':
      if (!accountOrArg || !args[0]) {
        console.error('Usage: node index.mjs delete <account> <event-id> [--calendar <id>]');
        process.exit(1);
      }
      const authDelete = await authenticate(accountOrArg);
      await deleteEvent(authDelete, accountOrArg, args[0], options.calendar);
      break;

    case 'move':
      if (!accountOrArg || !args[0] || !options.from || !options.to) {
        console.error('Usage: node index.mjs move <account> <event-id> --from <calendar> --to <calendar>');
        process.exit(1);
      }
      const authMove = await authenticate(accountOrArg);
      await moveEvent(authMove, accountOrArg, args[0], options.from, options.to);
      break;

    case 'show':
      if (!accountOrArg || !args[0]) {
        console.error('Usage: node index.mjs show <account> <event-id> [--calendar <id>]');
        process.exit(1);
      }
      const authShow = await authenticate(accountOrArg);
      await showEvent(authShow, args[0], options.calendar);
      break;

    default:
      showHelp();
  }
}

main().catch(console.error);
