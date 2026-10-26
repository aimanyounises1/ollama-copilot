/** Real LangChain adapters retain the app's bounded local inference and browser policy. */
import { tool } from "@langchain/core/tools";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod";
import { LIMITS } from "./config.mjs";
import { validateAction } from "./model-client.mjs";

const bounded = maximum => z.string().min(1).max(maximum);
const fields = {
  snapshot_id: bounded(LIMITS.maxSnapshotChars), reason: z.string().max(LIMITS.maxReasonChars),
};
const action = (kind, arguments_ = {}) => z.strictObject({ kind: z.literal(kind), ...fields, ...arguments_ });
const BrowserAction = z.discriminatedUnion("kind", [
  action("navigate", { url: bounded(LIMITS.maxUrlChars) }),
  action("click", { target_id: bounded(LIMITS.maxTargetChars) }),
  action("type", { target_id: bounded(LIMITS.maxTargetChars), text: z.string().max(LIMITS.maxActionText) }),
  action("press", { target_id: bounded(LIMITS.maxTargetChars), key: z.enum(["Enter", "Tab", "Escape"]) }),
  action("back"), action("search", { query: bounded(LIMITS.maxSearchQuery) }),
  action("open_tab", { target_id: bounded(LIMITS.maxTargetChars) }),
  action("switch_tab", { tab_ref: bounded(LIMITS.maxTargetChars) }),
  action("extract"), action("done"),
]);

/** This tool is invoked only by the graph's reviewed, checkpointed execution node. */
export function createBrowserActionTool({ driver, guard, onDispatch }) {
  return tool(async ({ action: proposed }) => {
    const validated = validateAction(proposed);
    guard();
    onDispatch();
    return driver.execute(validated);
  }, {
    name: "execute_reviewed_browser_action",
    description: "Execute one observed browser action after the decision review and saved authorization checkpoint. The driver enforces current page, task tab and public reading policy.",
    schema: z.strictObject({ action: BrowserAction }),
  });
}

/** LangChain runnable adapters do not replace the stricter local provider boundary. */
export function createModelRunnables(client, signal, guard) {
  const adapter = call => RunnableLambda.from(async input => {
    guard();
    const result = await call(input);
    guard();
    return result;
  });
  return {
    route: adapter(({ goal, observation }) => client.route(goal, observation, signal)),
    propose: adapter(({ goal, observation, history, route }) => client.propose(goal, observation, history, route, signal)),
    judge: adapter(({ goal, observation, action }) => client.judge(goal, observation, action, signal)),
  };
}
