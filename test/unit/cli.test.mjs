// core/cli.mjs — clap 4.6 parse-time behaviour driven by lib/spec.json. Every expected text is the
// stderr of the upstream 4.6.3 binary for the same argv (collected by the command groups whose
// handlers used to re-check these rules).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parse, typed, parseClapInt } = await import('../../skill/onchainos-lite/lib/core/cli.mjs');
const { UsageError } = await import('../../skill/onchainos-lite/lib/core/errors.mjs');

// parse(argv) → clap's error text, or null when clap accepts argv
async function clapErr(argv, options) {
  try { await parse(argv, options); return null; } catch (e) { assert.ok(e instanceof UsageError); return e.message; }
}
const TAIL = "\n\nFor more information, try '--help'.\n";
const usage = (msg, use) => `error: ${msg}\n\nUsage: onchainos ${use}${TAIL}`;
const missing = (...args) => `the following required arguments were not provided:\n${args.map((a) => `  ${a}`).join('\n')}`;
// value-parser errors print no Usage block
const invalid = (raw, arg, why) => `error: invalid value '${raw}' for '${arg}': ${why}${TAIL}`;

test('integer value parsers: RangedI64ValueParser (uN/iN) and RangedU64ValueParser (u64/usize) wording', () => {
  const err = (raw, t) => { try { parseClapInt(raw, t); } catch (e) { return e.message; } return 'ok'; };
  assert.equal(parseClapInt('255', 'u8'), 255);
  assert.equal(parseClapInt('+7', 'u32'), 7);
  assert.equal(parseClapInt('-0', 'u32'), 0);
  assert.equal(parseClapInt('+007', 'u32'), 7);
  assert.equal(parseClapInt('4294967295', 'u32'), 4294967295);
  assert.equal(parseClapInt('-9223372036854775808', 'i64'), -9223372036854775808n);
  assert.equal(err('300', 'u8'), '300 is not in 0..=255');
  assert.equal(err('-1', 'u8'), '-1 is not in 0..=255');
  assert.equal(err('+300', 'u8'), '300 is not in 0..=255');
  assert.equal(err('99999999999', 'u32'), '99999999999 is not in 0..=4294967295');
  assert.equal(err('99999999999999999999', 'u32'), 'number too large to fit in target type');
  assert.equal(err('-99999999999999999999', 'u32'), 'number too small to fit in target type');
  assert.equal(err('9223372036854775808', 'i64'), 'number too large to fit in target type');
  assert.equal(err('', 'u32'), 'cannot parse integer from empty string');
  assert.equal(err(' 5', 'u8'), 'invalid digit found in string');
  assert.equal(err('+', 'u8'), 'invalid digit found in string');
  assert.equal(parseClapInt('0', 'usize'), 0);
  assert.equal(parseClapInt('+7', 'usize'), 7);
  assert.equal(parseClapInt('18446744073709551615', 'u64'), 18446744073709551615n);
  assert.equal(err('18446744073709551616', 'u64'), 'number too large to fit in target type');
  assert.equal(err('-1', 'u64'), 'invalid digit found in string');
  assert.equal(err('x', 'usize'), 'invalid digit found in string');
  assert.equal(err('', 'u64'), 'cannot parse integer from empty string');
});

test('value parsers: i64 FromStr scans left to right (overflow before a later bad digit), then the bounds', async () => {
  const kline = (raw) => clapErr(['market', 'kline', '--address', 'x', `--limit=${raw}`]);
  for (const [raw, why] of [
    ['abc', 'invalid digit found in string'], ['', 'cannot parse integer from empty string'], ['+', 'invalid digit found in string'],
    ['-', 'invalid digit found in string'], [' 5', 'invalid digit found in string'], ['1_0', 'invalid digit found in string'],
    ['٣', 'invalid digit found in string'], ['-1', '-1 is not in 0..=4294967295'], ['+4294967296', '4294967296 is not in 0..=4294967295'],
    ['0004294967296', '4294967296 is not in 0..=4294967295'], ['99999999999999999999', 'number too large to fit in target type'],
    ['99999999999999999999x', 'number too large to fit in target type'], ['-99999999999999999999', 'number too small to fit in target type'],
  ]) assert.equal(await kline(raw), invalid(raw, '--limit <LIMIT>', why), raw);
  assert.equal(await clapErr(['security', 'tx-scan', '--from', 'a', '--chain', '1', '--gas-price', 'x', '--gas', 'y']),
    invalid('x', '--gas-price <GAS_PRICE>', 'invalid digit found in string'));
});

