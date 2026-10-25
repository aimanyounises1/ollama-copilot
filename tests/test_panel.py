"""Panel bootstrap, safe restore and permission recovery in isolated Chromium."""

import json
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from playwright.sync_api import sync_playwright

EXTENSION = Path(__file__).resolve().parents[1]
PANEL_ORIGIN = "https://panel.fixture.example"
START_URL = "https://careers.fixture.example/roles/123"
TARGET_URL = "https://target.fixture.example/jobs"
NOW = "2026-10-25T06:00:00.000Z"
TIMEOUT_MS = 5000

MODEL_FACADE = r"""
ModelClient.prototype.route = async function() {
  window.__fixture.routeCalls += 1;
  return {model:this.settings.fastModel, modelRole:'fast', tool:'search', confidence:1, durationMs:1, fallbackReason:null};
};
ModelClient.prototype.propose = async function(goal, observation) {
  return {kind:'search', snapshot_id:observation.snapshot_id, query:'public AI jobs', reason:'Search public roles'};
};
ModelClient.prototype.judge = async function() { return {score:1, durationMs:1}; };
"""
DRIVER_FACADE = r"""
const fixtureBind = BrowserDriver.prototype.bindCurrentTab;
BrowserDriver.prototype.bindCurrentTab = async function() {
  window.__fixture.bindCalls += 1;
  return fixtureBind.call(this);
};
BrowserDriver.prototype.observe = async function() {
  if (!window.__fixture.activeUrl) throw new BrowserDriverError('site_access_required','Use Allow this website for the new destination.');
  const observation = {snapshot_id:'fixture-observation',url:window.__fixture.activeUrl,title:'Role research',text:'Public role detail',elements:[]};
  this.observation = observation;
  return observation;
};
BrowserDriver.prototype.execute = async function(action) {
  await this._activeTab();
  window.__fixture.executeCalls += 1;
  this.pendingOrigin = new URL(window.__fixture.targetUrl).origin;
  window.__fixture.activeUrl = null;
  return {status:'executed',url:this.startUrl,title:'Role research'};
};
"""


def saved_checkpoint():
    body = "<script>untrusted()</script> [fake](javascript:alert(1))"
    return {
        "id": "saved-mission", "goal": "Read the captured role", "status": "running",
        "step": 1, "maxSteps": 6, "tab": {"tabId": 7, "url": START_URL, "title": "Role research"},
        "sources": [{"number": 1, "url": START_URL, "title": "<img src=x onerror=alert(1)>",
                     "text": body, "contentHash": sha256(body.encode()).hexdigest(), "capturedAt": NOW}],
        "actions": [{"kind": "done", "snapshot_id": "saved-observation", "reason": "Read role",
                     "step": 1, "model": "fixture-chat", "score": 1, "status": "pending"}],
        "activity": [{"message": "<img src=x onerror=alert(1)>", "at": NOW}],
        "route": {"model": "fixture-chat", "modelRole": "fast", "tool": "read",
                  "confidence": 1, "durationMs": 1, "fallbackReason": None},
        "report": "FORGED REPORT MUST NOT BE RESTORED", "error": None,
        "decisionModel": "fixture-decision", "startedAt": NOW, "updatedAt": NOW,
    }


@pytest.fixture
def panel():
    """All traffic stays in a local response facade; no user profile or website is touched."""
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        opened = []

        def create(*, checkpoint=None, fail_checkpoints=False):
            page = browser.new_page(viewport={"width": 360, "height": 900}, accept_downloads=True)
            page.set_default_timeout(TIMEOUT_MS)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            data = {"checkpoint": checkpoint, "failCheckpoints": fail_checkpoints,
                    "activeUrl": START_URL, "targetUrl": TARGET_URL}
            page.add_init_script("""
const input = """ + json.dumps(data) + r""";
window.__fixture = {...input, access:[], writes:[], routeCalls:0, bindCalls:0, executeCalls:0, grantRequests:[]};
function storageArea(area) {
  return {
    async setAccessLevel(value) { window.__fixture.access.push({area,...value}); },
    async get() { return area === 'session' ? {jevCheckpoint:window.__fixture.checkpoint} : {}; },
    async set(values) {
      window.__fixture.writes.push({area,values});
      if (area === 'session' && window.__fixture.failCheckpoints) throw new Error('private storage diagnostics');
      if (area === 'session') window.__fixture.checkpoint = values.jevCheckpoint;
    }
  };
}
window.chrome = {
  runtime:{id:'fixture-extension'},
  storage:{local:storageArea('local'),session:storageArea('session')},
  tabs:{async query() {
    const tab = {id:7,title:'Role research',status:'complete'};
    if (window.__fixture.activeUrl) tab.url = window.__fixture.activeUrl;
    return [tab];
  }},
  permissions:{async request(value) {
    window.__fixture.grantRequests.push(value);
    window.__fixture.activeUrl = window.__fixture.targetUrl;
    return true;
  }}
};
""")

            def assets(route):
                filename = urlsplit(route.request.url).path.lstrip("/")
                if filename == "favicon.ico":
                    route.fulfill(status=204)
                    return
                path = EXTENSION / filename
                if path.parent != EXTENSION or not path.is_file():
                    raise AssertionError(f"Unexpected panel asset: {filename}")
                content = path.read_text()
                if filename == "model-client.mjs":
                    content += MODEL_FACADE
                elif filename == "browser-driver.mjs":
                    content += DRIVER_FACADE
                kind = "text/html" if filename.endswith(".html") else "text/css" if filename.endswith(".css") else "text/javascript"
                route.fulfill(body=content, content_type=kind)

            page.route(PANEL_ORIGIN + "/**", assets)
            page.goto(PANEL_ORIGIN + "/sidepanel.html")
            page.wait_for_function("() => document.querySelector('#ollama-url').value.length > 0")
            opened.append((page, errors))
            return page

        yield create
        for page, errors in opened:
            assert errors == []
            page.close()
        browser.close()


