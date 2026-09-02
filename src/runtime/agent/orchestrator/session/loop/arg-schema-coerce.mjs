// Models sometimes hand a tool its object, array, number, or boolean argument
// as the JSON text of that value ("design": "{...}", "maxWidth": "300"). The
// tool then reads a string where its contract promises a structure and silently
// misbehaves. When the declared schema has no room for a string, the text is
// parsed and kept only if the parsed value fits a declared type; anything else
// stays untouched so real string arguments and malformed text still reach the
// tool's own validation.
import { clean } from '../../../../../session-runtime/session-text.mjs';
import { deferredCatalogUnion } from '../../../../../session-runtime/tool-catalog.mjs';
import { getInternalTools } from '../../internal-tools.mjs';

const STRUCTURAL_TYPES = new Set(['object', 'array', 'number', 'integer', 'boolean', 'null']);

function declaredTypes(property, depth = 0) {
    const types = new Set();
    if (!property || typeof property !== 'object' || depth > 3) return types;
    const listed = Array.isArray(property.type) ? property.type : property.type ? [property.type] : [];
    for (const entry of listed) types.add(String(entry));
    for (const branches of [property.anyOf, property.oneOf, property.allOf]) {
        if (!Array.isArray(branches)) continue;
        for (const branch of branches) for (const type of declaredTypes(branch, depth + 1)) types.add(type);
    }
    if (!types.size && property.properties && typeof property.properties === 'object') types.add('object');
    if (!types.size && property.items) types.add('array');
    if (Array.isArray(property.enum) && property.enum.some((value) => typeof value === 'string')) types.add('string');
    return types;
}

function fitsType(value, types) {
    if (value === null) return types.has('null');
    if (Array.isArray(value)) return types.has('array');
    if (typeof value === 'object') return types.has('object');
    if (typeof value === 'boolean') return types.has('boolean');
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return false;
        return types.has('number') || (types.has('integer') && Number.isInteger(value));
    }
    return false;
}

function parseJsonText(text) {
    const trimmed = text.trim();
    if (!trimmed || !'{["0123456789-tfn'.includes(trimmed[0])) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
}

export function coerceArgsToSchema(args, schema) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const properties = schema?.properties;
    if (!properties || typeof properties !== 'object') return args;
    for (const [key, value] of Object.entries(args)) {
        if (typeof value !== 'string') continue;
        const property = properties[key];
        if (!property) continue;
        const types = declaredTypes(property);
        if (!types.size || types.has('string')) continue;
        if (![...types].some((type) => STRUCTURAL_TYPES.has(type))) continue;
        const parsed = parseJsonText(value);
        if (parsed === undefined || !fitsType(parsed, types)) continue;
        args[key] = parsed;
    }
    return args;
}

export function toolInputSchemaForSession(sessionRef, name) {
    const key = clean(name);
    if (!key) return null;
    // Built-in runtime tools such as office live in the internal registry,
    // not in the session catalog, so both pools are consulted.
    const pools = [
        Array.isArray(sessionRef?.tools) ? sessionRef.tools : [],
        sessionRef ? deferredCatalogUnion(sessionRef) : [],
        getInternalTools(),
    ];
    for (const pool of pools) {
        for (const tool of pool) {
            if (clean(tool?.name) !== key) continue;
            const schema = tool?.inputSchema || tool?.input_schema || tool?.parameters || null;
            if (schema && typeof schema === 'object') return schema;
        }
    }
    return null;
}

export function coerceToolArgsForSession(sessionRef, name, args) {
    const schema = toolInputSchemaForSession(sessionRef, name);
    return schema ? coerceArgsToSchema(args, schema) : args;
}
