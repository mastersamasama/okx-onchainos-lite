// Unit tests for the shared transaction pipeline (lib/wallet/shared/**, lib/wallet/transfer/**,
// lib/wallet/{broadcast,sign}.mjs). Oracles are the upstream Rust unit tests (transfer/*.rs,
// shared/**/*.rs, sign.rs) and the Display texts of the crates upstream links (base64 0.22,
// hex 0.4, bs58 0.5, rust-bitcoin 0.32, serde_json 1.0).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

// A logged-in state dir (parity home with a never-stale chain cache) and a stub wallet API:
// both must be in place before lib/config.mjs is imported.
const HOME = mkdtempSync(join(tmpdir(), 'ocl-unit-wallet-tx-'));
cpSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'parity', 'homes', 'wallet-chains'), HOME, { recursive: true });
process.env.OCL_HOME = HOME;
process.env.ONCHAINOS_HOME = HOME;
process.env.ONCHAINOS_CREDENTIAL_STORE = 'file';
const STUB = { log: [], routes: {} };   // routes: path → [response bodies] (shifted per call)
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    STUB.log.push({ method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const queue = STUB.routes[req.url.split('?')[0]] ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0] ?? { code: '599', msg: 'no stub', data: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.OCL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const L = '../../skill/onchainos-lite/lib/';
const rs = await import(L + 'wallet/shared/_rust.mjs');
const cr = await import(L + 'wallet/shared/_crypto.mjs');
const serde = await import(L + 'wallet/shared/_serde-json.mjs');
const amount = await import(L + 'wallet/shared/common/amount.mjs');
const json = await import(L + 'wallet/shared/common/json.mjs');
const session = await import(L + 'wallet/shared/common/session.mjs');
const uhl = await import(L + 'wallet/shared/common/unsigned-hash-list.mjs');
const ctxmod = await import(L + 'wallet/shared/common/context.mjs');
const addr = await import(L + 'wallet/shared/adapters/bitcoin/_address.mjs');
const models = await import(L + 'wallet/shared/adapters/bitcoin/models.mjs');
const val = await import(L + 'wallet/shared/adapters/bitcoin/validation.mjs');
const btcApi = await import(L + 'wallet/shared/adapters/bitcoin/api.mjs');
const btcErr = await import(L + 'wallet/shared/adapters/bitcoin/error.mjs');
const btcBroadcast = await import(L + 'wallet/shared/adapters/bitcoin/broadcast.mjs');
const suiId = await import(L + 'wallet/shared/adapters/sui/identifiers.mjs');
const suiApi = await import(L + 'wallet/shared/adapters/sui/api.mjs');
const transfer = await import(L + 'wallet/transfer/index.mjs');
const gs = await import(L + 'wallet/transfer/gas-station.mjs');
const tbtc = await import(L + 'wallet/transfer/bitcoin.mjs');
const tsui = await import(L + 'wallet/transfer/sui.mjs');
const brc20 = await import(L + 'wallet/utxo/brc20.mjs');
const sign = await import(L + 'wallet/sign.mjs');
const cmdTransfer = await import(L + 'commands/wallet/transfer.mjs');
const api = await import(L + 'wallet/api.mjs');
const profile = await import(L + 'wallet/chain-profile.mjs');
const { stringify, parse, F64 } = await import(L + 'core/json.mjs');
const { Confirming, SetupRequired, CodedError } = await import(L + 'core/errors.mjs');
const { seal } = await import(L + 'crypto/hpke.mjs');
const { x25519, ed25519 } = await import(L + 'crypto/curve25519.mjs');
const { keccak256 } = await import(L + 'crypto/keccak.mjs');

const SEED1 = Buffer.alloc(32, 1);
const TAPROOT = 'bc1p35lr6647utu5dfm4se3wlazd706a0nl6z5qxjuacm3fhjxwjn2yqyfnvan';
const P2WPKH = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const TXID = '4d3f6a7a45dbb9d3398a8f83c0219b6bedfdcd77d1de63cc09f9cfe360c553c0';
const decodeUnsigned = (o) => api.decodeUnsignedInfoResponse(parse(JSON.stringify(o)));

// ── crate semantics (_rust.mjs) ─────────────────────────────────────

test('base64 0.22 STANDARD: strict canonical decode with the crate error texts', () => {
  assert.deepEqual([...rs.base64Decode('AAECAwQ=')], [0, 1, 2, 3, 4]);
  assert.equal(rs.base64Decode('').length, 0);
  assert.throws(() => rs.base64Decode('not-base64'), /^Error: Invalid symbol 45, offset 3\.$/);
  assert.throws(() => rs.base64Decode('AAECAwQ'), /^Error: Invalid padding$/);
  assert.throws(() => rs.base64Decode('AB=='), /^Error: Invalid last symbol 66, offset 1\.$/);
  assert.throws(() => rs.base64Decode('A'), /^Error: Invalid input length: 1$/);
  assert.throws(() => rs.base64Decode('=AAA'), /^Error: Invalid symbol 61, offset 0\.$/);
  assert.throws(() => rs.base64Decode('AA=A'), /^Error: Invalid symbol 61, offset 2\.$/);
  assert.throws(() => rs.base64Decode('AAAAA*'), /^Error: Invalid symbol 42, offset 5\.$/);
});

test('hex 0.4 / bs58 0.5 decoders with the crate error texts', () => {
  assert.deepEqual([...rs.hexDecode('0aFF')], [10, 255]);
  assert.throws(() => rs.hexDecode('abc'), /^Error: Odd number of digits$/);
  assert.throws(() => rs.hexDecode('zz'), /^Error: Invalid character 'z' at position 0$/);
  assert.throws(() => rs.hexDecode('0g'), /^Error: Invalid character 'g' at position 1$/);
  assert.deepEqual([...rs.bs58Decode('1112')], [0, 0, 0, 1]);
  assert.throws(() => rs.bs58Decode('0OIl'), /^Error: provided string contained invalid character '0' at byte 0$/);
  assert.throws(() => rs.bs58Decode('aé'), /^Error: provided string contained non-ascii character starting at byte 1$/);
  assert.equal(rs.bs58Encode(Buffer.from('Hello World')), 'JxF12TrwUP45BMd');
});

test('serde_jcs: sorted keys, ECMAScript numbers, 0.0 → 0', () => {
  assert.equal(rs.jcsStringify(parse('{"b":1.50,"a":[10.0,0.0,1e21],"c":"x"}')), '{"a":[10,0,1e+21],"b":1.5,"c":"x"}');
});

test('serde_json from_str error positions and messages', () => {
  const err = (s) => { try { serde.fromStr(s); return null; } catch (e) { return e.message; } };
  assert.equal(err('nox'), 'expected ident at line 1 column 2');
  assert.equal(err('x'), 'expected value at line 1 column 1');
  assert.equal(err(''), 'EOF while parsing a value at line 1 column 0');
  assert.equal(err('{"a":1} x'), 'trailing characters at line 1 column 9');
  assert.equal(err('[1,2,]'), 'trailing comma at line 1 column 6');
  assert.equal(err('{1:2}'), 'key must be a string at line 1 column 2');
  assert.equal(err('{"a":'), 'EOF while parsing a value at line 1 column 5');
  assert.equal(err('{"a" 1}'), 'expected `:` at line 1 column 6');
  assert.equal(err('[01]'), 'invalid number at line 1 column 3');
  assert.equal(err('[1 2]'), 'expected `,` or `]` at line 1 column 4');
  assert.equal(err('"abc'), 'EOF while parsing a string at line 1 column 4');
  assert.equal(err('{\n  "a": tru\n}'), 'expected ident at line 3 column 0');   // upstream-verified (parity case)
  assert.deepEqual(stringify(serde.fromStr('{"b":2.50,"a":1}')), '{"a":1,"b":2.5}');
});

// ── crypto.rs mirror ────────────────────────────────────────────────

test('ed25519_sign_eip191 / _encoded / _hex', () => {
  assert.equal(cr.ed25519SignEip191('', SEED1, 'hex'), '');
  const data = Buffer.from('deadbeef', 'hex');
  const digest = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${data.length}`), data]));
  assert.equal(cr.ed25519SignEip191('0xdeadbeef', SEED1, 'hex'), ed25519.sign(SEED1, digest).toString('base64'));
  assert.throws(() => cr.ed25519SignEip191('x', SEED1, 'raw'), /unsupported encoding for eip191: raw, expected "hex" or "utf8"/);
  assert.throws(() => cr.ed25519SignEip191('0xzz', SEED1, 'hex'), /^Error: msg is not valid hex: Invalid character 'z' at position 0$/);
  const b64 = SEED1.toString('base64');
  assert.equal(cr.ed25519SignEncoded('0x', b64, 'hex'), '');
  assert.equal(cr.ed25519SignHex('0xab', b64), ed25519.sign(SEED1, Buffer.from([0xab])).toString('base64'));
  assert.equal(cr.ed25519SignEncoded('AAE=', b64, 'base64'), ed25519.sign(SEED1, Buffer.from([0, 1])).toString('base64'));
  assert.throws(() => cr.ed25519SignEncoded('ab', b64, ''), /unsupported encoding: , expected hex\/base64\/base58/);
  assert.throws(() => cr.ed25519SignEncoded('0', b64, 'base58'), /failed to decode base58 message: provided string contained invalid character '0' at byte 0/);
});

test('hpke_decrypt_session_sk round trip and errors', () => {
  const sk = Buffer.alloc(32, 7);
  const { enc, ciphertext } = seal({ pkR: x25519.publicKey(sk), plaintext: SEED1, info: Buffer.from('okx-tee-sign'), ephemeral: Buffer.alloc(32, 9) });
  const blob = Buffer.concat([enc, ciphertext]).toString('base64');
  assert.deepEqual(cr.hpkeDecryptSessionSk(blob, sk.toString('base64')), SEED1);
  assert.throws(() => cr.hpkeDecryptSessionSk('not base64!', sk.toString('base64')), /^Error: encrypted_session_sk is not valid base64: Invalid symbol 32, offset 3\.$/);
  assert.throws(() => cr.hpkeDecryptSessionSk(blob, Buffer.alloc(16).toString('base64')), /session_key must be 32 bytes, got 16/);
  assert.throws(() => cr.hpkeDecryptSessionSk(Buffer.alloc(32).toString('base64'), sk.toString('base64')), /encrypted_session_sk too short: 32 bytes \(need > 32\)/);
  const tampered = Buffer.from(blob, 'base64'); tampered[40] ^= 1;
  assert.throws(() => cr.hpkeDecryptSessionSk(tampered.toString('base64'), sk.toString('base64')), /HPKE decryption failed: Failed to open ciphertext/);
});

// ── shared/common ───────────────────────────────────────────────────

test('amount.rs conversions', () => {
  assert.equal(amount.readableToMinimal('1.00000001', 8), '100000001');
  assert.equal(amount.readableToMinimal('1', 18), '1000000000000000000');
  assert.equal(amount.readableToMinimal('1.000000001', 9), '1000000001');
  assert.equal(amount.minimalToReadable('1000', 8), '0.00001');
  assert.equal(amount.minimalToReadable('1200000', 9), '0.0012');
  assert.equal(amount.minimalToReadable('5', 0), '5');
  assert.equal(amount.minimalToReadable('100000000', 8), '1');
  assert.throws(() => amount.parseMinimal('01', 'amount', true), /amount must not contain leading zeros/);
  assert.throws(() => amount.parseMinimal('0', 'readable-amount', false), /readable-amount must be greater than zero/);
  assert.throws(() => amount.parseMinimal('1.5', 'x', true), /x must be a non-negative integer in minimal units/);
  assert.throws(() => amount.readableToMinimal('1', 256), /asset decimal exceeds the supported limit/);
  assert.equal(amount.decimalField({ decimal: '18' }), 18);
  assert.equal(amount.decimalField({ decimals: 8 }), 8);
  assert.equal(amount.decimalField({ decimal: null, decimals: 8 }), undefined);   // first *present* key wins
  assert.equal(amount.decimalField({}), undefined);
  assert.equal(amount.valueAsDecimalString(12), '12');
  assert.equal(amount.valueAsDecimalString(new F64('1.5')), undefined);
  assert.equal(amount.valueAsDecimalString(-1), undefined);
});

test('json.rs helpers', () => {
  assert.deepEqual(json.firstDataItem([{ a: 1 }]), { a: 1 });
  assert.deepEqual(json.firstDataItem([1, 2]), [1, 2]);
  assert.equal(json.shellArg('bc1pfrom'), 'bc1pfrom');
  assert.equal(json.shellArg("it's x"), `'it'"'"'s x'`);
  assert.equal(json.shellArg(''), '');
  assert.equal(json.findString({ z: { txHash: 'b' }, a: [{ txHash: 'a' }] }, ['txHash']), 'a');
  assert.equal(json.findString({ n: 7 }, ['n']), '7');
  assert.throws(() => json.requiredString({ k: '' }, 'k', 'src'), /^Error: src is missing k$/);
});

test('session.rs decode_hex context', () => {
  assert.throws(() => session.decodeHex('0x0', 'unsignedHash'), /^CliError: unsignedHash is not valid hex: Odd number of digits$|unsignedHash is not valid hex: Odd number of digits/);
});

test('unsigned_hash_list: Bitcoin eip2519 signs the hex digest (upstream oracle)', () => {
  const seed = session.SigningSeed.fromBytes(SEED1);
  const hash = '0x' + 'ab'.repeat(32);
  const signed = uhl.signUnsignedHashes({ encoding: 'eip2519', unsignedHashList: [{ index: 0, unsignedHash: hash, unsignedHashSig: 'service-proof', backendField: 'keep-me' }] }, seed, uhl.SigningProfile.Bitcoin);
  assert.equal(signed[0].sessionSignature, ed25519.sign(SEED1, Buffer.alloc(32, 0xab)).toString('base64'));
  assert.equal(signed[0].unsignedHashSig, 'service-proof');
  assert.equal(signed[0].backendField, 'keep-me');
  assert.throws(() => uhl.signUnsignedHashes({ encoding: 'hex', unsignedHashList: [
    { index: 1, unsignedHash: '00', unsignedHashSig: 'p' }, { index: '1', unsignedHash: '11', unsignedHashSig: 'q' }] }, seed, uhl.SigningProfile.Bitcoin), /duplicate index 1/);
  assert.throws(() => uhl.signUnsignedHashes({ encoding: 'eip2519', unsignedHashList: [{ index: 0, unsignedHash: hash }] }, seed, uhl.SigningProfile.Bitcoin), /unsignedHashList\[0\] is missing unsignedHashSig/);
  assert.throws(() => uhl.signUnsignedHashes({ encoding: 'hex', unsignedHashList: [] }, seed, uhl.SigningProfile.Bitcoin), /unsignedHashList must not be empty/);
  assert.throws(() => uhl.signUnsignedHashes({ unsignedHashList: [{}] }, seed, uhl.SigningProfile.Bitcoin), /signing response is missing encoding/);
  assert.throws(() => uhl.signUnsignedHashes({ encoding: 'hex', unsignedHashList: [{ unsignedHash: 'x' }] }, seed, uhl.SigningProfile.Bitcoin), /unsignedHashList item is missing index/);
});

test('unsigned_hash_list: SUI profile (base64, 32 bytes, item encoding ignored)', () => {
  const seed = session.SigningSeed.fromBytes(SEED1);
  const signed = uhl.signUnsignedHashes({ encoding: 'base64', unsignedHashList: [
    { index: 0, unsignedHash: Buffer.alloc(32, 1).toString('base64'), encoding: 'hex' },
    { index: 1, unsignedHash: Buffer.alloc(32, 2).toString('base64') }] }, seed, uhl.SigningProfile.Sui);
  assert.equal(signed.length, 2);
  assert.ok(signed.every((i) => typeof i.sessionSignature === 'string'));
  assert.throws(() => uhl.signUnsignedHashes({ encoding: 'hex', unsignedHashList: [{ index: 0, unsignedHash: 'aa' }] }, seed, uhl.SigningProfile.Sui), /unsupported transaction encoding: hex/);
  assert.throws(() => uhl.signUnsignedHashes({ encoding: 'base64', unsignedHashList: [{ index: 0, unsignedHash: 'AAEC' }] }, seed, uhl.SigningProfile.Sui), /SUI unsignedHash must decode to 32 bytes, got 3/);
});

test('build_direct_extra_data (bitcoin/broadcast.rs + sui.rs oracles)', () => {
  const encoded = uhl.buildDirectExtraData({
    signType: 'transfer', encoding: 'hex', unsignedTx: 'unsigned-btc', unsignedTxHash: 'unsigned-tx-hash',
    txParam: { inputs: ['input-1'], outputs: ['output-1'] }, uopHash: 'uop-1', extraData: { serviceField: 'preserved', signTx: 'drop' },
  }, [{ index: 0, unsignedHash: 'hash-1', unsignedHashSig: 'proof-1', sessionSignature: 'sig-1' }], 'session-cert', true, 'Bitcoin');
  const extra = JSON.parse(encoded);
  assert.equal(extra.signTx, undefined);
  assert.equal(extra.msgForSign.unsignedHashList[0].sessionSignature, 'sig-1');
  assert.equal(extra.msgForSign.unsignedTxHash, 'unsigned-tx-hash');
  assert.equal(extra.msgForSign.sessionCert, 'session-cert');
  assert.equal(extra.checkBalance, true);
  assert.equal(extra.skipWarning, true);
  assert.equal(extra.txType, undefined);
  assert.equal(encoded, stringify(JSON.parse(encoded)));   // compact, sorted keys
  const nullUop = JSON.parse(uhl.buildDirectExtraData({ signType: 's', encoding: 'e', unsignedTx: 't', txParam: {}, uopHash: null }, [{ unsignedHash: 'h', sessionSignature: 's' }], 'c', false, 'SUI'));
  assert.equal(nullUop.uopHash, null);
  assert.throws(() => uhl.buildDirectExtraData({ signType: 's', encoding: 'e', unsignedTx: 't', txParam: null }, [{ unsignedHash: 'h', sessionSignature: 's' }], 'c', false, 'SUI'), /unsignedInfo response is missing txParam/);
  assert.throws(() => uhl.buildDirectExtraData({}, [], 'c', false, 'SUI'), /signed hash list must not be empty/);
});

test('select_current_address', () => {
  const prof = { chainIndex: '784' };
  const w = { accountsMap: { current: { addressList: [{ address: '0x' + '0'.repeat(63) + '1', chainIndex: '784' }] } } };
  assert.throws(() => ctxmod.selectCurrentAddress(w, 'current', prof, 'SUI', '0x' + '0'.repeat(63) + '2', suiId.sameAddress), /--from must be the SUI address of the current account/);
  assert.equal(ctxmod.selectCurrentAddress(w, 'current', prof, 'SUI', '0x1', suiId.sameAddress).chainIndex, '784');
  assert.throws(() => ctxmod.selectCurrentAddress(w, 'other', prof, 'SUI'), /current account 'other' was not found/);
  assert.throws(() => ctxmod.selectCurrentAddress(w, 'current', { chainIndex: '0' }, 'Bitcoin'), /has no Bitcoin address/);
});

// ── bitcoin adapter ─────────────────────────────────────────────────

test('rust-bitcoin address parsing and network checks', () => {
  val.validateRecipient(P2WPKH);
  val.validateRecipient('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2');
  val.validateWalletAddress(TAPROOT);
  assert.throws(() => val.validateWalletAddress(P2WPKH), /must be Taproot \(P2TR\)/);
  assert.throws(() => val.validateRecipient('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'), /^Error: recipient must be a Bitcoin mainnet address: validation error$/);
  assert.throws(() => val.validateRecipient('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9'), /invalid recipient Bitcoin address: tried to parse an unknown hrp/);
  assert.throws(() => val.validateRecipient('bc1qinvalid'), /invalid recipient Bitcoin address: base58 error/);
  assert.throws(() => val.validateRecipient('1'.repeat(51)), /legacy address base58 string/);
  assert.ok(val.sameAddress(' ' + TAPROOT.toUpperCase(), TAPROOT));
  // BIP-350 vector: bech32 (not bech32m) checksum on a v1 program is rejected
  assert.equal(addr.segwitDecode('bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx'), null);
  assert.equal(addr.segwitDecode('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').version, 0);
});

test('parse_fee_rate / normalize_brc20_token_address (upstream oracles)', () => {
  assert.equal(stringify(val.parseFeeRate('0.1')), '0.1');
  assert.equal(stringify(val.parseFeeRate('8')), '8');
  assert.equal(stringify(val.parseFeeRate(' 1.25 ')), '1.25');
  assert.equal(stringify(val.parseFeeRate('10.0')), '10.0');
  for (const bad of ['0.01', '0']) assert.throws(() => val.parseFeeRate(bad), /at least 0.1 sat\/vB/);
  for (const bad of ['1e2', '1.', '.5', '01', '1.2.3', '-1']) assert.throws(() => val.parseFeeRate(bad), /--fee-rate must be a decimal sat\/vB value/);
  assert.equal(val.normalizeBrc20TokenAddress('BTC-BRC20-ORDI'), 'btc-brc20-ordi');
  assert.throws(() => val.normalizeBrc20TokenAddress('铭文btc-brc20-ordi'), /must use btc-brc20-<ticker>/);
  assert.throws(() => val.normalizeBrc20TokenAddress('btc-brc20-'), /must use btc-brc20-<ticker>/);
  assert.throws(() => val.normalizeBrc20TokenAddress('btc-brc20-a b'), /unsupported characters/);
});

test('BtcOutPoint parse / canonical / api value; collect_outpoints; next_steps', () => {
  const p = models.BtcOutPoint.parse(`${TXID.toUpperCase()}:7`);
  assert.equal(p.canonical(), `${TXID}:7`);
  assert.deepEqual(p.toApiValue(), { txHash: TXID, voutIndex: '7' });
  assert.throws(() => models.BtcOutPoint.parse('zz:1'), /^Error: invalid outpoint 'zz:1': error parsing TXID$/);
  assert.throws(() => models.BtcOutPoint.parse(`${TXID}:01`), /no leading zeroes or \+ allowed in vout part/);
  assert.throws(() => models.BtcOutPoint.parse(TXID), /OutPoint not in <txid>:<vout> format/);
  assert.throws(() => models.BtcOutPoint.parse(`${TXID}:99999999999`), /vout should be at most 10 digits|error parsing vout/);
  const pts = models.collectOutpoints({ groups: [{ txHash: TXID, voutIndex: 1 }], again: { txHash: TXID, vout: '1' }, z: [{ txid: 'a', vout: 10 }, { txid: 'a', vout: 2 }] });
  assert.deepEqual(pts.map((x) => x.canonical()), [`${TXID}:1`, 'a:10', 'a:2']);
  const steps = models.nextSteps([models.ReadOnlyNextStep.QueryUnavailableUtxos, models.ReadOnlyNextStep.RefreshBtcBalance]);
  assert.equal(stringify(steps), '{"queryUnavailableUtxos":"onchainos wallet utxo unavailable --chain bitcoin","refreshBtcBalance":"onchainos wallet balance --chain bitcoin --force"}');
  assert.equal(models.nextSteps([models.ReadOnlyNextStep.queryBrc20TransferableUtxos('btc-brc20-trac')]).queryBrc20TransferableUtxos,
    'onchainos wallet utxo brc20-transferable --chain bitcoin --token-address btc-brc20-trac');
  assert.throws(() => models.nextSteps([models.ReadOnlyNextStep.checkInscriptionStatus({})]), /txHash or orderId is required/);
});

test('preview_from_response / validate_preview_intent / bind_utxo_availability (upstream oracles)', () => {
  const response = parse(JSON.stringify({
    executeResult: true, executeErrorMsg: '',
    txParam: { inputs: [{ txId: TXID, vout: 1, amount: '10000', address: TAPROOT }], outputs: [{ address: P2WPKH, amount: '5000' }], changeAddress: TAPROOT, feeRate: '10', fee: '1000' },
    unsignedHashList: [{ index: 0, unsignedHash: '00' }], signType: 'transfer', encoding: 'hex', extraData: {},
  }));
  const preview = val.previewFromResponse(response, 'BTC_TRANSFER', '0', TAPROOT, P2WPKH, undefined, '5000', '0.00005', 8);
  val.validatePreviewIntent(preview, 'BTC_TRANSFER', '0', TAPROOT, P2WPKH, '5000');
  assert.equal(preview.feeReadable, '0.00001');
  assert.equal(preview.asset.symbol, 'BTC');
  assert.match(val.localTransactionToken(response, preview), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => val.validatePreviewIntent(preview, 'BTC_TRANSFER', '0', TAPROOT, P2WPKH, '4000'), /PREVIEW_INTENT_MISMATCH: amount changed from '4000' to '5000'/);
  assert.throws(() => val.previewFromResponse({ ...response, signType: 'brc20Inscribe' }, 'BTC_TRANSFER', '0', TAPROOT, P2WPKH, undefined, '1', '1', 8), /expected signType transfer, got brc20Inscribe/);
  assert.throws(() => val.previewFromResponse({ executeResult: false }, 'BTC_TRANSFER', '0', TAPROOT, P2WPKH, undefined, '1', '1', 8), /^Error: PRE_EXECUTION_FAILED: Bitcoin transaction pre-execution failed$/);
  assert.ok(val.isLocalContinuation('sha256:' + 'a'.repeat(64)));
  assert.ok(!val.isLocalContinuation('sha256:short'));
  const pv = { inputs: [{ txId: TXID, vout: 1, amount: '10000' }] };
  val.bindUtxoAvailability(pv, { unavailableBreakdown: { totalUnavailableCount: 0 } });
  assert.deepEqual(pv.utxoAvailability.selectedAvailableInputs, [`${TXID}:1`]);
  assert.throws(() => val.bindUtxoAvailability({ inputs: [{ txId: TXID, vout: 1 }] }, { unavailableBreakdown: { assetLocked: { utxos: [{ txHash: TXID, voutIndex: '1' }] }, totalUnavailableCount: 1 } }), /PREVIEW_UTXO_UNAVAILABLE/);
});

test('bitcoin api body builders / order-detail guard / error mapping', () => {
  const ctx = { accountId: 'account-1', address: { address: TAPROOT }, profile: profile.fromEntry({ chainIndex: 0, realChainIndex: 0, chainName: 'btc', isEvmChain: false }) };
  const op = models.BtcOutPoint.parse(`${TXID}:7`);
  assert.deepEqual(btcApi.buildBrc20UtxoAssetInfoBody(ctx, [op]), { chainIndex: '0', address: TAPROOT, assetProtocols: ['BRC20'], utxos: [{ txHash: TXID, voutIndex: '7' }] });
  assert.throws(() => btcApi.buildBrc20UtxoAssetInfoBody(ctx, Array(11).fill(op)), /1\.\.=10 outpoints per batch/);
  assert.equal(btcApi.buildManageUtxosBody('0', 'ignoreAsset', 'reason', [op]).utxos[0].voutIndex, '7');
  assert.throws(() => btcApi.buildManageUtxosBody('0', 'remove', 'reason', [op]), /unsupported UTXO management action: remove/);
  assert.throws(() => btcApi.buildManageUtxosBody('0', 'ignoreAsset', ' ', [op]), /message must not be empty/);
  assert.throws(() => btcApi.validateOrderDetailContext(ctx, { accountId: 'account-1', chainIndex: '607', txHash: 'requested' }, 'requested'), /ORDER_CONTEXT_MISMATCH/);
  assert.equal(btcApi.extractTokenDecimals({ decimal: '18' }), 18);
  assert.throws(() => btcApi.extractTokenDecimals({}), /BRC-20 token metadata is missing decimal\/decimals/);
  const mapped = btcErr.mapApiError(new api.ApiCodeError('44001', 'service message', 200));
  assert.ok(mapped instanceof CodedError);
  assert.equal(mapped.message, 'service message');
  assert.deepEqual(mapped.data, { state: 'INSUFFICIENT_UTXO' });
  assert.match(mapped.nextSteps.queryUnavailableUtxos, /utxo unavailable --chain bitcoin/);
  assert.deepEqual(btcErr.mapApiError(new api.ApiCodeError('82003', 'm', 200)).data, { state: 'INVALID_UTXO_REQUEST' });
  const plain = new Error('x');
  assert.equal(btcErr.mapApiError(plain), plain);
});

test('inscription batch body (bitcoin/broadcast.rs oracle)', () => {
  const ctx = { accountId: 'account-1', address: { address: 'bc1-user' }, profile: { chainIndex: '0' } };
  const body = btcBroadcast.buildInscriptionBatchBody(ctx,
    { signType: 'brc20Inscribe', encoding: 'hex', txParam: { commitAddress: 'bc1-commit', commitFee: '154', revealFee: '156' } },
    { signedTxList: [{ signedTx: 'commit-tx', txHash: 'commit-hash' }, { signedTx: 'reveal-tx', txHash: 'reveal-hash' }] },
    'btc-brc20-pizza', '1', true);
  assert.equal(body[0].address, 'bc1-user');
  assert.equal(body[1].address, 'bc1-commit');
  const c = JSON.parse(body[0].extraData), r = JSON.parse(body[1].extraData);
  assert.equal(c.serviceCharge, '154');
  assert.equal(c.txType, 51);
  assert.equal(c.extJson.batchBroadcastType, 0);
  assert.equal(r.serviceCharge, '156');
  assert.deepEqual(r.dependTx, ['commit-hash']);
});

// ── SUI adapter ─────────────────────────────────────────────────────

test('SUI identifiers and contract-call body', () => {
  assert.equal(suiId.normalizeAddress('0xAbC'), `0x${'0'.repeat(61)}abc`);
  assert.throws(() => suiId.normalizeAddress('0x'), /1 to 64 hexadecimal characters/);
  assert.throws(() => suiId.normalizeAddress('0x' + '1'.repeat(65)), /1 to 64 hexadecimal characters/);
  assert.equal(suiId.normalizeCoinType('0x0002::sui::SUI'), suiId.NATIVE_COIN_TYPE);
  assert.ok(suiId.sameCoinType('0x2::sui::SUI', '2::sui::SUI'));
  assert.throws(() => suiId.normalizeCoinType('SUI'), /complete <package>::<module>::<type>/);
  assert.equal(suiId.normalizeCoinType('0x0::m::T<0x2::a::B,u8>'), '0x0::m::T<0x2::a::B,u8>');
  const body = suiApi.buildContractCallBody(784, '0xsender', undefined, '0', 'session-cert', 'AAECAwQ=');
  assert.equal(stringify(body), '{"amount":"0","chainIndex":784,"contractAddr":"0x0","fromAddr":"0xsender","sessionCert":"session-cert","toAddr":"0x","txParam":{"txBytes":"AAECAwQ="}}');
});

// ── transfer/mod.rs ─────────────────────────────────────────────────

const wallets = () => ({
  selectedAccountId: 'acc-1',
  accountsMap: {
    'acc-1': { addressList: [
      { accountId: 'acc-1', address: '0xAAA', chainIndex: '1', chainName: 'eth', addressType: 'eoa', chainPath: '/evm/1' },
      { accountId: 'acc-1', address: 'SolAdr1', chainIndex: '501', chainName: 'sol', addressType: 'eoa', chainPath: '/sol/501' }] },
    'acc-2': { addressList: [{ accountId: 'acc-2', address: '0xBBB', chainIndex: '1', chainName: 'eth', addressType: 'eoa', chainPath: '/evm/1' }] },
  },
});

test('resolve_address (upstream oracles)', () => {
  assert.deepEqual(transfer.resolveAddress(wallets(), undefined, 'eth').map((x) => x.address ?? x), ['acc-1', '0xAAA']);
  assert.equal(transfer.resolveAddress(wallets(), undefined, 'sol')[1].address, 'SolAdr1');
  assert.equal(transfer.resolveAddress(wallets(), '0xbbb', 'eth')[0], 'acc-2');
  assert.throws(() => transfer.resolveAddress(wallets(), '0xCCC', 'eth'), /no address matches from=0xCCC chain=eth/);
  assert.throws(() => transfer.resolveAddress(wallets(), undefined, 'tempo'), /no address for chain=tempo in account=acc-1/);
  assert.throws(() => transfer.resolveAddress({ ...wallets(), selectedAccountId: '' }, undefined, 'eth'), /no currentAccountId/);
  assert.throws(() => transfer.resolveAddress({ ...wallets(), selectedAccountId: 'x' }, undefined, 'eth'), /not found currentAccountId/);
});

test('resolve_address_with_refresh retries once', async () => {
  const w = wallets();
  const r = await transfer.resolveAddressWithRefresh(w, undefined, 'tempo', async () => {
    const f = wallets();
    f.accountsMap['acc-1'].addressList.push({ accountId: 'acc-1', address: '0xTempoAddr', chainIndex: '4217', chainName: 'tempo', addressType: 'eoa', chainPath: '' });
    return f;
  });
  assert.equal(r[1].address, '0xTempoAddr');
  await assert.rejects(transfer.resolveAddressWithRefresh(wallets(), undefined, 'tempo', async () => { throw new Error('network down'); }), /network down/);
  await assert.rejects(transfer.resolveAddressWithRefresh(wallets(), undefined, 'tempo', async () => wallets()), /no address for chain=tempo/);
});

test('apply_broadcast_core: checkBalance = !freeGas, keys preserved', () => {
  const u = decodeUnsigned({ uopHash: '0xuop', encoding: 'hex', signType: 'eip191', extraData: { freeGas: true, aaFreeGas: true, customKey: 'keep-me' } });
  const ed = { ...u.extraData };
  transfer.applyBroadcastCore(ed, u, { signature: 's' });
  assert.equal(ed.checkBalance, false);
  assert.equal(ed.customKey, 'keep-me');
  const ed2 = {};
  transfer.applyBroadcastCore(ed2, decodeUnsigned({ extraData: { freeGas: 'true' } }), {});
  assert.equal(ed2.checkBalance, true);
});

test('batch validation and element msgForSign (upstream oracles)', () => {
  const ok = decodeUnsigned({ hash: '0x' + '11'.repeat(32), executeResult: true });
  const empty = decodeUnsigned({ executeResult: true, gasStationStatus: 'READY_TO_USE' });
  const failed = decodeUnsigned({ executeResult: false, executeErrorMsg: 'boom' });
  transfer.validateBatchUnsignedResponses([ok, ok]);
  assert.throws(() => transfer.validateBatchUnsignedResponses([empty, failed]), /^Error: batch element 1: boom$/);
  assert.throws(() => transfer.validateBatchUnsignedResponses([ok, empty]), new Error('batch element 1: backend returned empty signing materials                  (gasStationStatus="READY_TO_USE")'));
  const withAuth = transfer.buildBatchElementMsgForSign(decodeUnsigned({ hash: '0x' + '11'.repeat(32), authHashFor7702: '0x' + '22'.repeat(32) }), SEED1, 'cert');
  assert.equal(withAuth.authSignatureFor7702, ed25519.sign(SEED1, Buffer.alloc(32, 0x22)).toString('base64'));
  assert.equal(withAuth.sessionCert, 'cert');
  const noAuth = transfer.buildBatchElementMsgForSign(decodeUnsigned({ hash: '0x' + '11'.repeat(32) }), SEED1, '');
  assert.equal(noAuth.authSignatureFor7702, undefined);
  assert.equal(noAuth.sessionCert, undefined);
});

test('funding helpers', () => {
  assert.ok(transfer.isTransferFundingCoveredChain('1'));
  assert.ok(transfer.isTransferFundingCoveredChain('501'));
  assert.ok(!transfer.isTransferFundingCoveredChain('784'));
  assert.ok(transfer.hasConfirmedReadableShortfall('10', '0.08504764'));
  assert.ok(!transfer.hasConfirmedReadableShortfall('1', '2'));
  assert.ok(!transfer.hasConfirmedReadableShortfall('1e2', '2'));
  const input = transfer.transferFundingInput(undefined, '0xabc', '5', null, '10004', 'Insufficient balance');
  assert.equal(input.asset, '0xabc');
  assert.equal(input.operation, 'transfer');
  assert.equal(input.balance, undefined);
});

// ── transfer/gas_station.rs ─────────────────────────────────────────

const token = (symbol, feeTokenAddress, balance, serviceCharge, sufficient, relayerId = `r-${symbol}`) =>
  ({ feeCoinId: 1, symbol, feeTokenAddress, serviceCharge, balance, sufficient, relayerId, context: '' });

test('format_sufficient_tokens / token_list_json / classify_gs_phase1', () => {
  const u = decodeUnsigned({ gasStationUsed: true, gasStationTokenList: [token('USDT', '0xaaa', '100', '0.13', false), token('USDC', '0xbbb', '120', '0.14', true), token('USDG', '0xccc', '50', '0.15', true)] });
  assert.equal(gs.formatSufficientTokens(u), '1. USDC (balance: 120, fee: 0.14)\n2. USDG (balance: 50, fee: 0.15)');
  assert.ok(gs.tokenListJson(u).startsWith('[{"feeCoinId":1,"symbol":"USDT","feeTokenAddress":"0xaaa","serviceCharge":"0.13","balance":"100","sufficient":false,"relayerId":"r-USDT","context":""}'));
  assert.equal(gs.classifyGsPhase1(u).kind, 'NeedsUserPick');          // two sufficient, no default
  assert.equal(gs.classifyGsPhase1({ ...u, gasStationStatus: 'REENABLE_ONLY' }).kind, 'Reenable');
  assert.equal(gs.classifyGsPhase1({ ...u, gasStationFirstTimePrompt: true }).kind, 'FirstTime');
  const pick = gs.classifyGsPhase1({ ...u, defaultGasTokenAddress: '0xBBB', gasStationStatus: 'PENDING_UPGRADE' });
  assert.deepEqual(pick, { kind: 'AutoPick', feeTokenAddress: '0xbbb', relayerId: 'r-USDC', needsEnable: true });
  const only = gs.classifyGsPhase1({ ...u, gasStationTokenList: [token('USDC', '0xbbb', '1', '0.1', true)] });
  assert.equal(only.kind, 'AutoPick');
  assert.equal(only.needsEnable, false);
});

test('Gas Station prompts and setup-required payload', () => {
  const u = decodeUnsigned({ gasStationUsed: true, gasStationStatus: 'FIRST_TIME_PROMPT', gasStationTokenList: [token('USDT', '0xaaa', '5', '0.1', true)] });
  const addrInfo = { address: '0xabc', chainIndex: '196' };
  const first = gs.buildGsFirstTimePrompt(addrInfo, u);
  assert.ok(first instanceof Confirming);
  assert.equal(first.scene, 'gs_first_time');
  assert.match(first.msg, /^Gas Station first-time setup required on X Layer\. /);
  const re = gs.buildGsReenablePrompt(addrInfo, u);
  assert.match(re.msg, /Previous default gas token address: \(none\)\./);
  const setup = gs.forceSetupRequiredForSend(true, '196', undefined, '0xdead', '1', undefined, addrInfo, u);
  assert.ok(setup instanceof SetupRequired);
  assert.equal(setup.errorCode, 'GAS_STATION_SETUP_REQUIRED');
  assert.equal(setup.data.scene, "B'");
  assert.equal(stringify(setup.data.originalRequest), '{"args":{"amount":"1","chain":"196","contractToken":null,"force":true,"from":null,"recipient":"0xdead"},"command":"wallet send"}');
  assert.equal(stringify(setup.data.tokenList), '[{"balance":"5","feeTokenAddress":"0xaaa","relayerId":"r-USDT","serviceCharge":"0.1","sufficient":true,"symbol":"USDT"}]');
  const cc = gs.forceSetupRequiredForTxParams(false, true, '1', '0xf', transfer.txParams({ toAddr: '0xt', value: '0', contractAddr: '0xt', inputData: '0x' }), addrInfo, u);
  assert.equal(cc.data.originalRequest.command, 'wallet contract-call');
  assert.equal(gs.gsNotSupportedErr('X').message, 'Gas Station does not support this transaction type — only transfers and swaps can pay gas with a stablecoin. Pay with native SOL instead, then retry. Top up SOL at: X');
});

test('gs_build_msg_for_sign / gs_apply_extra_data_fields', () => {
  const u = decodeUnsigned({
    eip712MessageHash: '0x' + '33'.repeat(32), hash: '0x' + '44'.repeat(32), authHashFor7702: '0x' + '55'.repeat(32), encoding: 'hex',
    serviceCharge: '0.13', serviceChargeFeeTokenAddress: '0xaaa', contractNonce: '42', eoaNonce: '3', user712Data: { a: 1 }, user7702Data: { b: 2 },
    gasStationTokenList: [token('USDT', '0xaaa', '5', '0.13', true)],
  });
  const m = gs.gsBuildMsgForSign(u, { sessionCert: 'cert' }, SEED1);
  assert.equal(m.sessionSignature, ed25519.sign(SEED1, Buffer.alloc(32, 0x33)).toString('base64'));   // 712 wins over legacy hash
  assert.equal(m.signature, undefined);
  assert.equal(m.authSignatureFor7702, ed25519.sign(SEED1, Buffer.alloc(32, 0x55)).toString('base64'));
  const ed = gs.gsBuildExtraData(u, m, 'to', '1', undefined, true);
  assert.equal(stringify(Object.keys(ed).sort()), '["checkBalance","context","contractNonce","encoding","feeTokenAddress","msgForSign","nonce","paymentType","relayerId","serviceCharge","signType","skipWarning","uopHash","user712Data","user7702Data"]');
  assert.equal(ed.nonce, '3');
  assert.equal(ed.relayerId, 'r-USDT');
});

// ── transfer/bitcoin.rs + transfer/sui.rs ───────────────────────────

const snapshot = () => ({ brc20TransferableUtxoList: { utxos: [
  { txHash: 'c'.repeat(64), voutIndex: 2, utxoId: 'utxo-1', utxoAmountRaw: '546', valueRaw: '1000000000000000000', offset: '0', inscriptionId: 'i-1' },
  { txHash: 'd'.repeat(64), voutIndex: 3, utxoId: 'utxo-2', utxoAmountRaw: '600', valueRaw: '2000000000000000000', offset: '1', inscriptionId: 'i-2' }] } });

test('BRC-20 carrier selection and transfer parameters (upstream oracles)', () => {
  const sel = [`${'c'.repeat(64)}:2`, `${'d'.repeat(64)}:3`];
  const [amt, txParam, outpoints] = tbtc.buildBrc20TransferParameters(snapshot(), sel, 'bc1pfrom', '3000000000000000000');
  assert.equal(amt, '3000000000000000000');
  assert.equal(txParam.inputs.length, 2);
  assert.equal(stringify(txParam.inputs[0]), `{"address":"bc1pfrom","amount":"546","txId":"${'c'.repeat(64)}","vout":2}`);
  assert.deepEqual(outpoints, sel);
  assert.throws(() => tbtc.buildBrc20TransferParameters(snapshot(), sel, 'bc1pfrom', '2000000000000000000'), /combined BRC-20 UTXO amount/);
  assert.throws(() => brc20.selectBrc20TransferableUtxos(snapshot(), []), /at least one --brc20-outpoint/);
  assert.throws(() => brc20.selectBrc20TransferableUtxos(snapshot(), [sel[0], sel[0].toUpperCase().replace(':2', ':2')]), /was selected more than once/);
  assert.throws(() => brc20.selectBrc20TransferableUtxos(snapshot(), [`${'e'.repeat(64)}:1`]), /no longer transferable/);
  assert.throws(() => brc20.parseBrc20TransferableUtxos({ utxos: [{ txHash: 'c'.repeat(64), voutIndex: 1 }] }), /transferable UTXO 0 is missing utxoAmountRaw/);
});

test('next-command builders (upstream oracles)', () => {
  assert.equal(tbtc.buildSendNextCommand('bc1precipient', 'bc1pfrom', 'btc-brc20-pizza', '3', ['tx-a:0', 'tx-b:1'], new F64('12.5')),
    'onchainos wallet send --chain bitcoin --recipient bc1precipient --readable-amount 3 --from bc1pfrom --contract-token btc-brc20-pizza --brc20-outpoint tx-a:0 --brc20-outpoint tx-b:1 --fee-rate 12.5 --force');
  assert.equal(tbtc.buildSendNextCommand('r', 'f', undefined, '1', [], 'bad'), 'onchainos wallet send --chain bitcoin --recipient r --readable-amount 1 --from f --force');
  assert.equal(tbtc.buildSendNextCommand('r', 'f', undefined, '1 btc', [], '8'), "onchainos wallet send --chain bitcoin --recipient r --readable-amount '1 btc' --from f --fee-rate 8 --force");
  assert.equal(tsui.buildSendNextCommand('0xrecipient', '0xsender', '0x2::coin::COIN', '2.5'),
    'onchainos wallet send --chain sui --recipient 0xrecipient --readable-amount 2.5 --from 0xsender --contract-token 0x2::coin::COIN --force');
});

test('SUI preview, tx-bytes validation and simulation check (upstream oracles)', () => {
  const ctx = { profile: { chainIndex: '784', nativeDecimals: 9, nativeSymbol: 'SUI' }, address: { address: '0xsender' } };
  const preview = tsui.previewFromPrepared(parse(JSON.stringify({ executeResult: true, signType: 'transfer', encoding: 'eip2519', unsignedHashList: [{ index: 0 }], txParam: { gasFee: '1200000', gasPrice: '1000', txBytes: 'raw' } })),
    ctx, '0xrecipient', '0x2::sui::SUI', 'SUI', '1000000000', '1');
  assert.equal(preview.feeReadable, '0.0012');
  assert.equal(preview.feeRate, '1000');
  assert.ok(!stringify(preview).includes('raw'));
  tsui.validateTxBytes('AAECAwQ=');
  assert.throws(() => tsui.validateTxBytes(''), /must not be empty/);
  assert.throws(() => tsui.validateTxBytes('not-base64'), /--sui-tx-bytes must be valid base64: Invalid symbol 45, offset 3\./);
  assert.throws(() => tsui.ensureSimulationSucceeded({ executeResult: false, executeErrorMsg: 'MoveAbort' }), /transaction simulation failed: MoveAbort/);
  tsui.ensureSimulationSucceeded({ executeResult: 'false' });
});

// ── sign.rs ─────────────────────────────────────────────────────────

test('sign.rs helpers (upstream oracles)', () => {
  assert.equal(sign.encodeMessageValue('Hello World', '1'), 'Hello World');
  assert.equal(sign.encodeMessageValue('Hello World', '501'), 'JxF12TrwUP45BMd');
  assert.equal(sign.encodeMessageValue('test', '56'), 'test');
  assert.deepEqual(sign.outputSignResult([{ signature: '0xabc123' }], '1', '0xAddr'), { signature: '0xabc123' });
  const sol = sign.outputSignResult([{ signature: '0x' + Buffer.from('test_signature').toString('hex') }], '501', 'SolAddr123');
  assert.equal(sol.publicKey, 'SolAddr123');
  assert.equal(sol.signature, rs.bs58Encode(Buffer.from('test_signature')));
  assert.throws(() => sign.outputSignResult([], '1', '0xAddr'), /sign-msg: empty response data/);
  assert.throws(() => sign.outputSignResult([{}], '1', '0xAddr'), /missing signature in sign-msg response/);
  assert.throws(() => sign.outputSignResult([{ signature: '0xzz' }], '501', 'x'), /invalid hex signature from API: Invalid character 'z' at position 0/);
});

// ── mod.rs::resolve_send_amount ─────────────────────────────────────

test('resolve_send_amount --amt / native --readable-amount', async () => {
  assert.equal(await cmdTransfer.resolveSendAmount(' 100 ', undefined, undefined, '1'), '100');
  await assert.rejects(cmdTransfer.resolveSendAmount('1.5', undefined, undefined, '1'), /no decimals/);
  await assert.rejects(cmdTransfer.resolveSendAmount('007', undefined, undefined, '1'), /must not have leading zeros, got "007"/);
  await assert.rejects(cmdTransfer.resolveSendAmount('000', undefined, undefined, '1'), /greater than zero/);
  await assert.rejects(cmdTransfer.resolveSendAmount('-5', undefined, undefined, '1'), /whole number in minimal units, got "-5"/);
  assert.equal(await cmdTransfer.resolveSendAmount(undefined, '1.5', undefined, '501'), '1500000000');
  assert.equal(await cmdTransfer.resolveSendAmount(undefined, '1', undefined, '195'), '1000000000000000000');   // upstream quirk: TRX uses 18
  await assert.rejects(cmdTransfer.resolveSendAmount(undefined, undefined, undefined, '1'), /Either --amt or --readable-amount is required/);
});

// ── pipeline entry points used by other groups (stub wallet API, parity home) ──

const H = await import('../parity/make-home.mjs');
const broadcastMod = await import(L + 'wallet/broadcast.mjs');
const EVM1 = '0xd825f780e3cb88b383907ff427495d1dca352d44';
const USDC_ETH_T = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const B = '/priapi/v5/wallet/agentic/pre-transaction/';
const okBody = (data) => ({ code: '0', msg: 'success', data });
const bres = (tx) => ({ pkgId: '', orderId: `o-${tx}`, orderType: '1', txHash: tx });
const eip191 = (hashHex) => {
  const data = Buffer.from(hashHex.slice(2), 'hex');
  return ed25519.sign(H.SIGNING_SEED, keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${data.length}`), data]))).toString('base64');
};

