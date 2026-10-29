import type {JsonSchemaNode,ObjectJsonSchema} from '@deepseek-ai/dsh-tools';

/**
 * The structured-output contract for one round of speaking advice.
 *
 * Handed to the agent backend as `SubagentStartRequest.outputSchema`, where the
 * subagent driver validates the model's captured value against it before the
 * run may report `completed` — which is what lets the agent path skip the
 * free-form-JSON fragility the direct path has to defend against.
 *
 * Written inside the enforced subset (`ObjectJsonSchema`): one scalar `type`
 * per node, `properties`/`required`/boolean `additionalProperties`, `items`,
 * and annotations. Length and cardinality keywords are absent from that subset,
 * so the "3 questions", "80–140字", and "each list is 1–5" rules stay
 * unenforced here and remain `parseAdvice`'s job. Both checks run: the schema
 * proves the shape, the parser proves the bounds, the sourceIds, and the
 * human-readable labels.
 */
const sources:JsonSchemaNode={type:'array',items:{type:'string'},description:'引用资料中确实存在的 sourceId，例如 T12、F1、B_ROLE；没有依据时用空数组。'};

export const ADVICE_SCHEMA:ObjectJsonSchema={
  type:'object',
  additionalProperties:false,
  required:['summary','askedOfMe','askOthers','uncertainties','carryForward'],
  properties:{
    summary:{type:'string',description:'从用户角色看本段讨论的重点，1–2 句。'},
    askedOfMe:{
      type:'array',
      description:'最可能问到用户的问题；通常 3 个，信息有限时至少 1 个。',
      items:{
        type:'object',
        additionalProperties:false,
        required:['question','why','tactfulReply','conciseReply','sources'],
        properties:{
          question:{type:'string'},
          why:{type:'string',description:'为什么会问到用户；不猜测用户身份与决策权。'},
          tactfulReply:{type:'string',description:'高情商版，约80–140字，可直接说出口。'},
          conciseReply:{type:'string',description:'精简版，约20–60字，1–2 句。'},
          sources,
        },
      },
    },
    askOthers:{
      type:'array',
      description:'用户可以追问的问题；通常 3 个，与用户职责无关的不要凑数。',
      items:{
        type:'object',
        additionalProperties:false,
        required:['question','purpose','timing','sources'],
        properties:{
          question:{type:'string'},
          purpose:{type:'string',description:'为什么问这个问题。'},
          timing:{type:'string',description:'在什么时机问合适。'},
          sources,
        },
      },
    },
    uncertainties:{type:'array',items:{type:'string'},description:'需要进一步确认的信息。'},
    carryForward:{type:'string',description:'供下一轮使用的事实摘要：已确认的决策、约束、数字与悬而未决的问题。不要把本轮的问题和建议当成会议事实。'},
  },
};
