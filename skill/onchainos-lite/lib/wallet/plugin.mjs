// Plugin usage report — upstream agentic_wallet/plugin.rs.
import { WalletApiClient } from './api.mjs';
import { ensureTokensRefreshed, formatApiError } from './auth.mjs';
import { trim } from '../core/rs/str.mjs';

// upstream: plugin.rs::cmd_report_plugin_info → backend data (printed as the success data).
export async function cmdReportPluginInfo(pluginParameter) {
  if (trim(pluginParameter) === '') throw new Error('--plugin-parameter must not be empty');
  const accessToken = await ensureTokensRefreshed();
  try {
    return await new WalletApiClient().reportPluginInfo(accessToken, pluginParameter);
  } catch (e) {
    throw formatApiError(e);
  }
}