test('hyphen values: `-<digit>…` is a short flag unless the option allows hyphen values; `--opt=-5` is a value', async () => {
  assert.equal(await clapErr(['token', 'hot-tokens', '--price-change-min', '-5', '--limit', '3']), null);
  assert.equal(await clapErr(['token', 'hot-tokens', '--volume-min', '-1.5']),
    usage("unexpected argument '-1' found", 'token hot-tokens [OPTIONS]'));
  assert.equal(await clapErr(['token', 'hot-tokens', '--volume-min=-5']), null);
});

test('conflicts: argv order, every present partner ("with:"), smart usage with the requires of used args', async () => {
  const cannot = (arg, ...others) => `the argument '${arg}' cannot be used with${others.length === 1 ? ` '${others[0]}'` : `:${others.map((o) => `\n  ${o}`).join('')}`}`;
  assert.equal(await clapErr(['security', 'token-scan', '--address', 'b', '--chain', '1', '--tokens', 'a']),
    usage(cannot('--address <ADDRESS>', '--tokens <TOKENS>'), 'security token-scan --address <ADDRESS> --chain <CHAIN>'));
  assert.equal(await clapErr(['--chain', 'eth', 'security', 'token-scan', '--tokens', 'a', '--address', 'b']),
    usage(cannot('--tokens <TOKENS>', '--address <ADDRESS>'), 'security token-scan --tokens <TOKENS>'));
  // strategy cancel: conflicts_with_all on each of the three selectors
  assert.equal(await clapErr(['strategy', 'cancel', '--wait', '--order-ids', '1', '--all', '--order-id', '2']),
    usage(cannot('--order-ids <ORDER_IDS>', '--all', '--order-id <ORDER_ID>'), 'strategy cancel --wait --order-ids <ORDER_IDS>'));
  assert.equal(await clapErr(['strategy', 'cancel', '--all', '--chain', 'eth', '--order-id', '1', '--order-ids', '2']),
    usage(cannot('--all', '--order-id <ORDER_ID>', '--order-ids <ORDER_IDS>'), 'strategy cancel --all --chain <CHAIN>'));
  assert.equal(await clapErr(['strategy', 'cancel', '--order-ids', '1', '--order-id', '2']),
    usage(cannot('--order-ids <ORDER_IDS>', '--order-id <ORDER_ID>'), 'strategy cancel --order-ids <ORDER_IDS>'));
  assert.equal(await clapErr(['strategy', 'cancel', '--order-id', '1', '--wait']), null);
  // wallet receive: --chain conflicts_with_all [token, cursor]; --cursor requires --token
  assert.equal(await clapErr(['wallet', 'receive', '--cursor', 'x', '--chain', 'y']),
    usage(cannot('--cursor <CURSOR>', '--chain <CHAIN>'), 'wallet receive --token <TOKEN> --cursor <CURSOR>'));
  assert.equal(await clapErr(['wallet', 'receive', '--token', 'x', '--cursor', 'y', '--chain', 'z']),
    usage(cannot('--token <TOKEN>', '--chain <CHAIN>'), 'wallet receive --token <TOKEN> --cursor <CURSOR>'));
  assert.equal(await clapErr(['wallet', 'receive', '--chain', '1', '--cursor', '9', '--token', 'x']),
    usage(cannot('--chain <CHAIN>', '--cursor <CURSOR>', '--token <TOKEN>'), 'wallet receive --chain <CHAIN>'));
  // the global --chain before the subcommand is not the leaf arg: no conflict
  assert.equal(await clapErr(['--chain', 'eth', 'wallet', 'receive', '--token', 'USDT']), null);
  assert.equal(await clapErr(['wallet', 'utxo', 'unlock', '--all', '--force', '--outpoint', 'a', '--chain', 'bitcoin']),
    usage(cannot('--all', '--outpoint <OUTPOINT>'), 'wallet utxo unlock --chain <CHAIN> --all --force'));
  assert.equal(await clapErr(['wallet', 'inscription', 'status', '--chain', 'b', '--order-id', 'a', '--tx-hash', 'b']),
    usage(cannot('--order-id <ORDER_ID>', '--tx-hash <TX_HASH>'), 'wallet inscription status --chain <CHAIN> --order-id <ORDER_ID>'));
  assert.equal(await clapErr(['wallet', 'send', '--from', 'F', '--readable-amount', '2', '--chain', '1', '--amt', '1', '--recipient', 'R']),
    usage(cannot('--readable-amount <READABLE_AMOUNT>', '--amt <AMT>'), 'wallet send --recipient <RECIPIENT> --chain <CHAIN> --from <FROM> --readable-amount <READABLE_AMOUNT>'));
  assert.equal(await clapErr(['wallet', 'send', '--chain', '1', '--recipient', 'R', '--force', '--amt', '1', '--readable-amount', '2']),
    usage(cannot('--amt <AMT>', '--readable-amount <READABLE_AMOUNT>'), 'wallet send --recipient <RECIPIENT> --chain <CHAIN> --force --amt <AMT>'));
  assert.equal(await clapErr(['wallet', 'send', '--chain', '1', '--recipient', 'R', '--brc20-outpoint', 'a:1', '--amt', '1', '--readable-amount', '2']),
    usage(cannot('--amt <AMT>', '--readable-amount <READABLE_AMOUNT>'),
      'wallet send --recipient <RECIPIENT> --chain <CHAIN> --contract-token <CONTRACT_TOKEN> --brc20-outpoint <BRC20_OUTPOINT> --amt <AMT>'));
  assert.equal(await clapErr(['wallet', 'contract-call', '--gas-limit', '1', '--chain', 'sui', '--unsigned-tx', 'x', '--to', 'T', '--sui-tx-bytes', 'AA', '--input-data', '0x']),
    usage(cannot('--unsigned-tx <UNSIGNED_TX>', '--sui-tx-bytes <SUI_TX_BYTES>'),
      'wallet contract-call --chain <CHAIN> --gas-limit <GAS_LIMIT> --unsigned-tx <UNSIGNED_TX> --to <TO> --input-data <INPUT_DATA>'));
  assert.equal(await clapErr(['wallet', 'contract-call', '--chain', 'sui', '--sui-tx-bytes', 'AA', '--unsigned-tx', 'x', '--input-data', '0x']),
    usage(cannot('--sui-tx-bytes <SUI_TX_BYTES>', '--unsigned-tx <UNSIGNED_TX>', '--input-data <INPUT_DATA>'), 'wallet contract-call --chain <CHAIN> --sui-tx-bytes <SUI_TX_BYTES>'));
});

