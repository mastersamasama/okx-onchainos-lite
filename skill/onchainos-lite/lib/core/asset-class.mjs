// The single asset-class taxonomy — upstream asset_class.rs (serde lowercase wire strings).
import { asciiLower } from './_rust-str.mjs';

// upstream: asset_class.rs::AssetClass — variants are their wire strings (AssetClass::as_str).
export const AssetClass = Object.freeze({
  Spot: 'spot',
  Perp: 'perp',
  Prediction: 'prediction',
  Option: 'option',
  Defi: 'defi',
});

// upstream: asset_class.rs::AssetClass::ORDER — canonical stable output order.
export const ASSET_CLASS_ORDER = Object.freeze([AssetClass.Spot, AssetClass.Perp, AssetClass.Prediction, AssetClass.Option, AssetClass.Defi]);

// upstream: asset_class.rs::AssetClass::as_str
export const assetClassAsStr = (c) => c;

const PARSE = { spot: AssetClass.Spot, perp: AssetClass.Perp, futures: AssetClass.Perp, prediction: AssetClass.Prediction, option: AssetClass.Option, options: AssetClass.Option, defi: AssetClass.Defi };
export const ASSET_CLASS_PARSE_ERROR = 'asset class must be spot, perp, prediction, option, or defi';

// upstream: asset_class.rs::<AssetClass as FromStr>::from_str — ASCII case-insensitive with aliases
// (futures → perp, options → option). Throws Error(ASSET_CLASS_PARSE_ERROR) otherwise.
export function assetClassFromStr(value) {
  const k = asciiLower(value);
  if (Object.prototype.hasOwnProperty.call(PARSE, k)) return PARSE[k];
  throw new Error(ASSET_CLASS_PARSE_ERROR);
}
