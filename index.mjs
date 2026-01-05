#!/usr/bin/env node
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createServer } from 'http';
import { URL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
const CREDENTIALS_PATH = join(ROOT_DIR, 'credentials.json');
const TOKENS_DIR = join(__dirname, 'tokens');
const CALENDAR_INDEX_DIR = join(ROOT_DIR, 'calendar-index');
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
    prompt: 'select_account', // Force account selection
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
  console.log(`\n📅 Calendars for ${account.toUpperCase()}:\n`);
  res.data.items.forEach((cal, i) => {
    console.log(`${i + 1}. ${cal.summary} (${cal.id})`);
  });
}

// Get events for date range
async function getEvents(auth, timeMin, timeMax, calendarId = 'primary') {
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId,
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
async function displayEvents(auth, account, startDate, endDate, label) {
  const events = await getEvents(auth, startDate, endDate);

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

// Tomorrow's events
async function tomorrowEvents(auth, account) {
  const now = new Date();
  const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  await displayEvents(auth, account, startOfTomorrow, endOfTomorrow, `Morgen (${startOfTomorrow.toLocaleDateString('de-DE')})`);
}

// Week events
async function weekEvents(auth, account) {
  const now = new Date();
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
  await displayEvents(auth, account, startOfWeek, endOfWeek, 'Diese Woche');
}

// Sync to calendar-index (LLM-friendly format)
// 4 weeks back + 4 weeks forward = 8 weeks total
async function syncCalendar(auth, account) {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 28); // 4 weeks back
  const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 28); // 4 weeks forward

  const events = await getEvents(auth, startDate, endDate);
  const formatted = events.map(formatEvent);

  // Group by date
  const byDate = {};
  formatted.forEach(event => {
    if (!byDate[event.date]) {
      byDate[event.date] = {
        date: event.date,
        weekday: event.weekday,
        events: []
      };
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
    range: {
      from: startDate.toISOString().split('T')[0],
      to: endDate.toISOString().split('T')[0],
    },
    total_events: events.length,
    days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
  };

  const outputPath = getCalendarIndexPath(account);
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`✅ Synced ${events.length} events for ${account} → ${outputPath}`);

  return output;
}

// Sync all accounts and create combined view
async function syncAll() {
  const combined = {
    synced_at: new Date().toISOString(),
    accounts: [],
    all_events: [],
  };

  for (const account of VALID_ACCOUNTS) {
    const tokenPath = getTokenPath(account);
    if (existsSync(tokenPath)) {
      try {
        const auth = await authenticate(account);
        const data = await syncCalendar(auth, account);
        combined.accounts.push(account);

        // Add to combined events
        data.days.forEach(day => {
          day.events.forEach(event => {
            combined.all_events.push({
              ...event,
              date: day.date,
              weekday: day.weekday,
              account: account,
            });
          });
        });
      } catch (e) {
        console.error(`⚠️ Could not sync ${account}:`, e.message);
      }
    } else {
      console.log(`⏭️ Skipping ${account} (not authenticated)`);
    }
  }

  // Sort combined events by date and time
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

// Create event
async function createEvent(auth, account, summary, startTime, endTime, description = '') {
  const calendar = google.calendar({ version: 'v3', auth });

  const event = {
    summary,
    description,
    start: { dateTime: new Date(startTime).toISOString() },
    end: { dateTime: new Date(endTime).toISOString() },
  };

  const res = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
  });

  console.log(`✅ Event erstellt in ${account}:`, res.data.htmlLink);
  return res.data;
}

// Show help
function showHelp() {
  console.log(`
Calendar Manager - Multi-Account Google Calendar CLI

Commands:
  pnpm run auth <account>       - Authenticate (personal|business)
  pnpm run list <account>       - List calendars
  pnpm run today <account>      - Today's events
  pnpm run tomorrow <account>   - Tomorrow's events
  pnpm run week <account>       - This week's events
  pnpm run sync <account>       - Sync to calendar-index/ (LLM-friendly)
  pnpm run sync all             - Sync all accounts + combined view
  pnpm run create <account> "Title" "Start" "End" ["Description"]

Accounts: personal, business

Examples:
  node index.mjs auth personal
  node index.mjs today business
  node index.mjs sync all
  node index.mjs create personal "Meeting" "2026-01-10T14:00" "2026-01-10T15:00"
  `);
}

// Main
async function main() {
  const [,, command, accountOrArg, ...args] = process.argv;

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

    case 'today':
      if (!accountOrArg) {
        console.error('Usage: node index.mjs today <personal|business>');
        process.exit(1);
      }
      const authToday = await authenticate(accountOrArg);
      await todayEvents(authToday, accountOrArg);
      break;

    case 'tomorrow':
      if (!accountOrArg) {
        console.error('Usage: node index.mjs tomorrow <personal|business>');
        process.exit(1);
      }
      const authTomorrow = await authenticate(accountOrArg);
      await tomorrowEvents(authTomorrow, accountOrArg);
      break;

    case 'week':
      if (!accountOrArg) {
        console.error('Usage: node index.mjs week <personal|business>');
        process.exit(1);
      }
      const authWeek = await authenticate(accountOrArg);
      await weekEvents(authWeek, accountOrArg);
      break;

    case 'sync':
      if (accountOrArg === 'all') {
        await syncAll();
      } else if (accountOrArg) {
        const authSync = await authenticate(accountOrArg);
        await syncCalendar(authSync, accountOrArg);
      } else {
        console.error('Usage: node index.mjs sync <personal|business|all>');
        process.exit(1);
      }
      break;

    case 'create':
      if (!accountOrArg || args.length < 2) {
        console.log('Usage: node index.mjs create <account> "Title" "Start" "End" ["Description"]');
        process.exit(1);
      }
      const authCreate = await authenticate(accountOrArg);
      await createEvent(authCreate, accountOrArg, args[0], args[1], args[2], args[3]);
      break;

    default:
      showHelp();
  }
}

main().catch(console.error);
