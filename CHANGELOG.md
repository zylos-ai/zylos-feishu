# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] - 2026-02-26

### Added
- DM policy model: `dmPolicy` (open/allowlist/owner) with `dmAllowFrom` list, replacing legacy whitelist
- On-demand media download script (`scripts/download.js`) for image/file retrieval by resource key
- Markdown card rendering for outgoing messages (`message.useMarkdownCard` in config.json, default: true)
- DM rejection message for non-allowed users
- Group rejection messages for unauthorized @mentions and disabled group policy

### Fixed
- bindOwner rollback on saveConfig failure (align with Lark)

### Changed
- Legacy whitelist config auto-migrated to dmPolicy on upgrade (post-upgrade hook)
- Legacy admin commands (`list-whitelist`, `add-whitelist`, etc.) aliased to new dmPolicy commands
- `useMarkdownCard` defaults to true on install and upgrade

## [0.2.3] - 2026-02-21

### Fixed
- Post-upgrade hook was deleting `bot.verification_token` from config, breaking webhook mode on upgrade

## [0.2.2] - 2026-02-20

### Added
- Split log files by thread for audit trail isolation

### Fixed
- Bind webhook server to 127.0.0.1 (security: prevent direct port exposure)
- Path traversal protection in log paths and media downloads
- Config watcher: null filename handling, strict parseInt validation, reload timer cleanup
- Admin CLI: complete validation and policy enum alignment
- Guard against malformed webhook event payloads
- Sanitize image key in download path and guard JSON.parse
- Sanitize typing marker paths and wrap log writes in try/catch
- Ensure DATA_DIR exists before token write
- Persist internal token to file for cross-process-tree access
- Webhook server must bind to 0.0.0.0 reverted to 127.0.0.1 for Caddy proxy setup
- readSheetData delegates to values API with proper URL encoding
- Chat pagination and URL encoding fixes

### Security
- Standards audit: 19 fixes covering input validation, bot self-loop prevention, internal auth

## [0.2.1] - 2026-02-17

### Added
- Unified message dedup across WebSocket and webhook modes (#6)
- Structured endpoint routing with metadata (type, root, parent, msg, thread) (#6)
- Reply quoting: fetch quoted message content for context (#6)
- Multiple image support with lazy download (#6)
- Markdown Card auto-detection: code blocks and tables rendered as interactive cards (#6)
- Markdown-aware message chunking (preserves code blocks) (#6)
- In-memory group chat history with configurable limits per group (#6)
- User name cache with TTL (10 min in-memory, file for cold start) (#6)
- Group policy system with per-group config and auto-migration from legacy format (#6)
- Permission error detection with grant URL notification (#6)
- Typing indicator with emoji reaction and 120s auto-timeout (#6)
- Thread context isolation: thread messages stored separately (#6)
- Lazy load fallback: fetch message history from API on first access after restart (#6)
- Bot reply recording via `/internal/record-outgoing` endpoint with auth (#6)

### Security
- parseEndpoint key whitelist to prevent prototype pollution (#6)
- FEISHU_APP_ID missing warning in send.js (#6)

### Changed
- Message dedup map now cleaned periodically via timer (#6)
- Typing indicator retry with deferred cleanup on failure (#6)
- Admin CLI: new group management commands (list-groups, add-group, set-group-policy, etc.) (#6)

## [0.2.0] - 2026-02-15

### Added
- Dual connection mode: WebSocket (default) and Webhook, configurable via `connection_mode` in config.json
- Interactive mode selection in post-install hook
- SKILL.md `http_routes` declaration for Caddy integration (webhook mode)
- Startup gate: service refuses to start without `verification_token` in webhook mode
- Runtime guard: webhook rejects requests when `verification_token` is missing

### Changed
- `verification_token` is now **required** for webhook mode (previously optional)
- post-install hook prompts for verification token directly (no optional gate)

## [0.1.0] - 2026-02-14

Initial release. Forked from zylos-lark and adapted for Feishu (飞书) Chinese platform.

### Added
- Feishu webhook integration with event subscription (WebSocket mode)
- Owner auto-binding (first private chat user becomes owner)
- Group support: allowed groups, smart groups, @mention detection
- Group context — include recent messages when responding to @mentions
- Mention resolution (@_user_N placeholders to real names)
- Media support: images, files with lazy download and on-demand retrieval
- C4 protocol integration with rejection response and retry
- Hooks-based lifecycle (post-install, post-upgrade, pre-upgrade)
- Admin CLI for managing groups, whitelist, and owner
- PM2 service management via ecosystem.config.cjs

### Changed (vs zylos-lark)
- API domain: open.feishu.cn (Domain.Feishu) instead of open.larksuite.com
- Env vars: FEISHU_APP_ID / FEISHU_APP_SECRET
- Config path: ~/zylos/components/feishu/
- Default webhook port: 3458
