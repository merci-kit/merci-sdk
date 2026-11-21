<!-- GENERATED FILE — do not edit by hand. Run `pnpm build:example-map` to regenerate. -->

# Merci SDK — Example → SDK symbol map

> 34 demo modules (numbered examples + server children), 350 public symbols. Generated from the current `examples/*.mjs` by `scripts/build-example-map.mjs`.
> Every example here is **live** (it needs a backend); deterministic, backend-free proofs are tests under `test/examples/`. Every example imports only public entry points.
> The map sees the **demonstrated** surface, not only the imports: the imported symbols plus the builder methods, the session methods, the parameter-builder methods and the methods of the SDK objects the example constructs.

## 1. Examples

| # | Example | Scenario | Mode | Public SDK symbols (imported or called) |
| --- | --- | --- | --- | --- |
| 01 | `01_quickstart.mjs` | Quickstart: init, stream, system message. | live | `createUserMessage`, `getAvailableModels`, `initializeClient`, `loadCredentials`, `log`, `step`, `withSystemMessage` |
| 02 | `02_conversation.mjs` | Conversation: one carried history, parameters, a stdin-safe REPL. | live | `EVENTS`, `cachePoints`, `countConversationTurns`, `createUserMessage`, `dedupeMessages`, `getToolCallName`, `guardedParse`, `initializeClient`, `loadCredentials`, `log`, `logprobs`, `logprobsTopK`, `maxTokens`, `previousResponseId`, `promptCacheKey`, `seed`, `serviceTier`, `step`, `store`, `stream`, `stripInjectionMeta`, `temperature`, `topP`, `withParameters`, `withSystemMessage` |
| 03 | `03_structured_output.mjs` | Structured output: JSON Schema, Zod, and bounded corrections. | live | `OrchestrationExhaustedError`, `asJsonSchema`, `guardedParse`, `initializeClient`, `loadCredentials`, `log`, `run`, `structuredLlmCall`, `withParameters`, `zodSchemaToJsonSchema` |
| 04 | `04_judgment.mjs` | Judgment: typed answers, then a gate in code. | live | `EVENTS`, `choiceQuestion`, `createAgenticRuntime`, `createDecisionGate`, `createDecisionReranker`, `createDecisionsClient`, `createRoleClients`, `decisionCalibration`, `getDecisionModel`, `initializeClient`, `loadCredentials`, `log`, `noulQuestion`, `readDecisionAnswer`, `resolveRole`, `scoreQuestion`, `withDecisionGate` |
| 05 | `05_tool_calling.mjs` | Tool calling: the model chooses, the SDK executes. | live | `capToolOutputValue`, `createAssistantMessage`, `createSystemMessage`, `createToolCallMessage`, `createToolResultMessage`, `createUserMessage`, `executeTools`, `getToolCallArguments`, `getToolCallName`, `initializeClient`, `loadCredentials`, `log`, `normalizeHistory`, `parallelToolCalls`, `run`, `step`, `withParameters`, `withSystemMessage`, `withTools` |
| 06 | `06_approvals_and_safety.mjs` | Approvals and safety: the refund agent that must be stopped. | live | `BudgetExceededError`, `EVENTS`, `GuardrailViolationError`, `InMemorySessionStore`, `PERMISSION_MODES`, `capToolOutputValue`, `createGuardrails`, `executeTools`, `extractUserText`, `initializeClient`, `isToolPermitted`, `load`, `loadCredentials`, `log`, `run`, `stillRequiresApproval`, `withApproval`, `withBudget`, `withGuardrails`, `withPermissions`, `withSessionStore`, `withSystemMessage`, `withToolTimeout`, `withTools` |
| 07 | `07_agent_loop.mjs` | The agent loop: staged follow-ups, abort, budget, limits, in-flight input. | live | `BudgetExceededError`, `EVENTS`, `LIMIT_DEFAULTS`, `LocalFileInboxStore`, `acquire`, `cancelInput`, `countConversationTurns`, `createShellTool`, `defaultDisplay`, `drainInbox`, `enqueueInput`, `filter`, `getLimits`, `getPendingInputs`, `hasLiveBackgroundWork`, `initializeClient`, `isAbortError`, `isRunning`, `load`, `loadCredentials`, `loadInbox`, `log`, `release`, `resetLimits`, `run`, `setInputDelivery`, `setLimits`, `waitForBackgroundWork`, `withBudget`, `withInboxStore`, `withSystemMessage`, `withTools` |
| 08 | `08_resilience.mjs` | Resilience: retries, fan-out limits, breaker, live policy wiring. | live | `BREAKER_OPEN_CODE`, `CircuitBreaker`, `EVENTS`, `ExponentialBackoffPolicy`, `InactivityTimeoutPolicy`, `canRun`, `createLimiter`, `defaultDisplay`, `initializeClient`, `loadCredentials`, `log`, `run`, `runBatch`, `runGuardedStep`, `stream`, `temperature`, `topK`, `withBudget`, `withParameters`, `withRetryPolicy`, `withStreamTimeout`, `withSystemMessage` |
| 09 | `09_memory_and_todos.mjs` | Memory and todos: the persistent agent state. | live | `EVENTS`, `LocalFileMemoryProvider`, `ProviderType`, `defaultDisplay`, `getEmbeddingDimensions`, `getEmbeddingModel`, `guardedParse`, `initializeClient`, `loadCredentials`, `log`, `run`, `store`, `withExecute`, `withMemory`, `withSystemMessage`, `withTodos` |
| 10 | `10_multimodal.mjs` | Multimodal intake: vision, document ingestion, structured output. | live | `ConfigurationError`, `PDF_MEDIA_PROVIDERS`, `ProviderType`, `asJsonSchema`, `createUnifiedMediaMessages`, `extractAndParseJson`, `ingestDocument`, `initializeClient`, `loadCredentials`, `log`, `next`, `run`, `step`, `withParameters`, `withSystemMessage` |
| 11 | `11_web_tools.mjs` | Web tools: search, scrape, and the headless browser. | live | `EVENTS`, `defaultDisplay`, `initializeClient`, `loadCredentials`, `log`, `resolveBrowserMode`, `resolveScrapeMode`, `resolveSearchMode`, `run`, `withBrowser`, `withSystemMessage`, `withWebScrape`, `withWebSearch` |
| 12 | `12_knowledge_graph.mjs` | The knowledge graph: a contract that can say no. | live | `applyPatch`, `buildGraph`, `createDecisionGate`, `defaultDisplay`, `edgeText`, `getDecisionModel`, `graphSha`, `initializeClient`, `loadCredentials`, `loadGraph`, `log`, `providerDescriptorFor`, `renderKnowledgeBlock`, `retrieveSubgraph`, `run`, `saveGraph`, `validateGraph`, `withDecisionGate`, `withExecute`, `withKnowledge`, `withSystemMessage` |
| 13 | `13_knowledge_corpus.mjs` | A corpus that becomes a wiki, and survives an edit. | live | `adoptOntology`, `adoptedProfile`, `applyPatch`, `buildGraph`, `corpusKey`, `defaultDisplay`, `extractAndParseJson`, `fingerprintSources`, `graphSha`, `initializeClient`, `loadCorpus`, `loadCredentials`, `log`, `memorySurface`, `mergeFragment`, `ontologySha`, `profileSources`, `proposeOntology`, `readSources`, `readWikiSha`, `renderKnowledgeBlock`, `renderWiki`, `run`, `saveGraph`, `sourceDelta`, `surfaceFragment`, `syncCorpus`, `todosSurface`, `validateGraph`, `wikiSurface`, `withExecute`, `withKnowledge`, `withSystemMessage` |
| 14 | `14_coding_agent.mjs` | A workspace-scoped coding agent (REPL). | live | `EVENTS`, `createContextTools`, `createShellTool`, `defaultDisplay`, `initializeClient`, `loadCredentials`, `loadSkillsFromDirectory`, `log`, `run`, `withApproval`, `withAutoContext`, `withSkills`, `withSystemMessage`, `withTools` |
| 15 | `15_delegation.mjs` | Delegation: a lead agent, two specialists, one contract. | live | `AgentContext`, `ConfigurationError`, `EVENTS`, `HANDOFF_CONTEXT_MODES`, `HANDOFF_GOAL_MODES`, `InMemorySessionStore`, `TASK_TOOL_NAME`, `compactHistory`, `contextFromMerciEnvelope`, `continueSpawn`, `createTaskTool`, `foldContext`, `forkSpawn`, `getBudgetPool`, `getSpawn`, `goalBlockForHandoff`, `initializeClient`, `listSpawns`, `loadCredentials`, `log`, `merciEnvelope`, `normalizeDelegationEnvelope`, `normalizeHandoff`, `resolveAgentClient`, `run`, `sendToSpawn`, `spawnThreadId`, `sumSpawnUsage`, `withAgentDelegation`, `withBudget`, `withObjective`, `withSessionStore`, `withSystemMessage`, `withTaskAgents` |
| 16 | `16_plan_and_execute.mjs` | Plan → approve → execute with a durable handoff. | live | `AGENT_EXECUTE`, `AGENT_PLAN`, `EVENTS`, `LocalFileSessionStore`, `approvePlanExit`, `createContextTools`, `createPlanStageFollowUp`, `createUserMessage`, `defaultDisplay`, `initializeClient`, `loadCheckpoint`, `loadCredentials`, `log`, `run`, `saveCheckpoint`, `withAutoContext`, `withExecute`, `withObjective`, `withPlan`, `withPlanTools`, `withSessionStore`, `withTodos`, `withTools` |
| 17 | `17_dag_workflow.mjs` | DAG workflow: plan → execute → evaluate → nested child DAG. | live | `EVENTS`, `TaskState`, `WorkflowEvaluator`, `WorkflowExecutor`, `WorkflowPlanner`, `assertStateSchema`, `collectTemplateRefs`, `execute`, `get`, `initializeClient`, `loadCredentials`, `log`, `on`, `plan`, `save`, `setSteps`, `validateTemplateRefs`, `values` |
| 18 | `18_state_machine.mjs` | State machine: a node verify gate + a contract completion gate. | live | `StateMachine`, `initializeClient`, `loadCredentials`, `log`, `run`, `save` |
| 19 | `19_discussion.mjs` | A decision group: task DAG → debate → judge → conclude. | live | `DiscussionSession`, `addAgent`, `conclude`, `discuss`, `getAgents`, `getLedger`, `initializeClient`, `judge`, `loadCredentials`, `log`, `map`, `on`, `runTasks` |
| 20 | `20_durability.mjs` | A crash mid-run, resumed exactly once. | live | `CHECKPOINT_KIND`, `ConfigurationError`, `ExecutionJournal`, `JOURNAL_STATUS`, `LocalFileSessionStore`, `begin`, `createUserMessage`, `defaultDisplay`, `entries`, `executeTools`, `find`, `forkCheckpoint`, `initializeClient`, `load`, `loadCheckpoint`, `loadCredentials`, `log`, `restoreCheckpoint`, `run`, `saveCheckpoint`, `toolJournalKey`, `withExecutionJournal`, `withSessionStore`, `withSystemMessage`, `withTools` |
| 21 | `21_observability.mjs` | Observability: correlation, custom observers, typed errors, abort. | live | `AbortedError`, `BackendError`, `EVENTS`, `EventEmitterApiObserver`, `MerciEventEmitter`, `PHASES`, `ProviderType`, `RunContext`, `STOP`, `createHooks`, `emit`, `enterPhase`, `initializeClient`, `isAbortError`, `loadCredentials`, `log`, `on`, `onError`, `onRequest`, `onResponse`, `onRetry`, `run`, `setRunContext`, `stampEvent`, `stampStreamEvent`, `withApiObserver`, `withSystemMessage`, `wrap`, `wrapError` |
| 22 | `22_telemetry.mjs` | Telemetry: the same run, as an OTLP envelope on disk. | live | `CompositeApiObserver`, `EVENTS`, `EventEmitterApiObserver`, `createOtlpExporter`, `initializeClient`, `loadCredentials`, `log`, `otelAttribute`, `run`, `withApiObserver`, `withSystemMessage`, `withTelemetry` |
| 23 | `23_evals.mjs` | Evals: ship a prompt only if it scores. | live | `EVAL_SCORERS`, `FailureClass`, `RetryLedger`, `canRetry`, `claimReplan`, `classifyFailure`, `compareProgress`, `createCassette`, `createLlmJudge`, `createScoredJudge`, `failureFingerprint`, `get`, `initializeClient`, `loadCredentials`, `log`, `record`, `runEvals`, `stateFingerprint`, `withCassette`, `withSystemMessage` |
| 24 | `24_mcp_client.mjs` | MCP: a stdio server's tools inside a live session. | live | `McpClient`, `defaultDisplay`, `executeTool`, `getPrompt`, `guardedParse`, `initializeClient`, `listPrompts`, `listResources`, `loadCredentials`, `loadMcpTools`, `log`, `readResource`, `run`, `stop`, `withSystemMessage`, `withTools` |
| 24 | `24_mcp_server.mjs` | the MCP server child (stdio). | live | `createMcpServer`, `log` |
| 25 | `25_mcp_server_http.mjs` | Your SDK is the MCP server. | live | `AcpCapability`, `ExternalToolCapability`, `LoadableComponent`, `McpClient`, `TOOL_OUTPUT_TRUNCATION_SUFFIX`, `buildEnvironmentBlock`, `capToolOutput`, `capToolOutputValue`, `connect`, `createMcpHttpHandler`, `createSaveArtifactTool`, `defaultDisplay`, `discoverInstructions`, `executeTool`, `initializeClient`, `loadCredentials`, `loadMcpTools`, `log`, `map`, `run`, `stop`, `tools`, `withCapability`, `withSystemMessage`, `withTools` |
| 26 | `26_a2a.mjs` | A2A: a remote peer as a tool — discover, delegate, track. | live | `A2A_COMPLETED_STATES`, `cancelA2ATask`, `getA2ATask`, `initializeClient`, `loadA2ATool`, `loadCredentials`, `log`, `run`, `withSystemMessage`, `withTools` |
| 26 | `26_a2a_server.mjs` | A2A child agent — spawned by `25_a2a_client.mjs`. | live | `createA2AHttpHandler`, `createA2AServer` |
| 27 | `27_acp_agent.mjs` | merci behind an editor protocol. | live | `ACP_AGENT_VERSION`, `ACP_STOP_REASONS`, `EVENTS`, `createAcpAgent`, `createContextTools`, `createShellTool`, `defaultDisplay`, `initializeClient`, `loadCredentials`, `log`, `permissionAllowed`, `withAutoContext`, `withSystemMessage`, `withTools` |
| 28 | `28_workspace_isolation.mjs` | One work item, one worktree, one agent that cannot leave it. | live | `EVENTS`, `TodoComponent`, `WORKSPACE_HOOKS`, `WORKSPACE_STRATEGIES`, `WorkScheduler`, `WorkspaceManager`, `afterRun`, `beforeRun`, `createMemoryClaimStore`, `createTodoWorkSource`, `createWorkspaceTools`, `ensure`, `includes`, `initializeClient`, `isInsideRoot`, `loadCredentials`, `log`, `remove`, `resolveWorkspacePath`, `run`, `save`, `snapshot`, `start`, `stop`, `withApproval`, `withSystemMessage`, `withTools`, `withWorkspace`, `workspaceKeyFor` |
| 29 | `29_workflow_contract.mjs` | The workflow contract: one repo-owned file, from config to prompt. | live | `EVENTS`, `MerciEventEmitter`, `PolicyError`, `WORKFLOW_POLICY_REASONS`, `WorkflowPolicy`, `createPolicyRenderer`, `getConfig`, `initializeClient`, `loadCredentials`, `loadWorkflowFile`, `log`, `onAny`, `parseWorkflowMarkdown`, `policyToSchedulerOptions`, `policyToWorkspaceOptions`, `preflight`, `reload`, `renderPrompt`, `renderPromptTemplate`, `run`, `snapshot`, `start`, `stop` |
| 30 | `30_scheduler.mjs` | An unattended queue that retries, parks and resumes. | live | `CLAIM_STATES`, `EVENTS`, `LocalFileSessionStore`, `RunContext`, `SCHEDULER_DEFAULTS`, `WorkScheduler`, `WorkSourceError`, `catch`, `createEngineRunner`, `createFileAttemptStore`, `createFileClaimStore`, `createFunctionWorkSource`, `createJsonFileWorkSource`, `createMemoryClaimStore`, `createMemoryWorkSource`, `initializeClient`, `join`, `load`, `loadCredentials`, `log`, `normalizeWorkItem`, `resetItem`, `snapshot`, `sortForDispatch`, `start`, `stop`, `tick` |
| 31 | `31_orchestration.mjs` | One call: policy + scheduler + workspace + operator. | live | `DEFAULT_PREFIXES`, `EVENTS`, `LocalFileSessionStore`, `MerciEventEmitter`, `OPERATOR_API_VERSION`, `OPERATOR_DEFAULTS`, `createEventRing`, `createMemoryWorkSource`, `createOperatorHttpHandler`, `createOrchestration`, `formatStatus`, `initializeClient`, `loadCredentials`, `log`, `run` |
| 32 | `32_agent_files.mjs` | Agent definition files: one YAML, a live tool-using agent, a live subagent. | live | `EVENTS`, `applyAgentSpec`, `createAgentToolbox`, `initializeClient`, `loadAgentFile`, `loadCredentials`, `log`, `resolveToolset`, `run`, `toTaskAgent`, `withApproval`, `withSystemMessage`, `withTaskAgents` |