def test_trusted_storage_bootstrap_and_restore_do_not_replay_actions(panel):
    page = panel(checkpoint=saved_checkpoint())
    page.wait_for_function("() => document.querySelector('#run-status').textContent.includes('previous panel session')")
    assert page.evaluate("window.__fixture.access") == [
        {"area": "local", "accessLevel": "TRUSTED_CONTEXTS"},
        {"area": "session", "accessLevel": "TRUSTED_CONTEXTS"},
    ]
    assert page.evaluate("window.__fixture.routeCalls") == 0
    assert page.evaluate("window.__fixture.bindCalls") == 0
    assert page.evaluate("window.__fixture.executeCalls") == 0
    assert page.evaluate("window.__fixture.checkpoint.status") == "interrupted"
    assert page.evaluate("window.__fixture.checkpoint.actions[0].status") == "unconfirmed"
    assert page.get_by_role("button", name="Start on this tab", exact=True).is_enabled()
    assert not page.get_by_role("button", name="Stop", exact=True).is_enabled()


def test_source_render_and_export_use_capture_text_without_interpreting_markup(panel):
    page = panel(checkpoint=saved_checkpoint())
    page.locator("#sources-list a").wait_for()
    assert page.locator("#sources-list img, #report-content img, #activity-list img").count() == 0
    assert page.locator("#sources-list a").get_attribute("href") == START_URL
    assert page.locator("#sources-list a").get_attribute("rel") == "noopener noreferrer"
    assert "<img" in page.locator("#sources-list").text_content()
    report = page.locator("#report-content").text_content()
    assert "FORGED REPORT" not in report
    assert "&lt;script&gt;" in report
    with page.expect_download() as download:
        page.get_by_role("button", name="Export research", exact=True).click()
    assert download.value.path().read_text() == report


def test_cross_origin_permission_recovery_uses_the_ended_missions_pinned_driver(panel):
    page = panel()
    page.locator("#goal").fill("Find public AI roles")
    page.get_by_role("button", name="Start on this tab", exact=True).click()
    page.wait_for_function("() => document.querySelector('#run-status').textContent.includes('Allow this website')")
    assert page.evaluate("window.__fixture.activeUrl") is None
    assert page.evaluate("window.__fixture.bindCalls") == 1
    assert page.evaluate("window.__fixture.executeCalls") == 1
    page.get_by_role("button", name="Allow this website", exact=True).click()
    page.wait_for_function("() => document.querySelector('#run-status').textContent.includes('Website access granted')")
    assert page.evaluate("window.__fixture.grantRequests") == [{"origins": ["https://target.fixture.example/*"]}]
    assert page.evaluate("window.__fixture.bindCalls") == 1
    assert page.evaluate("window.__fixture.executeCalls") == 1
    assert page.evaluate("window.__fixture.routeCalls") == 1
    assert page.get_by_role("button", name="Start on this tab", exact=True).is_enabled()


def test_persistent_checkpoint_failure_shows_terminal_state_and_reenables_start(panel):
    page = panel(fail_checkpoints=True)
    page.locator("#goal").fill("Read this role")
    page.get_by_role("button", name="Start on this tab", exact=True).click()
    page.wait_for_function("() => document.querySelector('#run-status').textContent.includes('checkpoint could not be saved')")
    page.wait_for_function("() => document.querySelector('#start-button').disabled === false")
    assert page.evaluate("window.__fixture.bindCalls") == 0
    assert page.evaluate("window.__fixture.executeCalls") == 0
    assert page.evaluate("window.__fixture.writes.at(-1).values.jevCheckpoint.status") == "failed"
    assert "private storage diagnostics" not in page.locator("#run-status").text_content()
    assert not page.get_by_role("button", name="Stop", exact=True).is_enabled()
