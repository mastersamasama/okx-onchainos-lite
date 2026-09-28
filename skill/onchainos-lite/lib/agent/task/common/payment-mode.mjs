// Task payment mode — upstream task/common/payment_mode.rs. Values: 'none' | 'escrow' | 'x402'.
export const PaymentMode = Object.freeze({
  None: 'none', Escrow: 'escrow', X402: 'x402',
  // upstream: PaymentMode::from_str (anything but escrow/x402 → Escrow)
  fromStr: (s) => (s === 'x402' ? 'x402' : 'escrow'),
  // upstream: PaymentMode::parse_flag → backend int
  parseFlag(flag) {
    if (flag === undefined || flag === null) return 0;
    if (flag === 'escrow') return 1;
    throw new Error(`unsupported --payment-mode "${flag}"; valid Task value: escrow`);
  },
  // upstream: PaymentMode::from_int
  fromInt: (i) => (Number(i) === 1 ? 'escrow' : Number(i) === 3 ? 'x402' : 'none'),
  asStr: (m) => ({ none: 'none', escrow: 'escrow', x402: 'legacy-x402-disabled' })[m],
  asInt: (m) => ({ none: 0, escrow: 1, x402: 3 })[m],
  desc: (m) => ({ none: 'not set', escrow: 'escrow payment', x402: 'legacy task payment disabled' })[m],
});