test('batch_sign_and_broadcast: batch unsignedInfo → per-element extraData → batch broadcast', async () => {
  STUB.log.length = 0;
  STUB.routes = {
    [B + 'batch/unsignedInfo']: [okBody([
      { hash: '0x' + '11'.repeat(32), uopHash: 'u1', encoding: 'hex', signType: 'eip1559', executeResult: true, extraData: { extJson: { keep: 1 }, nonce: 1 } },
      { hash: '0x' + '22'.repeat(32), uopHash: 'u2', encoding: 'hex', signType: 'eip1559', executeResult: null, extraData: 'not-an-object' },
    ])],
    [B + 'batch-broadcast-transaction']: [okBody([bres('0xaa'), bres('0xbb')])],
  };
  const txs = [transfer.batchTxParams({ toAddr: USDC_ETH_T, value: '0', contractAddr: USDC_ETH_T, inputData: '0x095ea7b3' }),
    transfer.batchTxParams({ toAddr: USDC_ETH_T, value: '0', contractAddr: USDC_ETH_T, inputData: '0xa9059cbb', gasLimit: '90000' })];
  const resp = await transfer.batchSignAndBroadcast('1', undefined, txs, true, false, true, '3', 'dex', 'skill-x');
  assert.deepEqual(resp.map((r) => r.txHash), ['0xaa', '0xbb']);
  assert.deepEqual(STUB.log.map((r) => r.path), [B + 'batch/unsignedInfo', B + 'batch-broadcast-transaction']);
  const [req1, req2] = STUB.log;
  assert.equal(req1.body.length, 2);
  assert.equal(req1.body[1].gasLimit, '90000');
  assert.equal(req1.body[0].chainIndex, 1);
  const ed0 = JSON.parse(req2.body[0].extraData), ed1 = JSON.parse(req2.body[1].extraData);
  assert.deepEqual(ed0.extJson, { batchBroadcastType: 1, keep: 1 });
  assert.equal(ed0.from7702Address, false);
  assert.equal(ed0.walletMainSaveConfirming, true);
  assert.equal(ed0.txSource, '3');
  assert.equal(ed0.agentBizType, 'dex');
  assert.equal(ed0.agentSkillName, 'skill-x');
  assert.equal(ed0.skipWarning, true);
  assert.equal(ed0.txType, undefined);
  assert.equal(ed0.msgForSign.signature, eip191('0x' + '11'.repeat(32)));
  assert.equal(ed1.msgForSign.sessionCert, H.SESSION_CERT);
  assert.deepEqual(ed1.extJson, { batchBroadcastType: 1 });
  assert.equal(req2.body[0].accountId, 'parity-account-0001');
  assert.equal(req2.body[0].chainIndex, '1');
});

