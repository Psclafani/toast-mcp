# Toast POS MCP server

Connect Claude (or any MCP client) to your Toast POS. Ask your restaurant questions in plain English — from your laptop, your phone, anywhere:

> *"What were my net sales last night?"*
> *"Who's clocked in right now?"*
> *"Compare this Saturday to last Saturday, hour by hour."*

**55 read-only tools** covering orders, sales, labor, employees, time entries, menus, inventory, customers, and cash — live-tested against real production restaurants.

A **PrimeCost** project — built and maintained by **Chris Cusack**, restaurant owner and writer of [All Day](https://chriscusack.net), a newsletter about running restaurants with AI. First in a series: working MCP connections for every major restaurant POS.

> 🎥 **Not a developer?** There's a full step-by-step walkthrough — with screenshots for every Toast screen, the exact Railway clicks, and the phone demo — at **[chriscusack.net/p/toast-mcp](https://www.chriscusack.net/p/toast-mcp)**. This README is the condensed version for people comfortable with a terminal.

---

## Deploy on Railway (5 minutes, one click)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/toast-mcp)

1. Click the button (or go to [railway.com/deploy/toast-mcp](https://railway.com/deploy/toast-mcp)) and hit **Deploy Now**
2. Paste your three values: `TOAST_CLIENT_ID` and `TOAST_CLIENT_SECRET` from Toast Web, and `TOAST_RESTAURANT_GUID` for your location. Everything else is pre-filled, and your connector password (`TOAST_MCP_SECRET`) is generated automatically.
3. After deploy, open the service's **Variables** tab and copy the `TOAST_MCP_SECRET` value. Save it somewhere safe. It is the only lock on your data.
4. **Settings → Networking → Generate Domain** (port 3000), then confirm `https://<your-domain>/health` returns `{"status":"ok"}`

If Claude is connected to your Chrome browser, you can also just ask it to do this setup for you.

Prefer manual setup? Deploy this repo as a GitHub service and set the six variables yourself (`TOAST_MCP_MODE=http`, `TOAST_ENVIRONMENT=production`, plus the four above — invent your own long random `TOAST_MCP_SECRET`).

## What you need

1. **Toast standard API access.** On Restaurant Management Suite Essentials and up this is a self-serve page in Toast Web: **Integrations → Toast API access → Manage credentials → Create new credentials**, with the dropdown set to **Standard API**. Name it, select every read scope, pick your locations, Confirm. You get a **client ID** and **client secret**; save the secret immediately, Toast shows it once. If the page is missing, a Customer Care ticket asking for "standard API access for my own restaurant group, for internal reporting, all read scopes" gets it turned on (mine came through in a day). Full walkthrough: https://www.chriscusack.net/p/your-pos-has-two-apis
2. **Your restaurant GUID.** Toast's API access confirmation email lists the GUID for every location you selected. Or: Toast Web sets a cookie named `lastRestaurantGuid` while you're logged in. (The walkthrough covers three ways to find it.)
3. **A place to run the server** — Railway (easiest, ~$5/mo), or any host that runs Node 18+.
4. **A Claude plan that supports custom connectors** (Pro/Max/Team) — or any other MCP client.

## Connect Claude

claude.ai → **Settings → Connectors → Add custom connector**:

- Name: `Toast`
- URL: `https://<your-domain>/<your-secret>/mcp`

That's it. The connector now works in Claude chat, mobile, Cowork, and Claude Code.

## Run locally instead (Claude Code / Claude Desktop)

```json
{
  "mcpServers": {
    "toast": {
      "command": "node",
      "args": ["/path/to/repo/dist/main.js"],
      "env": {
        "TOAST_CLIENT_ID": "...",
        "TOAST_CLIENT_SECRET": "...",
        "TOAST_RESTAURANT_GUID": "...",
        "TOAST_ENVIRONMENT": "production"
      }
    }
  }
}
```

Build first with `npm install && npm run build`. Stdio mode needs no secret.

## Security posture (read this)

- **Read-only by default.** The 21 tools that could modify a POS (create orders, refund payments, void checks, edit employees, adjust stock) are **disabled** unless you set `TOAST_ENABLE_WRITE_TOOLS=true`. They are untested against live Toast. Leave them off.
- **Your secret is the only lock on your sales data.** Treat the connector URL like a password. Never screenshot it, never post it. If it leaks, rotate `TOAST_MCP_SECRET` in Railway (takes 2 minutes) and update your connector URL.
- **Your credentials never leave your infrastructure.** This server talks to exactly one external host: Toast's API (`ws-api.toasttab.com`). No telemetry, no analytics, no third parties. Read the source — it's small.
- Multi-location groups: deploy one service per location (or omit `TOAST_RESTAURANT_GUID` and pass `restaurantGuid` per call where tools support it).

## Provenance

This began as [BusyBee3333/toast-mcp-2026-complete](https://github.com/BusyBee3333/toast-mcp-2026-complete) (MIT). The original had never been run against live Toast and could not work (see [issue #1](https://github.com/BusyBee3333/toast-mcp-2026-complete/issues/1)); this version fixes authentication, endpoints, and the labor report, adds the remote HTTP transport with secret auth, disables write tools by default, and is verified daily against production restaurants. MIT license preserved.

## Who made this

**Chris Cusack** — restaurant owner and operator (Houston, two locations) writing about restaurants + AI at **[chriscusack.net](https://chriscusack.net)**. If this saved you time, that's where the rest of the playbook lives: labor auditing with AI, review management, the full stack. If you want it set up for you, or want this for a POS that doesn't have one yet — reach out.

**Using it?** Tag [@chriscusack_](https://www.instagram.com/chriscusack_/) on Instagram or post with **#ToastAllDay**. I want to see what you're asking it.

---
*Not affiliated with or endorsed by Toast, Inc. Toast is a trademark of its owner. Use your own credentials; you are responsible for your own API terms compliance.*
