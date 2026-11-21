// @ts-check

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

describe('package exports map', () => {
    it('exposes the tools layer via merci-sdk/tools', async () => {
        const tools = await import('merci-sdk/tools');
        for (const symbol of ['executeTools', 'extractXmlToolCalls', 'createShellTool',
            'loadSkillsFromDirectory', 'McpClient', 'loadMcpTools', 'loadA2ATool', 'createContextTools']) {
            assert.ok(symbol in tools, `merci-sdk/tools must export ${symbol}`);
        }
    });

    it('exposes the planning layer via merci-sdk/planning', async () => {
        const planning = await import('merci-sdk/planning');
        for (const symbol of ['WorkflowPlanner', 'WorkflowExecutor', 'WorkflowEvaluator',
            'ApprovalCoordinator', 'sortDagNodes', 'interpolateTemplate', 'getLeafOutput']) {
            assert.ok(symbol in planning, `merci-sdk/planning must export ${symbol}`);
        }
    });

    it('exposes the messaging layer via merci-sdk/messaging', async () => {
        const messaging = await import('merci-sdk/messaging');
        for (const symbol of ['normalizeToOAI', 'normalizeToAAI', 'normalizeToGAI',
            'createUserMessage', 'createSystemMessage', 'createToolCallMessage',
            'createToolResultMessage', 'countConversationTurns', 'stripInjectionMeta']) {
            assert.ok(symbol in messaging, `merci-sdk/messaging must export ${symbol}`);
        }
    });

    it('exposes the workspace layer via merci-sdk/workspace', async () => {
        const workspace = await import('merci-sdk/workspace');
        const names = ['WorkspaceManager', 'createWorkspaceTools', 'workspaceKeyFor',
            'resolveWorkspacePath', 'isInsideRoot', 'WORKSPACE_STRATEGIES', 'WORKSPACE_HOOKS'];
        for (const symbol of names) {
            assert.ok(symbol in workspace, `merci-sdk/workspace must export ${symbol}`);
        }
        assert.deepEqual(Object.keys(workspace).sort(), [...names].sort());
    });

    it('exposes the scheduler layer via merci-sdk/scheduler', async () => {
        await assert.doesNotReject(() => import('merci-sdk/scheduler'));
        const scheduler = await import('merci-sdk/scheduler');
        const names = ['WorkScheduler', 'createEngineRunner', 'normalizeWorkItem', 'sortForDispatch',
            'createMemoryWorkSource', 'createJsonFileWorkSource', 'createFunctionWorkSource',
            'createTodoWorkSource',
            'createMemoryClaimStore', 'createFileClaimStore', 'createMemoryAttemptStore',
            'createFileAttemptStore', 'CLAIM_STATES', 'WORK_SOURCE_CATEGORIES', 'SCHEDULER_DEFAULTS'];
        for (const symbol of names) {
            assert.ok(symbol in scheduler, `merci-sdk/scheduler must export ${symbol}`);
        }
        assert.deepEqual(Object.keys(scheduler).sort(), [...names].sort());
    });

    it('exposes the operator API via merci-sdk/operator', async () => {
        await assert.doesNotReject(() => import('merci-sdk/operator'));
        const operator = await import('merci-sdk/operator');
        const names = ['createOperatorHttpHandler', 'createEventRing', 'formatStatus',
            'OPERATOR_API_VERSION', 'OPERATOR_DEFAULTS', 'DEFAULT_PREFIXES'];
        for (const symbol of names) {
            assert.ok(symbol in operator, `merci-sdk/operator must export ${symbol}`);
        }
        assert.deepEqual(Object.keys(operator).sort(), [...names].sort());
    });

    it('exposes the workflow policy via merci-sdk/workflow-policy', async () => {
        await assert.doesNotReject(() => import('merci-sdk/workflow-policy'));
        const workflowPolicy = await import('merci-sdk/workflow-policy');
        const names = ['WorkflowPolicy', 'loadWorkflowFile', 'parseWorkflowMarkdown',
            'resolveWorkflowConfig', 'renderPromptTemplate', 'createPolicyRenderer',
            'policyToSchedulerOptions', 'policyToWorkspaceOptions',
            'WORKFLOW_POLICY_DEFAULTS', 'WORKFLOW_POLICY_REASONS', 'WORKFLOW_POLICY_WARNINGS'];
        for (const symbol of names) {
            assert.ok(symbol in workflowPolicy, `merci-sdk/workflow-policy must export ${symbol}`);
        }
        assert.deepEqual(Object.keys(workflowPolicy).sort(), [...names].sort());
    });

    it('exposes the orchestration composition root via merci-sdk/orchestration', async () => {
        await assert.doesNotReject(() => import('merci-sdk/orchestration'));
        const orchestration = await import('merci-sdk/orchestration');
        const names = ['createOrchestration'];
        for (const symbol of names) {
            assert.ok(symbol in orchestration, `merci-sdk/orchestration must export ${symbol}`);
        }
        assert.deepEqual(Object.keys(orchestration).sort(), [...names].sort());
    });

    it('keeps the legacy backend subpaths intact', async () => {
        for (const sub of ['oai', 'jai', 'gai', 'aai', 'json']) {
            await assert.doesNotReject(() => import(`merci-sdk/${sub}`));
        }
    });
});

