import assert from 'node:assert/strict';
import test from 'node:test';
import {
    executeInternalTool,
    setInternalToolsProvider,
} from '../internal-tools.mjs';
import { normalizeToolEnvelope } from './tool-envelope.mjs';

test('structured internal-tool failures retain media and explicit failure metadata', async () => {
    const structured = {
        content: [
            { type: 'text', text: '{"ok":false,"action":"act"}' },
            {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
            },
        ],
        isError: true,
    };
    setInternalToolsProvider({
        tools: [{ name: 'computer' }],
        executor: async () => structured,
    });
    try {
        const normalized = normalizeToolEnvelope(
            await executeInternalTool('computer', {}),
        );
        assert.equal(normalized.explicitFailure, true);
        assert.equal(normalized.explicitSuccess, false);
        assert.equal(normalized.result, structured);
        assert.equal(normalized.result.content[1].type, 'image');
    } finally {
        setInternalToolsProvider({ tools: [], executor: async () => '' });
    }
});
