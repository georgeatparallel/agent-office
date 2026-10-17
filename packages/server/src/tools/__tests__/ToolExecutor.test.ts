import { ToolExecutor } from '../ToolExecutor';
import { OfficeRoom } from '../../rooms/OfficeRoom';
import { Agent } from '@agent-office/core';
import { OfficeState } from '../../schema/OfficeState';

const mockTavilySearch = jest.fn();
jest.mock('@tavily/core', () => ({ tavily: () => ({ search: mockTavilySearch }) }));

const SOURCE = 'https://www.typescriptlang.org/docs/';
const SEARCH_TEXT = `${SOURCE}\nTypeScript documentation\ngenerics describe relationships between types.`;
const savedEnv = { ...process.env };
const originalFetch = global.fetch;
let requests: { url: string; init?: RequestInit; message?: any }[];
let toolResult: { content: { type: string; text: string }[]; isError?: boolean };
let hangMethod: string | undefined;
let badHttp: boolean;

function installMcpFixture() {
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const message = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, init, message });
        if (init?.method === 'GET') return new Response(null, { status: 405 });
        if (hangMethod && message?.method === hangMethod) {
            return new Promise<Response>((_, reject) => {
                const abort = () => reject(new DOMException('Aborted', 'AbortError'));
                init?.signal?.addEventListener('abort', abort, { once: true });
                if (init?.signal?.aborted) abort();
            });
        }
        if (badHttp) return new Response('Service unavailable', { status: 503 });
        if (message?.method === 'notifications/initialized') return new Response(null, { status: 202 });
        const result = message?.method === 'initialize'
            ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : message?.method === 'tools/list'
                ? { tools: [{ name: 'web_search', inputSchema: { type: 'object', properties: {} } }] }
                : toolResult;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }) as typeof fetch;
}

beforeEach(() => {
    process.env = { ...savedEnv };
    delete process.env.TAVILY_API_KEY;
    delete process.env.WEB_SEARCH_PROVIDER;
    delete process.env.PARALLEL_API_KEY;
    requests = [];
    toolResult = { content: [{ type: 'text', text: JSON.stringify({ search_id: 'fixture', results: [{ url: SOURCE, title: 'TypeScript documentation', excerpts: ['generics describe relationships between types.'] }] }) }] };
    hangMethod = undefined;
    badHttp = false;
    mockTavilySearch.mockReset().mockResolvedValue({ results: [{ title: 'Tavily', content: 'Configured search' }] });
    installMcpFixture();
});

afterEach(() => {
    process.env = savedEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
});

test('fresh no-key configuration keeps DuckDuckGo and configured credentials keep Tavily', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ Abstract: 'Keyless answer' })));
    expect(await new ToolExecutor().execute('web_search', { query: 'TypeScript' }))
        .toEqual({ success: true, output: 'Result: Keyless answer' });
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('https://api.duckduckgo.com/');
    process.env.TAVILY_API_KEY = 'saved-key';
    expect((await new ToolExecutor().execute('web_search', { query: 'TypeScript' })).output).toContain('Configured search');
    expect(mockTavilySearch).toHaveBeenCalledWith('TypeScript', { maxResults: 5 });
});

test('explicit Parallel selection uses real MCP transport, preserves URLs and a stable session', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'parallel';
    process.env.TAVILY_API_KEY = 'saved-key';
    const executor = new ToolExecutor();
    for (let i = 0; i < 2; i++) {
        expect(await executor.execute('web_search', { query: 'TypeScript generics guide' }))
            .toEqual({ success: true, output: SEARCH_TEXT });
    }
    const calls = requests.filter(r => r.message?.method === 'tools/call');
    expect(calls).toHaveLength(2);
    expect(calls[0].message.params).toMatchObject({
        name: 'web_search', arguments: { objective: 'TypeScript generics guide', search_queries: ['TypeScript generics guide'] }
    });
    expect(calls[0].message.params.arguments.session_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(calls[0].message.params.arguments.session_id).toBe(calls[1].message.params.arguments.session_id);
    expect(requests.some(r => r.message?.method === 'tools/list')).toBe(true);
    for (const request of requests) {
        expect(request.url).toBe('https://search.parallel.ai/mcp');
        const headers = new Headers(request.init?.headers);
        expect(headers.get('User-Agent')).toBe('AgentOffice/1.0.0 (https://github.com/harishkotra/agent-office)');
        expect(headers.has('Authorization')).toBe(false);
    }
    expect(mockTavilySearch).not.toHaveBeenCalled();
});

test('explicit DuckDuckGo overrides saved Tavily credentials', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'duckduckgo';
    process.env.TAVILY_API_KEY = 'saved-key';
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ Abstract: 'Explicit answer' })));
    expect((await new ToolExecutor().execute('web_search', { query: 'query' })).output).toBe('Result: Explicit answer');
    expect(mockTavilySearch).not.toHaveBeenCalled();
});