describe('main entry surface hygiene', () => {
    it('no longer exports dead re-exports', async () => {
        const sdk = await import('merci-sdk');
        for (const symbol of ['sdkLog', 'sdkWarn', 'CommandDispatcher', 'createPlanExitTool',
            'SchemaError', 'PLAN_MODE_REMINDER', 'BUILD_SWITCH_REMINDER']) {
            assert.ok(!(symbol in sdk), `merci-sdk main entry must not export ${symbol}`);
        }
    });

    it('still exports the documented public API', async () => {
        const sdk = await import('merci-sdk');
        for (const symbol of ['resolveProvider', 'initializeClient', 'getDefaultModel', 'getEmbeddingModel', 'getEmbeddingDimensions', 'ProviderType',
            'createContextTools', 'SkillsLibrary', 'DiscussionSession', 'StateMachine',
            'AgentLauncher', 'normalizeHistory', 'countConversationTurns', 'AbortedError',
            'ConfigurationError', 'runStep', 'ExecutionJournal']) {
            assert.ok(symbol in sdk, `merci-sdk main entry must export ${symbol}`);
        }
    });

    it('exports the workspace surface and its error', async () => {
        const sdk = await import('merci-sdk');
        for (const symbol of ['WorkspaceManager', 'createWorkspaceTools', 'workspaceKeyFor',
            'resolveWorkspacePath', 'isInsideRoot', 'WORKSPACE_STRATEGIES', 'WORKSPACE_HOOKS',
            'WorkspaceError']) {
            assert.ok(symbol in sdk, `merci-sdk main entry must export ${symbol}`);
        }
    });

    it('exports the scheduler error types', async () => {
        const sdk = await import('merci-sdk');
        for (const symbol of ['WorkSourceError', 'SchedulerError']) {
            assert.ok(symbol in sdk, `merci-sdk main entry must export ${symbol}`);
        }
    });

    it('exports the coordination classes of all four subpaths from the main entry', async () => {
        const sdk = await import('merci-sdk');
        // One rule for the layer: a coordination subpath's primary classes are
        // reachable from the main entry, beside `MemoryManager` and
        // `StateMachine`. Constants and defaults stay on the subpaths only.
        for (const symbol of [
            'WorkspaceManager', 'createWorkspaceTools',
            'WorkScheduler', 'createEngineRunner',
            'WorkflowPolicy', 'policyToSchedulerOptions', 'policyToWorkspaceOptions', 'createPolicyRenderer',
            'createOperatorHttpHandler', 'createEventRing', 'formatStatus',
            'createOrchestration'
        ]) {
            assert.ok(symbol in sdk, `merci-sdk main entry must export ${symbol}`);
        }
        for (const symbol of ['SCHEDULER_DEFAULTS', 'CLAIM_STATES', 'WORK_SOURCE_CATEGORIES',
            'WORKFLOW_POLICY_DEFAULTS', 'OPERATOR_API_VERSION', 'OPERATOR_DEFAULTS', 'DEFAULT_PREFIXES']) {
            assert.equal(symbol in sdk, false, `merci-sdk main entry must not export ${symbol}`);
        }
    });

    it('exports the workflow policy error', async () => {
        const sdk = await import('merci-sdk');
        assert.ok('PolicyError' in sdk, 'merci-sdk main entry must export PolicyError');
        const err = new sdk.PolicyError({ message: 'x', options: { reason: 'stopped' } });
        assert.equal(err.code, 'MERCI-WORKFLOW-POLICY-ERR');
        assert.deepEqual(err.reasons, ['stopped']);
    });

    it('exports the operator handler and its helpers', async () => {
        const sdk = await import('merci-sdk');
        for (const symbol of ['createOperatorHttpHandler', 'createEventRing', 'formatStatus']) {
            assert.ok(symbol in sdk, `merci-sdk main entry must export ${symbol}`);
        }
        // The constants stay on the subpath (AC11); the main entry has no
        // second, drifting copy of the defaults.
        for (const symbol of ['OPERATOR_API_VERSION', 'OPERATOR_DEFAULTS', 'DEFAULT_PREFIXES']) {
            assert.ok(!(symbol in sdk), `merci-sdk main entry must not export ${symbol}`);
        }
    });
});