test('batch_sign_and_broadcast: single merged element uses the single broadcast endpoint; guards', async () => {
  STUB.log.length = 0;
  STUB.routes = {
    [B + 'batch/unsignedInfo']: [okBody([{ hash: '0x' + '33'.repeat(32), executeResult: true, encoding: 'hex' }])],
    [B + 'broadcast-transaction']: [{ code: '81362', msg: 'confirm please', data: [] }],
  };
  const tx = transfer.batchTxParams({ toAddr: USDC_ETH_T, value: '0', inputData: '0x' });
  await assert.rejects(transfer.batchSignAndBroadcast('1', undefined, [tx, tx], false, false, false), (e) => e instanceof Confirming && e.msg === 'confirm please');
  assert.deepEqual(STUB.log.map((r) => r.path), [B + 'batch/unsignedInfo', B + 'broadcast-transaction']);
  assert.equal(JSON.parse(STUB.log[1].body.extraData).txType, 2);
  await assert.rejects(transfer.batchSignAndBroadcast('1', undefined, [], false, false, false), /batch_sign_and_broadcast: empty txs/);
  await assert.rejects(transfer.batchSignAndBroadcast('1', undefined, Array(6).fill(tx), false, false, false), /backend allows up to 5 elements, got 6/);
  STUB.routes = { [B + 'batch/unsignedInfo']: [okBody([{ executeResult: false, executeErrorMsg: 'nope' }])] };
  await assert.rejects(transfer.batchSignAndBroadcast('1', undefined, [tx], false, false, false), /^Error: batch element 0: nope$/);
});

