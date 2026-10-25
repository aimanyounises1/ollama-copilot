/* Long inference stays in the visible side panel, not this short-lived worker. */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error("JEV could not configure its side panel:", error.name);
});
