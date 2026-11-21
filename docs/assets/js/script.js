/* assets/js/script.js */

(function() {
    'use strict';

    // --- Theme Toggle Functionality with Persistence ---
    const htmlEl = document.documentElement;
    const themeToggleButtons = document.querySelectorAll('.theme-toggle-btn');
    const themeToggleText = document.querySelectorAll('.theme-toggle-text');

    const applyTheme = (theme) => {
        if (theme === 'dark') {
            htmlEl.classList.add('dark');
            themeToggleText.forEach(el => el.textContent = 'Light Mode');
        } else {
            htmlEl.classList.remove('dark');
            themeToggleText.forEach(el => el.textContent = 'Dark Mode');
        }
    };

    const toggleTheme = () => {
        const currentTheme = htmlEl.classList.contains('dark') ? 'light' : 'dark';
        localStorage.setItem('theme', currentTheme);
        applyTheme(currentTheme);
    };

    themeToggleButtons.forEach(btn => {
        btn.addEventListener('click', toggleTheme);
    });

    // Initialize theme on page load
    const savedTheme = localStorage.getItem('theme');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(savedTheme || (systemPrefersDark ? 'dark' : 'light'));


    // --- Mobile Menu Toggle Functionality ---
    const menuToggleBtn = document.getElementById('menu-toggle');
    const menuContent = document.getElementById('menu-content');

    if (menuToggleBtn && menuContent) {
        menuToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuContent.classList.toggle('hidden');
        });
    }

    // --- Universal Code Syntax Highlighter ---
    const escapeHtml = (text) => {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    };

    const highlightSyntax = (rawCode) => {
        if (!rawCode) return '';
        const trimmed = rawCode.trim();

        // Check if shell / CLI command snippet
        const isBash = /^(npm|pnpm|npx|yarn|node|git|curl|export|cd|mkdir|cat|echo|brew)\s|^(#!\/bin\/bash)/m.test(trimmed) &&
                       !trimmed.includes('import ') &&
                       !trimmed.includes('const ') &&
                       !trimmed.includes('function ') &&
                       !trimmed.includes('class ');

        if (isBash) {
            const bashRegex = /(#[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|(\b(?:node|npm|pnpm|npx|yarn|bun|git|curl|export|cd|mkdir|cat|echo|brew)\b)|(--?[a-zA-Z0-9_\-]+)|([A-Z0-9_]+=[^\s]+)|(\$[A-Z0-9_]+)/g;
            return rawCode.replace(bashRegex, (match, comment, str, cmd, flag, envAssign, envVar) => {
                if (comment) return '<span style="color: #8b949e;">' + escapeHtml(comment) + '</span>';
                if (str) return '<span style="color: #a5d6ff;">' + escapeHtml(str) + '</span>';
                if (cmd) return '<span style="color: #ff7b72; font-weight: 600;">' + escapeHtml(cmd) + '</span>';
                if (flag) return '<span style="color: #ffa657;">' + escapeHtml(flag) + '</span>';
                if (envAssign) return '<span style="color: #79c0ff;">' + escapeHtml(envAssign) + '</span>';
                if (envVar) return '<span style="color: #d2a8ff;">' + escapeHtml(envVar) + '</span>';
                return escapeHtml(match);
            });
        }

        // JavaScript / TypeScript / JSON / ESM
        const jsRegex = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[\s\S]*?`)|(\b(?:import|export|from|as|default|const|let|var|function|class|extends|new|await|async|return|if|else|try|catch|finally|throw|for|while|do|switch|case|break|continue|typeof|instanceof|yield|of|in|this|super|static)\b)|(\b(?:true|false|null|undefined|NaN|Infinity|ProviderType|Promise|Set|Map|Array|Object|String|Number|Boolean|Error|MerciError|BackendError|ChatSessionBuilder)\b)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\())|(\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*:))|([a-zA-Z_$][a-zA-Z0-9_$]*)/g;

        return rawCode.replace(jsRegex, (match, comment, str, keyword, typeOrBool, num, fn, prop, ident) => {
            if (comment) return '<span style="color: #8b949e;">' + escapeHtml(comment) + '</span>';
            if (str) return '<span style="color: #a5d6ff;">' + escapeHtml(str) + '</span>';
            if (keyword) return '<span style="color: #ff7b72;">' + escapeHtml(keyword) + '</span>';
            if (typeOrBool) return '<span style="color: #79c0ff;">' + escapeHtml(typeOrBool) + '</span>';
            if (num) return '<span style="color: #79c0ff;">' + escapeHtml(num) + '</span>';
            if (fn) return '<span style="color: #d2a8ff;">' + escapeHtml(fn) + '</span>';
            if (prop) return '<span style="color: #7ee787;">' + escapeHtml(prop) + '</span>';
            if (ident && /^[A-Z][A-Z0-9_]+$/.test(ident)) return '<span style="color: #ffa657;">' + escapeHtml(ident) + '</span>';
            return escapeHtml(match);
        });
    };

    const applyUniversalSyntaxHighlighting = () => {
        const codeElements = document.querySelectorAll('.code-block pre code, .code-block code');
        codeElements.forEach(codeEl => {
            if (codeEl.dataset.highlighted === 'true') return;
            const rawText = codeEl.textContent;
            if (!rawText || !rawText.trim()) return;
            codeEl.innerHTML = highlightSyntax(rawText);
            codeEl.dataset.highlighted = 'true';
        });
    };

    applyUniversalSyntaxHighlighting();

    // --- Copy Code Button Functionality ---
    const attachCopyListeners = () => {
        const allCopyButtons = document.querySelectorAll('.copy-code-btn');
        allCopyButtons.forEach(btn => {
            if (btn.dataset.copyBound) return;
            btn.dataset.copyBound = 'true';
            btn.addEventListener('click', (e) => {
                const wrapper = e.currentTarget.closest('.code-block-wrapper') || e.currentTarget.parentElement;
                const codeBlock = wrapper.querySelector('code');
                if (!codeBlock) return;

                navigator.clipboard.writeText(codeBlock.textContent).then(() => {
                    const originalContent = e.currentTarget.innerHTML;
                    e.currentTarget.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="text-green-400" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>
                        <span class="text-green-400 font-medium">Copied!</span>`;
                    setTimeout(() => {
                        e.currentTarget.innerHTML = originalContent;
                    }, 2000);
                }).catch(err => {
                    console.error('Failed to copy text: ', err);
                });
            });
        });
    };
    attachCopyListeners();

    // --- Tutorials Search & Filter Functionality ---
    const tutorialSearchInput = document.getElementById('tutorial-search');
    const filterButtons = document.querySelectorAll('.tutorial-filter-btn');
    const lessonCards = document.querySelectorAll('.lesson-card');
    const emptyState = document.getElementById('no-lessons-found');

    let currentFilter = 'all';
    let searchQuery = '';

    const filterLessons = () => {
        let visibleCount = 0;
        lessonCards.forEach(card => {
            const category = card.dataset.category || '';
            const title = (card.dataset.title || card.querySelector('h3')?.textContent || '').toLowerCase();
            const desc = (card.querySelector('p')?.textContent || '').toLowerCase();
            const tags = (card.dataset.tags || '').toLowerCase();

            const matchesFilter = (currentFilter === 'all') || (category === currentFilter);
            const query = searchQuery.toLowerCase().trim();
            const matchesQuery = !query || title.includes(query) || desc.includes(query) || tags.includes(query);

            if (matchesFilter && matchesQuery) {
                card.style.display = 'flex';
                visibleCount++;
            } else {
                card.style.display = 'none';
            }
        });

        if (emptyState) {
            emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
        }
    };

    if (tutorialSearchInput) {
        tutorialSearchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value;
            filterLessons();
        });
    }

    if (filterButtons.length > 0) {
        filterButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                filterButtons.forEach(b => {
                    b.classList.remove('active', 'bg-blue-600', 'text-white');
                    b.classList.add('bg-slate-100', 'dark:bg-slate-800', 'text-slate-700', 'dark:text-slate-300');
                });
                btn.classList.add('active', 'bg-blue-600', 'text-white');
                btn.classList.remove('bg-slate-100', 'dark:bg-slate-800', 'text-slate-700', 'dark:text-slate-300');
                currentFilter = btn.dataset.filter || 'all';
                filterLessons();
            });
        });
    }

    // --- Interactive SDK Code & Output Preview Engine ---
    const demoPlayground = document.getElementById('sdk-interactive-playground');
    if (demoPlayground) {
        const backendSelect = document.getElementById('demo-backend-select');
        const patternSelect = document.getElementById('demo-pattern-select');
        const runDemoBtn = document.getElementById('demo-run-btn');
        const terminalOutput = document.getElementById('demo-terminal-output');
        const codeOutput = document.getElementById('demo-code-output');
        const tokenBadge = document.getElementById('demo-tokens-badge');
        const latencyBadge = document.getElementById('demo-latency-badge');
        const statusBadge = document.getElementById('demo-status-badge');

        const scenarios = {
            quickstart: {
                title: 'Streaming Quickstart',
                code: (provider) => `import { createUserMessage, ProviderType, resolveProvider, initializeClient, loadCredentials, getDefaultModel } from 'merci-sdk';

const PROVIDER = ProviderType.${provider.toUpperCase()};
const { client } = await initializeClient({ provider: PROVIDER, options: loadCredentials({ provider: PROVIDER }) });
const session = client.session(getDefaultModel({ provider: PROVIDER }))
    .withSystemMessage('You are a helpful software architect.');

const stream = session.step({ messages: [
    createUserMessage({ provider: PROVIDER, content: 'Explain the advantages of minimal-dependency agentic architecture.' })
] });

for await (const event of stream) {
    if (event.type === 'text') process.stdout.write(event.content);
}`,
                simulate: async (provider, updateTerminal, onFinish) => {
                    updateTerminal('clear');
                    updateTerminal('system', `[INIT] Initialized provider: ${provider}`);
                    await sleep(200);
                    updateTerminal('wire', `[WIRE >>] POST /v1/chat/completions (messages=2, stream=true)`);
                    await sleep(300);
                    const tokens = [
                        'Minimal-dependency ', 'agentic ', 'architecture ', 'provides ', 'three ', 'critical ', 'benefits:\n\n',
                        '1. **Portability & Security:** Minimal runtime dependencies — official provider SDKs and validators, no orchestration framework.\n',
                        '2. **Deterministic Wire Behavior:** Stateless resend avoids server-side session lock-in.\n',
                        '3. **Instant Cold Start:** Pure ES Modules execute in sub-millisecond runtimes across Node, Bun, and edge environments.'
                    ];
                    for (const tok of tokens) {
                        updateTerminal('stream', tok);
                        await sleep(80);
                    }
                    await sleep(150);
                    updateTerminal('system', '\n[EVENT] Turn complete. Tokens: 42 prompt + 68 completion = 110 total');
                    onFinish(110, '340ms');
                }
            },
            tools: {
                title: 'Multi-Tool Execution & Thinking Budget',
                code: (provider) => `import { ProviderType, initializeClient, loadCredentials, getToolModel } from 'merci-sdk';
import { executeTools } from 'merci-sdk/tools';

const PROVIDER = ProviderType.${provider.toUpperCase()};
const { client } = await initializeClient({ provider: PROVIDER, options: loadCredentials({ provider: PROVIDER }) });

const weatherTool = {
    name: 'get_current_weather',
    description: 'Get real-time weather conditions for a city',
    parameters: {
        type: 'object',
        properties: { city: { type: 'string' }, units: { type: 'string', enum: ['metric', 'imperial'] } },
        required: ['city']
    },
    execute: async ({ city }) => ({ temperature: 21, condition: 'Sunny', wind_kph: 12, city })
};

const session = client.session(getToolModel({ provider: PROVIDER }))
    .withTools([weatherTool]);

// Automatic agentic loop with thought signature propagation
const result = await session.run('What is the weather in Prague and Tokyo right now?');
console.log(result);`,
                simulate: async (provider, updateTerminal, onFinish) => {
                    updateTerminal('clear');
                    updateTerminal('system', `[INIT] Tool orchestration initialized on ${provider}`);
                    await sleep(180);
                    updateTerminal('wire', `[WIRE >>] Tool definitions registered: [get_current_weather]`);
                    await sleep(250);
                    updateTerminal('event', `[THINKING] Model reasoning: "User asked for weather in two cities (Prague and Tokyo). Need parallel tool calls."`);
                    await sleep(350);
                    updateTerminal('event', `[TOOL_START] Invoking get_current_weather(city="Prague", units="metric")`);
                    updateTerminal('event', `[TOOL_START] Invoking get_current_weather(city="Tokyo", units="metric")`);
                    await sleep(300);
                    updateTerminal('event', `[TOOL_FINISH] Prague -> { temperature: 19°C, condition: "Partly Cloudy" }`);
                    updateTerminal('event', `[TOOL_FINISH] Tokyo -> { temperature: 24°C, condition: "Clear Skies" }`);
                    await sleep(250);
                    updateTerminal('stream', '\n**Current Weather Report:**\n- **Prague:** 19°C, Partly Cloudy with mild breeze.\n- **Tokyo:** 24°C, Clear Skies and pleasant conditions.');
                    await sleep(100);
                    updateTerminal('system', '\n[EVENT] Tool loop resolved in 2 turns. Tokens: 185 total');
                    onFinish(185, '520ms');
                }
            },
            dag: {
                title: 'DAG Self-Healing Workflow',
                code: (provider) => `import { ProviderType, initializeClient, loadCredentials, getDefaultModel } from 'merci-sdk';
import { WorkflowPlanner, WorkflowExecutor, WorkflowEvaluator } from 'merci-sdk/planning';

const PROVIDER = ProviderType.${provider.toUpperCase()};
const { client } = await initializeClient({ provider: PROVIDER, options: loadCredentials({ provider: PROVIDER }) });

const planner = new WorkflowPlanner(client, getDefaultModel(PROVIDER));
const plan = await planner.plan('Audit API endpoints, benchmark latencies, and output Markdown report.');

const executor = new WorkflowExecutor(client, getDefaultModel(PROVIDER))
    .withSelfHealing(true)
    .withMaxRetries(3);

const result = await executor.execute(plan);
console.log('Final Deliverable:', result.output);`,
                simulate: async (provider, updateTerminal, onFinish) => {
                    updateTerminal('clear');
                    updateTerminal('system', `[PLANNER] Generating DAG Plan for Objective: API Audit & Benchmark`);
                    await sleep(250);
                    updateTerminal('event', `[DAG] Generated 3 Nodes: [1: discovery] -> [2: benchmark] -> [3: report_synthesis]`);
                    await sleep(300);
                    updateTerminal('event', `[NODE 1/3] Executing 'discovery' ... OK (Found 12 endpoints)`);
                    await sleep(300);
                    updateTerminal('event', `[NODE 2/3] Executing 'benchmark' ... P95: 42ms, Error Rate: 0.0%`);
                    await sleep(350);
                    updateTerminal('event', `[NODE 3/3] Executing 'report_synthesis' ...`);
                    await sleep(200);
                    updateTerminal('stream', '\n## API Performance Audit Summary\n- Total Endpoints: 12\n- Health: 100% Operational\n- Average P95 Latency: 42ms (Grade: 3A)');
                    await sleep(100);
                    updateTerminal('system', '\n[DAG SUCCESS] Workflow completed. Zero replanning triggers required.');
                    onFinish(340, '890ms');
                }
            },
            memory: {
                title: 'Persistent Memory & Distillation',
                code: (provider) => `import { ProviderType, initializeClient, loadCredentials, getDefaultModel } from 'merci-sdk';
import { LocalFileMemoryProvider } from 'merci-sdk';

const PROVIDER = ProviderType.${provider.toUpperCase()};
const { client } = await initializeClient({ provider: PROVIDER, options: loadCredentials({ provider: PROVIDER }) });

const memory = new LocalFileMemoryProvider({
    filePath: './user_memory.json',
    preload: true,
    recencyFallback: true
});

const session = client.session(getDefaultModel({ provider: PROVIDER }))
    .withMemory(memory);

// Background distillation runs asynchronously without blocking user turns
await session.run('Remember that our production Kubernetes cluster is in region eu-central-1.');`,
                simulate: async (provider, updateTerminal, onFinish) => {
                    updateTerminal('clear');
                    updateTerminal('system', `[MEMORY] Preloading LocalFileMemoryProvider: ./user_memory.json (3 existing facts)`);
                    await sleep(200);
                    updateTerminal('event', `[MEMORY INJECT] Injected facts: [role=DevOpsLead, cloud=GCP, preferred_lang=TypeScript]`);
                    await sleep(300);
                    updateTerminal('wire', `[WIRE >>] Streaming assistant answer...`);
                    await sleep(200);
                    updateTerminal('stream', 'Understood! I have committed to memory that your production Kubernetes cluster operates in region `eu-central-1`.');
                    await sleep(300);
                    updateTerminal('event', `\n[DISTILLATION BACKGROUND] Fact extracted: "production_cluster_region: eu-central-1" -> Distilled to persistent storage.`);
                    onFinish(142, '410ms');
                }
            },
            discussion: {
                title: 'Multi-Agent Consensus & Debate',
                code: (provider) => `import { ProviderType, initializeClient, loadCredentials, getDefaultModel } from 'merci-sdk';
import { DiscussionSession } from 'merci-sdk';

const PROVIDER = ProviderType.${provider.toUpperCase()};
const { client } = await initializeClient({ provider: PROVIDER, options: loadCredentials({ provider: PROVIDER }) });

const swarm = new DiscussionSession(client, {
    model: getDefaultModel(PROVIDER),
    objective: 'Design a resilient rate-limiting policy for distributed GraphQL APIs',
    agents: [
        { name: 'Architect', perspective: 'Scalability & Token-Bucket Algorithm' },
        { name: 'SecurityEngineer', perspective: 'DDoS mitigation, IP rotation defense, and API-key quotas' },
        { name: 'Judge', perspective: 'Synthesize optimal hybrid architecture' }
    ],
    maxRounds: 2
});

await swarm.runDebate();
const verdict = await swarm.judge();
console.log('Consensus Verdict:', verdict);`,
                simulate: async (provider, updateTerminal, onFinish) => {
                    updateTerminal('clear');
                    updateTerminal('system', `[SWARM] Initialized 3 agents with shared objective.`);
                    await sleep(250);
                    updateTerminal('event', `[ROUND 1: Architect] "We should implement Redis-backed Distributed Token Bucket with Redis Cluster failover."`);
                    await sleep(350);
                    updateTerminal('event', `[ROUND 1: SecurityEngineer] "Agreed, but add Leaky Bucket smoothing on GraphQL query complexity cost calculation."`);
                    await sleep(300);
                    updateTerminal('event', `[ROUND 2: Consensus] "Architect & Security reach agreement on 2-tier sliding window + complexity budget."`);
                    await sleep(300);
                    updateTerminal('stream', '\n**Consensus Decision:**\nImplement hierarchical rate-limiting:\n1. Layer 1: Edge sliding-window IP filter (Cloudflare/Kong).\n2. Layer 2: Redis-backed query complexity scoring engine (GraphQL AST depth limit + token cost).');
                    await sleep(100);
                    updateTerminal('system', '\n[SWARM COMPLETE] Judge rendered final consensus verdict.');
                    onFinish(480, '1.12s');
                }
            }
        };

        const updateCodeDisplay = () => {
            const currentBackend = backendSelect ? backendSelect.value : 'openai';
            const currentPattern = patternSelect ? patternSelect.value : 'quickstart';
            const scenario = scenarios[currentPattern] || scenarios.quickstart;
            if (codeOutput) {
                codeOutput.innerHTML = highlightSyntax(scenario.code(currentBackend));
            }
        };

        const helperSleep = (ms) => new Promise(r => setTimeout(r, ms));
        const sleep = helperSleep;

        const updateTerminal = (type, text) => {
            if (!terminalOutput) return;
            if (type === 'clear') {
                terminalOutput.innerHTML = '';
                return;
            }

            const span = document.createElement('div');
            span.className = 'my-1 text-sm leading-relaxed';

            if (type === 'system') {
                span.className += ' text-blue-400 font-semibold';
                span.textContent = text;
            } else if (type === 'wire') {
                span.className += ' text-purple-400 font-mono text-xs';
                span.textContent = text;
            } else if (type === 'event') {
                span.className += ' text-amber-300 font-mono text-xs';
                span.textContent = text;
            } else if (type === 'stream') {
                span.className += ' text-emerald-300 whitespace-pre-wrap';
                span.textContent = text;
            }

            terminalOutput.appendChild(span);
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
        };

        if (backendSelect) backendSelect.addEventListener('change', updateCodeDisplay);
        if (patternSelect) patternSelect.addEventListener('change', updateCodeDisplay);

        if (runDemoBtn) {
            runDemoBtn.addEventListener('click', async () => {
                runDemoBtn.disabled = true;
                runDemoBtn.classList.add('opacity-50', 'cursor-not-allowed');
                if (statusBadge) {
                    statusBadge.textContent = 'Running';
                    statusBadge.className = 'tag-badge bg-amber-500/20 text-amber-300 border border-amber-500/30';
                }

                const currentBackend = backendSelect ? backendSelect.value : 'openai';
                const currentPattern = patternSelect ? patternSelect.value : 'quickstart';
                const scenario = scenarios[currentPattern] || scenarios.quickstart;

                await scenario.simulate(currentBackend, updateTerminal, (tokens, latency) => {
                    if (tokenBadge) tokenBadge.textContent = `${tokens} tokens`;
                    if (latencyBadge) latencyBadge.textContent = latency;
                    if (statusBadge) {
                        statusBadge.textContent = 'Ready';
                        statusBadge.className = 'tag-badge bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
                    }
                    runDemoBtn.disabled = false;
                    runDemoBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                });
            });
        }

        updateCodeDisplay();
    }

})();