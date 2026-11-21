// @ts-check
// ponytail: regenerated after the JAI THINKING_BUDGET wire-position restore

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { ProviderType, StandardType } from '../lib/core/constants/index.mjs';
import { EVENTS } from '../lib/core/events.mjs';
import { z } from 'zod';
import {
    UnifiedParameterBuilder,
    buildParameterMapForOai,
    buildParameterMapForAai,
    buildParameterMapForGai,
    buildParameterMapForJai
} from '../lib/messaging/unified-parameter.mjs';

const STANDARDS = [StandardType.OAI, StandardType.AAI, StandardType.GAI, StandardType.JAI];
const PROVIDER_FOR_STANDARD = {
    [StandardType.OAI]: ProviderType.OPENAI,
    [StandardType.AAI]: ProviderType.ANTHROPIC,
    [StandardType.GAI]: ProviderType.GOOGLE_GENAI,
    [StandardType.JAI]: ProviderType.JAI,
};


const SMALL_SCHEMA = { type: 'object', properties: { a: { type: 'string' } } };


/** @type {Array<[string, (b: any) => any]>} */
export const CASES = [
    ['temperature', (b) => b.temperature({ v: 0.7 })],
    ['topP-topK', (b) => b.topP({ v: 0.9 }).topK({ v: 40 })],
    ['maxTokens', (b) => b.maxTokens({ v: 1024 })],
    ['stop-string', (b) => b.stop('STOP')],
    ['stop-array', (b) => b.stop(['A', 'B'])],
    ['seed', (b) => b.seed({ v: 42 })],
    ['stream', (b) => b.stream(true)],
    ['penalties', (b) => b.presencePenalty({ v: 0.1 }).frequencyPenalty({ v: 0.2 })],
    ['user', (b) => b.user('u-1')],
    ['rf-text', (b) => b.asText()],
    ['rf-json-object', (b) => b.asJson()],
    ['rf-json', (b) => b.responseFormat({ v: { type: 'json' } })],
    ['rf-json-schema', (b) => b.asJsonSchema({ config: { name: 'out', schema: SMALL_SCHEMA } })],
    ['rf-json-schema-no-name', (b) => b.asJsonSchema({ config: SMALL_SCHEMA })],
    ['withSchema-alias', (b) => b.withSchema({ schema: SMALL_SCHEMA })],
    ['schema-plain-hostile', (b) => b.asJsonSchema({ config: { schema: { anyOf: [SMALL_SCHEMA] } } })],
    ['tools-empty', (b) => b.tools([])],
    ['tools-function', (b) => b.tools([{ name: 'f', description: 'd', parameters: SMALL_SCHEMA }])],
    ['tools-underscore', (b) => b.tools([{ name: 'g', description: 'd', input_schema: SMALL_SCHEMA }])],
    ['tools-zod', (b) => b.tools([{ name: 'z', description: 'd', parameters: z.object({ q: z.string() }) }])],
    ['tools-zod-hostile', (b) => b.tools([{ name: 'h', description: 'd', parameters: z.object({ q: z.string().nullable() }) }])],
    ['toolChoice-auto', (b) => b.toolChoice({ v: 'auto' })],
    ['toolChoice-required', (b) => b.toolChoice({ v: 'required' })],
    ['toolChoice-none', (b) => b.toolChoiceNone()],
    ['toolChoice-named', (b) => b.toolChoiceNamed({ name: 'f' })],
    ['toolChoice-oai-object', (b) => b.toolChoice({ v: { type: 'function', function: { name: 'z' } } })],
    ['parallelToolCalls', (b) => b.parallelToolCalls({ v: false })],
    ['reasoningEffort', (b) => b.reasoningEffort({ v: 'high' })],
    ['reasoningSummary', (b) => b.reasoningSummary({ v: 'auto' })],
    ['thinkingBudget', (b) => b.thinkingBudget({ v: 2048 })],
    ['thinkingBudget-zero', (b) => b.thinkingBudget({ v: 0 })],
    ['thinkingLevel', (b) => b.thinkingLevel({ v: 'medium' })],
    ['thinkingLevel+thinkingBudget', (b) => b.thinkingLevel({ v: 'high' }).thinkingBudget({ v: 512 })],
    ['predictedOutput', (b) => b.predictedOutput({ v: 'draft' })],
    ['cachePoints', (b) => b.cachePoints({ v: { c: 1 } })],
    ['numberOfChoices', (b) => b.numberOfChoices({ v: 3 })],
    ['verbosity', (b) => b.verbosity({ v: 'low' })],
    ['promptCacheKey', (b) => b.promptCacheKey({ v: 'key-1' })],
    ['metadata', (b) => b.metadata({ v: { k: 'v' } })],
    ['length-alias', (b) => b.length({ v: 512 })],
    ['stopToken-alias', (b) => b.stopToken({ v: 'T' })],
    ['asTool-with-schema', (b) => b.asJsonSchema({ config: { schema: SMALL_SCHEMA } }).asTool({ toolName: 'my_out' })],
    ['asTool-with-schema-and-tools', (b) => b
        .tools([{ name: 'f', description: 'd', parameters: SMALL_SCHEMA }])
        .asJsonSchema({ config: { schema: SMALL_SCHEMA } })
        .asTool({ toolName: 'my_out' })],
    ['asTool-no-schema', (b) => b.asTool()],
    ['jai-thinking-order', (b) => b.thinkingBudget({ v: 100 }).numberOfChoices({ v: 3 }).verbosity({ v: 'low' }).promptCacheKey({ v: 'k' })],
    ['kitchen-sink', (b) => b
        .temperature({ v: 0.2 }).topP({ v: 0.8 }).topK({ v: 5 }).maxTokens({ v: 256 }).stop(['S1', 'S2']).seed({ v: 7 })
        .stream(true).presencePenalty({ v: 0 }).frequencyPenalty({ v: 0 }).user('u')
        .asJsonSchema({ config: { name: 'ks', schema: SMALL_SCHEMA } })
        .tools([
            { name: 'f', description: 'd', parameters: SMALL_SCHEMA },
            { name: 'g', description: 'd2', input_schema: SMALL_SCHEMA }
        ])
        .toolChoiceNamed({ name: 'f' }).parallelToolCalls({ v: true })
        .reasoningEffort({ v: 'low' }).reasoningSummary({ v: 'auto' })
        .thinkingBudget({ v: 1024 }).thinkingLevel({ v: 'low' })
        .predictedOutput({ v: 'p' }).cachePoints({ v: { c: 1 } }).numberOfChoices({ v: 2 })
        .verbosity({ v: 'high' }).promptCacheKey({ v: 'k' }).metadata({ v: { m: 1 } })
        .length({ v: 128 }).stopToken({ v: 'X' })],
];


/**
  * @param {{id: *, standard?: *}} arg0
 */
function executeCase({ id, standard }) {
    const entry =  (CASES.find(([cid]) => cid === id));
    const emitter = new EventEmitter();
    
    /** @type {any[]} */
        const warnings = [];
    emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, (e) => {
        const { ts, ...rest } = e;
        warnings.push(rest);
    });
    const b = new UnifiedParameterBuilder({ model: 'test-model', eventEmitter: emitter, provider: /** @type {string} */ (PROVIDER_FOR_STANDARD[standard]), standard });
    /** @type {any} */ (entry)[1](b);
    const spec = b._build();
    return {
        wire: JSON.stringify(spec),
        warnings,
        maps: {
            oai: JSON.stringify(buildParameterMapForOai({ spec })),
            aai: JSON.stringify(buildParameterMapForAai({ spec })),
            gai: JSON.stringify(buildParameterMapForGai({ spec })),
            jai: JSON.stringify(buildParameterMapForJai({ spec }))
        }
    };
}


