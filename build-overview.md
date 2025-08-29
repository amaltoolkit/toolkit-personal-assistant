Build a Chrome extension authenticates with BlueSquareApps (RC) via OAuth 2.0, stores the returned PassKey in Supabase as plain text, lets the user pick an organization, then lists contacts.
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
  access_token text not null,     -- store PassKey in plain text
  refresh_token text,             -- if provided
  expires_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
OAuth flow
1. Extension opens GET /auth/start?session_id=...
2. Backend saves state, 302 to:
{BSA_BASE}/auth/oauth2/authorize
  ?response_type=code
  &client_id={BSA_CLIENT_ID}
  &redirect_uri={BSA_REDIRECT_URI}
  &scope=basic
  &state={state}
1. Provider redirects to:
{APP_BASE_URL}/auth/callback?code=...&state=...
1. Backend exchanges code for token:
POST {BSA_BASE}/auth/oauth2/token
Content-Type: application/json
{
  "grant_type":"authorization_code",
  "client_id":"...",
  "client_secret":"...",
  "code":"...",
  "redirect_uri":"{BSA_REDIRECT_URI}"
}
1. Store PassKey as plain text in bsa_tokens.access_token.
2. Callback returns a small success page. Extension polls /auth/status and proceeds.
BlueSquare data calls
1. List user orgs
POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json
Content-Type: application/json

{ "PassKey": "<access_token from Supabase>" }
1. List contacts for org
POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json
Content-Type: application/json

{
  "PassKey": "<access_token from Supabase>",
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

  const authUrl = new URL(`${BSA_BASE}/auth/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", process.env.BSA_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", process.env.BSA_REDIRECT_URI);
  authUrl.searchParams.set("scope", "basic");
  authUrl.searchParams.set("state", state);
  res.redirect(authUrl.toString());
});

// 2) OAuth callback
app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("missing code/state");

  const { data: rows, error } = await supabase
    .from("oauth_sessions")
    .select("*")
    .eq("state", state)
    .limit(1);
  if (error) return res.status(500).send("db error");
  const row = rows && rows[0];
  if (!row) return res.status(400).send("invalid state");

  const tokenResp = await axios.post(
    `${BSA_BASE}/auth/oauth2/token`,
    {
      grant_type: "authorization_code",
      client_id: process.env.BSA_CLIENT_ID,
      client_secret: process.env.BSA_CLIENT_SECRET,
      code,
      redirect_uri: process.env.BSA_REDIRECT_URI
    },
    { headers: { "Content-Type": "application/json" } }
  );

  // Treat the returned access token as the PassKey
  const accessToken = tokenResp.data.access_token || tokenResp.data.token || tokenResp.data.PassKey;
  const refreshToken = tokenResp.data.refresh_token || null;
  const expiresIn = tokenResp.data.expires_in || 3600;

  await supabase.from("bsa_tokens").upsert({
    session_id: row.session_id,
    access_token: accessToken,                 // plain text storage
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
  }, { onConflict: "session_id" });

  await supabase.from("oauth_sessions").update({ used_at: new Date().toISOString() }).eq("id", row.id);

  res.send(`<html><body>Login success. You can close this window.</body></html>`);
});

// 3) Auth status for polling
app.get("/auth/status", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.json({ ok: false });
  const { data: rows } = await supabase.from("bsa_tokens").select("session_id").eq("session_id", sessionId).limit(1);
  res.json({ ok: !!(rows && rows[0]) });
});

// 4) List orgs
app.get("/api/orgs", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send("missing session_id");

  const { data: rows } = await supabase.from("bsa_tokens").select("*").eq("session_id", sessionId).limit(1);
  if (!rows || !rows[0]) return res.status(401).send("not authenticated");

  const passKey = rows[0].access_token;       // use plain text PassKey
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json`;
  const resp = await axios.post(url, { PassKey: passKey }, { headers: { "Content-Type": "application/json" } });
  res.json(resp.data);
});

// 5) List contacts for org
app.post("/api/orgs/:orgId/contacts", async (req, res) => {
  const sessionId = req.query.session_id;
  const orgId = req.params.orgId;
  if (!sessionId) return res.status(400).send("missing session_id");
  if (!orgId) return res.status(400).send("missing orgId");

  const { data: rows } = await supabase.from("bsa_tokens").select("*").eq("session_id", sessionId).limit(1);
  if (!rows || !rows[0]) return res.status(401).send("not authenticated");

  const passKey = rows[0].access_token;       // use plain text PassKey
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
  "version": "0.1.0",
  "permissions": ["storage"],
  "host_permissions": [
    "https://rc.bluesquareapps.com/*",
    "YOUR_APP_BASE_URL/*"
  ],
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
Security and ops notes
* You are intentionally storing the PassKey in plain text to use as-is in API calls. Protect the table with strict Supabase Row Level Security and keep access limited to your backend’s service role.
* Never return the PassKey to the extension. The extension identifies a session and the server-side proxies API calls.
* Validate and expire sessions as needed. Log only high-level events. Add rate limits on /api/* if required.
* If /token returns refresh_token and expires_in, implement refresh later by updating the plain text access_token in Supabase.
Quick test path
1. Login in side panel → complete OAuth → callback stores PassKey in plain text.
2. Extension polling flips to authed state.
3. Load orgs → select org → List contacts returns JSON.
