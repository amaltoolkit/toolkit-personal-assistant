# **0\) Vision**

Deliver a Chrome extension companion for Blue Square Apps that:

1. Turns natural language into a reliable plan, executes in the right order, and asks for approval before any write.

2. Runs unrelated actions in parallel when safe.

3. Maintains session memory for multi‑turn work, plus user‑managed long‑term memory with CRUD inside the extension.

4. Answers “How do I…?” questions from a versioned, swappable KB with citations.

5. Always replies with a crisp, conversational final message that mirrors the user, reports actions, and proposes next steps.

Foundation: LangGraph JS for orchestration and persistence, LangChain JS for models, tools, and structured output, Supabase Postgres \+ pgvector for storage, Mem0 for auto‑extracted memory suggestions, Express on Vercel for the backend. ([LangChain](https://www.langchain.com/langgraph?utm_source=chatgpt.com))

---

# **1\) Architecture**

## **1.1 High‑level components**

* **Orchestrator graph** in LangGraph: Intent → Memory‑Recall → Planner → Parallel Design → Approval → Parallel Apply → Memory Synthesis → Mem0 Suggest → Conversational Finalizer. Supersteps provide transactional parallelism, and checkpointers persist state across turns. ([LangChain AI](https://langchain-ai.github.io/langgraph/how-tos/graph-api/?utm_source=chatgpt.com))

* **Planner** returns a typed DAG: `actions[{id, type, params, dependsOn}]` via LangChain structured output. ([Langchain](https://js.langchain.com/docs/concepts/structured_outputs/?utm_source=chatgpt.com))

* **Designer nodes** normalize payloads but never write.

* **Approval gate** uses LangGraph `interrupt()` to pause and resume with user decisions. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/concepts/human_in_the_loop/?utm_source=chatgpt.com))

* **Applier nodes** call Blue Square APIs using captured PassKey \+ OrgId.

* **Parallel fan‑out** per ready layer using LangGraph branching and `Send` for concurrent node execution. Supersteps are transactional. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/branching/?utm_source=chatgpt.com))

* **Session memory** via Postgres checkpointer, **long‑term memory** via LangGraph Store \+ pgvector semantic search, and **Mem0 suggestions** for auto‑extraction. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/persistence-postgres/?utm_source=chatgpt.com))