## 2. Subpath entry points

Symbols not on the `merci-sdk` barrel, imported from a published subpath:

| Example | Import |
| --- | --- |
| `02_conversation.mjs` | `merci-sdk/json → guardedParse` |
| `03_structured_output.mjs` | `merci-sdk/json → guardedParse, zodSchemaToJsonSchema` |
| `09_memory_and_todos.mjs` | `merci-sdk/json → guardedParse` |
| `10_multimodal.mjs` | `merci-sdk/json → extractAndParseJson` |
| `13_knowledge_corpus.mjs` | `merci-sdk/json → extractAndParseJson` |
| `17_dag_workflow.mjs` | `merci-sdk/planning → TaskState, WorkflowEvaluator, WorkflowExecutor, WorkflowPlanner, assertStateSchema, collectTemplateRefs, validateTemplateRefs` |
| `24_mcp_client.mjs` | `merci-sdk/json → guardedParse` |
| `25_mcp_server_http.mjs` | `merci-sdk/tools → TOOL_OUTPUT_TRUNCATION_SUFFIX` |
| `26_a2a.mjs` | `merci-sdk/tools → loadA2ATool, getA2ATask, cancelA2ATask, A2A_COMPLETED_STATES` |
| `28_workspace_isolation.mjs` | `merci-sdk/scheduler → WorkScheduler, createMemoryClaimStore, createTodoWorkSource` |
| `28_workspace_isolation.mjs` | `merci-sdk/workspace → WORKSPACE_HOOKS, WORKSPACE_STRATEGIES, WorkspaceManager, createWorkspaceTools, isInsideRoot, resolveWorkspacePath, workspaceKeyFor` |
| `29_workflow_contract.mjs` | `merci-sdk/workflow-policy → WORKFLOW_POLICY_REASONS, WorkflowPolicy, createPolicyRenderer, loadWorkflowFile, parseWorkflowMarkdown, policyToSchedulerOptions, policyToWorkspaceOptions, renderPromptTemplate` |
| `30_scheduler.mjs` | `merci-sdk/scheduler → CLAIM_STATES, SCHEDULER_DEFAULTS, WorkScheduler, createEngineRunner, createFileAttemptStore, createFileClaimStore, createFunctionWorkSource, createJsonFileWorkSource, createMemoryClaimStore, createMemoryWorkSource, normalizeWorkItem, sortForDispatch` |
| `31_orchestration.mjs` | `merci-sdk/operator → DEFAULT_PREFIXES, OPERATOR_API_VERSION, OPERATOR_DEFAULTS, createEventRing, createOperatorHttpHandler, formatStatus` |
| `31_orchestration.mjs` | `merci-sdk/orchestration → createOrchestration` |
| `31_orchestration.mjs` | `merci-sdk/scheduler → createMemoryWorkSource` |
| `32_agent_files.mjs` | `merci-sdk/agents → applyAgentSpec, createAgentToolbox, loadAgentFile, resolveToolset, toTaskAgent` |