test('broadcast_unsigned: overlay keys, txType for non-contract calls, 81362 mapping', async () => {
  STUB.log.length = 0;
  STUB.routes = { [B + 'broadcast-transaction']: [okBody([bres('0xcc')])] };
  const unsigned = decodeUnsigned({ hash: '0x' + '44'.repeat(32), unsignedTxHash: '0x' + '55'.repeat(32), encoding: 'hex', uopHash: 'u', signType: 's', extraData: { a: 1 } });
  const addrInfo = { address: EVM1, chainIndex: '196' };
  const tx = await broadcastMod.broadcastUnsigned({ accessToken: H.TOKENS.access, accountId: 'acc', addrInfo, sessionCert: 'cert', signingSeed: H.SIGNING_SEED,
    unsigned, isContractCall: false, mevProtection: true, force: false, extraDataOverlay: { erc8004Msg: { x: 1 }, a: 2 }, traceHeaders: [['ok-client-tid', 'tid-1']] });
  assert.equal(tx, '0xcc');
  const req = STUB.log[0];
  assert.equal(req.headers['ok-client-tid'], 'tid-1');
  const ed = JSON.parse(req.body.extraData);
  assert.equal(ed.a, 2);
  assert.deepEqual(ed.erc8004Msg, { x: 1 });
  assert.equal(ed.txType, 2);
  assert.equal(ed.isMEV, true);
  assert.equal(ed.checkBalance, true);
  assert.equal(ed.msgForSign.signature, eip191('0x' + '44'.repeat(32)));
  assert.equal(ed.msgForSign.sessionSignature, ed25519.sign(H.SIGNING_SEED, Buffer.alloc(32, 0x55)).toString('base64'));
  STUB.routes = { [B + 'broadcast-transaction']: [{ code: '81362', msg: 'm', data: [] }] };
  await assert.rejects(broadcastMod.broadcastUnsigned({ accessToken: 'x', accountId: 'acc', addrInfo, sessionCert: '', signingSeed: H.SIGNING_SEED, unsigned, isContractCall: true, mevProtection: false, force: false }),
    (e) => e instanceof Confirming);
  await assert.rejects(broadcastMod.broadcastUnsigned({ unsigned: decodeUnsigned({ executeResult: false }), signingSeed: H.SIGNING_SEED }), /^Error: transaction simulation failed: transaction simulation failed$/);
});