/** @type {Record<string, Record<string, { wire: string, warnings: any[], maps: Record<string, string> }>>} */
const EXPECTED = {
  "temperature": {
    "oai": {
      "wire": "{\"temperature\":0.7}",
      "warnings": [],
      "maps": {
        "oai": "{\"temperature\":0.7}",
        "aai": "{\"temperature\":0.7}",
        "gai": "{\"temperature\":0.7}",
        "jai": "{\"TEMPERATURE\":0.7}"
      }
    },
    "aai": {
      "wire": "{\"temperature\":0.7}",
      "warnings": [],
      "maps": {
        "oai": "{\"temperature\":0.7}",
        "aai": "{\"temperature\":0.7}",
        "gai": "{\"temperature\":0.7}",
        "jai": "{\"TEMPERATURE\":0.7}"
      }
    },
    "gai": {
      "wire": "{\"temperature\":0.7}",
      "warnings": [],
      "maps": {
        "oai": "{\"temperature\":0.7}",
        "aai": "{\"temperature\":0.7}",
        "gai": "{\"temperature\":0.7}",
        "jai": "{\"TEMPERATURE\":0.7}"
      }
    },
    "jai": {
      "wire": "{\"temperature\":0.7}",
      "warnings": [],
      "maps": {
        "oai": "{\"temperature\":0.7}",
        "aai": "{\"temperature\":0.7}",
        "gai": "{\"temperature\":0.7}",
        "jai": "{\"TEMPERATURE\":0.7}"
      }
    }
  },
  "topP-topK": {
    "oai": {
      "wire": "{\"topP\":0.9}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "topK",
          "message": "Parameter 'topK' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"top_p\":0.9}",
        "aai": "{\"top_p\":0.9}",
        "gai": "{\"topP\":0.9}",
        "jai": "{\"TOP_P\":0.9}"
      }
    },
    "aai": {
      "wire": "{\"topP\":0.9,\"topK\":40}",
      "warnings": [],
      "maps": {
        "oai": "{\"top_p\":0.9}",
        "aai": "{\"top_p\":0.9,\"top_k\":40}",
        "gai": "{\"topP\":0.9,\"topK\":40}",
        "jai": "{\"TOP_P\":0.9,\"TOP_K\":40}"
      }
    },
    "gai": {
      "wire": "{\"topP\":0.9,\"topK\":40}",
      "warnings": [],
      "maps": {
        "oai": "{\"top_p\":0.9}",
        "aai": "{\"top_p\":0.9,\"top_k\":40}",
        "gai": "{\"topP\":0.9,\"topK\":40}",
        "jai": "{\"TOP_P\":0.9,\"TOP_K\":40}"
      }
    },
    "jai": {
      "wire": "{\"topP\":0.9,\"topK\":40}",
      "warnings": [],
      "maps": {
        "oai": "{\"top_p\":0.9}",
        "aai": "{\"top_p\":0.9,\"top_k\":40}",
        "gai": "{\"topP\":0.9,\"topK\":40}",
        "jai": "{\"TOP_P\":0.9,\"TOP_K\":40}"
      }
    }
  },
  "maxTokens": {
    "oai": {
      "wire": "{\"maxTokens\":1024}",
      "warnings": [],
      "maps": {
        "oai": "{\"max_tokens\":1024}",
        "aai": "{\"max_tokens\":1024}",
        "gai": "{\"maxOutputTokens\":1024}",
        "jai": "{\"LENGTH\":1024}"
      }
    },
    "aai": {
      "wire": "{\"maxTokens\":1024}",
      "warnings": [],
      "maps": {
        "oai": "{\"max_tokens\":1024}",
        "aai": "{\"max_tokens\":1024}",
        "gai": "{\"maxOutputTokens\":1024}",
        "jai": "{\"LENGTH\":1024}"
      }
    },
    "gai": {
      "wire": "{\"maxTokens\":1024}",
      "warnings": [],
      "maps": {
        "oai": "{\"max_tokens\":1024}",
        "aai": "{\"max_tokens\":1024}",
        "gai": "{\"maxOutputTokens\":1024}",
        "jai": "{\"LENGTH\":1024}"
      }
    },
    "jai": {
      "wire": "{\"maxTokens\":1024}",
      "warnings": [],
      "maps": {
        "oai": "{\"max_tokens\":1024}",
        "aai": "{\"max_tokens\":1024}",
        "gai": "{\"maxOutputTokens\":1024}",
        "jai": "{\"LENGTH\":1024}"
      }
    }
  },
  "stop-string": {
    "oai": {
      "wire": "{\"stop\":\"STOP\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":\"STOP\"}",
        "aai": "{\"stop_sequences\":[\"STOP\"]}",
        "gai": "{\"stopSequences\":[\"STOP\"]}",
        "jai": "{\"STOP_TOKEN\":\"STOP\"}"
      }
    },
    "aai": {
      "wire": "{\"stop\":\"STOP\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":\"STOP\"}",
        "aai": "{\"stop_sequences\":[\"STOP\"]}",
        "gai": "{\"stopSequences\":[\"STOP\"]}",
        "jai": "{\"STOP_TOKEN\":\"STOP\"}"
      }
    },
    "gai": {
      "wire": "{\"stop\":\"STOP\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":\"STOP\"}",
        "aai": "{\"stop_sequences\":[\"STOP\"]}",
        "gai": "{\"stopSequences\":[\"STOP\"]}",
        "jai": "{\"STOP_TOKEN\":\"STOP\"}"
      }
    },
    "jai": {
      "wire": "{\"stop\":\"STOP\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":\"STOP\"}",
        "aai": "{\"stop_sequences\":[\"STOP\"]}",
        "gai": "{\"stopSequences\":[\"STOP\"]}",
        "jai": "{\"STOP_TOKEN\":\"STOP\"}"
      }
    }
  },
  "stop-array": {
    "oai": {
      "wire": "{\"stop\":[\"A\",\"B\"]}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":[\"A\",\"B\"]}",
        "aai": "{\"stop_sequences\":[\"A\",\"B\"]}",
        "gai": "{\"stopSequences\":[\"A\",\"B\"]}",
        "jai": "{\"STOP_TOKEN\":\"A\"}"
      }
    },
    "aai": {
      "wire": "{\"stop\":[\"A\",\"B\"]}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":[\"A\",\"B\"]}",
        "aai": "{\"stop_sequences\":[\"A\",\"B\"]}",
        "gai": "{\"stopSequences\":[\"A\",\"B\"]}",
        "jai": "{\"STOP_TOKEN\":\"A\"}"
      }
    },
    "gai": {
      "wire": "{\"stop\":[\"A\",\"B\"]}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":[\"A\",\"B\"]}",
        "aai": "{\"stop_sequences\":[\"A\",\"B\"]}",
        "gai": "{\"stopSequences\":[\"A\",\"B\"]}",
        "jai": "{\"STOP_TOKEN\":\"A\"}"
      }
    },
    "jai": {
      "wire": "{\"stop\":[\"A\",\"B\"]}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":[\"A\",\"B\"]}",
        "aai": "{\"stop_sequences\":[\"A\",\"B\"]}",
        "gai": "{\"stopSequences\":[\"A\",\"B\"]}",
        "jai": "{\"STOP_TOKEN\":\"A\"}"
      }
    }
  },
  "seed": {
    "oai": {
      "wire": "{\"seed\":42}",
      "warnings": [],
      "maps": {
        "oai": "{\"seed\":42}",
        "aai": "{}",
        "gai": "{\"seed\":42}",
        "jai": "{\"SEED\":42}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "seed",
          "message": "Parameter 'seed' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{\"seed\":42}",
      "warnings": [],
      "maps": {
        "oai": "{\"seed\":42}",
        "aai": "{}",
        "gai": "{\"seed\":42}",
        "jai": "{\"SEED\":42}"
      }
    },
    "jai": {
      "wire": "{\"seed\":42}",
      "warnings": [],
      "maps": {
        "oai": "{\"seed\":42}",
        "aai": "{}",
        "gai": "{\"seed\":42}",
        "jai": "{\"SEED\":42}"
      }
    }
  },
  "stream": {
    "oai": {
      "wire": "{\"stream\":true}",
      "warnings": [],
      "maps": {
        "oai": "{\"stream\":true}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "stream",
          "message": "Parameter 'stream' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "stream",
          "message": "Parameter 'stream' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "stream",
          "message": "Parameter 'stream' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    }
  },
  "penalties": {
    "oai": {
      "wire": "{\"presencePenalty\":0.1,\"frequencyPenalty\":0.2}",
      "warnings": [],
      "maps": {
        "oai": "{\"presence_penalty\":0.1,\"frequency_penalty\":0.2}",
        "aai": "{}",
        "gai": "{\"presencePenalty\":0.1,\"frequencyPenalty\":0.2}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "presencePenalty",
          "message": "Parameter 'presencePenalty' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "frequencyPenalty",
          "message": "Parameter 'frequencyPenalty' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{\"presencePenalty\":0.1,\"frequencyPenalty\":0.2}",
      "warnings": [],
      "maps": {
        "oai": "{\"presence_penalty\":0.1,\"frequency_penalty\":0.2}",
        "aai": "{}",
        "gai": "{\"presencePenalty\":0.1,\"frequencyPenalty\":0.2}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"presencePenalty\":0.1,\"frequencyPenalty\":0.2}",
      "warnings": [],
      "maps": {
        "oai": "{\"presence_penalty\":0.1,\"frequency_penalty\":0.2}",
        "aai": "{}",
        "gai": "{\"presencePenalty\":0.1,\"frequencyPenalty\":0.2}",
        "jai": "{}"
      }
    }
  },
  "user": {
    "oai": {
      "wire": "{\"user\":\"u-1\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"user\":\"u-1\"}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "user",
          "message": "Parameter 'user' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "user",
          "message": "Parameter 'user' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "user",
          "message": "Parameter 'user' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    }
  },
  "rf-text": {
    "oai": {
      "wire": "{\"responseFormat\":{\"type\":\"text\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"text\"}}",
        "aai": "{}",
        "gai": "{\"responseMimeType\":\"text/plain\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"text\"}}"
      }
    },
    "aai": {
      "wire": "{\"responseFormat\":{\"type\":\"text\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"text\"}}",
        "aai": "{}",
        "gai": "{\"responseMimeType\":\"text/plain\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"text\"}}"
      }
    },
    "gai": {
      "wire": "{\"responseFormat\":{\"type\":\"text\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"text\"}}",
        "aai": "{}",
        "gai": "{\"responseMimeType\":\"text/plain\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"text\"}}"
      }
    },
    "jai": {
      "wire": "{\"responseFormat\":{\"type\":\"text\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"text\"}}",
        "aai": "{}",
        "gai": "{\"responseMimeType\":\"text/plain\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"text\"}}"
      }
    }
  },
  "rf-json-object": {
    "oai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_object\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_object\"}}",
        "aai": "{\"_jsonMode\":true}",
        "gai": "{\"responseMimeType\":\"application/json\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\"},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "aai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_object\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_object\"}}",
        "aai": "{\"_jsonMode\":true}",
        "gai": "{\"responseMimeType\":\"application/json\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\"},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "gai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_object\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_object\"}}",
        "aai": "{\"_jsonMode\":true}",
        "gai": "{\"responseMimeType\":\"application/json\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\"},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "jai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_object\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_object\"}}",
        "aai": "{\"_jsonMode\":true}",
        "gai": "{\"responseMimeType\":\"application/json\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\"},\"TOOL_CHOICE_NONE\":true}"
      }
    }
  },
  "rf-json": {
    "oai": {
      "wire": "{\"responseFormat\":{\"type\":\"json\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json\"}}",
        "aai": "{\"_jsonMode\":true}",
        "gai": "{\"responseMimeType\":\"application/json\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\"},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "aai": {
      "wire": "{\"responseFormat\":{\"type\":\"json\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json\"}}",
        "aai": "{\"_jsonMode\":true}",
        "gai": "{\"responseMimeType\":\"application/json\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\"},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "gai": {
      "wire": "{\"responseFormat\":{\"type\":\"json\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json\"}}",
        "aai": "{\"_jsonMode\":true}",
        "gai": "{\"responseMimeType\":\"application/json\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\"},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "jai": {
      "wire": "{\"responseFormat\":{\"type\":\"json\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json\"}}",
        "aai": "{\"_jsonMode\":true}",
        "gai": "{\"responseMimeType\":\"application/json\"}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\"},\"TOOL_CHOICE_NONE\":true}"
      }
    }
  },
  "rf-json-schema": {
    "oai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "aai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "gai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "jai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    }
  },
  "rf-json-schema-no-name": {
    "oai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "aai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "gai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "jai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    }
  },
  "withSchema-alias": {
    "oai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "aai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "gai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "jai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NONE\":true}"
      }
    }
  },
  "schema-plain-hostile": {
    "oai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}}}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "schema",
          "message": "Schema uses anyOf, which JAI/Gemini reject — express it without unions or nullable fields.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "aai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}}}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "schema",
          "message": "Schema uses anyOf, which JAI/Gemini reject — express it without unions or nullable fields.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "gai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}}}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "schema",
          "message": "Schema uses anyOf, which JAI/Gemini reject — express it without unions or nullable fields.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}},\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "jai": {
      "wire": "{\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}}}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "schema",
          "message": "Schema uses anyOf, which JAI/Gemini reject — express it without unions or nullable fields.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"response\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}}}",
        "aai": "{\"_jsonMode\":true,\"_jsonSchema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}",
        "gai": "{\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}}",
        "jai": "{\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}]}},\"TOOL_CHOICE_NONE\":true}"
      }
    }
  },
  "tools-empty": {
    "oai": {
      "wire": "{\"tools\":[]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[]}",
        "aai": "{\"_tools\":[]}",
        "gai": "{\"_tools\":[]}",
        "jai": "{\"_tools\":[]}"
      }
    },
    "aai": {
      "wire": "{\"tools\":[]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[]}",
        "aai": "{\"_tools\":[]}",
        "gai": "{\"_tools\":[]}",
        "jai": "{\"_tools\":[]}"
      }
    },
    "gai": {
      "wire": "{\"tools\":[]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[]}",
        "aai": "{\"_tools\":[]}",
        "gai": "{\"_tools\":[]}",
        "jai": "{\"_tools\":[]}"
      }
    },
    "jai": {
      "wire": "{\"tools\":[]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[]}",
        "aai": "{\"_tools\":[]}",
        "gai": "{\"_tools\":[]}",
        "jai": "{\"_tools\":[]}"
      }
    }
  },
  "tools-function": {
    "oai": {
      "wire": "{\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "gai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "jai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "aai": {
      "wire": "{\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "gai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "jai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "gai": {
      "wire": "{\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "gai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "jai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "jai": {
      "wire": "{\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "gai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "jai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    }
  },
  "tools-underscore": {
    "oai": {
      "wire": "{\"tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"g\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "gai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "jai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "aai": {
      "wire": "{\"tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"g\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "gai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "jai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "gai": {
      "wire": "{\"tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"g\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "gai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "jai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "jai": {
      "wire": "{\"tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"g\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "gai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}",
        "jai": "{\"_tools\":[{\"name\":\"g\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    }
  },
  "tools-zod": {
    "oai": {
      "wire": "{\"tools\":[{\"name\":\"z\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"z\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
        "gai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
        "jai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}"
      }
    },
    "aai": {
      "wire": "{\"tools\":[{\"name\":\"z\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"z\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
        "gai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
        "jai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}"
      }
    },
    "gai": {
      "wire": "{\"tools\":[{\"name\":\"z\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"z\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
        "gai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
        "jai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}"
      }
    },
    "jai": {
      "wire": "{\"tools\":[{\"name\":\"z\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"z\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
        "gai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}",
        "jai": "{\"_tools\":[{\"name\":\"z\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}},\"required\":[\"q\"]}}]}"
      }
    }
  },
  "tools-zod-hostile": {
    "oai": {
      "wire": "{\"tools\":[{\"name\":\"h\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "tool.parameters[h]",
          "message": "Schema uses type[], which JAI/Gemini reject — express it without unions or nullable fields.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"h\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
        "gai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
        "jai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}"
      }
    },
    "aai": {
      "wire": "{\"tools\":[{\"name\":\"h\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "tool.parameters[h]",
          "message": "Schema uses type[], which JAI/Gemini reject — express it without unions or nullable fields.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"h\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
        "gai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
        "jai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}"
      }
    },
    "gai": {
      "wire": "{\"tools\":[{\"name\":\"h\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "tool.parameters[h]",
          "message": "Schema uses type[], which JAI/Gemini reject — express it without unions or nullable fields.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"h\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
        "gai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
        "jai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}"
      }
    },
    "jai": {
      "wire": "{\"tools\":[{\"name\":\"h\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "tool.parameters[h]",
          "message": "Schema uses type[], which JAI/Gemini reject — express it without unions or nullable fields.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"h\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}}]}",
        "aai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
        "gai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}",
        "jai": "{\"_tools\":[{\"name\":\"h\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"q\"]}}]}"
      }
    }
  },
  "toolChoice-auto": {
    "oai": {
      "wire": "{\"toolChoice\":\"auto\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"auto\"}",
        "aai": "{\"_toolChoice\":\"auto\"}",
        "gai": "{\"_toolConfig\":\"auto\"}",
        "jai": "{\"TOOL_CHOICE_AUTO\":true}"
      }
    },
    "aai": {
      "wire": "{\"toolChoice\":\"auto\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"auto\"}",
        "aai": "{\"_toolChoice\":\"auto\"}",
        "gai": "{\"_toolConfig\":\"auto\"}",
        "jai": "{\"TOOL_CHOICE_AUTO\":true}"
      }
    },
    "gai": {
      "wire": "{\"toolChoice\":\"auto\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"auto\"}",
        "aai": "{\"_toolChoice\":\"auto\"}",
        "gai": "{\"_toolConfig\":\"auto\"}",
        "jai": "{\"TOOL_CHOICE_AUTO\":true}"
      }
    },
    "jai": {
      "wire": "{\"toolChoice\":\"auto\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"auto\"}",
        "aai": "{\"_toolChoice\":\"auto\"}",
        "gai": "{\"_toolConfig\":\"auto\"}",
        "jai": "{\"TOOL_CHOICE_AUTO\":true}"
      }
    }
  },
  "toolChoice-required": {
    "oai": {
      "wire": "{\"toolChoice\":\"required\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"required\"}",
        "aai": "{\"_toolChoice\":\"any\"}",
        "gai": "{\"_toolConfig\":\"required\"}",
        "jai": "{\"TOOL_CHOICE_REQUIRED\":true}"
      }
    },
    "aai": {
      "wire": "{\"toolChoice\":\"required\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"required\"}",
        "aai": "{\"_toolChoice\":\"any\"}",
        "gai": "{\"_toolConfig\":\"required\"}",
        "jai": "{\"TOOL_CHOICE_REQUIRED\":true}"
      }
    },
    "gai": {
      "wire": "{\"toolChoice\":\"required\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"required\"}",
        "aai": "{\"_toolChoice\":\"any\"}",
        "gai": "{\"_toolConfig\":\"required\"}",
        "jai": "{\"TOOL_CHOICE_REQUIRED\":true}"
      }
    },
    "jai": {
      "wire": "{\"toolChoice\":\"required\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"required\"}",
        "aai": "{\"_toolChoice\":\"any\"}",
        "gai": "{\"_toolConfig\":\"required\"}",
        "jai": "{\"TOOL_CHOICE_REQUIRED\":true}"
      }
    }
  },
  "toolChoice-none": {
    "oai": {
      "wire": "{\"toolChoice\":\"none\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"none\"}",
        "aai": "{\"_toolChoice\":\"none\"}",
        "gai": "{\"_toolConfig\":\"none\"}",
        "jai": "{\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "aai": {
      "wire": "{\"toolChoice\":\"none\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"none\"}",
        "aai": "{\"_toolChoice\":\"none\"}",
        "gai": "{\"_toolConfig\":\"none\"}",
        "jai": "{\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "gai": {
      "wire": "{\"toolChoice\":\"none\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"none\"}",
        "aai": "{\"_toolChoice\":\"none\"}",
        "gai": "{\"_toolConfig\":\"none\"}",
        "jai": "{\"TOOL_CHOICE_NONE\":true}"
      }
    },
    "jai": {
      "wire": "{\"toolChoice\":\"none\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":\"none\"}",
        "aai": "{\"_toolChoice\":\"none\"}",
        "gai": "{\"_toolConfig\":\"none\"}",
        "jai": "{\"TOOL_CHOICE_NONE\":true}"
      }
    }
  },
  "toolChoice-named": {
    "oai": {
      "wire": "{\"toolChoice\":{\"type\":\"named\",\"name\":\"f\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"f\"}}}",
        "aai": "{\"_toolChoice\":{\"type\":\"tool\",\"name\":\"f\"}}",
        "gai": "{\"_toolConfig\":{\"type\":\"named\",\"name\":\"f\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"f\"}"
      }
    },
    "aai": {
      "wire": "{\"toolChoice\":{\"type\":\"named\",\"name\":\"f\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"f\"}}}",
        "aai": "{\"_toolChoice\":{\"type\":\"tool\",\"name\":\"f\"}}",
        "gai": "{\"_toolConfig\":{\"type\":\"named\",\"name\":\"f\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"f\"}"
      }
    },
    "gai": {
      "wire": "{\"toolChoice\":{\"type\":\"named\",\"name\":\"f\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"f\"}}}",
        "aai": "{\"_toolChoice\":{\"type\":\"tool\",\"name\":\"f\"}}",
        "gai": "{\"_toolConfig\":{\"type\":\"named\",\"name\":\"f\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"f\"}"
      }
    },
    "jai": {
      "wire": "{\"toolChoice\":{\"type\":\"named\",\"name\":\"f\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"f\"}}}",
        "aai": "{\"_toolChoice\":{\"type\":\"tool\",\"name\":\"f\"}}",
        "gai": "{\"_toolConfig\":{\"type\":\"named\",\"name\":\"f\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"f\"}"
      }
    }
  },
  "toolChoice-oai-object": {
    "oai": {
      "wire": "{\"toolChoice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "aai": "{\"_toolChoice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "gai": "{\"_toolConfig\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{\"toolChoice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "aai": "{\"_toolChoice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "gai": "{\"_toolConfig\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{\"toolChoice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "aai": "{\"_toolChoice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "gai": "{\"_toolConfig\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"toolChoice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "aai": "{\"_toolChoice\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "gai": "{\"_toolConfig\":{\"type\":\"function\",\"function\":{\"name\":\"z\"}}}",
        "jai": "{}"
      }
    }
  },
  "parallelToolCalls": {
    "oai": {
      "wire": "{\"parallelToolCalls\":false}",
      "warnings": [],
      "maps": {
        "oai": "{\"parallel_tool_calls\":false}",
        "aai": "{\"_parallelToolCalls\":false}",
        "gai": "{}",
        "jai": "{\"PARALLEL_TOOL_CALLS\":false}"
      }
    },
    "aai": {
      "wire": "{\"parallelToolCalls\":false}",
      "warnings": [],
      "maps": {
        "oai": "{\"parallel_tool_calls\":false}",
        "aai": "{\"_parallelToolCalls\":false}",
        "gai": "{}",
        "jai": "{\"PARALLEL_TOOL_CALLS\":false}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "parallelToolCalls",
          "message": "Parameter 'parallelToolCalls' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"parallelToolCalls\":false}",
      "warnings": [],
      "maps": {
        "oai": "{\"parallel_tool_calls\":false}",
        "aai": "{\"_parallelToolCalls\":false}",
        "gai": "{}",
        "jai": "{\"PARALLEL_TOOL_CALLS\":false}"
      }
    }
  },
  "reasoningEffort": {
    "oai": {
      "wire": "{\"reasoningEffort\":\"high\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"reasoning_effort\":\"high\"}",
        "aai": "{\"output_config\":{\"effort\":\"high\"}}",
        "gai": "{}",
        "jai": "{\"REASONING_EFFORT\":\"high\"}"
      }
    },
    "aai": {
      "wire": "{\"reasoningEffort\":\"high\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"reasoning_effort\":\"high\"}",
        "aai": "{\"output_config\":{\"effort\":\"high\"}}",
        "gai": "{}",
        "jai": "{\"REASONING_EFFORT\":\"high\"}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "reasoningEffort",
          "message": "Parameter 'reasoningEffort' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"reasoningEffort\":\"high\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"reasoning_effort\":\"high\"}",
        "aai": "{\"output_config\":{\"effort\":\"high\"}}",
        "gai": "{}",
        "jai": "{\"REASONING_EFFORT\":\"high\"}"
      }
    }
  },
  "reasoningSummary": {
    "oai": {
      "wire": "{\"reasoningSummary\":\"auto\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"reasoning_summary\":\"auto\"}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"REASONING_SUMMARY\":\"auto\"}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "reasoningSummary",
          "message": "Parameter 'reasoningSummary' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "reasoningSummary",
          "message": "Parameter 'reasoningSummary' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"reasoningSummary\":\"auto\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"reasoning_summary\":\"auto\"}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"REASONING_SUMMARY\":\"auto\"}"
      }
    }
  },
  "thinkingBudget": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingBudget",
          "message": "Parameter 'thinkingBudget' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{\"thinkingBudget\":2048}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":2048}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":2048,\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":2048}"
      }
    },
    "gai": {
      "wire": "{\"thinkingBudget\":2048}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":2048}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":2048,\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":2048}"
      }
    },
    "jai": {
      "wire": "{\"thinkingBudget\":2048}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":2048}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":2048,\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":2048}"
      }
    }
  },
  "thinkingBudget-zero": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingBudget",
          "message": "Parameter 'thinkingBudget' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{\"thinkingBudget\":0}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"disabled\"}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":0,\"includeThoughts\":false}}",
        "jai": "{\"THINKING_BUDGET\":0}"
      }
    },
    "gai": {
      "wire": "{\"thinkingBudget\":0}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"disabled\"}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":0,\"includeThoughts\":false}}",
        "jai": "{\"THINKING_BUDGET\":0}"
      }
    },
    "jai": {
      "wire": "{\"thinkingBudget\":0}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"disabled\"}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":0,\"includeThoughts\":false}}",
        "jai": "{\"THINKING_BUDGET\":0}"
      }
    }
  },
  "thinkingLevel": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{\"thinkingLevel\":\"medium\"}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{\"thinkingConfig\":{\"thinkingLevel\":\"medium\",\"includeThoughts\":true}}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    }
  },
  "thinkingLevel+thinkingBudget": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "thinkingBudget",
          "message": "Parameter 'thinkingBudget' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{\"thinkingBudget\":512}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":512}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":512,\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":512}"
      }
    },
    "gai": {
      "wire": "{\"thinkingLevel\":\"high\",\"thinkingBudget\":512}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":512}}",
        "gai": "{\"thinkingConfig\":{\"thinkingLevel\":\"high\",\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":512}"
      }
    },
    "jai": {
      "wire": "{\"thinkingBudget\":512}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":512}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":512,\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":512}"
      }
    }
  },
  "predictedOutput": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "predictedOutput",
          "message": "Parameter 'predictedOutput' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "predictedOutput",
          "message": "Parameter 'predictedOutput' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "predictedOutput",
          "message": "Parameter 'predictedOutput' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"predictedOutput\":\"draft\"}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"PREDICTED_OUTPUT\":\"draft\"}"
      }
    }
  },
  "cachePoints": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "cachePoints",
          "message": "Parameter 'cachePoints' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{\"cachePoints\":{\"c\":1}}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"_cachePoints\":1,\"_cachePointType\":\"ephemeral\"}",
        "gai": "{}",
        "jai": "{\"CACHE_POINTS\":{\"c\":1}}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "cachePoints",
          "message": "Parameter 'cachePoints' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"cachePoints\":{\"c\":1}}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"_cachePoints\":1,\"_cachePointType\":\"ephemeral\"}",
        "gai": "{}",
        "jai": "{\"CACHE_POINTS\":{\"c\":1}}"
      }
    }
  },
  "numberOfChoices": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"numberOfChoices\":3}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"NUMBER_OF_CHOICES\":3}"
      }
    }
  },
  "verbosity": {
    "oai": {
      "wire": "{\"verbosity\":\"low\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"verbosity\":\"low\"}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"VERBOSITY\":\"low\"}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "verbosity",
          "message": "Parameter 'verbosity' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "verbosity",
          "message": "Parameter 'verbosity' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"verbosity\":\"low\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"verbosity\":\"low\"}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"VERBOSITY\":\"low\"}"
      }
    }
  },
  "promptCacheKey": {
    "oai": {
      "wire": "{\"promptCacheKey\":\"key-1\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"prompt_cache_key\":\"key-1\"}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"PROMPT_CACHE_KEY\":\"key-1\"}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "promptCacheKey",
          "message": "Parameter 'promptCacheKey' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "promptCacheKey",
          "message": "Parameter 'promptCacheKey' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"promptCacheKey\":\"key-1\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"prompt_cache_key\":\"key-1\"}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"PROMPT_CACHE_KEY\":\"key-1\"}"
      }
    }
  },
  "metadata": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "metadata",
          "message": "Parameter 'metadata' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{\"metadata\":{\"k\":\"v\"}}",
      "warnings": [],
      "maps": {
        "oai": "{}",
        "aai": "{\"metadata\":{\"k\":\"v\"}}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "metadata",
          "message": "Parameter 'metadata' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "metadata",
          "message": "Parameter 'metadata' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    }
  },
  "length-alias": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "length",
          "message": "Parameter 'length' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "length",
          "message": "Parameter 'length' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "length",
          "message": "Parameter 'length' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{\"maxTokens\":512}",
      "warnings": [],
      "maps": {
        "oai": "{\"max_tokens\":512}",
        "aai": "{\"max_tokens\":512}",
        "gai": "{\"maxOutputTokens\":512}",
        "jai": "{\"LENGTH\":512}"
      }
    }
  },
  "stopToken-alias": {
    "oai": {
      "wire": "{\"stop\":\"T\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":\"T\"}",
        "aai": "{\"stop_sequences\":[\"T\"]}",
        "gai": "{\"stopSequences\":[\"T\"]}",
        "jai": "{\"STOP_TOKEN\":\"T\"}"
      }
    },
    "aai": {
      "wire": "{\"stop\":\"T\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":\"T\"}",
        "aai": "{\"stop_sequences\":[\"T\"]}",
        "gai": "{\"stopSequences\":[\"T\"]}",
        "jai": "{\"STOP_TOKEN\":\"T\"}"
      }
    },
    "gai": {
      "wire": "{\"stop\":\"T\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":\"T\"}",
        "aai": "{\"stop_sequences\":[\"T\"]}",
        "gai": "{\"stopSequences\":[\"T\"]}",
        "jai": "{\"STOP_TOKEN\":\"T\"}"
      }
    },
    "jai": {
      "wire": "{\"stop\":\"T\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"stop\":\"T\"}",
        "aai": "{\"stop_sequences\":[\"T\"]}",
        "gai": "{\"stopSequences\":[\"T\"]}",
        "jai": "{\"STOP_TOKEN\":\"T\"}"
      }
    }
  },
  "asTool-with-schema": {
    "oai": {
      "wire": "{\"tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_structured\":true}],\"toolChoice\":{\"type\":\"named\",\"name\":\"my_out\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"my_out\"}}}",
        "aai": "{\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"my_out\"}}",
        "gai": "{\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"my_out\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"my_out\",\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "aai": {
      "wire": "{\"tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_structured\":true}],\"toolChoice\":{\"type\":\"named\",\"name\":\"my_out\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"my_out\"}}}",
        "aai": "{\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"my_out\"}}",
        "gai": "{\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"my_out\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"my_out\",\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "gai": {
      "wire": "{\"tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_structured\":true}],\"toolChoice\":{\"type\":\"named\",\"name\":\"my_out\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"my_out\"}}}",
        "aai": "{\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"my_out\"}}",
        "gai": "{\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"my_out\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"my_out\",\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "jai": {
      "wire": "{\"tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_structured\":true}],\"toolChoice\":{\"type\":\"named\",\"name\":\"my_out\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"my_out\"}}}",
        "aai": "{\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"my_out\"}}",
        "gai": "{\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"my_out\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"my_out\",\"_tools\":[{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    }
  },
  "asTool-with-schema-and-tools": {
    "oai": {
      "wire": "{\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_structured\":true}],\"toolChoice\":{\"type\":\"named\",\"name\":\"my_out\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},{\"type\":\"function\",\"function\":{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"my_out\"}}}",
        "aai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"my_out\"}}",
        "gai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"my_out\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"my_out\",\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "aai": {
      "wire": "{\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_structured\":true}],\"toolChoice\":{\"type\":\"named\",\"name\":\"my_out\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},{\"type\":\"function\",\"function\":{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"my_out\"}}}",
        "aai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"my_out\"}}",
        "gai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"my_out\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"my_out\",\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "gai": {
      "wire": "{\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_structured\":true}],\"toolChoice\":{\"type\":\"named\",\"name\":\"my_out\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},{\"type\":\"function\",\"function\":{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"my_out\"}}}",
        "aai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"my_out\"}}",
        "gai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"my_out\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"my_out\",\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    },
    "jai": {
      "wire": "{\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_structured\":true}],\"toolChoice\":{\"type\":\"named\",\"name\":\"my_out\"}}",
      "warnings": [],
      "maps": {
        "oai": "{\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},{\"type\":\"function\",\"function\":{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"my_out\"}}}",
        "aai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"my_out\"}}",
        "gai": "{\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"my_out\"}}",
        "jai": "{\"TOOL_CHOICE_NAMED\":\"my_out\",\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"my_out\",\"description\":\"Return structured output matching the schema.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}]}"
      }
    }
  },
  "asTool-no-schema": {
    "oai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "asTool",
          "message": "Parameter 'asTool' is ignored without asJsonSchema/withSchema.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "aai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "asTool",
          "message": "Parameter 'asTool' is ignored without asJsonSchema/withSchema.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "gai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "asTool",
          "message": "Parameter 'asTool' is ignored without asJsonSchema/withSchema.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    },
    "jai": {
      "wire": "{}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "asTool",
          "message": "Parameter 'asTool' is ignored without asJsonSchema/withSchema.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{}"
      }
    }
  },
  "jai-thinking-order": {
    "oai": {
      "wire": "{\"verbosity\":\"low\",\"promptCacheKey\":\"k\"}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "thinkingBudget",
          "message": "Parameter 'thinkingBudget' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"verbosity\":\"low\",\"prompt_cache_key\":\"k\"}",
        "aai": "{}",
        "gai": "{}",
        "jai": "{\"VERBOSITY\":\"low\",\"PROMPT_CACHE_KEY\":\"k\"}"
      }
    },
    "aai": {
      "wire": "{\"thinkingBudget\":100}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "verbosity",
          "message": "Parameter 'verbosity' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "promptCacheKey",
          "message": "Parameter 'promptCacheKey' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":100}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":100,\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":100}"
      }
    },
    "gai": {
      "wire": "{\"thinkingBudget\":100}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "verbosity",
          "message": "Parameter 'verbosity' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "promptCacheKey",
          "message": "Parameter 'promptCacheKey' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":100}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":100,\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":100}"
      }
    },
    "jai": {
      "wire": "{\"thinkingBudget\":100,\"numberOfChoices\":3,\"verbosity\":\"low\",\"promptCacheKey\":\"k\"}",
      "warnings": [],
      "maps": {
        "oai": "{\"verbosity\":\"low\",\"prompt_cache_key\":\"k\"}",
        "aai": "{\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":100}}",
        "gai": "{\"thinkingConfig\":{\"thinkingBudget\":100,\"includeThoughts\":true}}",
        "jai": "{\"THINKING_BUDGET\":100,\"NUMBER_OF_CHOICES\":3,\"VERBOSITY\":\"low\",\"PROMPT_CACHE_KEY\":\"k\"}"
      }
    }
  },
  "kitchen-sink": {
    "oai": {
      "wire": "{\"temperature\":0.2,\"topP\":0.8,\"maxTokens\":256,\"stop\":\"X\",\"seed\":7,\"stream\":true,\"presencePenalty\":0,\"frequencyPenalty\":0,\"user\":\"u\",\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"ks\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"toolChoice\":{\"type\":\"named\",\"name\":\"f\"},\"parallelToolCalls\":true,\"reasoningEffort\":\"low\",\"reasoningSummary\":\"auto\",\"verbosity\":\"high\",\"promptCacheKey\":\"k\"}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "topK",
          "message": "Parameter 'topK' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "thinkingBudget",
          "message": "Parameter 'thinkingBudget' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "predictedOutput",
          "message": "Parameter 'predictedOutput' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "cachePoints",
          "message": "Parameter 'cachePoints' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "metadata",
          "message": "Parameter 'metadata' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "length",
          "message": "Parameter 'length' is ignored in oai standard.",
          "provider": "openai",
          "standard": "oai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"temperature\":0.2,\"top_p\":0.8,\"max_tokens\":256,\"stop\":\"X\",\"seed\":7,\"presence_penalty\":0,\"frequency_penalty\":0,\"reasoning_effort\":\"low\",\"reasoning_summary\":\"auto\",\"verbosity\":\"high\",\"user\":\"u\",\"stream\":true,\"parallel_tool_calls\":true,\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"ks\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},\"prompt_cache_key\":\"k\",\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},{\"type\":\"function\",\"function\":{\"name\":\"g\",\"description\":\"d2\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"f\"}}}",
        "aai": "{\"temperature\":0.2,\"top_p\":0.8,\"max_tokens\":256,\"stop_sequences\":[\"X\"],\"output_config\":{\"effort\":\"low\"},\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"f\"},\"_parallelToolCalls\":true}",
        "gai": "{\"temperature\":0.2,\"topP\":0.8,\"maxOutputTokens\":256,\"stopSequences\":[\"X\"],\"seed\":7,\"presencePenalty\":0,\"frequencyPenalty\":0,\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"f\"}}",
        "jai": "{\"TEMPERATURE\":0.2,\"TOP_P\":0.8,\"LENGTH\":256,\"STOP_TOKEN\":\"X\",\"SEED\":7,\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NAMED\":\"f\",\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"PARALLEL_TOOL_CALLS\":true,\"REASONING_EFFORT\":\"low\",\"REASONING_SUMMARY\":\"auto\",\"VERBOSITY\":\"high\",\"PROMPT_CACHE_KEY\":\"k\"}"
      }
    },
    "aai": {
      "wire": "{\"temperature\":0.2,\"topP\":0.8,\"topK\":5,\"maxTokens\":256,\"stop\":\"X\",\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"ks\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"toolChoice\":{\"type\":\"named\",\"name\":\"f\"},\"parallelToolCalls\":true,\"reasoningEffort\":\"low\",\"thinkingBudget\":1024,\"cachePoints\":{\"c\":1},\"metadata\":{\"m\":1}}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "seed",
          "message": "Parameter 'seed' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "stream",
          "message": "Parameter 'stream' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "presencePenalty",
          "message": "Parameter 'presencePenalty' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "frequencyPenalty",
          "message": "Parameter 'frequencyPenalty' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "user",
          "message": "Parameter 'user' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "reasoningSummary",
          "message": "Parameter 'reasoningSummary' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "predictedOutput",
          "message": "Parameter 'predictedOutput' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "verbosity",
          "message": "Parameter 'verbosity' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "promptCacheKey",
          "message": "Parameter 'promptCacheKey' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "length",
          "message": "Parameter 'length' is ignored in aai standard.",
          "provider": "anthropic",
          "standard": "aai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"temperature\":0.2,\"top_p\":0.8,\"max_tokens\":256,\"stop\":\"X\",\"reasoning_effort\":\"low\",\"parallel_tool_calls\":true,\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"ks\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},{\"type\":\"function\",\"function\":{\"name\":\"g\",\"description\":\"d2\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"f\"}}}",
        "aai": "{\"temperature\":0.2,\"top_p\":0.8,\"top_k\":5,\"max_tokens\":256,\"stop_sequences\":[\"X\"],\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":1024},\"output_config\":{\"effort\":\"low\"},\"metadata\":{\"m\":1},\"_cachePoints\":1,\"_cachePointType\":\"ephemeral\",\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"f\"},\"_parallelToolCalls\":true}",
        "gai": "{\"temperature\":0.2,\"topP\":0.8,\"topK\":5,\"maxOutputTokens\":256,\"stopSequences\":[\"X\"],\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"thinkingConfig\":{\"thinkingBudget\":1024,\"includeThoughts\":true},\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"f\"}}",
        "jai": "{\"TEMPERATURE\":0.2,\"TOP_P\":0.8,\"TOP_K\":5,\"LENGTH\":256,\"STOP_TOKEN\":\"X\",\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NAMED\":\"f\",\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"PARALLEL_TOOL_CALLS\":true,\"REASONING_EFFORT\":\"low\",\"CACHE_POINTS\":{\"c\":1}}"
      }
    },
    "gai": {
      "wire": "{\"temperature\":0.2,\"topP\":0.8,\"topK\":5,\"maxTokens\":256,\"stop\":\"X\",\"seed\":7,\"presencePenalty\":0,\"frequencyPenalty\":0,\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"ks\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"toolChoice\":{\"type\":\"named\",\"name\":\"f\"},\"thinkingBudget\":1024,\"thinkingLevel\":\"low\"}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "stream",
          "message": "Parameter 'stream' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "user",
          "message": "Parameter 'user' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "parallelToolCalls",
          "message": "Parameter 'parallelToolCalls' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "reasoningEffort",
          "message": "Parameter 'reasoningEffort' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "reasoningSummary",
          "message": "Parameter 'reasoningSummary' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "predictedOutput",
          "message": "Parameter 'predictedOutput' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "cachePoints",
          "message": "Parameter 'cachePoints' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "numberOfChoices",
          "message": "Parameter 'numberOfChoices' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "verbosity",
          "message": "Parameter 'verbosity' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "promptCacheKey",
          "message": "Parameter 'promptCacheKey' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "metadata",
          "message": "Parameter 'metadata' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "length",
          "message": "Parameter 'length' is ignored in gai standard.",
          "provider": "google_genai",
          "standard": "gai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"temperature\":0.2,\"top_p\":0.8,\"max_tokens\":256,\"stop\":\"X\",\"seed\":7,\"presence_penalty\":0,\"frequency_penalty\":0,\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"ks\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},{\"type\":\"function\",\"function\":{\"name\":\"g\",\"description\":\"d2\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"f\"}}}",
        "aai": "{\"temperature\":0.2,\"top_p\":0.8,\"top_k\":5,\"max_tokens\":256,\"stop_sequences\":[\"X\"],\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":1024},\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"f\"}}",
        "gai": "{\"temperature\":0.2,\"topP\":0.8,\"topK\":5,\"maxOutputTokens\":256,\"stopSequences\":[\"X\"],\"seed\":7,\"presencePenalty\":0,\"frequencyPenalty\":0,\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"thinkingConfig\":{\"thinkingLevel\":\"low\",\"includeThoughts\":true},\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"f\"}}",
        "jai": "{\"TEMPERATURE\":0.2,\"TOP_P\":0.8,\"TOP_K\":5,\"LENGTH\":256,\"STOP_TOKEN\":\"X\",\"SEED\":7,\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NAMED\":\"f\",\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"THINKING_BUDGET\":1024}"
      }
    },
    "jai": {
      "wire": "{\"temperature\":0.2,\"topP\":0.8,\"topK\":5,\"maxTokens\":128,\"stop\":\"X\",\"seed\":7,\"presencePenalty\":0,\"frequencyPenalty\":0,\"responseFormat\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"ks\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},\"tools\":[{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"toolChoice\":{\"type\":\"named\",\"name\":\"f\"},\"parallelToolCalls\":true,\"reasoningEffort\":\"low\",\"reasoningSummary\":\"auto\",\"thinkingBudget\":1024,\"predictedOutput\":\"p\",\"cachePoints\":{\"c\":1},\"numberOfChoices\":2,\"verbosity\":\"high\",\"promptCacheKey\":\"k\"}",
      "warnings": [
        {
          "model": "test-model",
          "parameter": "stream",
          "message": "Parameter 'stream' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "user",
          "message": "Parameter 'user' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "thinkingLevel",
          "message": "Parameter 'thinkingLevel' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        },
        {
          "model": "test-model",
          "parameter": "metadata",
          "message": "Parameter 'metadata' is ignored in jai standard.",
          "provider": "jai",
          "standard": "jai",
          "event": "parameter_warning",
          "runId": null,
          "parentRunId": null
        }
      ],
      "maps": {
        "oai": "{\"temperature\":0.2,\"top_p\":0.8,\"max_tokens\":128,\"stop\":\"X\",\"seed\":7,\"presence_penalty\":0,\"frequency_penalty\":0,\"reasoning_effort\":\"low\",\"reasoning_summary\":\"auto\",\"verbosity\":\"high\",\"parallel_tool_calls\":true,\"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"ks\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},\"prompt_cache_key\":\"k\",\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"description\":\"d\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}},{\"type\":\"function\",\"function\":{\"name\":\"g\",\"description\":\"d2\",\"parameters\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"f\"}}}",
        "aai": "{\"temperature\":0.2,\"top_p\":0.8,\"top_k\":5,\"max_tokens\":128,\"stop_sequences\":[\"X\"],\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":1024},\"output_config\":{\"effort\":\"low\"},\"_cachePoints\":1,\"_cachePointType\":\"ephemeral\",\"_jsonMode\":true,\"_jsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolChoice\":{\"type\":\"tool\",\"name\":\"f\"},\"_parallelToolCalls\":true}",
        "gai": "{\"temperature\":0.2,\"topP\":0.8,\"topK\":5,\"maxOutputTokens\":128,\"stopSequences\":[\"X\"],\"seed\":7,\"presencePenalty\":0,\"frequencyPenalty\":0,\"responseMimeType\":\"application/json\",\"responseJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}},\"thinkingConfig\":{\"thinkingBudget\":1024,\"includeThoughts\":true},\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"parametersJsonSchema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"_toolConfig\":{\"type\":\"named\",\"name\":\"f\"}}",
        "jai": "{\"TEMPERATURE\":0.2,\"TOP_P\":0.8,\"TOP_K\":5,\"LENGTH\":128,\"STOP_TOKEN\":\"X\",\"SEED\":7,\"RESPONSE_FORMAT\":{\"type\":\"json\",\"schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},\"TOOL_CHOICE_NAMED\":\"f\",\"_tools\":[{\"name\":\"f\",\"description\":\"d\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}},{\"name\":\"g\",\"description\":\"d2\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}}],\"PARALLEL_TOOL_CALLS\":true,\"REASONING_EFFORT\":\"low\",\"REASONING_SUMMARY\":\"auto\",\"PREDICTED_OUTPUT\":\"p\",\"CACHE_POINTS\":{\"c\":1},\"NUMBER_OF_CHOICES\":2,\"VERBOSITY\":\"high\",\"PROMPT_CACHE_KEY\":\"k\"}"
      }
    }
  }
};
describe('UnifiedParameterBuilder wire parity (captured from reference implementation)', () => {
    for (const [id] of CASES) {
        for (const standard of STANDARDS) {
            it(`${id} × ${standard}: _build() + translators + warnings byte-identical`, () => {
                const actual = executeCase({ id, standard });
                const expected = EXPECTED[id][standard];
                assert.equal(actual.wire, expected.wire, `_build() wire for ${id} × ${standard}`);
                assert.deepEqual(actual.warnings, expected.warnings, `warnings for ${id} × ${standard}`);
                const keys = /** @type {Array<'oai'|'aai'|'gai'|'jai'>} */ (['oai', 'aai', 'gai', 'jai']);
                for (const k of keys) {
                    assert.equal(actual.maps[k], expected.maps[k], `${k} translator for ${id} × ${standard}`);
                }
            });
        }
    }
});

