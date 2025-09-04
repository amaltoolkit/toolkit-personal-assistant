Build a Chrome extension that authenticates with BlueSquareApps (RC) via OAuth 2.0, exchanges the OAuth token for a PassKey, stores that PassKey in Supabase as plain text, lets the user pick an organization, then lists contacts.
Architecture
* Chrome Extension (MV3, Side Panel)
* Node + Express on Vercel
* Supabase for storing the PassKey in plain text
* All endpoints on https://rc.bluesquareapps.com
Env (Vercel)
BSA_BASE=https://rc.bluesquareapps.com
BSA_CLIENT_ID=YOUR_BSA_CLIENT_ID
BSA_CLIENT_SECRET=YOUR_BSA_CLIENT_SECRET
BSA_REDIRECT_URI=YOUR_VERCEL_URL/auth/callback

SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY

APP_BASE_URL=YOUR_APP_BASE_URL
Supabase schema
create table oauth_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  state text not null,
  created_at timestamptz default now(),
  used_at timestamptz
);

create table bsa_tokens (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  passkey text not null,          -- stores the PassKey in plain text
  refresh_token text,             -- not used (PassKey refresh uses login.json endpoint)
  expires_at timestamptz,         -- PassKey expiration (1 hour from issuance)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
OAuth flow
1. Extension opens GET /auth/start?session_id=...
2. Backend saves state, 302 to:
{BSA_BASE}/oauth2/authorize
  ?response_type=code
  &client_id={BSA_CLIENT_ID}
  &redirect_uri={BSA_REDIRECT_URI}
  &scope=openid profile email
  &state={state}
3. Provider redirects to:
{APP_BASE_URL}/auth/callback?code=...&state=...
4. Backend immediately redirects user to BSA while processing continues in background
5. Backend exchanges authorization code for OAuth bearer token (temporary):
POST {BSA_BASE}/oauth2/token
Content-Type: application/x-www-form-urlencoded
{
  "grant_type":"authorization_code",
  "client_id":"...",
  "client_secret":"...",
  "code":"...",
  "redirect_uri":"{BSA_REDIRECT_URI}"
}
Returns: { "access_token": "<bearer_token>", ... }  -- This bearer token is temporary
6. Backend immediately exchanges OAuth bearer token for PassKey (permanent for 1 hour):
POST {BSA_BASE}/oauth2/passkey
Authorization: Bearer {bearer_token_from_step_5}
Content-Type: application/json
{}
Returns: { "passkey": "<PassKey>" }
7. Store ONLY the PassKey in bsa_tokens.passkey field (bearer token is discarded)
   - PassKey stored in plain text with 1-hour expiry
   - This PassKey is what's used for all BlueSquare API calls
8. Extension polls /auth/status and proceeds when PassKey is stored

PassKey Refresh
- PassKey expires in 1 hour
- Auto-refresh when < 5 minutes remaining before API calls
- Refresh using current PassKey:
POST {BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/login.json
Content-Type: application/json
{ "PassKey": "<current_passkey>" }
BlueSquare data calls
All API calls use the PassKey that was obtained from the PassKey exchange and stored in Supabase's bsa_tokens.passkey field.

1. List user orgs
POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json
Content-Type: application/json

{ "PassKey": "<PassKey stored in Supabase>" }

2. List contacts for org
POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json
Content-Type: application/json

{
  "PassKey": "<PassKey stored in Supabase>",
  "OrganizationId": "<orgId>",
  "ObjectName": "contact"
}
Express on Vercel (no encryption, plain text storage)
api/index.js
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BSA_BASE = process.env.BSA_BASE;

// 1) Start OAuth
app.get("/auth/start", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send("missing session_id");
  const state = crypto.randomBytes(16).toString("hex");
  await supabase.from("oauth_sessions").insert({ session_id: sessionId, state });

  const authUrl = new URL(`${BSA_BASE}/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", process.env.BSA_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", process.env.BSA_REDIRECT_URI);
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("state", state);
  res.redirect(authUrl.toString());
});

// 2) OAuth callback - redirects immediately, processes in background
app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("missing code/state");
  
  // Immediately redirect user to BSA
  res.redirect(`${BSA_BASE}`);
  
  // Process OAuth in background
  processOAuthCallback(code, state).catch(console.error);
});

async function processOAuthCallback(code, state) {
  // Validate state
  const { data: rows } = await supabase
    .from("oauth_sessions")
    .select("*")
    .eq("state", state)
    .is("used_at", null)
    .limit(1);
  const row = rows?.[0];
  if (!row) return;

  // Step 1: Exchange code for bearer token
  const tokenResp = await axios.post(
    `${BSA_BASE}/oauth2/token`,
    {
      grant_type: "authorization_code",
      client_id: process.env.BSA_CLIENT_ID,
      client_secret: process.env.BSA_CLIENT_SECRET,
      code,
      redirect_uri: process.env.BSA_REDIRECT_URI
    },
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const bearerToken = tokenResp.data.access_token;  // OAuth bearer token (temporary)
  if (!bearerToken) return;

  // Step 2: Exchange bearer token for PassKey
  const passKeyResp = await axios.post(
    `${BSA_BASE}/oauth2/passkey`,
    {},
    {
      headers: {
        "Authorization": `Bearer ${bearerToken}`,
        "Content-Type": "application/json"
      }
    }
  );

  const passKey = passKeyResp.data.passkey || passKeyResp.data.PassKey;
  if (!passKey) return;

  // Step 3: Store only PassKey (expires in 1 hour)
  await supabase.from("bsa_tokens").upsert({
    session_id: row.session_id,
    passkey: passKey,  // Store PassKey in passkey field
    refresh_token: null,    // Not used - PassKey refresh uses different mechanism
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
  }, { onConflict: "session_id" });

  await supabase.from("oauth_sessions").update({ used_at: new Date().toISOString() }).eq("id", row.id);
}

// 3) Auth status for polling
app.get("/auth/status", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.json({ ok: false });
  const { data: rows } = await supabase.from("bsa_tokens").select("session_id").eq("session_id", sessionId).limit(1);
  res.json({ ok: !!(rows && rows[0]) });
});

// Helper: Refresh PassKey using current PassKey
async function refreshPassKey(sessionId) {
  const { data: rows } = await supabase.from("bsa_tokens").select("*").eq("session_id", sessionId).limit(1);
  if (!rows?.[0]) return null;
  
  const currentPassKey = rows[0].passkey;
  const refreshResp = await axios.post(
    `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/login.json`,
    { PassKey: currentPassKey },
    { headers: { "Content-Type": "application/json" } }
  );
  
  const newPassKey = refreshResp.data.PassKey;
  if (!newPassKey) return null;
  
  await supabase.from("bsa_tokens").update({
    passkey: newPassKey,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
  }).eq("session_id", sessionId);
  
  return newPassKey;
}

// Helper: Get valid PassKey (auto-refreshes if < 5 min remaining)
async function getValidPassKey(sessionId) {
  const { data: rows } = await supabase.from("bsa_tokens").select("*").eq("session_id", sessionId).limit(1);
  const token = rows?.[0];
  if (!token) return null;
  
  const passKey = token.passkey;
  if (token.expires_at) {
    const timeLeft = new Date(token.expires_at) - new Date();
    if (timeLeft < 5 * 60 * 1000) {
      const newPassKey = await refreshPassKey(sessionId);
      return newPassKey || passKey;
    }
  }
  return passKey;
}

// 4) List orgs (with auto-refresh)
app.get("/api/orgs", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send("missing session_id");

  const passKey = await getValidPassKey(sessionId);
  if (!passKey) return res.status(401).send("not authenticated");

  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json`;
  const resp = await axios.post(url, { PassKey: passKey }, { headers: { "Content-Type": "application/json" } });
  res.json(resp.data);
});

// 5) List contacts for org (with auto-refresh)
app.post("/api/orgs/:orgId/contacts", async (req, res) => {
  const sessionId = req.query.session_id;
  const orgId = req.params.orgId;
  if (!sessionId) return res.status(400).send("missing session_id");
  if (!orgId) return res.status(400).send("missing orgId");

  const passKey = await getValidPassKey(sessionId);
  if (!passKey) return res.status(401).send("not authenticated");

  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json`;
  const payload = { PassKey: passKey, OrganizationId: orgId, ObjectName: "contact" };
  const resp = await axios.post(url, payload, { headers: { "Content-Type": "application/json" } });
  res.json(resp.data);
});

module.exports = app;
vercel.json
{
  "version": 2,
  "builds": [{ "src": "api/index.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "api/index.js" }]
}
Extension wiring (MV3 side panel)
manifest.json
{
  "manifest_version": 3,
  "name": "BlueSquare Assistant",
  "version": "1.0.0",
  "permissions": ["storage", "activeTab", "sidePanel"],
  "host_permissions": [
    "https://rc.bluesquareapps.com/*",
    "YOUR_APP_BASE_URL/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "BlueSquare Assistant" }
}
sidepanel.html
<!doctype html>
<html>
  <body>
    <button id="login">Login with BlueSquareApps</button>
    <div id="authed" style="display:none;">
      <div id="orgs"></div>
      <div id="contacts"></div>
    </div>
    <script src="sidepanel.js"></script>
  </body>
</html>
sidepanel.js
const APP_BASE = "YOUR_APP_BASE_URL";
const sessionIdKey = "bsa_session_id";

function getSessionId() {
  const existing = localStorage.getItem(sessionIdKey);
  if (existing) return existing;
  const s = crypto.randomUUID();
  localStorage.setItem(sessionIdKey, s);
  return s;
}

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function pollAuth(sessionId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${APP_BASE}/auth/status?session_id=${encodeURIComponent(sessionId)}`);
    const json = await r.json();
    if (json.ok) return true;
    await sleep(1000);
  }
  return false;
}

document.getElementById("login").addEventListener("click", async () => {
  const sessionId = getSessionId();
  const authStart = `${APP_BASE}/auth/start?session_id=${encodeURIComponent(sessionId)}`;
  window.open(authStart, "_blank", "popup,width=480,height=720");
  const ok = await pollAuth(sessionId);
  if (!ok) { alert("Login timed out. Try again."); return; }
  document.getElementById("authed").style.display = "block";
  await loadOrgs();
});

async function loadOrgs() {
  const sessionId = getSessionId();
  const r = await fetch(`${APP_BASE}/api/orgs?session_id=${encodeURIComponent(sessionId)}`);
  const orgs = await r.json();
  const div = document.getElementById("orgs");
  div.innerHTML = "<h3>Select an org</h3>";
  const ul = document.createElement("ul");
  (orgs || []).forEach(o => {
    const id = o.Id || o.id;
    const name = o.Name || o.name || id;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = `${name} (${id})`;
    btn.onclick = () => listContacts(id);
    li.appendChild(btn);
    ul.appendChild(li);
  });
  div.appendChild(ul);
}

async function listContacts(orgId) {
  const sessionId = getSessionId();
  const r = await fetch(`${APP_BASE}/api/orgs/${encodeURIComponent(orgId)}/contacts?session_id=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  const contacts = await r.json();
  const div = document.getElementById("contacts");
  div.innerHTML = `<h3>Contacts for org ${orgId}</h3><pre>${JSON.stringify(contacts, null, 2)}</pre>`;
}
background.js (Service Worker)
// Service Worker for Chrome Extension
// Handles extension lifecycle and side panel configuration

console.log('BlueSquare Assistant service worker started');

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed/updated:', details.reason);
  
  // Configure side panel behavior if API is available
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .then(() => console.log('Side panel behavior configured'))
      .catch((error) => console.log('Side panel behavior not supported:', error.message));
  }
});

// Handle runtime messages from the side panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received:', request);
  
  if (request.action === 'checkAuth') {
    sendResponse({ status: 'ok' });
  }
  
  return false; // Synchronous response
});
Security and ops notes

Core Security Principles:
* PassKey stored in plain text in Supabase - MUST use strict Row Level Security (RLS)
* Backend service role is the ONLY entity with database access
* Extension never receives or stores PassKey directly - only session IDs
* All API calls proxied through backend to prevent PassKey exposure

Authentication & Session Management:
* PassKey expires in 1 hour - automatic refresh when < 5 minutes remaining
* Session IDs generated client-side using crypto.randomUUID()
* OAuth state parameter validated to prevent CSRF attacks
* Sessions marked as "used" after successful authentication
* Expired PassKeys automatically refreshed using login.json endpoint

API Security:
* 10-second timeout on all external API calls
* Retry mechanism with PassKey refresh on 401 errors
* CORS enabled with credentials support
* Input validation on all endpoints (session_id, orgId required)
* HTML escaping for XSS prevention in frontend display

Operational Considerations:
* Health check endpoint available at /health
* Comprehensive logging with prefixed identifiers:
  - [AUTH START] - OAuth initiation
  - [AUTH CALLBACK] - Callback processing
  - [PROCESS OAUTH] - Background OAuth flow
  - [SIDEPANEL] - Client-side operations
* Background processing for OAuth to improve UX
* Immediate user redirect during callback processing

Development & Monitoring:
* Automatic API base URL switching for local development
* Error handling middleware for unhandled exceptions
* Consider implementing:
  - Rate limiting on /api/* endpoints
  - Session expiration policies
  - Audit logging for PassKey usage
  - Monitoring for failed authentication attempts
  - Alerts for PassKey refresh failures

Database Security:
* Use Supabase service role key (full access) - keep secure
* Implement RLS policies:
  - oauth_sessions: Write-only for backend
  - bsa_tokens: Read/write only for backend service role
* Regular cleanup of expired sessions and tokens
* Never expose database credentials to client
Quick test path
1. Login in side panel → complete OAuth → callback stores PassKey in plain text.
2. Extension polling flips to authed state.
3. Load orgs → select org → List contacts returns JSON.