test('build_broadcast_body: session material from the state dir; no eip712 / agent fields', async () => {
  const unsigned = decodeUnsigned({ hash: '0x' + '66'.repeat(32), eip712MessageHash: '0x' + '77'.repeat(32), jitoUnsignedTx: '0x0102', encoding: 'hex', extraData: { freeGas: true } });
  const body = await transfer.buildBroadcastBody(unsigned, 'acc', EVM1, '196', true, false, true);
  assert.deepEqual(Object.keys(body), ['accountId', 'address', 'chainIndex', 'extraData']);
  const ed = JSON.parse(body.extraData);
  assert.equal(ed.checkBalance, false);
  assert.equal(ed.skipWarning, true);
  assert.equal(ed.msgForSign.sessionSignature, undefined);          // eip712MessageHash is not signed here
  assert.equal(ed.msgForSign.jitoSessionSignature, ed25519.sign(H.SIGNING_SEED, Buffer.from([1, 2])).toString('base64'));
  assert.equal(ed.msgForSign.sessionCert, H.SESSION_CERT);
});

// ── clap 4.6 validation texts (transfer/_clap.mjs). Oracles: stderr of the upstream binary
// (onchainos 4.6.3) for the same argv; the core parser may pre-empt these checks. ──
const clapMod = await import(L + 'wallet/transfer/_clap.mjs');
const { UsageError } = await import(L + 'core/errors.mjs');
const clapErr = (argv, rules) => {
  const path = argv.filter((t) => ['wallet', 'send', 'contract-call', 'sign-message'].includes(t)).slice(0, 2).join(' ');
  try { clapMod.clapValidate({ path, argv }, rules); } catch (e) { assert.ok(e instanceof UsageError); return e.message; }
  return null;
};
const SEND_RULES = { conflicts: [['amt', 'readableAmount']], requires: [['brc20Outpoint', 'contractToken']], leafRequired: ['chain'] };
const CC_RULES = { conflicts: [['unsignedTx', 'suiTxBytes'], ['inputData', 'suiTxBytes']], leafRequired: ['chain'] };
const TAIL = "\n\nFor more information, try '--help'.\n";

