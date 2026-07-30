const MANAGER_URL = browser.runtime.getURL("manager.html");

async function openManager() {
  const existing = await browser.tabs.query({ url: MANAGER_URL });
  if (existing.length > 0) {
    const tab = existing[0];
    await browser.windows.update(tab.windowId, { focused: true });
    await browser.tabs.update(tab.id, { active: true });
    return;
  }
  await browser.tabs.create({ url: MANAGER_URL });
}

browser.action.onClicked.addListener(openManager);
