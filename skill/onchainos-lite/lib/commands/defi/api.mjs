// DeFi API wrappers — upstream cli/src/commands/defi/api.rs. Request bodies are built with
// json! upstream (serde_json::Value → keys sorted), i.e. plain objects here.
import { resolveChain } from '../../core/chains.mjs';
import { trim } from '../../core/rs/str.mjs';
import { parseI64 } from '../../core/rs/num.mjs';
import { fromStr, T } from '../../core/serde.mjs';
import { convertMinimalToDecimal } from './helpers.mjs';

// upstream: api.rs::fetch_chains — GET /api/v6/defi/product/supported-chains
export const fetchChains = async (client) => client.get('/api/v6/defi/product/supported-chains', []);

// upstream: api.rs::fetch_protocols — GET /api/v6/defi/product/supported-platforms
export const fetchProtocols = async (client) => client.get('/api/v6/defi/product/supported-platforms', []);

// upstream: api.rs::fetch_search — POST /api/v6/defi/product/search (keyword lists keep empties)
export async function fetchSearch(client, token, platform, chainIndex, productGroup, pageNum) {
  const body = {};
  if (token !== undefined && token !== null) body.tokenKeywordList = String(token).split(',').map((s) => trim(s));
  if (platform !== undefined && platform !== null) body.platformKeywordList = String(platform).split(',').map((s) => trim(s));
  if (chainIndex !== undefined && chainIndex !== null) body.chainIndex = chainIndex;
  if (productGroup !== undefined && productGroup !== null) body.productGroup = productGroup;
  if (pageNum !== undefined && pageNum !== null) body.pageNum = pageNum;
  return client.post('/api/v6/defi/product/search', body);
}

// upstream: api.rs::fetch_detail — GET /api/v6/defi/product/detail?investmentId=
export const fetchDetail = async (client, investmentId) => client.get('/api/v6/defi/product/detail', [['investmentId', investmentId]]);

// upstream: api.rs::fetch_prepare — POST /api/v6/defi/product/detail/prepare
export const fetchPrepare = async (client, investmentId) => client.post('/api/v6/defi/product/detail/prepare', { investmentId });

// `serde_json::from_str::<Vec<Value>>(s).map_err(|e| anyhow!("failed to parse <flag> as JSON array: {e}"))`
function parseArrayArg(text, flag) {
  try { return fromStr(String(text), T.vec(T.value)); } catch (e) { throw new Error(`failed to parse ${flag} as JSON array: ${e.message}`); }
}

// upstream: api.rs::fetch_enter — POST /api/v6/defi/transaction/enter (coinAmount minimal → decimal)
export async function fetchEnter(client, investmentId, address, userInput, slippage, tokenId, tickLower, tickUpper) {
  const userInputList = parseArrayArg(userInput, '--user-input');
  convertMinimalToDecimal(userInputList);
  const body = { investmentId, address, userInputList, slippage };
  if (tokenId !== undefined && tokenId !== null) body.tokenId = tokenId;
  if (tickLower !== undefined && tickLower !== null) body.tickLower = tickLower;
  if (tickUpper !== undefined && tickUpper !== null) body.tickUpper = tickUpper;
  return client.post('/api/v6/defi/transaction/enter', body);
}

// upstream: api.rs::fetch_exit — POST /api/v6/defi/transaction/exit
export async function fetchExit(client, productId, chainIndex, wallet, redeemRatio, tokenAddress, tokenSymbol, amount, tokenPrecision, tokenId, slippage, userInput) {
  const body = { investmentId: productId, address: wallet, slippage };
  if (redeemRatio !== undefined && redeemRatio !== null) body.redeemPercent = redeemRatio;
  if (tokenId !== undefined && tokenId !== null) body.tokenId = tokenId;
  if (userInput !== undefined && userInput !== null) {
    const list = parseArrayArg(userInput, '--user-input');
    convertMinimalToDecimal(list);
    body.userInputList = list;
  } else if (tokenAddress !== undefined && tokenAddress !== null && amount !== undefined && amount !== null) {
    const tokenInput = { tokenAddress, chainIndex, coinAmount: amount };
    if (tokenSymbol !== undefined && tokenSymbol !== null) tokenInput.tokenSymbol = tokenSymbol;
    if (tokenPrecision !== undefined && tokenPrecision !== null) tokenInput.tokenPrecision = tokenPrecision;
    body.userInputList = [tokenInput];
  }
  return client.post('/api/v6/defi/transaction/exit', body);
}

