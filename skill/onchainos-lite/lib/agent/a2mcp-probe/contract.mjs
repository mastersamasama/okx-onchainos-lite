// A2MCP routing / parameter contract — upstream commands/agent_commerce/a2mcp_probe/contract.rs.
import { u64, value, vec, string, struct as deStruct } from '../../watch/_serde.mjs';
import { fromStr, SerdeError } from '../identity/_from-str.mjs';
import { paramSpec, ParamCarrier } from '../../payment/state.mjs';
import { urlParseError } from '../../payment/a2mcp.mjs';
import { trim, eqIgnoreAsciiCase, asciiLower, isObj, isNum, numText, asI64, asU64, splitWhitespace } from '../_rs.mjs';
import { optionDe, boolDe } from '../identity/models.mjs';
import { ContractError, defaultStringType } from './_model.mjs';
import { requestMethodIsDefaulted, resolveRequestMethod } from './method.mjs';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const mget = (m, k) => (isObj(m) && hasOwn(m, k) && m[k] !== undefined ? m[k] : undefined);

// upstream: mod.rs::FieldConstraint (serde camelCase; type default "string", required default true)
export const FIELD_CONSTRAINT_DE = deStruct('FieldConstraint', [
  { name: 'name', de: string },
  { name: 'type', de: string, def: defaultStringType },
  { name: 'required', de: boolDe, def: () => true },
  { name: 'carrier', de: optionDe(string), def: () => null },
  { name: 'description', de: optionDe(string), def: () => null },
]);
// upstream: mod.rs::RequestSpec
export const REQUEST_SPEC_DE = deStruct('RequestSpec', [
  { name: 'method', de: optionDe(string), def: () => null },
  { name: 'fields', de: vec(FIELD_CONSTRAINT_DE), def: () => [] },
  { name: 'requiredAnyOf', de: vec(string), def: () => [] },
]);
// upstream: mod.rs::RoutingPayload
export const ROUTING_PAYLOAD_DE = deStruct('RoutingPayload', [
  { name: 'schemaVersion', de: u64 },
  { name: 'serviceSnapshot', de: value },
  { name: 'requestSpec', de: optionDe(REQUEST_SPEC_DE), def: () => null },
]);

// serde_json::from_str::<RoutingPayload>
export const parseRoutingPayload = (text) => fromStr(text, ROUTING_PAYLOAD_DE);

// upstream: contract.rs::parse_probe_input(routing_json, params_json) → ProbeInput; throws ContractError
export function parseProbeInput(routingJson, paramsJson) {
  let routing;
  try { routing = parseRoutingPayload(routingJson); } catch (e) {
    if (e instanceof SerdeError) throw new ContractError('invalid_a2mcp_routing', `routing JSON is invalid: ${e.message}`);
    throw e;
  }
  if (BigInt(routing.schemaVersion) !== 1n) throw new ContractError('invalid_a2mcp_routing', 'schemaVersion must be the integer 1');
  const object = routing.serviceSnapshot;
  if (!isObj(object)) throw new ContractError('invalid_a2mcp_routing', 'serviceSnapshot must be an object');
  const st = mget(object, 'serviceType');
  if (!(typeof st === 'string' && eqIgnoreAsciiCase(st, 'A2MCP'))) throw new ContractError('invalid_a2mcp_routing', 'serviceSnapshot.serviceType must equal A2MCP');
  const ep = mget(object, 'endpoint');
  if (typeof ep !== 'string') throw new ContractError('invalid_a2mcp_routing', 'serviceSnapshot.endpoint must be a URL string');
  let endpoint;
  try { endpoint = new URL(ep); } catch { throw new ContractError('invalid_a2mcp_routing', `serviceSnapshot.endpoint is invalid: ${urlParseError(ep)}`); }
  if (endpoint.protocol !== 'https:') throw new ContractError('invalid_a2mcp_routing', 'serviceSnapshot.endpoint must use HTTPS');
  let params;
  try { params = fromStr(paramsJson, value); } catch (e) {
    if (e instanceof SerdeError) throw new ContractError('invalid_a2mcp_params', `params JSON is invalid: ${e.message}`);
    throw e;
  }
  if (!isObj(params)) throw new ContractError('invalid_a2mcp_params', 'params JSON must be an object');
  const typedParams = params;
  const requestSpec = routing.requestSpec;
  const outputSchema = mget(object, 'outputSchema');
  const paramPlan = requestSpec ? requestSpec.fields.map((f) => ({ ...f }))
    : (mget(outputSchema, 'input') === undefined ? [] : parseFields(mget(outputSchema, 'input')));
  const requiredAnyOf = requestSpec ? [...requestSpec.requiredAnyOf] : stringArray(mget(outputSchema, 'requiredAnyOf'));
  const serviceId = scalarString(mget(object, 'serviceId'));
  if (serviceId === undefined || trim(serviceId) === '') throw new ContractError('invalid_a2mcp_routing', 'serviceSnapshot.serviceId is required');
  validateTypedParams(typedParams, paramPlan);
  let fallbackMethod = requestSpec && requestSpec.method !== null ? requestSpec.method : undefined;
  if (fallbackMethod === undefined && typeof mget(object, 'method') === 'string') fallbackMethod = object.method;
  if (fallbackMethod === undefined && typeof mget(outputSchema, 'method') === 'string') fallbackMethod = outputSchema.method;
  const sd = mget(object, 'serviceDescription');
  const serviceDescription = typeof sd === 'string' ? sd : undefined;
  const methodWasDefaulted = requestMethodIsDefaulted(serviceDescription, fallbackMethod);
  const method = resolveRequestMethod(serviceDescription, endpoint, fallbackMethod);
  const sn = mget(object, 'serviceName');
  const asp = mget(object, 'asp');
  const aspId = isObj(asp) ? scalarString(mget(asp, 'aspAgentId')) : undefined;
  const sym = mget(object, 'feeTokenSymbol');
  return {
    snapshot: {
      raw: routing.serviceSnapshot,
      serviceId,
      serviceName: typeof sn === 'string' && trim(sn) !== '' ? sn : null,
      providerAgentId: aspId !== undefined && trim(aspId) !== '' ? aspId : null,
      endpoint,
      method,
      methodWasDefaulted,
      aspAmount: scalarString(mget(object, 'feeAmount')) ?? null,
      aspSymbol: typeof sym === 'string' ? sym.replace(/[a-z]/g, (c) => c.toUpperCase()) : null,
      paramPlan,
      requiredAnyOf,
    },
    typedParams,
  };
}

