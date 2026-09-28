// Bitcoin service-code → CLI CodedError mapping — upstream
// agentic_wallet/shared/adapters/bitcoin/error.rs.
import { CodedError } from '../../../../core/errors.mjs';
import { ApiCodeError } from '../../../api.mjs';
import { nextSteps, ReadOnlyNextStep } from './models.mjs';
import { downcast } from '../../_rust.mjs';

const steps = (list) => { try { return nextSteps(list); } catch { return {}; } };

// upstream: error.rs::map_api_error — ApiCodeError → CodedError{code, msg} (+ state/nextSteps for
// documented codes); anything else unchanged.
export function mapApiError(error) {
  const api = downcast(error, ApiCodeError);
  if (!api) return error;
  let data, next;
  switch (api.code) {
    case '44001': data = { state: 'INSUFFICIENT_UTXO' }; next = steps([ReadOnlyNextStep.QueryUnavailableUtxos]); break;
    case '44002': data = { state: 'INSUFFICIENT_BTC_FOR_INSCRIPTION' }; next = steps([ReadOnlyNextStep.ShowBitcoinAddress, ReadOnlyNextStep.RefreshBtcBalance]); break;
    case '44003': data = { state: 'NEED_INSCRIBE' }; break;
    case '82001': data = { state: 'UTXO_PERMISSION_DENIED' }; break;
    case '82002': data = { state: 'UTXO_NOT_FOUND' }; next = steps([ReadOnlyNextStep.QueryUnavailableUtxos]); break;
    case '82003': data = { state: 'INVALID_UTXO_REQUEST' }; break;
    case '82005': data = { state: 'UTXO_ALREADY_SPENT' }; next = steps([ReadOnlyNextStep.QueryUnavailableUtxos]); break;
    default: break;
  }
  return new CodedError(api.code, null, api.msg, { data, nextSteps: next });
}