## 3. Symbol → examples

| Public symbol | Used by |
| --- | --- |
| `A2A_COMPLETED_STATES` | `26_a2a.mjs` |
| `AbortedError` | `21_observability.mjs` |
| `ACP_AGENT_VERSION` | `27_acp_agent.mjs` |
| `ACP_STOP_REASONS` | `27_acp_agent.mjs` |
| `AcpCapability` | `25_mcp_server_http.mjs` |
| `acquire` | `07_agent_loop.mjs` |
| `addAgent` | `19_discussion.mjs` |
| `adoptedProfile` | `13_knowledge_corpus.mjs` |
| `adoptOntology` | `13_knowledge_corpus.mjs` |
| `afterRun` | `28_workspace_isolation.mjs` |
| `AGENT_EXECUTE` | `16_plan_and_execute.mjs` |
| `AGENT_PLAN` | `16_plan_and_execute.mjs` |
| `AgentContext` | `15_delegation.mjs` |
| `applyAgentSpec` | `32_agent_files.mjs` |
| `applyPatch` | `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs` |
| `approvePlanExit` | `16_plan_and_execute.mjs` |
| `asJsonSchema` | `03_structured_output.mjs`, `10_multimodal.mjs` |
| `assertStateSchema` | `17_dag_workflow.mjs` |
| `BackendError` | `21_observability.mjs` |
| `beforeRun` | `28_workspace_isolation.mjs` |
| `begin` | `20_durability.mjs` |
| `BREAKER_OPEN_CODE` | `08_resilience.mjs` |
| `BudgetExceededError` | `06_approvals_and_safety.mjs`, `07_agent_loop.mjs` |
| `buildEnvironmentBlock` | `25_mcp_server_http.mjs` |
| `buildGraph` | `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs` |
| `cachePoints` | `02_conversation.mjs` |
| `cancelA2ATask` | `26_a2a.mjs` |
| `cancelInput` | `07_agent_loop.mjs` |
| `canRetry` | `23_evals.mjs` |
| `canRun` | `08_resilience.mjs` |
| `capToolOutput` | `25_mcp_server_http.mjs` |
| `capToolOutputValue` | `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `25_mcp_server_http.mjs` |
| `catch` | `30_scheduler.mjs` |
| `CHECKPOINT_KIND` | `20_durability.mjs` |
| `choiceQuestion` | `04_judgment.mjs` |
| `CircuitBreaker` | `08_resilience.mjs` |
| `CLAIM_STATES` | `30_scheduler.mjs` |
| `claimReplan` | `23_evals.mjs` |
| `classifyFailure` | `23_evals.mjs` |
| `collectTemplateRefs` | `17_dag_workflow.mjs` |
| `compactHistory` | `15_delegation.mjs` |
| `compareProgress` | `23_evals.mjs` |
| `CompositeApiObserver` | `22_telemetry.mjs` |
| `conclude` | `19_discussion.mjs` |
| `ConfigurationError` | `10_multimodal.mjs`, `15_delegation.mjs`, `20_durability.mjs` |
| `connect` | `25_mcp_server_http.mjs` |
| `contextFromMerciEnvelope` | `15_delegation.mjs` |
| `continueSpawn` | `15_delegation.mjs` |
| `corpusKey` | `13_knowledge_corpus.mjs` |
| `countConversationTurns` | `02_conversation.mjs`, `07_agent_loop.mjs` |
| `createA2AHttpHandler` | `26_a2a_server.mjs` |
| `createA2AServer` | `26_a2a_server.mjs` |
| `createAcpAgent` | `27_acp_agent.mjs` |
| `createAgenticRuntime` | `04_judgment.mjs` |
| `createAgentToolbox` | `32_agent_files.mjs` |
| `createAssistantMessage` | `05_tool_calling.mjs` |
| `createCassette` | `23_evals.mjs` |
| `createContextTools` | `14_coding_agent.mjs`, `16_plan_and_execute.mjs`, `27_acp_agent.mjs` |
| `createDecisionGate` | `04_judgment.mjs`, `12_knowledge_graph.mjs` |
| `createDecisionReranker` | `04_judgment.mjs` |
| `createDecisionsClient` | `04_judgment.mjs` |
| `createEngineRunner` | `30_scheduler.mjs` |
| `createEventRing` | `31_orchestration.mjs` |
| `createFileAttemptStore` | `30_scheduler.mjs` |
| `createFileClaimStore` | `30_scheduler.mjs` |
| `createFunctionWorkSource` | `30_scheduler.mjs` |
| `createGuardrails` | `06_approvals_and_safety.mjs` |
| `createHooks` | `21_observability.mjs` |
| `createJsonFileWorkSource` | `30_scheduler.mjs` |
| `createLimiter` | `08_resilience.mjs` |
| `createLlmJudge` | `23_evals.mjs` |
| `createMcpHttpHandler` | `25_mcp_server_http.mjs` |
| `createMcpServer` | `24_mcp_server.mjs` |
| `createMemoryClaimStore` | `28_workspace_isolation.mjs`, `30_scheduler.mjs` |
| `createMemoryWorkSource` | `30_scheduler.mjs`, `31_orchestration.mjs` |
| `createOperatorHttpHandler` | `31_orchestration.mjs` |
| `createOrchestration` | `31_orchestration.mjs` |
| `createOtlpExporter` | `22_telemetry.mjs` |
| `createPlanStageFollowUp` | `16_plan_and_execute.mjs` |
| `createPolicyRenderer` | `29_workflow_contract.mjs` |
| `createRoleClients` | `04_judgment.mjs` |
| `createSaveArtifactTool` | `25_mcp_server_http.mjs` |
| `createScoredJudge` | `23_evals.mjs` |
| `createShellTool` | `07_agent_loop.mjs`, `14_coding_agent.mjs`, `27_acp_agent.mjs` |
| `createSystemMessage` | `05_tool_calling.mjs` |
| `createTaskTool` | `15_delegation.mjs` |
| `createTodoWorkSource` | `28_workspace_isolation.mjs` |
| `createToolCallMessage` | `05_tool_calling.mjs` |
| `createToolResultMessage` | `05_tool_calling.mjs` |
| `createUnifiedMediaMessages` | `10_multimodal.mjs` |
| `createUserMessage` | `01_quickstart.mjs`, `02_conversation.mjs`, `05_tool_calling.mjs`, `16_plan_and_execute.mjs`, `20_durability.mjs` |
| `createWorkspaceTools` | `28_workspace_isolation.mjs` |
| `decisionCalibration` | `04_judgment.mjs` |
| `dedupeMessages` | `02_conversation.mjs` |
| `DEFAULT_PREFIXES` | `31_orchestration.mjs` |
| `defaultDisplay` | `07_agent_loop.mjs`, `08_resilience.mjs`, `09_memory_and_todos.mjs`, `11_web_tools.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `14_coding_agent.mjs`, `16_plan_and_execute.mjs`, `20_durability.mjs`, `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `27_acp_agent.mjs` |
| `discoverInstructions` | `25_mcp_server_http.mjs` |
| `discuss` | `19_discussion.mjs` |
| `DiscussionSession` | `19_discussion.mjs` |
| `drainInbox` | `07_agent_loop.mjs` |
| `edgeText` | `12_knowledge_graph.mjs` |
| `emit` | `21_observability.mjs` |
| `enqueueInput` | `07_agent_loop.mjs` |
| `ensure` | `28_workspace_isolation.mjs` |
| `enterPhase` | `21_observability.mjs` |
| `entries` | `20_durability.mjs` |
| `EVAL_SCORERS` | `23_evals.mjs` |
| `EventEmitterApiObserver` | `21_observability.mjs`, `22_telemetry.mjs` |
| `EVENTS` | `02_conversation.mjs`, `04_judgment.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `09_memory_and_todos.mjs`, `11_web_tools.mjs`, `14_coding_agent.mjs`, `15_delegation.mjs`, `16_plan_and_execute.mjs`, `17_dag_workflow.mjs`, `21_observability.mjs`, `22_telemetry.mjs`, `27_acp_agent.mjs`, `28_workspace_isolation.mjs`, `29_workflow_contract.mjs`, `30_scheduler.mjs`, `31_orchestration.mjs`, `32_agent_files.mjs` |
| `execute` | `17_dag_workflow.mjs` |
| `executeTool` | `24_mcp_client.mjs`, `25_mcp_server_http.mjs` |
| `executeTools` | `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `20_durability.mjs` |
| `ExecutionJournal` | `20_durability.mjs` |
| `ExponentialBackoffPolicy` | `08_resilience.mjs` |
| `ExternalToolCapability` | `25_mcp_server_http.mjs` |
| `extractAndParseJson` | `10_multimodal.mjs`, `13_knowledge_corpus.mjs` |
| `extractUserText` | `06_approvals_and_safety.mjs` |
| `FailureClass` | `23_evals.mjs` |
| `failureFingerprint` | `23_evals.mjs` |
| `filter` | `07_agent_loop.mjs` |
| `find` | `20_durability.mjs` |
| `fingerprintSources` | `13_knowledge_corpus.mjs` |
| `foldContext` | `15_delegation.mjs` |
| `forkCheckpoint` | `20_durability.mjs` |
| `forkSpawn` | `15_delegation.mjs` |
| `formatStatus` | `31_orchestration.mjs` |
| `get` | `17_dag_workflow.mjs`, `23_evals.mjs` |
| `getA2ATask` | `26_a2a.mjs` |
| `getAgents` | `19_discussion.mjs` |
| `getAvailableModels` | `01_quickstart.mjs` |
| `getBudgetPool` | `15_delegation.mjs` |
| `getConfig` | `29_workflow_contract.mjs` |
| `getDecisionModel` | `04_judgment.mjs`, `12_knowledge_graph.mjs` |
| `getEmbeddingDimensions` | `09_memory_and_todos.mjs` |
| `getEmbeddingModel` | `09_memory_and_todos.mjs` |
| `getLedger` | `19_discussion.mjs` |
| `getLimits` | `07_agent_loop.mjs` |
| `getPendingInputs` | `07_agent_loop.mjs` |
| `getPrompt` | `24_mcp_client.mjs` |
| `getSpawn` | `15_delegation.mjs` |
| `getToolCallArguments` | `05_tool_calling.mjs` |
| `getToolCallName` | `02_conversation.mjs`, `05_tool_calling.mjs` |
| `goalBlockForHandoff` | `15_delegation.mjs` |
| `graphSha` | `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs` |
| `guardedParse` | `02_conversation.mjs`, `03_structured_output.mjs`, `09_memory_and_todos.mjs`, `24_mcp_client.mjs` |
| `GuardrailViolationError` | `06_approvals_and_safety.mjs` |
| `HANDOFF_CONTEXT_MODES` | `15_delegation.mjs` |
| `HANDOFF_GOAL_MODES` | `15_delegation.mjs` |
| `hasLiveBackgroundWork` | `07_agent_loop.mjs` |
| `InactivityTimeoutPolicy` | `08_resilience.mjs` |
| `includes` | `28_workspace_isolation.mjs` |
| `ingestDocument` | `10_multimodal.mjs` |
| `initializeClient` | `01_quickstart.mjs`, `02_conversation.mjs`, `03_structured_output.mjs`, `04_judgment.mjs`, `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `09_memory_and_todos.mjs`, `10_multimodal.mjs`, `11_web_tools.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `14_coding_agent.mjs`, `15_delegation.mjs`, `16_plan_and_execute.mjs`, `17_dag_workflow.mjs`, `18_state_machine.mjs`, `19_discussion.mjs`, `20_durability.mjs`, `21_observability.mjs`, `22_telemetry.mjs`, `23_evals.mjs`, `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `26_a2a.mjs`, `27_acp_agent.mjs`, `28_workspace_isolation.mjs`, `29_workflow_contract.mjs`, `30_scheduler.mjs`, `31_orchestration.mjs`, `32_agent_files.mjs` |
| `InMemorySessionStore` | `06_approvals_and_safety.mjs`, `15_delegation.mjs` |
| `isAbortError` | `07_agent_loop.mjs`, `21_observability.mjs` |
| `isInsideRoot` | `28_workspace_isolation.mjs` |
| `isRunning` | `07_agent_loop.mjs` |
| `isToolPermitted` | `06_approvals_and_safety.mjs` |
| `join` | `30_scheduler.mjs` |
| `JOURNAL_STATUS` | `20_durability.mjs` |
| `judge` | `19_discussion.mjs` |
| `LIMIT_DEFAULTS` | `07_agent_loop.mjs` |
| `listPrompts` | `24_mcp_client.mjs` |
| `listResources` | `24_mcp_client.mjs` |
| `listSpawns` | `15_delegation.mjs` |
| `load` | `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `20_durability.mjs`, `30_scheduler.mjs` |
| `loadA2ATool` | `26_a2a.mjs` |
| `LoadableComponent` | `25_mcp_server_http.mjs` |
| `loadAgentFile` | `32_agent_files.mjs` |
| `loadCheckpoint` | `16_plan_and_execute.mjs`, `20_durability.mjs` |
| `loadCorpus` | `13_knowledge_corpus.mjs` |
| `loadCredentials` | `01_quickstart.mjs`, `02_conversation.mjs`, `03_structured_output.mjs`, `04_judgment.mjs`, `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `09_memory_and_todos.mjs`, `10_multimodal.mjs`, `11_web_tools.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `14_coding_agent.mjs`, `15_delegation.mjs`, `16_plan_and_execute.mjs`, `17_dag_workflow.mjs`, `18_state_machine.mjs`, `19_discussion.mjs`, `20_durability.mjs`, `21_observability.mjs`, `22_telemetry.mjs`, `23_evals.mjs`, `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `26_a2a.mjs`, `27_acp_agent.mjs`, `28_workspace_isolation.mjs`, `29_workflow_contract.mjs`, `30_scheduler.mjs`, `31_orchestration.mjs`, `32_agent_files.mjs` |
| `loadGraph` | `12_knowledge_graph.mjs` |
| `loadInbox` | `07_agent_loop.mjs` |
| `loadMcpTools` | `24_mcp_client.mjs`, `25_mcp_server_http.mjs` |
| `loadSkillsFromDirectory` | `14_coding_agent.mjs` |
| `loadWorkflowFile` | `29_workflow_contract.mjs` |
| `LocalFileInboxStore` | `07_agent_loop.mjs` |
| `LocalFileMemoryProvider` | `09_memory_and_todos.mjs` |
| `LocalFileSessionStore` | `16_plan_and_execute.mjs`, `20_durability.mjs`, `30_scheduler.mjs`, `31_orchestration.mjs` |
| `log` | `01_quickstart.mjs`, `02_conversation.mjs`, `03_structured_output.mjs`, `04_judgment.mjs`, `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `09_memory_and_todos.mjs`, `10_multimodal.mjs`, `11_web_tools.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `14_coding_agent.mjs`, `15_delegation.mjs`, `16_plan_and_execute.mjs`, `17_dag_workflow.mjs`, `18_state_machine.mjs`, `19_discussion.mjs`, `20_durability.mjs`, `21_observability.mjs`, `22_telemetry.mjs`, `23_evals.mjs`, `24_mcp_client.mjs`, `24_mcp_server.mjs`, `25_mcp_server_http.mjs`, `26_a2a.mjs`, `27_acp_agent.mjs`, `28_workspace_isolation.mjs`, `29_workflow_contract.mjs`, `30_scheduler.mjs`, `31_orchestration.mjs`, `32_agent_files.mjs` |
| `logprobs` | `02_conversation.mjs` |
| `logprobsTopK` | `02_conversation.mjs` |
| `map` | `19_discussion.mjs`, `25_mcp_server_http.mjs` |
| `maxTokens` | `02_conversation.mjs` |
| `McpClient` | `24_mcp_client.mjs`, `25_mcp_server_http.mjs` |
| `memorySurface` | `13_knowledge_corpus.mjs` |
| `merciEnvelope` | `15_delegation.mjs` |
| `MerciEventEmitter` | `21_observability.mjs`, `29_workflow_contract.mjs`, `31_orchestration.mjs` |
| `mergeFragment` | `13_knowledge_corpus.mjs` |
| `next` | `10_multimodal.mjs` |
| `normalizeDelegationEnvelope` | `15_delegation.mjs` |
| `normalizeHandoff` | `15_delegation.mjs` |
| `normalizeHistory` | `05_tool_calling.mjs` |
| `normalizeWorkItem` | `30_scheduler.mjs` |
| `noulQuestion` | `04_judgment.mjs` |
| `on` | `17_dag_workflow.mjs`, `19_discussion.mjs`, `21_observability.mjs` |
| `onAny` | `29_workflow_contract.mjs` |
| `onError` | `21_observability.mjs` |
| `onRequest` | `21_observability.mjs` |
| `onResponse` | `21_observability.mjs` |
| `onRetry` | `21_observability.mjs` |
| `ontologySha` | `13_knowledge_corpus.mjs` |
| `OPERATOR_API_VERSION` | `31_orchestration.mjs` |
| `OPERATOR_DEFAULTS` | `31_orchestration.mjs` |
| `OrchestrationExhaustedError` | `03_structured_output.mjs` |
| `otelAttribute` | `22_telemetry.mjs` |
| `parallelToolCalls` | `05_tool_calling.mjs` |
| `parseWorkflowMarkdown` | `29_workflow_contract.mjs` |
| `PDF_MEDIA_PROVIDERS` | `10_multimodal.mjs` |
| `PERMISSION_MODES` | `06_approvals_and_safety.mjs` |
| `permissionAllowed` | `27_acp_agent.mjs` |
| `PHASES` | `21_observability.mjs` |
| `plan` | `17_dag_workflow.mjs` |
| `PolicyError` | `29_workflow_contract.mjs` |
| `policyToSchedulerOptions` | `29_workflow_contract.mjs` |
| `policyToWorkspaceOptions` | `29_workflow_contract.mjs` |
| `preflight` | `29_workflow_contract.mjs` |
| `previousResponseId` | `02_conversation.mjs` |
| `profileSources` | `13_knowledge_corpus.mjs` |
| `promptCacheKey` | `02_conversation.mjs` |
| `proposeOntology` | `13_knowledge_corpus.mjs` |
| `providerDescriptorFor` | `12_knowledge_graph.mjs` |
| `ProviderType` | `09_memory_and_todos.mjs`, `10_multimodal.mjs`, `21_observability.mjs` |
| `readDecisionAnswer` | `04_judgment.mjs` |
| `readResource` | `24_mcp_client.mjs` |
| `readSources` | `13_knowledge_corpus.mjs` |
| `readWikiSha` | `13_knowledge_corpus.mjs` |
| `record` | `23_evals.mjs` |
| `release` | `07_agent_loop.mjs` |
| `reload` | `29_workflow_contract.mjs` |
| `remove` | `28_workspace_isolation.mjs` |
| `renderKnowledgeBlock` | `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs` |
| `renderPrompt` | `29_workflow_contract.mjs` |
| `renderPromptTemplate` | `29_workflow_contract.mjs` |
| `renderWiki` | `13_knowledge_corpus.mjs` |
| `resetItem` | `30_scheduler.mjs` |
| `resetLimits` | `07_agent_loop.mjs` |
| `resolveAgentClient` | `15_delegation.mjs` |
| `resolveBrowserMode` | `11_web_tools.mjs` |
| `resolveRole` | `04_judgment.mjs` |
| `resolveScrapeMode` | `11_web_tools.mjs` |
| `resolveSearchMode` | `11_web_tools.mjs` |
| `resolveToolset` | `32_agent_files.mjs` |
| `resolveWorkspacePath` | `28_workspace_isolation.mjs` |
| `restoreCheckpoint` | `20_durability.mjs` |
| `retrieveSubgraph` | `12_knowledge_graph.mjs` |
| `RetryLedger` | `23_evals.mjs` |
| `run` | `03_structured_output.mjs`, `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `09_memory_and_todos.mjs`, `10_multimodal.mjs`, `11_web_tools.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `14_coding_agent.mjs`, `15_delegation.mjs`, `16_plan_and_execute.mjs`, `18_state_machine.mjs`, `20_durability.mjs`, `21_observability.mjs`, `22_telemetry.mjs`, `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `26_a2a.mjs`, `28_workspace_isolation.mjs`, `29_workflow_contract.mjs`, `31_orchestration.mjs`, `32_agent_files.mjs` |
| `runBatch` | `08_resilience.mjs` |
| `RunContext` | `21_observability.mjs`, `30_scheduler.mjs` |
| `runEvals` | `23_evals.mjs` |
| `runGuardedStep` | `08_resilience.mjs` |
| `runTasks` | `19_discussion.mjs` |
| `save` | `17_dag_workflow.mjs`, `18_state_machine.mjs`, `28_workspace_isolation.mjs` |
| `saveCheckpoint` | `16_plan_and_execute.mjs`, `20_durability.mjs` |
| `saveGraph` | `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs` |
| `SCHEDULER_DEFAULTS` | `30_scheduler.mjs` |
| `scoreQuestion` | `04_judgment.mjs` |
| `seed` | `02_conversation.mjs` |
| `sendToSpawn` | `15_delegation.mjs` |
| `serviceTier` | `02_conversation.mjs` |
| `setInputDelivery` | `07_agent_loop.mjs` |
| `setLimits` | `07_agent_loop.mjs` |
| `setRunContext` | `21_observability.mjs` |
| `setSteps` | `17_dag_workflow.mjs` |
| `snapshot` | `28_workspace_isolation.mjs`, `29_workflow_contract.mjs`, `30_scheduler.mjs` |
| `sortForDispatch` | `30_scheduler.mjs` |
| `sourceDelta` | `13_knowledge_corpus.mjs` |
| `spawnThreadId` | `15_delegation.mjs` |
| `stampEvent` | `21_observability.mjs` |
| `stampStreamEvent` | `21_observability.mjs` |
| `start` | `28_workspace_isolation.mjs`, `29_workflow_contract.mjs`, `30_scheduler.mjs` |
| `stateFingerprint` | `23_evals.mjs` |
| `StateMachine` | `18_state_machine.mjs` |
| `step` | `01_quickstart.mjs`, `02_conversation.mjs`, `05_tool_calling.mjs`, `10_multimodal.mjs` |
| `stillRequiresApproval` | `06_approvals_and_safety.mjs` |
| `stop` | `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `28_workspace_isolation.mjs`, `29_workflow_contract.mjs`, `30_scheduler.mjs` |
| `STOP` | `21_observability.mjs` |
| `store` | `02_conversation.mjs`, `09_memory_and_todos.mjs` |
| `stream` | `02_conversation.mjs`, `08_resilience.mjs` |
| `stripInjectionMeta` | `02_conversation.mjs` |
| `structuredLlmCall` | `03_structured_output.mjs` |
| `sumSpawnUsage` | `15_delegation.mjs` |
| `surfaceFragment` | `13_knowledge_corpus.mjs` |
| `syncCorpus` | `13_knowledge_corpus.mjs` |
| `TASK_TOOL_NAME` | `15_delegation.mjs` |
| `TaskState` | `17_dag_workflow.mjs` |
| `temperature` | `02_conversation.mjs`, `08_resilience.mjs` |
| `tick` | `30_scheduler.mjs` |
| `TodoComponent` | `28_workspace_isolation.mjs` |
| `todosSurface` | `13_knowledge_corpus.mjs` |
| `TOOL_OUTPUT_TRUNCATION_SUFFIX` | `25_mcp_server_http.mjs` |
| `toolJournalKey` | `20_durability.mjs` |
| `tools` | `25_mcp_server_http.mjs` |
| `topK` | `08_resilience.mjs` |
| `topP` | `02_conversation.mjs` |
| `toTaskAgent` | `32_agent_files.mjs` |
| `validateGraph` | `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs` |
| `validateTemplateRefs` | `17_dag_workflow.mjs` |
| `values` | `17_dag_workflow.mjs` |
| `waitForBackgroundWork` | `07_agent_loop.mjs` |
| `wikiSurface` | `13_knowledge_corpus.mjs` |
| `withAgentDelegation` | `15_delegation.mjs` |
| `withApiObserver` | `21_observability.mjs`, `22_telemetry.mjs` |
| `withApproval` | `06_approvals_and_safety.mjs`, `14_coding_agent.mjs`, `28_workspace_isolation.mjs`, `32_agent_files.mjs` |
| `withAutoContext` | `14_coding_agent.mjs`, `16_plan_and_execute.mjs`, `27_acp_agent.mjs` |
| `withBrowser` | `11_web_tools.mjs` |
| `withBudget` | `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `15_delegation.mjs` |
| `withCapability` | `25_mcp_server_http.mjs` |
| `withCassette` | `23_evals.mjs` |
| `withDecisionGate` | `04_judgment.mjs`, `12_knowledge_graph.mjs` |
| `withExecute` | `09_memory_and_todos.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `16_plan_and_execute.mjs` |
| `withExecutionJournal` | `20_durability.mjs` |
| `withGuardrails` | `06_approvals_and_safety.mjs` |
| `withInboxStore` | `07_agent_loop.mjs` |
| `withKnowledge` | `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs` |
| `withMemory` | `09_memory_and_todos.mjs` |
| `withObjective` | `15_delegation.mjs`, `16_plan_and_execute.mjs` |
| `withParameters` | `02_conversation.mjs`, `03_structured_output.mjs`, `05_tool_calling.mjs`, `08_resilience.mjs`, `10_multimodal.mjs` |
| `withPermissions` | `06_approvals_and_safety.mjs` |
| `withPlan` | `16_plan_and_execute.mjs` |
| `withPlanTools` | `16_plan_and_execute.mjs` |
| `withRetryPolicy` | `08_resilience.mjs` |
| `withSessionStore` | `06_approvals_and_safety.mjs`, `15_delegation.mjs`, `16_plan_and_execute.mjs`, `20_durability.mjs` |
| `withSkills` | `14_coding_agent.mjs` |
| `withStreamTimeout` | `08_resilience.mjs` |
| `withSystemMessage` | `01_quickstart.mjs`, `02_conversation.mjs`, `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `09_memory_and_todos.mjs`, `10_multimodal.mjs`, `11_web_tools.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `14_coding_agent.mjs`, `15_delegation.mjs`, `20_durability.mjs`, `21_observability.mjs`, `22_telemetry.mjs`, `23_evals.mjs`, `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `26_a2a.mjs`, `27_acp_agent.mjs`, `28_workspace_isolation.mjs`, `32_agent_files.mjs` |
| `withTaskAgents` | `15_delegation.mjs`, `32_agent_files.mjs` |
| `withTelemetry` | `22_telemetry.mjs` |
| `withTodos` | `09_memory_and_todos.mjs`, `16_plan_and_execute.mjs` |
| `withTools` | `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `14_coding_agent.mjs`, `16_plan_and_execute.mjs`, `20_durability.mjs`, `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `26_a2a.mjs`, `27_acp_agent.mjs`, `28_workspace_isolation.mjs` |
| `withToolTimeout` | `06_approvals_and_safety.mjs` |
| `withWebScrape` | `11_web_tools.mjs` |
| `withWebSearch` | `11_web_tools.mjs` |
| `withWorkspace` | `28_workspace_isolation.mjs` |
| `WORKFLOW_POLICY_REASONS` | `29_workflow_contract.mjs` |
| `WorkflowEvaluator` | `17_dag_workflow.mjs` |
| `WorkflowExecutor` | `17_dag_workflow.mjs` |
| `WorkflowPlanner` | `17_dag_workflow.mjs` |
| `WorkflowPolicy` | `29_workflow_contract.mjs` |
| `WorkScheduler` | `28_workspace_isolation.mjs`, `30_scheduler.mjs` |
| `WorkSourceError` | `30_scheduler.mjs` |
| `WORKSPACE_HOOKS` | `28_workspace_isolation.mjs` |
| `WORKSPACE_STRATEGIES` | `28_workspace_isolation.mjs` |
| `workspaceKeyFor` | `28_workspace_isolation.mjs` |
| `WorkspaceManager` | `28_workspace_isolation.mjs` |
| `wrap` | `21_observability.mjs` |
| `wrapError` | `21_observability.mjs` |
| `zodSchemaToJsonSchema` | `03_structured_output.mjs` |

## 4. Builder methods in use

The `with*` builder methods the examples call — the fluent surface of a session. A method that is missing here is a session feature no example shows.

| Builder method | Used by |
| --- | --- |
| `withApiObserver` | `21_observability.mjs`, `22_telemetry.mjs` |
| `withApproval` | `06_approvals_and_safety.mjs`, `14_coding_agent.mjs`, `28_workspace_isolation.mjs`, `32_agent_files.mjs` |
| `withAutoContext` | `14_coding_agent.mjs`, `16_plan_and_execute.mjs`, `27_acp_agent.mjs` |
| `withBrowser` | `11_web_tools.mjs` |
| `withBudget` | `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `15_delegation.mjs` |
| `withCapability` | `25_mcp_server_http.mjs` |
| `withCassette` | `23_evals.mjs` |
| `withDecisionGate` | `04_judgment.mjs`, `12_knowledge_graph.mjs` |
| `withExecute` | `09_memory_and_todos.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `16_plan_and_execute.mjs` |
| `withExecutionJournal` | `20_durability.mjs` |
| `withGuardrails` | `06_approvals_and_safety.mjs` |
| `withInboxStore` | `07_agent_loop.mjs` |
| `withKnowledge` | `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs` |
| `withMemory` | `09_memory_and_todos.mjs` |
| `withObjective` | `15_delegation.mjs`, `16_plan_and_execute.mjs` |
| `withParameters` | `02_conversation.mjs`, `03_structured_output.mjs`, `05_tool_calling.mjs`, `08_resilience.mjs`, `10_multimodal.mjs` |
| `withPermissions` | `06_approvals_and_safety.mjs` |
| `withPlan` | `16_plan_and_execute.mjs` |
| `withPlanTools` | `16_plan_and_execute.mjs` |
| `withRetryPolicy` | `08_resilience.mjs` |
| `withSessionStore` | `06_approvals_and_safety.mjs`, `15_delegation.mjs`, `16_plan_and_execute.mjs`, `20_durability.mjs` |
| `withSkills` | `14_coding_agent.mjs` |
| `withStreamTimeout` | `08_resilience.mjs` |
| `withSystemMessage` | `01_quickstart.mjs`, `02_conversation.mjs`, `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `08_resilience.mjs`, `09_memory_and_todos.mjs`, `10_multimodal.mjs`, `11_web_tools.mjs`, `12_knowledge_graph.mjs`, `13_knowledge_corpus.mjs`, `14_coding_agent.mjs`, `15_delegation.mjs`, `20_durability.mjs`, `21_observability.mjs`, `22_telemetry.mjs`, `23_evals.mjs`, `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `26_a2a.mjs`, `27_acp_agent.mjs`, `28_workspace_isolation.mjs`, `32_agent_files.mjs` |
| `withTaskAgents` | `32_agent_files.mjs` |
| `withTelemetry` | `22_telemetry.mjs` |
| `withTodos` | `09_memory_and_todos.mjs`, `16_plan_and_execute.mjs` |
| `withTools` | `05_tool_calling.mjs`, `06_approvals_and_safety.mjs`, `07_agent_loop.mjs`, `14_coding_agent.mjs`, `16_plan_and_execute.mjs`, `20_durability.mjs`, `24_mcp_client.mjs`, `25_mcp_server_http.mjs`, `26_a2a.mjs`, `27_acp_agent.mjs`, `28_workspace_isolation.mjs` |
| `withToolTimeout` | `06_approvals_and_safety.mjs` |
| `withWebScrape` | `11_web_tools.mjs` |
| `withWebSearch` | `11_web_tools.mjs` |
| `withWorkspace` | `28_workspace_isolation.mjs` |

## 5. Shared example plumbing (`examples/_shared/`)

Repo-internal helpers; not part of the public SDK. Every example imports its bootstrap/observability from here.

| Module | Exports |
| --- | --- |
| `_shared/example-audit.mjs` | `createAudit`, `createRunLog`, `exampleIdFromArgv`, `wireAllEvents` |
| `_shared/example-utils.mjs` | `childLog`, `deltaUsage`, `isExitKeyword`, `judgeArtifact`, `parseLogArgs`, `readlineSafe`, `reportUsage`, `resolveExample`, `runMain`, `showPlan`, `spawnChild`, `trackUsage`, `warnEmptyAnswer`, `wireClient`, `wireDiscussionEvents`, `wireStateMachineEvents`, `wireTaskEvents`, `wireWorkflowEvents` |
| `_shared/real-tools.mjs` | `SCRATCH_DIR`, `createApplyPatchTool`, `createHttpProbeTool`, `createResolveParameterTool`, `createRestartSystemTool`, `createSecurityScanTool`, `createSyncDataTool`, `createValidateRemediationTool`, `startLocalApiServer` |
