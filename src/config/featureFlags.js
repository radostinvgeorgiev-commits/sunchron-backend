export function isCopilotAutomationEnabled(env = process.env) {
  return env.COPILOT_AUTOMATION_ENABLED === "true";
}
