# JavaScript Architecture & Coding Standards

This document defines the baseline JavaScript conventions for this project. All generated or refactored code must follow these patterns.

---

### 1. Function Signatures (Destructured Named Arguments)

Always prefer single-object parameter destructuring with an empty object default fallback (`{ ... } = {}`) for any function accepting options, configuration, or multiple parameters.

* **Rule:** Never use long positional parameter lists.
* **Rule:** Always provide a default `{}` so functions can be invoked without arguments when all options are optional.

```javascript
// ✅ Preferred
export async function fetchRecords({
  filter = {},
  limit = 20,
  offset = 0,
  signal,
} = {}) {
  // ...
}

// ❌ Avoid
export async function fetchRecords(filter, limit, offset, signal) {
  // ...
}
```

---

### 2. Fluent Chaining

Design builders, pipelines, and configuration APIs to support fluent method chaining.

* **Rule:** Configuration or mutation methods should return `this` (or a new instance for immutable pipelines).
* **Rule:** Provide clear terminal methods (e.g., `.build()`, `.execute()`, `.run()`, `.toResult()`) to finalize execution.

```javascript
// ✅ Preferred
export class QueryPipeline {
  constructor({ source } = {}) {
    this.source = source;
    this.steps = [];
  }

  filter({ predicate } = {}) {
    this.steps.push({ type: 'filter', fn: predicate });
    return this;
  }

  transform({ mapper } = {}) {
    this.steps.push({ type: 'map', fn: mapper });
    return this;
  }

  async execute() {
    return this.steps.reduce((data, step) => /* ... */, this.source);
  }
}

// Usage:
const results = await new QueryPipeline({ source: items })
  .filter({ predicate: (x) => x.active })
  .transform({ mapper: (x) => x.id })
  .execute();
```

---

### 3. Event-Driven Architecture

Decouple subsystems and cross-cutting concerns (logging, metrics, notifications, side effects) using events.

* **Rule:** Services should extend or compose `EventEmitter` (Node.js) or `EventTarget` (Browser / Web standards).
* **Rule:** State-changing methods should emit lifecycle events (`created`, `updated`, `failed`) rather than directly calling downstream consumers.
* **Rule:** Support fluent listener registration where possible.

```javascript
// ✅ Preferred
import { EventEmitter } from 'node:events';

export class JobRunner extends EventEmitter {
  constructor({ concurrency = 5 } = {}) {
    super();
    this.concurrency = concurrency;
  }

  async run({ job } = {}) {
    this.emit('job:start', { id: job.id });
    try {
      const result = await job.execute();
      this.emit('job:success', { id: job.id, result });
      return result;
    } catch (error) {
      this.emit('job:error', { id: job.id, error });
      throw error;
    }
  }
}
```

---

### 4. Reusability: Generic Core vs. Domain Adapters

Strictly separate **domain-agnostic core logic** from **domain-specific integrations**.

* **Rule: Core is Generic.** Place reusable data structures, utility functions, orchestration loops, and protocol handlers in shared modules. The core must have zero knowledge of business-specific entities.
* **Rule: Adapters for Domain Logic.** Wrap third-party APIs, database schemas, and application-specific business rules inside dedicated adapter layers.
* **Rule: Dependency Injection.** Pass domain adapters or hooks into generic engines via options objects.

```
src/
  ├── core/            # Domain-agnostic, reusable engines & utilities
  │   ├── queue.js
  │   └── pipeline.js
  └── adapters/        # Concrete domain implementations & integrations
      ├── stripe-billing.adapter.js
      └── user-notification.adapter.js
```

```javascript
// ✅ Core: Completely generic & reusable
export class TaskQueue extends EventEmitter {
  constructor({ worker } = {}) {
    super();
    this.worker = worker;
  }
  // Generic queue processing...
}

// ✅ Adapter: Only introduces domain-specific context
export function createBillingQueueAdapter({ stripeClient, queue } = {}) {
  queue.on('task:ready', async ({ invoiceId }) => {
    await stripeClient.invoices.pay(invoiceId);
  });
  return queue;
}
```

---

### Quick Agent Checklist

Before completing code generation, verify:
- [ ] Do functions use `{ param1, param2 } = {}`?
- [ ] Is configuration/pipeline logic chainable (`return this`)?
- [ ] Are side-effects decoupled via event emission rather than hard-coded calls?
- [ ] Is core business logic kept clean and generic, with specific dependencies isolated in adapters?