/** The browser workflow is an explicit, local LangGraph state machine. */
import { Annotation, StateGraph, MemorySaver, START, END } from "@langchain/langgraph/web";

export const GRAPH_NODE_NAMES = Object.freeze([
  "bind", "observe", "permission_gate", "route", "propose", "judge", "prepare_action", "execute", "capture", "finalize",
]);
const TaskState = Annotation.Root({
  goal: Annotation(), step: Annotation(), observation: Annotation(), capturedAt: Annotation(),
  modelRoute: Annotation(), action: Annotation(), judgment: Annotation(), result: Annotation(),
  approved: Annotation(), finished: Annotation(), needsPermission: Annotation(),
});

/** Operations close over one mission's services and signal; graph state is JSON data. */
export function createBrowserTaskGraph(operations) {
  const workflow = new StateGraph(TaskState);
  for (const name of GRAPH_NODE_NAMES) workflow.addNode(name, operations[name]);
  return workflow
    .addEdge(START, "bind")
    .addEdge("bind", "observe")
    .addConditionalEdges("observe", state => state.needsPermission ? "permission_gate" : "route", ["permission_gate", "route"])
    .addEdge("permission_gate", "observe")
    .addEdge("route", "propose")
    .addEdge("propose", "judge")
    .addConditionalEdges("judge", state => state.approved ? "prepare_action" : "finalize", ["prepare_action", "finalize"])
    .addEdge("prepare_action", "execute")
    .addEdge("execute", "capture")
    .addConditionalEdges("capture", state => state.finished ? "finalize" : "observe", ["finalize", "observe"])
    .addEdge("finalize", END)
    .compile({ checkpointer: new MemorySaver(), interruptBefore: ["permission_gate"] });
}

/** Leave room for every named node per allowed action, including entry and exit. */
export function browserGraphRecursionLimit(maxSteps) {
  return GRAPH_NODE_NAMES.length * (maxSteps + 1);
}