* **Knowledge Base**: versioned docsets in Supabase, chunked \+ embedded for RAG retrieval; answer with steps and citations. Supabase automatic embeddings can async‑update vectors. ([Supabase](https://supabase.com/docs/guides/ai/automatic-embeddings?utm_source=chatgpt.com))

* **Conversational Finalizer** produces the last message in a consistent voice with statuses, citations, and three follow‑up questions using structured output. ([Langchain](https://js.langchain.com/docs/concepts/structured_outputs/?utm_source=chatgpt.com))

* **Express on Vercel**: export the app as the module default. ([Vercel](https://vercel.com/docs/frameworks/backend/express?utm_source=chatgpt.com))

## **1.2 Data stores**

* **Supabase Postgres**

  * `ltm_memories` table with `embedding vector(1536)` for user CRUD and audits.

  * KB tables: `kb_docsets`, `kb_docs`, `kb_chunks` with `embedding vector(1536)`.

  * pgvector indexes for similarity search; optional Supabase automatic embeddings or Edge Functions for background embedding generation. ([Supabase](https://supabase.com/docs/guides/database/extensions/pgvector?utm_source=chatgpt.com))

## **1.3 Models and configuration**

* **Planner, Designers, Finalizer**: ChatOpenAI with `withStructuredOutput()` and Zod schemas for deterministic JSON. ([Langchain](https://js.langchain.com/docs/concepts/structured_outputs/?utm_source=chatgpt.com))

* **Tools**: build with `tool()` and Zod schemas; bind at the node or call directly. ([LangChain](https://api.js.langchain.com/functions/_langchain_core.tools.tool-1.html?utm_source=chatgpt.com), [Langchain](https://js.langchain.com/docs/how_to/tools_builtin/?utm_source=chatgpt.com))

* **RunnableConfig**: inject `configurable` values like `passKey`, `orgId`, `user_tz`, `safe_mode`, `thread_id`, and limit branch concurrency with `maxConcurrency`. ([LangChain](https://api.js.langchain.com/interfaces/langchain_core.runnables.RunnableConfig.html?utm_source=chatgpt.com), [Langchain](https://js.langchain.com/docs/concepts/runnables/?utm_source=chatgpt.com))

---

# **2\) Schemas and tables**

## **2.1 Long‑term memories**

create table if not exists ltm\_memories (  
  key uuid primary key,  
  org\_id text not null,  
  user\_id text not null,  
  namespace text\[\] not null,      \-- e.g. {org, user, memories}  
  kind text not null,             \-- user\_pref | team\_info | client\_note | fact  
  subject\_id text,  
  text text not null,  
  importance int default 3 check (importance between 1 and 5),  
  source text default 'manual',   \-- manual | auto | suggested  
  ttl\_days int,  
  created\_at timestamptz default now(),  
  updated\_at timestamptz default now(),  
  embedding vector(1536)  
);  
create index if not exists ltm\_memories\_embedding\_idx  
  on ltm\_memories using ivfflat (embedding vector\_l2\_ops);

1536 dims fits OpenAI `text-embedding-3-small` and Supabase vector columns. ([Supabase](https://supabase.com/docs/guides/ai/vector-columns?utm_source=chatgpt.com))

## **2.2 Knowledge Base**

create table if not exists kb\_docsets (  
  id uuid primary key default gen\_random\_uuid(),  
  slug text unique not null,  
  version text not null,  
  is\_active boolean default false,  
  created\_at timestamptz default now()  
);  
create table if not exists kb\_docs (  
  id uuid primary key default gen\_random\_uuid(),  
  docset\_id uuid references kb\_docsets(id) on delete cascade,  
  slug text not null,  
  title text not null,  
  url text,  
  updated\_at timestamptz not null,  
  body\_md text not null  
);  
create table if not exists kb\_chunks (  
  id uuid primary key default gen\_random\_uuid(),  
  doc\_id uuid references kb\_docs(id) on delete cascade,  
  chunk\_no int not null,  
  text text not null,  
  headings text\[\],  
  tokens int,  
  embedding vector(1536)  
);  
create index if not exists kb\_chunks\_emb\_idx on kb\_chunks using ivfflat (embedding vector\_l2\_ops);

Flip `is_active` to roll out new docsets without redeploy. Use Supabase automatic embeddings later to keep vectors in sync. ([Supabase](https://supabase.com/docs/guides/ai/automatic-embeddings?utm_source=chatgpt.com))

---

# **3\) Packages and environment**

pnpm add express  
pnpm add @langchain/langgraph @langchain/core @langchain/openai zod cross-fetch  
pnpm add @langchain/langgraph-checkpoint-postgres  
pnpm add dayjs dayjs-plugin-utc dayjs-plugin-timezone  
pnpm add mem0ai

* LangGraph JS quickstart and graph state via `MessagesAnnotation` are current patterns. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/tutorials/quickstart/?utm_source=chatgpt.com))

* PostgresSaver and PostgresStore are the supported persistence layers in JS. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/persistence-postgres/?utm_source=chatgpt.com))

---

# **4\) Core services in Node**

## **4.1 Graph state, checkpointer, store**

// src/graph/state.ts  
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";  
import { PostgresSaver, PostgresStore } from "@langchain/langgraph-checkpoint-postgres";  
import { OpenAIEmbeddings } from "@langchain/openai";

export const AppState \= Annotation.Root({  
  ...MessagesAnnotation.spec,                      // chat history  
  plan: Annotation\<any\[\]\>({ default: () \=\> \[\] }),  
  cursor: Annotation\<number\>({ default: () \=\> 0 }),  
  previews: Annotation\<any\[\]\>({  
    default: () \=\> \[\],  
    reducer: (a, b) \=\> a.concat(b)               // collect layer previews  
  }),  
  approvals: Annotation\<any | null\>({ default: () \=\> null }),  
  artifacts: Annotation\<Record\<string, any\>\>({ default: () \=\> ({}) }),  
  intent: Annotation\<string | null\>({ default: () \=\> null }),  
  kb: Annotation\<any | null\>({ default: () \=\> null })  
});

export const checkpointer \= PostgresSaver.fromConnString(process.env.SUPABASE\_DB\_URL\!); // call setup() on first boot  
const embeddings \= new OpenAIEmbeddings({ model: "text-embedding-3-small" });  
export const store \= PostgresStore.fromConnString(process.env.SUPABASE\_DB\_URL\!, {  
  index: { embeddings, dims: 1536, fields: \["text"\] } // enables semantic search  
}); // call setup() on first boot

MessagesAnnotation, supersteps, checkpointers, and Store are the recommended primitives in LangGraph JS. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/tutorials/quickstart/?utm_source=chatgpt.com))

## **4.2 Blue Square API tools**

// src/tools/bsa.ts  
import { tool } from "@langchain/core/tools";  
import { z } from "zod";  
import fetch from "cross-fetch";

function makePoster(BSA\_BASE: string, passKey: string, orgId: string) {  
  const url \= \`${BSA\_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json\`;  
  return async (objectName: string, DataObject: any) \=\> {  
    const payload \= { PassKey: passKey, OrganizationId: orgId, ObjectName: objectName, DataObject, IncludeExtendedProperties: false };  
    const resp \= await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });  
    if (\!resp.ok) throw new Error(\`${objectName} create failed: ${resp.status} ${resp.statusText}\`);  
    return await resp.json();  
  };  
}

export function makeWorkflowTools(cfg: { BSA\_BASE: string; passKey: string; orgId: string }) {  
  const post \= makePoster(cfg.BSA\_BASE, cfg.passKey, cfg.orgId);  
  const createWorkflowShell \= tool(async (i) \=\> post("advocate\_process", { Name: i.name, Description: i.description ?? "" }), {  
    name: "bsa\_create\_workflow\_shell",  
    description: "Create advocate\_process shell.",  
    schema: z.object({ name: z.string(), description: z.string().optional() })  
  });  
  const addWorkflowStep \= tool(async (i) \=\> post("advocate\_process\_template", { ...i, AdvocateProcessId: i.workflowId }), {  
    name: "bsa\_add\_workflow\_step",  
    description: "Add advocate\_process\_template step.",  
    schema: z.object({  
      workflowId: z.string(), subject: z.string(), sequence: z.number(),  
      description: z.string().optional(), activityType: z.enum(\["Task","Appointment"\]).optional(),  
      dayOffset: z.number().optional(), startTime: z.string().nullable().optional(), endTime: z.string().nullable().optional(),  
      allDay: z.boolean().optional(), assigneeType: z.string().optional(), assigneeId: z.string().nullable().optional(),  
      rollOver: z.boolean().optional(), location: z.string().nullable().optional(), appointmentTypeId: z.string().nullable().optional()  
    })  
  });  
  return { createWorkflowShell, addWorkflowStep };  
}

Tools in LangChain JS are created with `tool()` and Zod schemas. ([LangChain](https://api.js.langchain.com/functions/_langchain_core.tools.tool-1.html?utm_source=chatgpt.com))

---

# **5\) Intent, memory recall, planning**

## **5.1 Intent classification**

// src/graph/intent.ts  
import { z } from "zod";  
import { ChatOpenAI } from "@langchain/openai";  
const Intent \= z.object({ kind: z.enum(\["help\_kb","action","mixed"\]) });  
const ic \= new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });

export async function intentNode(state: any) {  
  const structured \= ic.withStructuredOutput(Intent);  
  const last \= String(state.messages.at(-1)?.content ?? "");  
  const out \= await structured.invoke(\`Classify as help\_kb, action, or mixed:\\n${last}\`);  
  return { intent: out.kind };  
}

`withStructuredOutput` is the recommended method for typed model outputs in JS. ([Langchain](https://js.langchain.com/docs/concepts/structured_outputs/?utm_source=chatgpt.com))

## **5.2 Memory recall before planning**

// src/memory/recall.ts  
export async function recallMemoryNode(state: any, config: any) {  
  const ns \= \[config.configurable.orgId, config.configurable.userId, "memories"\];  
  const query \= String(state.messages.at(-1)?.content ?? "");  
  const hits \= await config.store.search(ns, { query, limit: 5 });  
  if (\!hits?.length) return {};  
  const snippet \= hits.map((h: any) \=\> \`• ${h.value.text}\`).join("\\n");  
  return { messages: \[{ role: "system", content: \`Relevant context:\\n${snippet}\` }\] };  
}

LangGraph Store organizes memories by namespace and supports semantic search when configured with an index. ([LangChain AI](https://langchain-ai.github.io/langgraph/concepts/memory/?utm_source=chatgpt.com))

## **5.3 Planner returns a DAG**

// src/graph/plan.ts  
import { z } from "zod";  
import { ChatOpenAI } from "@langchain/openai";  
export const ActionSchema \= z.object({  
  id: z.string(),  
  type: z.enum(\["build\_workflow","create\_task","create\_appointment"\]),  
  params: z.record(z.any()).default({}),  
  dependsOn: z.array(z.string()).default(\[\])  
});  
export const PlanSchema \= z.object({ actions: z.array(ActionSchema) });

const planner \= new ChatOpenAI({ model: process.env.LLM\_PLANNER ?? "gpt-4o", temperature: 0 });

export async function planNode(state: any) {  
  const last \= String(state.messages.at(-1)?.content ?? "");  
  const structured \= planner.withStructuredOutput(PlanSchema);  
  const plan \= await structured.invoke(  
    \`Turn the user's request into a plan of actions with ids, params, and dependsOn. Use dependsOn only when order is required. User: ${last}\`  
  );  
  return { plan: plan.actions, cursor: 0 };  
}

Zod plus `withStructuredOutput` is the official JS pattern for strict JSON plans. ([Langchain](https://js.langchain.com/docs/how_to/structured_output/?utm_source=chatgpt.com))

---

# **6\) Parallel design, approval, and apply**

## **6.1 Fan‑out design**

// src/graph/parallel.ts  
import { Send } from "@langchain/langgraph";

function ready(state: any) {  
  const done \= new Set(state.artifacts?.doneIds ?? \[\]);  
  return state.plan.filter((a: any) \=\> \!done.has(a.id) && a.dependsOn.every((d: string) \=\> done.has(d)));  
}  
export function fanOutDesign(state: any) {  
  const r \= ready(state);  
  return r.map((a: any) \=\> new Send(\`design\_${a.type}\`, { action: a }));  
}

LangGraph supports parallel fan‑out and fan‑in. Supersteps are transactional. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/branching/?utm_source=chatgpt.com))

## **6.2 Batched approval with interrupt**

// src/graph/approval.ts  
import { interrupt } from "@langchain/langgraph";  
export function approvalBatchNode(state: any, config: any) {  
  if (\!config?.configurable?.safe\_mode) return {}; // auto-approve when safe mode is off  
  const decision \= interrupt({ kind: "approval\_batch", previews: state.previews });  
  return { approvals: decision }; // expected shape: { \[actionId\]: true|false }  
}

Human‑in‑the‑loop approvals use `interrupt()` and resume with a `Command` carrying the user’s input. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/concepts/human_in_the_loop/?utm_source=chatgpt.com))

## **6.3 Fan‑out apply and mark done**

// src/graph/apply.ts  
import { Send } from "@langchain/langgraph";  
export function fanOutApply(state: any) {  
  const ok \= new Set(Object.entries(state.approvals ?? {}).filter((\[, v\]) \=\> v).map((\[k\]) \=\> k));  
  const r \= (state.plan as any\[\]).filter(a \=\> ok.has(a.id));  
  return r.map((a) \=\> new Send(\`apply\_${a.type}\`, { action: a }));  
}

## **6.4 Concurrency control**

When invoking the graph you can pass `configurable.maxConcurrency` to limit parallel branches in line with API limits. This is exposed in `RunnableConfig`. ([LangChain](https://api.js.langchain.com/interfaces/langchain_core.runnables.RunnableConfig.html?utm_source=chatgpt.com))

---

# **7\) Designer and applier examples**

## **7.1 Workflow Designer and Applier**

// src/agents/workflowDesigner.ts  
import { z } from "zod";  
import { ChatOpenAI } from "@langchain/openai";

export const WorkflowSpec \= z.object({  
  name: z.string(),  
  description: z.string().optional(),  
  steps: z.array(z.object({  
    subject: z.string(),  
    description: z.string().optional(),  
    sequence: z.number(),  
    activityType: z.enum(\["Task","Appointment"\]).default("Task"),  
    dayOffset: z.number().default(1),  
    startTime: z.string().nullable().optional(),  
    endTime: z.string().nullable().optional(),  
    allDay: z.boolean().default(true),  
    assigneeType: z.string().default("ContactsOwner"),  
    assigneeId: z.string().nullable().optional(),  
    rollOver: z.boolean().default(true),  
    location: z.string().nullable().optional(),  
    appointmentTypeId: z.string().nullable().optional()  
  }))  
});

const llm \= new ChatOpenAI({ model: process.env.LLM\_WORKFLOW ?? "gpt-4o", temperature: 0 });  
export async function design\_build\_workflow(state: any) {  
  const specModel \= llm.withStructuredOutput(WorkflowSpec);  
  const last \= String(state.messages.at(-1)?.content ?? "");  
  const spec \= await specModel.invoke(  
    \`Compose a financial-advisor workflow from scratch based on the user's request. 5-12 steps with meaningful subjects and dayOffset cadence.\`  
  );  
  return { previews: \[{ actionId: state.action.id, kind: "workflow", spec }\] };  
}

// src/agents/workflowApplier.ts  
import { makeWorkflowTools } from "../tools/bsa";

export async function apply\_build\_workflow(state: any, config: any) {  
  const p \= state.previews.find((x: any) \=\> x.actionId \=== state.action.id);  
  const spec \= p.spec;  
  const { createWorkflowShell, addWorkflowStep } \= makeWorkflowTools({  
    BSA\_BASE: config.configurable.BSA\_BASE, passKey: config.configurable.passKey, orgId: config.configurable.orgId  
  });

  const shell \= await createWorkflowShell.invoke({ name: spec.name, description: spec.description ?? "" }, config);  
  const workflowId \= shell?.id || shell?.DataObjectId || shell?.Id;  
  for (const step of spec.steps) {  
    await addWorkflowStep.invoke({ workflowId, ...step }, config);  
  }

  const done \= new Set(state.artifacts?.doneIds ?? \[\]);  
  done.add(state.action.id);  
  return { artifacts: { ...state.artifacts, doneIds: Array.from(done), workflowId } };  
}

* Tools are standard LangChain JS tools with Zod schemas and are invoked with `invoke(input, config)`. ([LangChain](https://api.js.langchain.com/functions/_langchain_core.tools.tool-1.html?utm_source=chatgpt.com))

---

# **8\) Knowledge Base retrieval**

## **8.1 Ingestion**

Ingest Markdown from a GitHub repo, chunk by headings, embed with OpenAI or Supabase Edge Functions, and insert into `kb_docs` and `kb_chunks`. Supabase automatic embeddings keeps vectors in sync as docs change. ([Supabase](https://supabase.com/docs/guides/ai/automatic-embeddings?utm_source=chatgpt.com))

## **8.2 Retrieval route**

// src/routes/kb.ts  
import { Router } from "express";  
import { supa, embed } from "../supabase"; // your helpers  
export const kbRouter \= Router();

kbRouter.get("/search", async (req, res) \=\> {  
  const { q, docset \= "bsa-help", top\_k \= 6 } \= req.query as any;  
  const { data: ds, error: e1 } \= await supa.from("kb\_docsets").select("id").eq("slug", docset).eq("is\_active", true).single();  
  if (e1 || \!ds) return res.status(404).json({ error: "active docset not found" });  
  const v \= await embed(String(q));  
  // Recommended: implement a SQL function for semantic search with filters  
  const { data, error } \= await supa.rpc("kb\_semantic\_search", { docset\_id: ds.id, query\_vec: v, match\_count: Number(top\_k) });  
  if (error) return res.status(500).json({ error: error.message });  
  res.json({ chunks: data });  
});

Supabase AI guides show semantic search patterns, Edge Functions for embedding generation, and pgvector basics. ([Supabase](https://supabase.com/docs/guides/functions/examples/semantic-search?utm_source=chatgpt.com))

---

# **9\) Long‑term memory and Mem0**

## **9.1 Store and CRUD API**

* Write and read memories through LangGraph Store for agent recall, and mirror to `ltm_memories` for the extension’s Manage Memories UI. Store supports semantic search by namespace when configured with an index. ([LangChain AI](https://langchain-ai.github.io/langgraph/concepts/memory/?utm_source=chatgpt.com))

* Build routes for list, search, create, update, delete. When writing, compute an embedding and update `ltm_memories.embedding`. Supabase automatic embeddings can replace on‑write embedding later. ([Supabase](https://supabase.com/docs/guides/ai/automatic-embeddings?utm_source=chatgpt.com))

## **9.2 Synthesize durable memory after actions**

// src/memory/synthesize.ts  
import { z } from "zod";  
import { ChatOpenAI } from "@langchain/openai";  
import { v4 as uuid } from "uuid";  
const MemoryBatch \= z.object({ memories: z.array(z.object({  
  kind: z.enum(\["user\_pref","team\_info","client\_note","fact"\]),  
  text: z.string().min(8),  
  subjectId: z.string().optional(),  
  importance: z.number().min(1).max(5).default(3),  
  ttlDays: z.number().min(1).max(365).optional()  
})).max(5) });

const memLLM \= new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });  
export async function synthesizeMemoryNode(state: any, config: any) {  
  const structured \= memLLM.withStructuredOutput(MemoryBatch);  
  const recent \= state.messages.slice(-8);  
  const out \= await structured.invoke(\`Extract durable facts to remember. Avoid secrets and transient IDs.\\n${JSON.stringify(recent)}\`);

  const ns \= \[config.configurable.orgId, config.configurable.userId, "memories"\];  
  for (const m of out.memories) {  
    const key \= uuid();  
    await config.store.put(ns, key, { text: m.text, kind: m.kind, subjectId: m.subjectId ?? null, importance: m.importance });  
    const vec \= await config.embed(m.text);  
    await config.supa.from("ltm\_memories").insert({  
      key, org\_id: ns\[0\], user\_id: ns\[1\], namespace: ns, kind: m.kind, subject\_id: m.subjectId ?? null, text: m.text,  
      importance: m.importance, ttl\_days: m.ttlDays ?? null, embedding: vec, source: "auto"  
    });  
  }  
  return {};  
}

## **9.3 Mem0 Node SDK for suggestions**

// src/memory/mem0.ts  
import { Memory as Mem0 } from "mem0ai/oss";  
export const mem0 \= new Mem0({  
  embedder: { provider: "openai", config: { apiKey: process.env.OPENAI\_API\_KEY\!, model: "text-embedding-3-small" } },  
  historyStore: {  
    provider: "supabase",  
    config: { supabaseUrl: process.env.SUPABASE\_URL\!, supabaseKey: process.env.SUPABASE\_KEY\!, tableName: "memory\_history" }  
  }  
});

Use `mem0.add([...messages], { userId, metadata })` after each important turn to generate suggested memories. Surface suggestions in the extension for one‑click acceptance into your Store and table. ([Mem0](https://docs.mem0.ai/open-source/node-quickstart?utm_source=chatgpt.com))

---

# **10\) Conversational Finalizer**

## **10.1 Schema and node**

// src/graph/response.ts  
import { z } from "zod";  
import { ChatOpenAI } from "@langchain/openai";

export const ResponseSchema \= z.object({  
  message: z.string(),  
  ui: z.object({  
    actions: z.array(z.object({ id: z.string(), type: z.string(), title: z.string().optional(), status: z.enum(\["planned","waiting\_approval","completed","failed"\]).optional() })).optional(),  
    citations: z.array(z.object({ title: z.string(), url: z.string() })).optional()  
  }).optional(),  
  followups: z.tuple(\[z.string(), z.string(), z.string()\])  
});

const finalizerLLM \= new ChatOpenAI({ model: process.env.LLM\_FINALIZER ?? "gpt-4o-mini", temperature: 0.2 });

export async function responseFinalizerNode(state: any, config: any) {  
  const structured \= finalizerLLM.withStructuredOutput(ResponseSchema);  
  const lastUser \= String(state.messages.at(-1)?.content ?? "");  
  const approvalsPending \= \!\!state.approvals && Object.values(state.approvals).every((v: any) \=\> v \=== false);  
  const completed \= state.artifacts?.doneIds ?? \[\];  
  const previews \= state.previews ?? \[\];  
  const citations \= state.kb?.citations ?? \[\];  
  const tone \= state.tone ?? "direct, motivational, no emojis, no em dashes";

  const res \= await structured.invoke(  
\`Write a concise, conversational reply aligned to the user's last message.  
\- Mirror intent in one line.  
\- If approvals are pending, ask clearly for confirmation.  
\- If work is completed, summarize what was done and list any IDs.  
\- If KB answer, provide steps and include citations.  
\- Suggest next best actions.  
\- End with exactly three bold follow-up questions labeled Q1, Q2, Q3.

User: ${lastUser}  
Approvals pending: ${approvalsPending}  
Completed actions: ${JSON.stringify(completed)}  
Drafts: ${JSON.stringify(previews).slice(0, 3000)}  
Citations: ${JSON.stringify(citations).slice(0, 2000)}  
Tone: ${tone}\`  
  );

  const sanitize \= (t: string) \=\> t.replace(/\\u2014/g, "-");  
  return { messages: \[{ role: "assistant", content: sanitize(res.message) }\], ui: res.ui };  
}

Using `withStructuredOutput()` ensures a predictable rendering payload for chat plus UI cards. ([Langchain](https://js.langchain.com/docs/concepts/structured_outputs/?utm_source=chatgpt.com))

## **10.2 Wiring**

* KB path: `kb_answer → response_finalizer → END`.

* Approval pause: `approval_batch → response_finalizer` then your HTTP route returns `PENDING_APPROVAL` with the finalizer message.

* After writes: `mem0_suggest → response_finalizer → END`.  
   This uses interrupts to pause and `Command` to resume. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/concepts/human_in_the_loop/?utm_source=chatgpt.com))

---

# **11\) Orchestrator graph**

// src/graph/orchestrator.ts  
import { StateGraph, START, END } from "@langchain/langgraph";  
import { AppState, checkpointer, store } from "./state";  
import { recallMemoryNode } from "../memory/recall";  
import { intentNode } from "./intent";  
import { planNode } from "./plan";  
import { fanOutDesign, fanOutApply } from "./parallel";  
import { approvalBatchNode } from "./approval";  
import { synthesizeMemoryNode } from "../memory/synthesize";  
import { responseFinalizerNode } from "./response";  
import { mem0 } from "../memory/mem0";  
import { design\_build\_workflow, apply\_build\_workflow } from "../agents/workflowNodes";  
import { design\_create\_task, apply\_create\_task } from "../agents/taskNodes";  
import { design\_create\_appointment, apply\_create\_appointment } from "../agents/appointmentNodes";  
import { kbRetrieveNode, kbAnswerNode } from "../kb/nodes";

export function buildGraph() {  
  const g \= new StateGraph(AppState)  
    .addNode("recall\_memory", recallMemoryNode)  
    .addNode("intent", intentNode)  
    .addNode("plan", planNode)  
    .addNode("fanOutDesign", fanOutDesign)  
    .addNode("approval\_batch", approvalBatchNode)  
    .addNode("fanOutApply", fanOutApply)  
    .addNode("synthesize\_memory", synthesizeMemoryNode)  
    .addNode("response\_finalizer", responseFinalizerNode)  
    .addNode("design\_build\_workflow", design\_build\_workflow)  
    .addNode("apply\_build\_workflow", apply\_build\_workflow)  
    .addNode("design\_create\_task", design\_create\_task)  
    .addNode("apply\_create\_task", apply\_create\_task)  
    .addNode("design\_create\_appointment", design\_create\_appointment)  
    .addNode("apply\_create\_appointment", apply\_create\_appointment)  
    .addNode("kb\_retrieve", kbRetrieveNode)  
    .addNode("kb\_answer", kbAnswerNode)  
    .addEdge(START, "recall\_memory")  
    .addEdge("recall\_memory", "intent")  
    .addConditionalEdges("intent", (s) \=\> s.intent \=== "help\_kb" ? \["kb\_retrieve"\] : \["plan"\])  
    .addEdge("kb\_retrieve", "kb\_answer")  
    .addEdge("kb\_answer", "response\_finalizer")  
    .addEdge("response\_finalizer", END)  
    .addEdge("plan", "fanOutDesign")  
    .addEdge("fanOutDesign", "approval\_batch")  
    .addEdge("approval\_batch", "response\_finalizer")   // conversational approval prompt  
    .addEdge("approval\_batch", "fanOutApply")  
    .addEdge("fanOutApply", "synthesize\_memory")  
    .addEdge("synthesize\_memory", "response\_finalizer");

  return g.compile({ checkpointer, store });  
}

Parallel branches, supersteps, and persistence semantics are per current LangGraph JS docs. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/branching/?utm_source=chatgpt.com))

---

# **12\) Express on Vercel routes**

// src/index.ts  
import express from "express";  
import { buildGraph } from "./graph/orchestrator";

const app \= express();  
app.use(express.json());  
const graph \= buildGraph();

async function getContext(session\_id: string, org\_id: string) {  
  // Use your existing Supabase logic  
  const passKey \= await getValidPassKey(session\_id);  
  const userId \= await getBsaUserId(session\_id);  
  return { passKey, userId, orgId: org\_id, BSA\_BASE: process.env.BSA\_BASE\! };  
}

app.post("/api/agent/execute", async (req, res) \=\> {  
  const { session\_id, org\_id, time\_zone, query, safe\_mode, thread\_id } \= req.body;  
  const { passKey, userId, orgId, BSA\_BASE } \= await getContext(session\_id, org\_id);

  const config \= {  
    configurable: {  
      thread\_id: thread\_id ?? \`${session\_id}:${org\_id}\`,  
      userId, orgId,  
      user\_tz: time\_zone ?? "UTC",  
      safe\_mode: \!\!safe\_mode,  
      passKey, BSA\_BASE  
    }  
  };

  const out \= await graph.invoke({ messages: \[{ role: "human", content: query }\] }, config);  
  if ((out as any).\_\_interrupt\_\_) return res.status(202).json({ status: "PENDING\_APPROVAL", interrupt: (out as any).\_\_interrupt\_\_, ui: out.ui });  
  return res.json({ status: "DONE", result: out });  
});

app.post("/api/agent/approve", async (req, res) \=\> {  
  const { session\_id, org\_id, thread\_id, approvals, time\_zone } \= req.body;  
  const { passKey, userId, orgId, BSA\_BASE } \= await getContext(session\_id, org\_id);  
  const config \= { configurable: { thread\_id, userId, orgId, user\_tz: time\_zone ?? "UTC", safe\_mode: true, passKey, BSA\_BASE } };  
  const out \= await graph.invoke({ \_\_command\_\_: { resume: approvals } } as any, config);  
  return res.json({ status: "RESUMED", result: out });  
});

export default app; // required by Vercel

Vercel expects a default export for Express apps. ([Vercel](https://vercel.com/docs/frameworks/backend/express?utm_source=chatgpt.com))

---

# **13\) Chrome extension UX**

* **Chat**: shows assistant text and a compact “What I did” list from `ui.actions`.

* **Approvals**: when `PENDING_APPROVAL`, render previews with checkboxes and post to `/api/agent/approve`.

* **Manage Memories**: list, search, add, edit, delete; “Suggested” tab for Mem0 candidates.

* **Help**: send queries to `help_kb`; show answer and `ui.citations`.

---

# **14\) Agent memory model**

* **Session memory**: persisted automatically by the Postgres checkpointer keyed by `thread_id` in LangGraph JS. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/persistence-postgres/?utm_source=chatgpt.com))

* **Long‑term memory**: hierarchical namespaces in LangGraph Store with semantic search; CRUD mirrored to `ltm_memories` for UI. ([LangChain AI](https://langchain-ai.github.io/langgraph/concepts/memory/?utm_source=chatgpt.com))

* **Mem0**: optional auto‑extraction; store suggestions, let users accept into your Store. Node SDK quickstart is current. ([Mem0](https://docs.mem0.ai/open-source/node-quickstart?utm_source=chatgpt.com))

---

# **15\) Knowledge Base path**

* **Intent** routes `help_kb` to retrieval → synthesis with steps and citations.

* **Docsets** provide swappable versions. Flip `is_active` to roll out updates without code changes.

* **Automatic embeddings** with Supabase Edge Functions can keep vectors synced on edit. ([Supabase](https://supabase.com/docs/guides/ai/automatic-embeddings?utm_source=chatgpt.com))

---

# **16\) Security and governance**

* PassKey and OrgId never enter prompts or state. Inject through `configurable` and closures. ([Langchain](https://js.langchain.com/docs/concepts/runnables/?utm_source=chatgpt.com))

* Safe Mode default on for new users.

* Memory PII minimization and TTLs per `kind`.

* Supabase RLS by `org_id` and `user_id`.

* Superstep semantics avoid partial state application on branch errors. ([LangChain AI](https://langchain-ai.github.io/langgraph/how-tos/graph-api/?utm_source=chatgpt.com))

---

# **17\) Observability**

* Enable LangSmith to visualize node runs, state transitions, and tool I/O.

* Use `RunnableConfig.maxConcurrency` to tune fan‑out throughput when needed. ([LangChain](https://api.js.langchain.com/interfaces/langchain_core.runnables.RunnableConfig.html?utm_source=chatgpt.com))

---

# **18\) Phased execution plan**

## **Phase 1 \- Foundations**

1. Create Supabase tables for `ltm_memories`, KB docsets/docs/chunks, and vector indexes. Enable pgvector. ([Supabase](https://supabase.com/docs/guides/database/extensions/pgvector?utm_source=chatgpt.com))

2. Add `@langchain/langgraph` and `@langchain/langgraph-checkpoint-postgres`. Initialize `checkpointer.setup()` and `store.setup()` in a migration script. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/persistence-postgres/?utm_source=chatgpt.com))

3. Implement Blue Square tools with closures for PassKey and OrgId.

4. Implement Intent, Memory‑Recall, and Planner nodes with structured output. ([Langchain](https://js.langchain.com/docs/concepts/structured_outputs/?utm_source=chatgpt.com))

5. Deploy Express on Vercel with default export. ([Vercel](https://vercel.com/docs/frameworks/backend/express?utm_source=chatgpt.com))

## **Phase 2 \- Actions and approvals**

1. Add `design_*` and `apply_*` for workflow, task, appointment.

2. Wire `fanOutDesign`, `approval_batch` with `interrupt`, and `fanOutApply`. Parallelize per layer. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/branching/?utm_source=chatgpt.com))

3. Add `synthesize_memory` after applies.

4. Add Mem0 suggestions hook.

## **Phase 3 \- Manage Memories UI**

1. CRUD routes that mirror Store writes to `ltm_memories` with embeddings.

2. Extension panel with search, add, edit, delete, Suggestions tab.

3. Policies: opt‑in auto‑capture suggestions, TTLs per `kind`.

## **Phase 4 \- Knowledge Base**

1. Ingestion script from GitHub Markdown, chunk \+ embed, insert into KB tables, flip `is_active`.

2. `/api/kb/search` using a Postgres function for semantic search and filters. ([Supabase](https://supabase.com/docs/guides/functions/examples/semantic-search?utm_source=chatgpt.com))

3. KB nodes that return steps and `kb.citations` for the finalizer.

## **Phase 5 \- Conversational polish**

1. Add the **Conversational Finalizer** after both KB and Apply paths, and after Approval when pausing.

2. Persist a tone profile memory so replies always match your house style.

3. CI style guards to reject em dashes or emojis.

## **Phase 6 \- Hardening**

1. Dedupe writes with a short‑TTL action hash table since BSA has no idempotency.

2. Retry with exponential backoff on BSA failures.

3. Concurrency caps via `maxConcurrency`. ([LangChain](https://api.js.langchain.com/interfaces/langchain_core.runnables.RunnableConfig.html?utm_source=chatgpt.com))

4. Tests for sequential, parallel, failure, and approval flows. Superstep semantics should prevent partial updates. ([LangChain AI](https://langchain-ai.github.io/langgraph/how-tos/graph-api/?utm_source=chatgpt.com))

---

# **19\) Agent patterns you can add later**

* **Prebuilt ReAct agent** as a node for research or fuzzy tasks, using `createReactAgent` from LangGraph’s prebuilt package. Keep Blue Square writes behind your Design → Approve → Apply nodes. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/create-react-agent/?utm_source=chatgpt.com))

* **Supervisor tool‑calling** for open‑ended routing if you expand beyond the current action set. Keep approvals invariant. ([LangChain AI](https://langchain-ai.github.io/langgraph/concepts/multi_agent/?utm_source=chatgpt.com))

---

# **20\) Implementation checklist for the coding agent**

* Run DB migrations for memory and KB tables with vector columns. ([Supabase](https://supabase.com/docs/guides/ai/vector-columns?utm_source=chatgpt.com))

* Initialize `checkpointer` and `store` and call `setup()` once. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/persistence-postgres/?utm_source=chatgpt.com))

* Implement BSA tools with closures.

* Build Intent, Recall, Planner nodes with Zod structured outputs. ([Langchain](https://js.langchain.com/docs/concepts/structured_outputs/?utm_source=chatgpt.com))

* Add design/apply nodes, parallel fan‑out, interrupt approvals. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/branching/?utm_source=chatgpt.com))

* Implement Conversational Finalizer and wire it after KB and after Apply or Approval.

* Add Memory CRUD routes and extension UI.

* Add KB ingestion and `/api/kb/search` function. ([Supabase](https://supabase.com/docs/guides/functions/examples/semantic-search?utm_source=chatgpt.com))

* Deploy Express with a default export on Vercel. ([Vercel](https://vercel.com/docs/frameworks/backend/express?utm_source=chatgpt.com))

* Configure `RunnableConfig.configurable` and `maxConcurrency` per environment. ([Langchain](https://js.langchain.com/docs/concepts/runnables/?utm_source=chatgpt.com), [LangChain](https://api.js.langchain.com/interfaces/langchain_core.runnables.RunnableConfig.html?utm_source=chatgpt.com))

---

## **References used for this plan**

* **LangGraph multi‑agent patterns and superstep semantics**. ([LangChain AI](https://langchain-ai.github.io/langgraph/concepts/multi_agent/?utm_source=chatgpt.com))

* **Parallel branching in JS**. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/branching/?utm_source=chatgpt.com))

* **MessagesAnnotation and graph state**. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/concepts/low_level/?utm_source=chatgpt.com))

* **Postgres checkpointer for persistence**. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/persistence-postgres/?utm_source=chatgpt.com))

* **LangGraph memory Store and namespaces**. ([LangChain AI](https://langchain-ai.github.io/langgraph/concepts/memory/?utm_source=chatgpt.com))

* **Structured output in LangChain JS**. ([Langchain](https://js.langchain.com/docs/concepts/structured_outputs/?utm_source=chatgpt.com))

* **Tools with Zod and tool‑calling**. ([LangChain](https://api.js.langchain.com/functions/_langchain_core.tools.tool-1.html?utm_source=chatgpt.com), [Langchain](https://js.langchain.com/docs/how_to/tools_builtin/?utm_source=chatgpt.com))

* **RunnableConfig and configurable values**. ([Langchain](https://js.langchain.com/docs/concepts/runnables/?utm_source=chatgpt.com), [LangChain](https://api.js.langchain.com/interfaces/langchain_core.runnables.RunnableConfig.html?utm_source=chatgpt.com))

* **Prebuilt ReAct agent**. ([LangChain AI](https://langchain-ai.github.io/langgraphjs/how-tos/create-react-agent/?utm_source=chatgpt.com))

* **Supabase pgvector and automatic embeddings**. ([Supabase](https://supabase.com/docs/guides/database/extensions/pgvector?utm_source=chatgpt.com))

* **Express on Vercel default export**. ([Vercel](https://vercel.com/docs/frameworks/backend/express?utm_source=chatgpt.com))

* **Mem0 Node SDK quickstart and Supabase as history store**. ([Mem0](https://docs.mem0.ai/open-source/node-quickstart?utm_source=chatgpt.com))

---