test('required: a leaf --chain is not satisfied by the global one; requires / required_unless grow the graph', async () => {
  assert.equal(await clapErr(['--chain', 'ethereum', 'gateway', 'orders', '--order-id', '5', '--address', '0x1']),
    usage(missing('--chain <CHAIN>'), 'gateway orders --address <ADDRESS> --chain <CHAIN> --order-id <ORDER_ID>'));
  assert.equal(await clapErr(['wallet', 'receive', '--cursor', 'x']),
    usage(missing('--token <TOKEN>'), 'wallet receive --token <TOKEN> --cursor <CURSOR>'));
  assert.equal(await clapErr(['wallet', 'utxo', 'unlock', '--force', '--chain', 'bitcoin', '--operation-token', 'x']),
    usage(missing('--outpoint <OUTPOINT>'), 'wallet utxo unlock --chain <CHAIN> --force --operation-token <OPERATION_TOKEN> --outpoint <OUTPOINT>'));
  assert.equal(await clapErr(['wallet', 'utxo', 'lock']),
    usage(missing('--chain <CHAIN>', '--outpoint <OUTPOINT>'), 'wallet utxo lock --chain <CHAIN> --outpoint <OUTPOINT>'));
  assert.equal(await clapErr(['--chain', 'bitcoin', 'wallet', 'utxo', 'unlock', '--all']),
    usage(missing('--chain <CHAIN>'), 'wallet utxo unlock --chain <CHAIN> --all'));
  assert.equal(await clapErr(['wallet', 'inscription', 'status']),
    usage(missing('--chain <CHAIN>', '--tx-hash <TX_HASH>', '--order-id <ORDER_ID>'), 'wallet inscription status --chain <CHAIN> --tx-hash <TX_HASH> --order-id <ORDER_ID>'));
  assert.equal(await clapErr(['wallet', 'inscription', 'status', '--tx-hash', 'a']),
    usage(missing('--chain <CHAIN>'), 'wallet inscription status --chain <CHAIN> --tx-hash <TX_HASH>'));
  assert.equal(await clapErr(['wallet', 'gas-station', 'setup', '--from', 'x', '--relayer-id', 'y']),
    usage(missing('--chain <CHAIN>', '--gas-token-address <GAS_TOKEN_ADDRESS>'),
      'wallet gas-station setup --chain <CHAIN> --gas-token-address <GAS_TOKEN_ADDRESS> --relayer-id <RELAYER_ID> --from <FROM>'));
  assert.equal(await clapErr(['wallet', 'utxo', 'reclaim', '--force']),
    usage(missing('--chain <CHAIN>', '--tx-hash <TX_HASH>'), 'wallet utxo reclaim --chain <CHAIN> --tx-hash <TX_HASH> --force'));
  assert.equal(await clapErr(['wallet', 'send', '--brc20-outpoint', 'a:1', '--from', 'F', '--recipient', 'R', '--chain', '1', '--fee-rate', '2', '--amt', '1']),
    usage(missing('--contract-token <CONTRACT_TOKEN>'),
      'wallet send --recipient <RECIPIENT> --chain <CHAIN> --contract-token <CONTRACT_TOKEN> --brc20-outpoint <BRC20_OUTPOINT> --from <FROM> --fee-rate <FEE_RATE> --amt <AMT>'));
  assert.equal(await clapErr(['--chain', '1', 'wallet', 'send', '--brc20-outpoint', 'a:1', '--recipient', 'R', '--fee-rate', '3']),
    usage(missing('--chain <CHAIN>', '--contract-token <CONTRACT_TOKEN>'),
      'wallet send --recipient <RECIPIENT> --chain <CHAIN> --contract-token <CONTRACT_TOKEN> --brc20-outpoint <BRC20_OUTPOINT> --fee-rate <FEE_RATE>'));
});