// upstream: api.rs::fetch_claim — POST /api/v6/defi/transaction/claim (chainIndex as an i64 number)
export async function fetchClaim(client, wallet, chainIndex, rewardType, productId, platformId, tokenId, principalIndex, expectOutputList) {
  const body = { address: wallet, rewardType };
  if (chainIndex !== '') body.chainIndex = parseI64(chainIndex) ?? 0;
  if (productId !== undefined && productId !== null) body.investmentId = productId;
  if (platformId !== undefined && platformId !== null) body.analysisPlatformId = platformId;
  if (tokenId !== undefined && tokenId !== null) body.tokenId = tokenId;
  if (principalIndex !== undefined && principalIndex !== null) body.principalIndex = principalIndex;
  if (expectOutputList !== undefined && expectOutputList !== null) body.expectOutputList = parseArrayArg(expectOutputList, '--expect-output');
  return client.post('/api/v6/defi/transaction/claim', body);
}

// upstream: api.rs::fetch_calculate_entry — POST /api/v6/defi/calculator/enter/info
export async function fetchCalculateEntry(client, investmentId, address, inputTokenAddress, inputAmount, tokenDecimal, tickLower, tickUpper) {
  const body = { investmentId, address, inputTokenAddress, inputAmount, tokenDecimal };
  if (tickLower !== undefined && tickLower !== null) body.tickLower = tickLower;
  if (tickUpper !== undefined && tickUpper !== null) body.tickUpper = tickUpper;
  return client.post('/api/v6/defi/calculator/enter/info', body);
}

// upstream: api.rs::fetch_rate_chart — GET /api/v6/defi/product/rate/chart
export async function fetchRateChart(client, investmentId, timeRange) {
  const params = [['investmentId', investmentId]];
  if (timeRange !== undefined && timeRange !== null) params.push(['timeRange', timeRange]);
  return client.get('/api/v6/defi/product/rate/chart', params);
}

// upstream: api.rs::fetch_tvl_chart — GET /api/v6/defi/product/tvl/chart
export async function fetchTvlChart(client, investmentId, timeRange) {
  const params = [['investmentId', investmentId]];
  if (timeRange !== undefined && timeRange !== null) params.push(['timeRange', timeRange]);
  return client.get('/api/v6/defi/product/tvl/chart', params);
}

// upstream: api.rs::fetch_depth_price_chart — GET /api/v6/defi/product/depth-price/chart
export async function fetchDepthPriceChart(client, investmentId, chartType, timeRange) {
  const params = [['investmentId', investmentId]];
  if (chartType !== undefined && chartType !== null) params.push(['chartType', chartType]);
  if (timeRange !== undefined && timeRange !== null) params.push(['timeRange', timeRange]);
  return client.get('/api/v6/defi/product/depth-price/chart', params);
}

// upstream: api.rs::fetch_positions — POST /api/v6/defi/user/asset/platform/list
export async function fetchPositions(client, wallet, chains) {
  const walletAddressList = String(chains).split(',').map((c) => ({ chainIndex: resolveChain(trim(c)), walletAddress: wallet }));
  return client.post('/api/v6/defi/user/asset/platform/list', { walletAddressList });
}

// upstream: api.rs::fetch_position_detail — POST /api/v6/defi/user/asset/platform/detail
export async function fetchPositionDetail(client, wallet, chainIndex, platformId) {
  return client.post('/api/v6/defi/user/asset/platform/detail', {
    walletAddressList: [{ chainIndex, walletAddress: wallet }],
    platformList: [{ analysisPlatformId: platformId, chainIndex }],
  });
}