// upstream: contract.rs::to_payment_param_plan(plan, method) → ParamSpec[]
export function toPaymentParamPlan(plan, method) {
  const def = eqIgnoreAsciiCase(method, 'POST') ? 'body' : 'query';
  return plan.map((field) => {
    const c = field.carrier ?? def;
    const carrier = { query: ParamCarrier.Query, body: ParamCarrier.Body, header: ParamCarrier.Header, path: ParamCarrier.Path }[c];
    if (carrier === undefined || !['query', 'body', 'header', 'path'].includes(c)) throw new Error(`invalid_a2mcp_params: unsupported carrier \`${c}\``);
    return paramSpec({ name: field.name, carrier, required: field.required, type: field.type });
  });
}

// upstream: contract.rs::outstanding_input(required, params) → InputRequired | null
export function outstandingInput(required, params) {
  const r = { ...required, fields: [...required.fields], requiredAnyOf: [...required.requiredAnyOf] };
  const alternatives = r.requiredAnyOf;
  r.fields = r.fields.filter((f) => f.required && !alternatives.includes(f.name) && !hasOwn(params, f.name));
  if (r.requiredAnyOf.some((n) => hasOwn(params, n))) r.requiredAnyOf = [];
  if (!r.fields.length && !r.requiredAnyOf.length) return r.needsDescriptionFallback ? r : null;
  return r;
}

const strOrNull = (v) => (typeof v === 'string' ? v : null);

// upstream: contract.rs::discover_input_required(value) → InputRequired | null
export function discoverInputRequired(v) {
  const ir = mget(v, 'input_required');
  if (isObj(ir)) {
    const fields = mget(ir, 'fields') === undefined ? [] : parseFields(ir.fields);
    const requiredAnyOf = stringArray(mget(ir, 'requiredAnyOf'));
    if (fields.length || requiredAnyOf.length) {
      return {
        fields, requiredAnyOf, message: strOrNull(mget(ir, 'message')),
        method: strOrNull(mget(ir, 'method')) ?? strOrNull(mget(mget(v, 'outputSchema'), 'method')), needsDescriptionFallback: false,
      };
    }
  }
  if (mget(v, 'status') === 'input_required') {
    const src = mget(v, 'fields') !== undefined ? v.fields : mget(v, 'requiredArgs');
    const fields = src === undefined ? [] : parseFields(src);
    const requiredAnyOf = stringArray(mget(v, 'requiredAnyOf'));
    if (fields.length || requiredAnyOf.length) {
      return { fields, requiredAnyOf, message: strOrNull(mget(v, 'message')), method: strOrNull(mget(v, 'method')), needsDescriptionFallback: false };
    }
  }
  const outputSchema = mget(v, 'outputSchema');
  const input = mget(outputSchema, 'input');
  const outputFields = (input === undefined ? [] : parseFields(input)).filter((f) => f.required);
  const outputAnyOf = stringArray(mget(outputSchema, 'requiredAnyOf'));
  if (outputFields.length || outputAnyOf.length) {
    return { fields: outputFields, requiredAnyOf: outputAnyOf, message: null, method: strOrNull(mget(outputSchema, 'method')), needsDescriptionFallback: false };
  }
  const missing = stringArray(mget(v, 'missingParams'));
  const names = missing.length ? missing : stringArray(mget(v, 'required'));
  if (!names.length) return null;
  return {
    fields: names.map((name) => ({ name, type: defaultStringType(), required: true, carrier: null, description: null })),
    requiredAnyOf: stringArray(mget(v, 'requiredAnyOf')),
    message: strOrNull(mget(v, 'message')),
    method: strOrNull(mget(outputSchema, 'method')),
    needsDescriptionFallback: true,
  };
}

