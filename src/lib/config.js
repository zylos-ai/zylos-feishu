/**
 * Configuration loader for zylos-feishu
 *
 * Loads config from ~/zylos/components/feishu/config.json
 * Secrets from ~/zylos/.env (FEISHU_APP_ID, FEISHU_APP_SECRET)
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/feishu');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Default configuration
export const DEFAULT_CONFIG = {
  enabled: true,
  // Connection mode: 'websocket' (SDK WSClient) or 'webhook' (Express HTTP server)
  connection_mode: 'websocket',
  webhook_port: 3458,
  // Bot settings
  bot: {
    encrypt_key: '',
    verification_token: ''
  },
  // Owner (primary partner) - auto-bound on first private chat
  owner: {
    bound: false,
    user_id: '',
    open_id: '',
    name: ''
  },
  // Whitelist settings (disabled by default)
  whitelist: {
    enabled: false,
    private_users: [],
    group_users: []
  },
  // Group policy: 'open' (all groups), 'allowlist' (only configured groups), 'disabled' (no groups)
  groupPolicy: 'allowlist',
  // Per-group configuration map
  // Format: { "oc_xxx": { name, mode, requireMention, allowFrom, historyLimit } }
  // mode: "mention" (respond to @mentions) or "smart" (receive all messages)
  groups: {},
  // Legacy fields (kept for backward compatibility, migrated to groups on upgrade)
  // group_whitelist: { enabled: true },
  // allowed_groups: [],
  // smart_groups: [],
  // Proxy settings (optional)
  proxy: {
    enabled: false,
    host: '',
    port: 0
  },
  // Message settings
  message: {
    context_messages: 10
  }
};

let config = null;
let configWatcher = null;

/**
 * Load configuration from file
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      config = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
      // Runtime backward-compat: derive groupPolicy from legacy group_whitelist if present
      // (group_whitelist is not in DEFAULT_CONFIG, so its presence means it came from the file)
      if (config.group_whitelist !== undefined) {
        config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';
      }
    } else {
      console.warn(`[feishu] Config file not found: ${CONFIG_PATH}`);
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[feishu] Failed to load config: ${err.message}`);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

/**
 * Get current configuration
 */
export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

/**
 * Save configuration to file
 */
export function saveConfig(newConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
    config = newConfig;
  } catch (err) {
    console.error(`[feishu] Failed to save config: ${err.message}`);
    throw err;
  }
}

/**
 * Watch config file for changes
 */
export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }

  if (fs.existsSync(CONFIG_PATH)) {
    configWatcher = fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        console.log('[feishu] Config file changed, reloading...');
        loadConfig();
        if (onChange) {
          onChange(config);
        }
      }
    });
  }
}

/**
 * Stop watching config file
 */
export function stopWatching() {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}

/**
 * Get credentials from environment
 */
export function getCredentials() {
  return {
    app_id: process.env.FEISHU_APP_ID || '',
    app_secret: process.env.FEISHU_APP_SECRET || ''
  };
}

/**
 * Get proxy config for axios
 */
export function getProxyConfig() {
  const cfg = getConfig();
  if (cfg.proxy?.enabled && cfg.proxy?.host && cfg.proxy?.port) {
    return {
      host: cfg.proxy.host,
      port: cfg.proxy.port
    };
  }
  return false;
}