test('clap: conflict usage lists used args in command-line order (ArgMatcher order)', () => {
  assert.equal(clapErr(['wallet', 'send', '--from', 'F', '--readable-amount', '2', '--chain', '1', '--amt', '1', '--recipient', 'R'], SEND_RULES),
    "error: the argument '--readable-amount <READABLE_AMOUNT>' cannot be used with '--amt <AMT>'\n\nUsage: onchainos wallet send --recipient <RECIPIENT> --chain <CHAIN> --from <FROM> --readable-amount <READABLE_AMOUNT>" + TAIL);
  assert.equal(clapErr(['wallet', 'send', '--chain', '1', '--recipient', 'R', '--force', '--amt', '1', '--readable-amount', '2'], SEND_RULES),
    "error: the argument '--amt <AMT>' cannot be used with '--readable-amount <READABLE_AMOUNT>'\n\nUsage: onchainos wallet send --recipient <RECIPIENT> --chain <CHAIN> --force --amt <AMT>" + TAIL);
  assert.equal(clapErr(['wallet', 'contract-call', '--gas-limit', '1', '--chain', 'sui', '--unsigned-tx', 'x', '--to', 'T', '--sui-tx-bytes', 'AA', '--input-data', '0x'], CC_RULES),
    "error: the argument '--unsigned-tx <UNSIGNED_TX>' cannot be used with '--sui-tx-bytes <SUI_TX_BYTES>'\n\nUsage: onchainos wallet contract-call --chain <CHAIN> --gas-limit <GAS_LIMIT> --unsigned-tx <UNSIGNED_TX> --to <TO> --input-data <INPUT_DATA>" + TAIL);
});