test('accepted argv: Vec<String> occurrences, defaults, leaf-local --chain; typed() converts', async () => {
  let { opts } = await parse(['wallet', 'utxo', 'unlock', '--chain', 'bitcoin', '--outpoint', 'a', '--outpoint=b']);
  assert.deepEqual(opts.outpoint, ['a', 'b']);
  ({ opts } = await parse(['wallet', 'send', '--chain', '1', '--recipient', 'R', '--amt', '1']));
  assert.equal(opts.brc20Outpoint, undefined);
  ({ opts } = await parse(['token', 'trades', '--address', 'x']));
  assert.equal(typed('token trades', 'limit', opts.limit, 'u32'), 100);
  ({ opts } = await parse(['--chain', 'ethereum', 'agent', 'funding-notice', '--chain', 'base', '--currency', 'USDT', '--shortfall', '1', '--deposit-address', '0xabc']));
  assert.equal(opts.chain, 'base');
});

test('custom value_parser fn: runs at parse time; its output is the option value, its error clap\'s', async () => {
  const valueParsers = async (path) => (path === 'agent my-subscriptions' ? { status: (s) => { if (s !== '7') throw new Error('bad status'); return 7; } } : undefined);
  const { opts } = await parse(['agent', 'my-subscriptions', '--status', '7'], { valueParsers });
  assert.equal(opts.status, 7);
  assert.equal(await clapErr(['agent', 'my-subscriptions', '--status', 'x', '--role', 'asp'], { valueParsers }),
    invalid('x', '--status <STATUS>', 'bad status'));
});
