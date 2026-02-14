# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