// upstream: contract.rs::discover_input_fallback_hint(value) → InputRequired | null
export function discoverInputFallbackHint(v) {
  for (const key of ['error', 'message', 'detail']) {
    const m = mget(v, key);
    if (typeof m === 'string' && messageReportsMissingInput(m)) {
      return { fields: [], requiredAnyOf: [], message: m, method: null, needsDescriptionFallback: true };
    }
  }
  return null;
}

// upstream: contract.rs::message_reports_missing_input (private)
export function messageReportsMissingInput(message) {
  const normalized = asciiLower(trim(message).replace(/[!-/:-@[-`{-~]+$/, ''));
  if (['payment required', 'authentication required', 'authorization required'].some((x) => normalized.includes(x))) return false;
  if (['missing required parameter', 'required parameter missing', 'missing required input', 'required input missing',
    'missing required argument', 'required argument missing'].some((x) => normalized.includes(x))) return true;
  const words = splitWhitespace(normalized);
  return words.length === 3 && words[1] === 'is' && words[2] === 'required' && words[0] !== '' && /^[A-Za-z0-9_-]+$/.test(words[0]);
}

// upstream: contract.rs::parse_fields(value) → FieldConstraint[]
export function parseFields(v) {
  if (Array.isArray(v)) return v.map(parseField).filter((f) => f !== null);
  if (isObj(v)) return Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((name) => fieldFromSchema(name, v[name]));
  return [];
}

// upstream: contract.rs::parse_field(value) → FieldConstraint | null
export function parseField(v) {
  if (typeof v === 'string') return fieldFromSchema(v, null);
  const name = mget(v, 'name');
  return typeof name === 'string' ? fieldFromSchema(name, v) : null;
}

// upstream: contract.rs::field_from_schema(name, schema)
export function fieldFromSchema(name, schema) {
  const t = mget(schema, 'type'), r = mget(schema, 'required'), c = mget(schema, 'carrier'), d = mget(schema, 'description');
  return {
    name, type: typeof t === 'string' ? t : 'string', required: typeof r === 'boolean' ? r : true,
    carrier: typeof c === 'string' ? c : null, description: typeof d === 'string' ? d : null,
  };
}

// upstream: contract.rs::string_array(value) → string[]
export const stringArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// upstream: contract.rs::validate_typed_params(params, plan); throws ContractError
export function validateTypedParams(params, plan) {
  for (const field of plan) {
    if (!isSupportedParamType(field.type)) {
      throw new ContractError('invalid_a2mcp_routing', `requestSpec field \`${field.name}\` has unsupported type \`${field.type}\``);
    }
    if (!hasOwn(params, field.name)) continue;
    if (!typedValueMatches(params[field.name], field.type)) {
      throw new ContractError('invalid_a2mcp_param_value', `parameter \`${field.name}\` must be ${field.type}`);
    }
  }
}

// upstream: contract.rs::is_supported_param_type
export const isSupportedParamType = (t) => ['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(t);

// upstream: contract.rs::typed_value_matches(value, expected)
export function typedValueMatches(v, expected) {
  switch (expected) {
    case 'string': return typeof v === 'string';
    case 'number': return isNum(v);
    case 'integer': return asI64(v) !== undefined || asU64(v) !== undefined;
    case 'boolean': return typeof v === 'boolean';
    case 'object': return isObj(v);
    case 'array': return Array.isArray(v);
    default: return false;
  }
}

// upstream: contract.rs::scalar_string(value) → string | undefined
export function scalarString(v) {
  if (typeof v === 'string') return v;
  if (isNum(v)) return numText(v);
  return undefined;
}