test.each(['none', 'unknown', 'tavily'])('selection %s blocks unavailable or disabled search without fallback', async provider => {
    process.env.WEB_SEARCH_PROVIDER = provider;
    expect((await new ToolExecutor().execute('web_search', { query: 'query' })).success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
});

test.each([undefined, '', '   ', 3])('rejects invalid query %s before network access', async query => {
    process.env.WEB_SEARCH_PROVIDER = 'parallel';
    expect((await new ToolExecutor().execute('web_search', { query })).success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
});

test('MCP tool errors retain a useful error and do not fall back to another provider', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'parallel';
    toolResult = { isError: true, content: [{ type: 'text', text: 'Search service rejected query' }] };
    const result = await new ToolExecutor().execute('web_search', { query: 'query' });
    expect(result).toEqual({ success: false, output: '', error: 'Parallel search failed: Search service rejected query' });
    expect(requests.every(r => r.url === 'https://search.parallel.ai/mcp')).toBe(true);
});

test('HTTP and malformed result failures are returned as tool errors', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'parallel';
    badHttp = true;
    expect((await new ToolExecutor().execute('web_search', { query: 'query' })).success).toBe(false);
    badHttp = false;
    toolResult = { content: [] };
    expect((await new ToolExecutor().execute('web_search', { query: 'query' })).error).toContain('returned no text');
});

test.each(['initialize', 'tools/call'])('the deadline aborts %s and returns an error', async method => {
    jest.useFakeTimers();
    process.env.WEB_SEARCH_PROVIDER = 'parallel';
    hangMethod = method;
    const pending = new ToolExecutor().execute('web_search', { query: 'query' });
    await jest.advanceTimersByTimeAsync(15000);
    expect((await pending).error).toContain('timed out after 15 seconds');
    expect(requests.find(r => r.message?.method === method)?.init?.signal?.aborted).toBe(true);
});

test.each(['initialize', 'tools/call'])('cancellation aborts %s and pre-cancelled calls make no requests', async method => {
    process.env.WEB_SEARCH_PROVIDER = 'parallel';
    hangMethod = method;
    const controller = new AbortController();
    const executor = new ToolExecutor();
    const pending = executor.execute('web_search', { query: 'query' }, { signal: controller.signal });
    for (let i = 0; i < 20 && !requests.some(r => r.message?.method === method); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    expect(requests.some(r => r.message?.method === method)).toBe(true);
    controller.abort();
    expect((await pending).error).toContain('cancelled');
    const count = requests.length;
    expect((await executor.execute('web_search', { query: 'query' }, { signal: controller.signal })).error).toContain('cancelled');
    expect(requests).toHaveLength(count);
});

test('the OfficeRoom caller dispatches a scripted model search and consumes its result in agent memory', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    process.env.WEB_SEARCH_PROVIDER = 'parallel';
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const agent = new Agent({
        id: 'test', name: 'Researcher', role: 'Researcher', avatar: '',
        inference: { provider: 'custom', model: 'scripted-fixture', systemPrompt: 'Research TypeScript.' },
        personality: { traits: { openness: 1, conscientiousness: 1, extraversion: 0, agreeableness: 1, neuroticism: 0 }, communicationStyle: 'technical', workHours: { start: '09:00', end: '17:00' }, breakFrequency: 120 },
        capabilities: [{ name: 'web_search', description: 'Search the web' }], memory: { shortTermLimit: 50 }
    });
    const complete = jest.fn().mockResolvedValue({ content: JSON.stringify({
        thought: 'Find a source', action: 'use_tool', toolCall: { name: 'web_search', params: { query: 'TypeScript generics guide' } }
    }) });
    agent.setInferenceAdapter({ provider: 'scripted-fixture', isLocal: true, complete });
    const state = new OfficeState();
    state.createAgent('test', 'Researcher');
    const room = Object.create(OfficeRoom.prototype);
    Object.assign(room, {
        state, coreAgents: new Map([['test', agent]]), thinkingLocks: new Map(),
        toolExecutor: new ToolExecutor(), demoTickCount: 0, highlights: [],
        broadcast: jest.fn(), currentScenario: 'Test', sessionId: 'fixture'
    });
    await room.update(0);
    for (let i = 0; i < 20 && !agent.memories.some(m => m.type === 'task_result'); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    expect(complete).toHaveBeenCalled();
    expect(agent.getRecentMemories().join('\n')).toContain(SOURCE);
    expect(agent.getRecentMemories().join('\n')).toContain('generics describe relationships');
    expect(room.broadcast).toHaveBeenCalledWith('chat', expect.objectContaining({ text: expect.stringContaining('Used tool [web_search]') }));
    jest.clearAllTimers();
});
