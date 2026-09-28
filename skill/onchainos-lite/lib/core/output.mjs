// stdout envelopes — mirrors upstream output.rs. Every print goes through here.
import { stringify, struct } from './json.mjs';
import { PRETTY } from '../config.mjs';
import { drainEvents } from './notify.mjs';

const print = (v) => process.stdout.write(stringify(v, PRETTY) + '\n');

// JsonOutput { ok, data?, error?, notifications (skip if empty) } — a struct: field order.
function envelope({ ok, data, error }) {
  const n = drainEvents();
  return struct({ ok, data, error, notifications: n.length ? n : undefined });
}

export const successEmpty = () => print(envelope({ ok: true }));
export const success = (data) => print(envelope({ ok: true, data: data === undefined ? null : data }));
export const error = (msg) => print(envelope({ ok: false, error: msg }));
export const errorData = (data) => print(envelope({ ok: false, data }));

// {ok:false,error,errorCode,errorField?,data?,nextSteps?,notifications?} — json! Value: sorted keys.
export function errorCoded(code, field, message, data, nextSteps) {
  const v = { ok: false, error: message, errorCode: code };
  if (field != null) v.errorField = field;
  if (data != null) v.data = data;
  if (nextSteps != null) v.nextSteps = nextSteps;
  const n = drainEvents();
  if (n.length) v.notifications = n;
  print(v);
}

export function insufficientBalance({ message, depositAddress, depositChain, currency, shortfall }) {
  if (depositAddress == null) return error(message);
  const v = { ok: false, error: message, depositAddress, depositChain: depositChain ?? null, currency: currency ?? null, shortfall: shortfall ?? null };
  const n = drainEvents();
  if (n.length) v.notifications = n;
  print(v);
}

// ConfirmingOutput { confirming, scene?, message (skip empty), next (skip empty), notifications }
export function confirming(message, next, scene) {
  const n = drainEvents();
  print(struct({ confirming: true, scene: scene ?? undefined, message: message || undefined, next: next || undefined, notifications: n.length ? n : undefined }));
}

// AgenticWalletConfirmingOutput { confirming, scene, message?, preview, next?, notifications }
export function walletConfirming(message, next, scene, preview) {
  const n = drainEvents();
  print(struct({ confirming: true, scene, message: message || undefined, preview: preview ?? null, next: next || undefined, notifications: n.length ? n : undefined }));
}

export const setupRequired = (errorCode, message, data) => print({ ok: false, errorCode, message, data: data ?? null });

// Bespoke top-level {ok} / {ok:false,reason} (autotrade-grant-check) — no envelope, no notifications.
export const bespokeOk = () => print({ ok: true });
export const bespokeDeny = (reason) => print({ ok: false, reason });

// Raw line (streaming commands such as ws/watch print one JSON document per line).
export const line = (v) => print(v);
