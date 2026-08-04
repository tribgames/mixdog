// Grok's gRPC tool registry rejects a root anyOf/oneOf when even one branch
// is not an object. Tool definitions are never mutated.

function schemasDeepEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => schemasDeepEqual(value, right[index]));
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index]
            && schemasDeepEqual(left[key], right[key]));
}

function pureAnyOfAlternatives(schema) {
    return schema && typeof schema === 'object' && !Array.isArray(schema)
        && Object.keys(schema).length === 1
        && Array.isArray(schema.anyOf)
        ? schema.anyOf
        : [schema];
}

function mergeObjectBranchProperties(objectBranches) {
    const properties = {};
    for (const branch of objectBranches) {
        for (const [name, schema] of Object.entries(branch.properties || {})) {
            if (!Object.prototype.hasOwnProperty.call(properties, name)) {
                properties[name] = schema;
                continue;
            }
            if (schemasDeepEqual(properties[name], schema)) continue;
            const alternatives = [
                ...pureAnyOfAlternatives(properties[name]),
                ...pureAnyOfAlternatives(schema),
            ];
            const deduped = alternatives.reduce(
                (unique, alternative) => unique.some(item => schemasDeepEqual(item, alternative))
                    ? unique
                    : [...unique, alternative],
                [],
            );
            properties[name] = deduped.length === 1 ? deduped[0] : { anyOf: deduped };
        }
    }
    return properties;
}

function normalizeGrokToolSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)
        || (!Array.isArray(schema.anyOf) && !Array.isArray(schema.oneOf))) {
        return schema;
    }

    const { anyOf, oneOf, ...root } = schema;
    const branches = [...(Array.isArray(anyOf) ? anyOf : []), ...(Array.isArray(oneOf) ? oneOf : [])];
    const objectBranches = branches.filter((branch) => branch && typeof branch === 'object' && !Array.isArray(branch)
        && (branch.type === 'object'
            || (Array.isArray(branch.type) && branch.type.includes('object'))
            || (branch.properties && typeof branch.properties === 'object')));

    if (!objectBranches.length) {
        return {
            ...root,
            type: 'object',
            ...(!Object.prototype.hasOwnProperty.call(root, 'additionalProperties')
                ? { additionalProperties: true }
                : {}),
        };
    }

    const properties = objectBranches.some(branch => branch.properties) || root.properties
        ? {
            ...mergeObjectBranchProperties(objectBranches),
            ...(root.properties || {}),
        }
        : undefined;
    const branchRequiredInEvery = (Array.isArray(objectBranches[0].required) ? objectBranches[0].required : [])
        .filter(key => objectBranches.every(branch => Array.isArray(branch.required) && branch.required.includes(key)));
    const required = [...new Set([
        ...(Array.isArray(root.required) ? root.required : []),
        ...branchRequiredInEvery,
    ])];
    const { properties: _rootProperties, required: _rootRequired, ...rootWithoutPropertiesOrRequired } = root;
    const mergedObjectBranches = Object.assign({}, ...objectBranches);
    const {
        properties: _branchProperties,
        required: _branchRequired,
        ...mergedObjectBranchesWithoutPropertiesOrRequired
    } = mergedObjectBranches;
    return {
        ...mergedObjectBranchesWithoutPropertiesOrRequired,
        ...rootWithoutPropertiesOrRequired,
        type: 'object',
        ...(properties ? { properties } : {}),
        ...(required.length ? { required } : {}),
    };
}

export function normalizeGrokToolSchemas(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools.map((tool) => {
        const inputSchema = normalizeGrokToolSchema(tool?.inputSchema);
        return inputSchema === tool?.inputSchema ? tool : { ...tool, inputSchema };
    });
}
