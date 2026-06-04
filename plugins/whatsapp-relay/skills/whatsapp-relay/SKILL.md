---
name: whatsapp-relay
description: Connect and manage tagged local WhatsApp accounts from Codex using terminal QR codes and WhatsApp MCP tools.
---

# WhatsApp Relay

Use this skill when the user wants to connect one or more WhatsApp accounts, inspect recent chats, read messages, sync older history on demand, send a message from Codex, or control Codex from one allowed WhatsApp number.

## Workflow

1. Check configured account tags and local auth state first:

   Use the `whatsapp_list_accounts` plugin tool. For a specific tag, use `whatsapp_auth_status` with the `account` argument.

2. If the user is adding another WhatsApp number, create or select a tag:

   Use `whatsapp_add_account` with a short tag such as `personal`, `sales`, or `support`, or call `whatsapp_start_auth` with that `account` tag directly.

3. If WhatsApp is not authenticated, run the QR flow:

   Use the `whatsapp_start_auth` plugin tool. Pass `account` when working with anything other than the default account.

4. The tool returns a terminal QR block. Tell the user to scan that QR directly from the terminal or Codex output using the phone that owns that WhatsApp number.

5. After auth succeeds, prefer the plugin's WhatsApp MCP tools for chat listing, message review, and sending replies. Include the `account` argument when the user names a tag like `@sales`.

6. If the QR code expires, rerun `whatsapp_start_auth` for the same account tag.

7. If the user wants to control Codex from WhatsApp, set up the controller bridge:

   Use `whatsapp_allow_controller`, then `whatsapp_start_controller_bridge`.

8. Once the bridge is running, allowed direct chats can:

   - send `/accounts` to list linked WhatsApp account tags
   - send `/account add <tag> [label]` to add another WhatsApp number and receive a QR code
   - send `/account auth <tag>` to re-run auth for an existing account tag
   - send plain text to continue the current Codex session
   - send voice notes that are transcribed locally before continuing the current Codex session
   - receive outbound WhatsApp voice-note replies when voice reply mode is enabled for that chat
   - send `/new` or `/n` to start fresh
   - send `/sessions` or `/ls` to list recent Codex threads
   - send `/1`, `/2`, ... or `/session <number|thread-id-prefix>` or `/c <number|thread-id-prefix>` to switch this chat to another Codex session
   - send `/status` or `/st` to inspect the active session
   - send `/permissions` or `/p` to inspect the current permission level
   - send `/voice` to inspect or change outbound voice-reply mode for that chat
   - send `/permissions ro|ww|dfa` or `/permissions read-only|workspace-write|danger-full-access` to change the session sandbox level
   - send `/approve` or `/a`, `/approve session`, `/deny` or `/d`, or `/cancel` or `/q` to answer pending approvals in `workspace-write`
   - send `/stop` or `/x` to cancel the in-flight Codex run
   - send `/help` or `/h` to see command help

   The bridge uses `codex app-server` under the hood so each allowed number maps to a native Codex thread that can be resumed across messages.
   `workspace-write` is the safe default because guarded command and file-change approvals can be answered from WhatsApp.
   `danger-full-access` requires an explicit confirmation code from the chat before the bridge disables sandboxing for that session.
   Voice notes are transcribed locally with Parakeet v3 via `uvx` and `ffmpeg`, and short low-confidence transcripts are rejected so the chat can retry instead of sending a bad prompt to Codex.
   Outbound voice replies are synthesized locally through Chatterbox by default. English uses Turbo, and supported non-English replies route through Chatterbox Multilingual. macOS `say` remains available as an explicit fallback.
   While the bridge is running, treat the relay manager as the sole owner of all enabled live WhatsApp sessions. Prefer cached reads from MCP tools and route outbound messages through the bridge instead of reconnecting a second socket.
   If the allowed controller is the same WhatsApp account linked to the plugin, the self chat can be used as the control surface and should be treated as a valid source of prompts.

## Local state

- Account registry: `plugins/whatsapp-relay/data/accounts.json`
- Per-account auth and cache: `plugins/whatsapp-relay/data/accounts/<tag>/auth` and `plugins/whatsapp-relay/data/accounts/<tag>/store.json`
- Legacy single-account auth/cache may still exist at `plugins/whatsapp-relay/data/auth*` and `plugins/whatsapp-relay/data/store.json`; on first run it is copied into `@personal` and left in place as backup.

## Rules

- Do not guess a chat if multiple names match. List candidates first.
- Do not guess an account tag if the user has more than one configured account and the target is ambiguous. Ask for the tag or list accounts.
- If the user asks for older messages that are not in the local cache yet, use `whatsapp_sync_history` before concluding the history is unavailable.
- Keep outbound messages short and explicit when the user asks you to send one.
- If the user only wants a draft, do not call the send tool.
- Keep `npm run whatsapp:auth -- --account <tag>` as a local fallback, not the primary path.
- When relaying a QR from the plugin tools, preserve the compact block as-is instead of restyling or expanding it.
- Only allow explicit controller numbers to drive Codex from WhatsApp. Group chats should not be used as a control surface.
- Treat anything under `plugins/whatsapp-relay/data/auth*` and `plugins/whatsapp-relay/data/accounts/*/auth` as sensitive local state and keep it out of git.
- Typed slash commands remain the most reliable admin surface for sessions, permissions, and approvals; voice notes are best for natural prompts plus short commands like `help`, `status`, `stop`, and `new session`.