// ─── fixture-keyed shortcuts are gone: a tool called `g` is an ordinary tool ──

describe('no fixture-keyed production branches (A2-7)', () => {
    it('keeps an input_schema tool named `g`/`d` on every wire', () => {
        const tools = [{ name: 'g', description: 'd', input_schema: SMALL_SCHEMA }];
        for (const model of ['test-model', 'gpt-4.1']) {
            const b = new UnifiedParameterBuilder({ model, eventEmitter: new EventEmitter(), provider: ProviderType.OPENAI });
            b.tools(tools);
            const spec = b._build();
            const oai = JSON.parse(JSON.stringify(buildParameterMapForOai({ spec })));
            const gai = JSON.parse(JSON.stringify(buildParameterMapForGai({ spec })));
            assert.deepEqual(oai.tools[0].function.parameters, SMALL_SCHEMA, `oai map keeps the schema for ${model}`);
            assert.deepEqual(gai._tools[0].parametersJsonSchema, SMALL_SCHEMA, `gai map keeps the schema for ${model}`);
        }
    });
});

// ─── fail-closed tools: an unconvertible Zod schema drops the tool (no empty schema) ──

describe('fail-closed Zod tool handling', () => {
    it('drops a tool whose schema cannot convert, warning with the tool name', () => {
        const emitter = new EventEmitter();
        
        /** @type {any[]} */
                const warnings = [];
        emitter.on(EVENTS.CLIENT.PARAMETER_WARNING, ( e) => {
            const { ts, ...rest } = e;
            warnings.push(rest);
        });
        const zodV3Like = { safeParse: () => ({ success: false }), _def: { typeName: 'ZodObject' } };
        const b = new UnifiedParameterBuilder({ model: 'm', eventEmitter: emitter, provider: ProviderType.OPENAI });
        b.tools([
            { name: 'broken', description: 'd', parameters: zodV3Like },
            { name: 'healthy', description: 'd', parameters: SMALL_SCHEMA }
        ]);
        const spec = b._build();
        assert.deepEqual(( (spec.tools ?? [])).map(/** @type {(...args: any[]) => any} */ ((t) => t.name)), ['healthy'],
            'the unconvertible tool must be dropped, never shipped with an empty schema');
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].parameter, 'tool.parameters[broken]');
        assert.match(warnings[0].message, /Zod schema could not be converted/);
    });
});
