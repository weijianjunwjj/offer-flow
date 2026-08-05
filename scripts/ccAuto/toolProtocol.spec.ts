/** toolProtocol.spec.ts —— DeepSeek 工具协议解析与校验测试 */
import { describe, it, expect } from 'vitest';
import { parseToolCalls, DEEPSEEK_FILE_TOOL_DEFINITIONS } from './toolProtocol';
import type { ModelToolCall } from './types';

// ============================================================================
// Fixtures
// ============================================================================

function makeToolCall(overrides: Partial<ModelToolCall> = {}): ModelToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: {
      name: 'read_file',
      arguments: JSON.stringify({ path: 'src/foo.ts' }),
    },
    ...overrides,
  } as ModelToolCall;
}

// ============================================================================
// 1. Five legal tools
// ============================================================================
describe('parseToolCalls — valid tools', () => {
  it('parses read_file', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/foo.ts' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed[0].name).toBe('read_file');
      expect(result.parsed[0].id).toBe('call_1');
    }
  });

  it('parses grep', () => {
    const tc = makeToolCall({
      function: { name: 'grep', arguments: JSON.stringify({ query: 'search term' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed[0].name).toBe('grep');
  });

  it('parses glob', () => {
    const tc = makeToolCall({
      function: { name: 'glob', arguments: JSON.stringify({ pattern: 'src/**/*.ts' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed[0].name).toBe('glob');
  });

  // 2. unknown tool
  it('rejects unknown tool name', () => {
    const tc = makeToolCall({
      function: { name: 'unknown_tool', arguments: '{}' },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('UNKNOWN_TOOL');
      expect(result.message).toContain('unknown_tool');
    }
  });

  // 3. missing tool call id
  it('rejects missing id', () => {
    const tc = { type: 'function', function: { name: 'read_file', arguments: '{}' } };
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TOOL_CALL_ID_MISSING');
  });

  // 4. duplicate tool call id
  it('rejects duplicate tool call id', () => {
    const tc1 = makeToolCall({ id: 'dup_id' });
    const tc2 = makeToolCall({ id: 'dup_id' });
    const result = parseToolCalls([tc1, tc2]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('DUPLICATE_TOOL_CALL_ID');
  });

  // 5. non-function type
  it('rejects non-function type', () => {
    const tc = { id: 'call_1', type: 'file', function: { name: 'read_file', arguments: '{}' } };
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_TOOL_CALL');
  });

  // 6. arguments not valid JSON
  it('rejects non-JSON arguments', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: 'not json' },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENTS_INVALID_JSON');
  });

  // 7. arguments is an array
  it('rejects arguments that parse to an array', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify([1, 2, 3]) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENTS_NOT_OBJECT');
  });

  // 8. arguments is null
  it('rejects arguments that parse to null', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: 'null' },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENTS_NOT_OBJECT');
  });

  // 9. unknown fields
  it('rejects unknown fields', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/foo.ts', unknownExtraField: 42 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_FIELD_UNKNOWN');
  });

  // 10. missing required field
  it('rejects missing required field', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({}) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The new protocol has path validation: missing path is requiredString check
      expect(['ARGUMENT_FIELD_MISSING', 'ARGUMENT_TYPE_INVALID']).toContain(result.reason);
    }
  });

  // 11. wrong field type
  it('rejects wrong field type', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 123 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Path is required and must be string
      expect(['ARGUMENT_FIELD_MISSING', 'ARGUMENT_TYPE_INVALID']).toContain(result.reason);
    }
  });

  // 12. arguments too large
  it('rejects oversized arguments', () => {
    const tc2 = makeToolCall({
      function: {
        name: 'read_file',
        arguments: 'x'.repeat(65_000),
      },
    });
    const result = parseToolCalls([tc2]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENTS_TOO_LARGE');
  });

  // 13. tool name too long
  it('rejects excessively long tool name', () => {
    const tc = makeToolCall({
      function: { name: 'x'.repeat(200), arguments: '{}' },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNKNOWN_TOOL');
  });

  // 14. id too long
  it('rejects excessively long tool call id', () => {
    const tc = makeToolCall({
      id: 'x'.repeat(300),
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_TOOL_CALL');
  });

  // 15. error message does not contain full raw arguments
  it('error message does not contain full raw arguments', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/secret-very-long-path-that-might-leak-info.ts' }) },
    });
    // valid — should parse
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(true);

    // Test with invalid args: the spec says error messages must not contain
    // the COMPLETE raw arguments JSON string — field names and tool names may appear
    // as part of error context but the sensitive argument VALUES must not leak.
    const tc2 = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/foo.ts', extraUnknown: 'SENSITIVE_VAL_12345' }) },
    });
    const result2 = parseToolCalls([tc2]);
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      // The sensitive VALUE must not appear in the error message
      expect(result2.message).not.toContain('SENSITIVE_VAL_12345');
      // Unknown field detection is correct
      expect(result2.reason).toBe('ARGUMENT_FIELD_UNKNOWN');
    }
  });
});

