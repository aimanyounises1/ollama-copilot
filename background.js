/* Long inference stays in the visible side panel, not this short-lived worker. */
// The direct action gesture grants activeTab. The automatic panel toggle does not.
// Clear the persisted toggle behavior when upgrading from an earlier build.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((error) => {
  console.error("Ollama Copilot could not configure its side panel:", error.name);
});

/** Open immediately in the clicked tab's window, preserving the action gesture. */
chrome.action.onClicked.addListener((tab) => {
  if (!Number.isInteger(tab?.windowId) || tab.windowId < 0) {
    console.error("Ollama Copilot could not identify the clicked window.");
    return;
  }
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
    console.error("Ollama Copilot could not open its side panel:", error.name);
  });
});