test('clap: several conflicting args are listed with "with:"; requirements of used args join the usage', () => {
  assert.equal(clapErr(['wallet', 'contract-call', '--chain', 'sui', '--sui-tx-bytes', 'AA', '--unsigned-tx', 'x', '--input-data', '0x'], CC_RULES),
    "error: the argument '--sui-tx-bytes <SUI_TX_BYTES>' cannot be used with:\n  --unsigned-tx <UNSIGNED_TX>\n  --input-data <INPUT_DATA>\n\nUsage: onchainos wallet contract-call --chain <CHAIN> --sui-tx-bytes <SUI_TX_BYTES>" + TAIL);
  assert.equal(clapErr(['wallet', 'send', '--chain', '1', '--recipient', 'R', '--brc20-outpoint', 'a:1', '--amt', '1', '--readable-amount', '2'], SEND_RULES),
    "error: the argument '--amt <AMT>' cannot be used with '--readable-amount <READABLE_AMOUNT>'\n\nUsage: onchainos wallet send --recipient <RECIPIENT> --chain <CHAIN> --contract-token <CONTRACT_TOKEN> --brc20-outpoint <BRC20_OUTPOINT> --amt <AMT>" + TAIL);
});

test('clap: missing requirement — required graph gains `requires`, then used args in order', () => {
  assert.equal(clapErr(['wallet', 'send', '--brc20-outpoint', 'a:1', '--from', 'F', '--recipient', 'R', '--chain', '1', '--fee-rate', '2', '--amt', '1'], SEND_RULES),
    "error: the following required arguments were not provided:\n  --contract-token <CONTRACT_TOKEN>\n\nUsage: onchainos wallet send --recipient <RECIPIENT> --chain <CHAIN> --contract-token <CONTRACT_TOKEN> --brc20-outpoint <BRC20_OUTPOINT> --from <FROM> --fee-rate <FEE_RATE> --amt <AMT>" + TAIL);
  assert.equal(clapErr(['--chain', '1', 'wallet', 'send', '--brc20-outpoint', 'a:1', '--recipient', 'R', '--fee-rate', '3'], SEND_RULES),
    "error: the following required arguments were not provided:\n  --chain <CHAIN>\n  --contract-token <CONTRACT_TOKEN>\n\nUsage: onchainos wallet send --recipient <RECIPIENT> --chain <CHAIN> --contract-token <CONTRACT_TOKEN> --brc20-outpoint <BRC20_OUTPOINT> --fee-rate <FEE_RATE>" + TAIL);
  assert.equal(clapErr(['wallet', 'send', '--chain', '1', '--recipient', 'R', '--amt', '1'], SEND_RULES), null);
});