// ============================================================================
// Multiple tool calls
// ============================================================================
describe('parseToolCalls — multiple calls', () => {
  it('parses multiple valid tool calls', () => {
    const tc1 = makeToolCall({
      id: 'call_1',
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) },
    });
    const tc2 = makeToolCall({
      id: 'call_2',
      function: { name: 'grep', arguments: JSON.stringify({ query: 'foo' }) },
    });
    const result = parseToolCalls([tc1, tc2]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed).toHaveLength(2);
  });

  it('rejects empty array', () => {
    const result = parseToolCalls([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_TOOL_CALL');
  });

  it('rejects non-array input', () => {
    const result = parseToolCalls('ordinary text containing {"function":"read_file"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_TOOL_CALL');
  });
});

// ============================================================================
// Additional read_file validation
// ============================================================================
describe('parseToolCalls — read_file specifics', () => {
  it('accepts valid startLine and endLine', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/foo.ts', startLine: 10, endLine: 50 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(true);
    if (result.ok && result.parsed[0].name === 'read_file') {
      expect(result.parsed[0].arguments.startLine).toBe(10);
      expect(result.parsed[0].arguments.endLine).toBe(50);
    }
  });

  it('rejects startLine=0 (not positive integer)', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/foo.ts', startLine: 0 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_VALUE_INVALID');
  });

  it('rejects startLine that is not integer', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/foo.ts', startLine: 1.5 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_TYPE_INVALID');
  });

  it('rejects endLine < startLine', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/foo.ts', startLine: 50, endLine: 10 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_VALUE_INVALID');
  });

  it('does not convert string startLine to number', () => {
    const tc = makeToolCall({
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/foo.ts', startLine: '10' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_TYPE_INVALID'); // "startLine" as string is wrong type
  });
});

// ============================================================================
// Additional grep validation
// ============================================================================
describe('parseToolCalls — grep specifics', () => {
  it('accepts basic grep', () => {
    const tc = makeToolCall({
      function: { name: 'grep', arguments: JSON.stringify({ query: 'TODO' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(true);
  });

  it('accepts grep with all options', () => {
    const tc = makeToolCall({
      function: { name: 'grep', arguments: JSON.stringify({ query: 'TODO', roots: ['src'], caseSensitive: true, maxResults: 100 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(true);
  });

  it('rejects empty query', () => {
    const tc = makeToolCall({
      function: { name: 'grep', arguments: JSON.stringify({ query: '' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_VALUE_INVALID');
  });

  it('rejects maxResults below 1', () => {
    const tc = makeToolCall({
      function: { name: 'grep', arguments: JSON.stringify({ query: 'test', maxResults: 0 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_VALUE_INVALID');
  });

  it('rejects maxResults above 200', () => {
    const tc = makeToolCall({
      function: { name: 'grep', arguments: JSON.stringify({ query: 'test', maxResults: 201 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_VALUE_INVALID');
  });

  it('rejects non-string entries in roots', () => {
    const tc = makeToolCall({
      function: { name: 'grep', arguments: JSON.stringify({ query: 'test', roots: [123] }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_TYPE_INVALID');
  });

  it('rejects caseSensitive that is not boolean', () => {
    const tc = makeToolCall({
      function: { name: 'grep', arguments: JSON.stringify({ query: 'test', caseSensitive: 'true' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_TYPE_INVALID');
  });
});

// ============================================================================
// Additional glob validation
// ============================================================================
describe('parseToolCalls — glob specifics', () => {
  it('accepts basic glob', () => {
    const tc = makeToolCall({
      function: { name: 'glob', arguments: JSON.stringify({ pattern: 'src/**/*.ts' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(true);
  });

  it('rejects empty pattern', () => {
    const tc = makeToolCall({
      function: { name: 'glob', arguments: JSON.stringify({ pattern: '' }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_VALUE_INVALID');
  });

  it('rejects maxResults above 500', () => {
    const tc = makeToolCall({
      function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.ts', maxResults: 501 }) },
    });
    const result = parseToolCalls([tc]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ARGUMENT_VALUE_INVALID');
  });
});

// ============================================================================
// Tool definitions
// ============================================================================
describe('DEEPSEEK_FILE_TOOL_DEFINITIONS', () => {
  it('has exactly the three read-only tool definitions', () => {
    expect(DEEPSEEK_FILE_TOOL_DEFINITIONS).toHaveLength(3);
  });

  const expectedNames = ['read_file', 'grep', 'glob'];
  for (const name of expectedNames) {
    it(`includes ${name}`, () => {
      const def = DEEPSEEK_FILE_TOOL_DEFINITIONS.find(d => d.function.name === name);
      expect(def).toBeDefined();
      expect(def!.type).toBe('function');
      expect(def!.function.parameters.additionalProperties).toBe(false);
    });
  }

  it('no duplicate names', () => {
    const names = DEEPSEEK_FILE_TOOL_DEFINITIONS.map(d => d.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
