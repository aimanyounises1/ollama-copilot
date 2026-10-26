"""Actual Chromium DOM actors; only Chrome's extension-message transport is simulated."""

import json
import os
import shutil
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOME = "https://browser-fixture.example/"
TIMEOUT_MS = 5000
HTML = """<!doctype html><title>Public fixture</title><main>
<h1>Research fixture</h1><form method="get" action="/search">
<label>Search jobs <input id="query" type="search" name="q"></label>
<input type="hidden" name="area" value="default"><button id="go">Go</button></form>
<a id="docs" href="/guide">Documentation</a>
<input id="other" type="search" aria-label="Other search">
<button id="delete">Delete account</button>
<form method="post" action="/write"><label>Search <input id="post-query" type="search" name="query"></label><button>Search</button></form>
</main>"""
CHROME_TRANSPORT = r"""
(() => {
 const event = () => {
   const handlers = new Set();
   return { handlers, addListener: fn => handlers.add(fn), removeListener: fn => handlers.delete(fn),
     emit: (...args) => { for (const fn of [...handlers]) fn(...args); } };
 };
 const connected = event(), updated = event();
 const fixture = window.fixture = { activeTabId: 7, windowId: 11, nextTabId: 8, tabData: new Map(), createdTabs: [], activatedTabs: [], documentId: 'document-A', loading: false,
   lastConnect: null, permissionOrigins: [], typed: [], updated, connections: [], deferAction: false, queryUrl: null, urlVisible: true };
 fixture.connect = () => {
   let alive = true;
   const clientMessage = event(), clientDisconnect = event(), serverMessage = event(), serverDisconnect = event();
   const close = () => { if (!alive) return; alive = false; serverDisconnect.emit(); clientDisconnect.emit(); };
   const client = { name: 'jev-browser-v1', onMessage: clientMessage, onDisconnect: clientDisconnect,
     postMessage: msg => { if (!alive) throw new Error('disconnected'); if (msg.op === 'execute' && fixture.deferAction) { fixture.pendingAction = msg; fixture.confirmAction = result => clientMessage.emit({id:msg.id,ok:true,result}); return; } queueMicrotask(() => { if (alive) serverMessage.emit(msg); }); }, disconnect: close };
   const server = { name: 'jev-browser-v1', sender: { id: 'fixture-extension', url: 'chrome-extension://fixture-extension/sidepanel.html' },
     onMessage: serverMessage, onDisconnect: serverDisconnect,
     postMessage: msg => { if (!alive) throw new Error('disconnected'); queueMicrotask(() => { if (alive) clientMessage.emit(msg); }); }, disconnect: close };
   connected.emit(server); fixture.connections.push(client); return client;
 };
 fixture.attach = () => {
   const port = fixture.connect(), pending = new Map(); fixture.port = port;
   port.onMessage.addListener(msg => {
     const item = pending.get(msg.id); if (!item) return; pending.delete(msg.id);
     if (msg.ok) item.resolve(msg.result); else { const e = new Error(msg.error.message); e.code = msg.error.code; item.reject(e); }
   });
   port.onDisconnect.addListener(() => { for (const item of pending.values()) item.reject(new DOMException('Stopped', 'AbortError')); pending.clear(); });
   fixture.request = (op, options = {}) => new Promise((resolve, reject) => {
     const id = crypto.randomUUID(); pending.set(id, {resolve, reject}); port.postMessage({id, op, ...options});
   });
 };
 fixture.tab = id => fixture.tabData.get(id) || {id, windowId: fixture.windowId,
   url: fixture.urlVisible ? fixture.queryUrl || location.href : undefined,
   title: document.title, status: fixture.loading ? 'loading' : 'complete'};
 window.chrome = {
   runtime: { id: 'fixture-extension', getURL: path => 'chrome-extension://fixture-extension/' + path, onConnect: connected, lastError: null },
   tabs: { query: async () => [fixture.tab(fixture.activeTabId)],
     get: async id => fixture.tab(id), onUpdated: updated,
     create: async options => {
       fixture.createdTabs.push(options);
       const tab = {id: fixture.nextTabId++, windowId: options.windowId, url: options.url, title: 'New public reading tab', status: 'complete'};
       fixture.tabData.set(tab.id, tab); fixture.activeTabId = tab.id;
       if (fixture.deferCreate) return new Promise(resolve => { fixture.confirmCreate = () => resolve(tab); });
       return tab;
     },
     update: async (id, options) => { fixture.activatedTabs.push({id, ...options}); fixture.activeTabId = id; if (fixture.deferUpdate) return new Promise(resolve => { fixture.confirmUpdate = () => resolve(fixture.tab(id)); }); return fixture.tab(id); },
     connect: (id, options) => { fixture.lastConnect = {id, ...options}; return fixture.connect(); } },
   scripting: { executeScript: async options => { fixture.lastInjection = options; return [{ frameId: 0, documentId: fixture.documentId }]; } },
   permissions: { request: async options => { fixture.permissionOrigins.push(options.origins); return true; } },
 };
})();
"""


@pytest.fixture(scope="module")
def playwright_runtime():
    with sync_playwright() as playwright:
        yield playwright


@pytest.fixture(scope="module")
def chromium(playwright_runtime):
    browser = playwright_runtime.chromium.launch(headless=True)
    try:
        yield browser
    finally:
        browser.close()


@pytest.fixture
def actor(chromium):
    context = chromium.new_context()
    page = context.new_page()
    page.set_default_timeout(TIMEOUT_MS)

    def respond(route):
        path = urlsplit(route.request.url).path
        if path.startswith("/extension/"):
            module = ROOT / path.removeprefix("/extension/")
            assert module.is_file()
            route.fulfill(body=module.read_text(), content_type="text/javascript")
        elif path in {"/", "/search", "/guide"}:
            route.fulfill(body=HTML if path == "/" else "<!doctype html><title>Results</title><main>Captured public result</main>", content_type="text/html")
        else:
            raise AssertionError(f"Unexpected fixture request: {route.request.url}")

    context.route("**/*", respond)
    page.add_init_script(CHROME_TRANSPORT)
    page.goto(HOME)
    page.add_script_tag(content=(ROOT / "content.js").read_text())
    page.evaluate("() => fixture.attach()")
    try:
        yield page
    finally:
        context.close()


def observation(page):
    return page.evaluate("() => fixture.request('observe')")


def action_for(snapshot, kind, label=None, **extra):
    action = {"kind": kind, "snapshot_id": snapshot["snapshot_id"], **extra}
    if label is not None:
        action["target_id"] = next(item["id"] for item in snapshot["elements"] if item["label"] == label)
    return action


def execute(page, action, **options):
    return page.evaluate("payload => fixture.request('execute', payload)", {"action": action, "typingDelayMs": 0, "start_url": HOME, **options})


def failure(page, action, **options):
    return page.evaluate("async payload => { try { await fixture.request('execute', payload); return null; } catch (e) { return {code:e.code, name:e.name}; } }", {"action": action, "typingDelayMs": 0, "start_url": HOME, **options})


def test_paced_typing_emits_intermediate_input_and_get_search_navigates(actor):
    actor.evaluate("() => document.querySelector('#query').addEventListener('input', event => fixture.typed.push(event.target.value))")
    first = observation(actor)
    assert first["url"] == HOME
    assert len(first["elements"]) <= 40
    assert execute(actor, action_for(first, "type", "Search jobs", text="asyncio"), typingDelayMs=1)["status"] == "executed"
    assert actor.evaluate("() => fixture.typed") == ["", "a", "as", "asy", "asyn", "async", "asynci", "asyncio"]
    current = observation(actor)
    clicked = execute(actor, action_for(current, "click", "Go"))
    assert clicked["navigation"] is True
    assert clicked["destination"] == HOME + "search"
    actor.wait_for_url("**/search?**")
    assert parse_qs(urlsplit(actor.url).query) == {"q": ["asyncio"], "area": ["default"]}


def append_file_picker(actor, *, name=None, hidden=True, inside_form=True):
    """Add an ordinary native file control to the isolated public-search fixture."""
    actor.evaluate("""options => {
        const field=document.createElement('input');
        field.id='aux-file'; field.type='file'; field.hidden=options.hidden;
        if (options.name !== null) field.name=options.name;
        (options.inside_form ? document.querySelector('form') : document.body).append(field);
    }""", {"name": name, "hidden": hidden, "inside_form": inside_form})


def select_fixture_file(actor):
    """Set synthetic fixture bytes only; the actor must prevent their submission."""
    actor.locator("#aux-file").set_input_files({"name": "fixture.txt", "mimeType": "text/plain", "buffer": b"fixture-only"})
    assert actor.evaluate("() => document.querySelector('#aux-file').files.length") == 1


@pytest.mark.parametrize("name", [None, ""])
@pytest.mark.parametrize("kind", ["click", "press"])
def test_empty_unnamed_hidden_file_pickers_allow_public_get_search(actor, name, kind):
    append_file_picker(actor, name=name)
    actor.evaluate("() => { const field=document.querySelector('#aux-file'); field.after(field.cloneNode()); }")
    assert actor.evaluate("() => Array.from(document.querySelectorAll('input[type=file]'), field => field.files.length)") == [0, 0]
    first = observation(actor)
    assert execute(actor, action_for(first, "type", "Search jobs", text="backend Israel"))["status"] == "executed"
    assert actor.locator("#query").input_value() == "backend Israel"
    assert actor.url == HOME
    snapshot = observation(actor)
    action = action_for(snapshot, "click", "Go") if kind == "click" else action_for(snapshot, "press", "Search jobs", key="Enter")
    assert execute(actor, action)["navigation"] is True
    actor.wait_for_url("**/search?**")
    assert parse_qs(urlsplit(actor.url).query) == {"q": ["backend Israel"], "area": ["default"]}


@pytest.mark.parametrize("variant", ["named", "space-name", "selected", "visible", "css-only-hidden", "hidden-visible", "until-found", "unknown-files", "fake-files"])
def test_file_picker_exception_rejects_other_file_states(actor, variant):
    append_file_picker(actor)
    if variant == "selected":
        select_fixture_file(actor)
    else:
        actor.evaluate("""variant => {
            const field=document.querySelector('#aux-file');
            if (variant === 'named') field.name='attachment';
            if (variant === 'space-name') field.name=' ';
            if (variant === 'visible') field.hidden=false;
            if (variant === 'css-only-hidden') { field.hidden=false; field.style.display='none'; }
            if (variant === 'hidden-visible') field.style.display='block';
            if (variant === 'until-found') field.hidden='until-found';
            if (variant === 'unknown-files') Object.defineProperty(field,'files',{value:null});
            if (variant === 'fake-files') Object.defineProperty(field,'files',{value:{length:0}});
        }""", variant)
    first = observation(actor)
    assert failure(actor, action_for(first, "type", "Search jobs", text="blocked"))["code"] == "manual_review"
    assert actor.locator("#query").input_value() == ""
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "click", "Go"))["code"] == "manual_review"
    assert actor.url == HOME


@pytest.mark.parametrize("mutation", ["named", "selected"])
def test_file_state_changes_during_typing_stop_before_the_next_character(actor, mutation):
    append_file_picker(actor, inside_form=mutation != "selected")
    if mutation == "selected":
        select_fixture_file(actor)
    actor.evaluate("""mutation => document.querySelector('#query').addEventListener('input', event => {
        if (event.target.value !== 'a') return;
        const field=document.querySelector('#aux-file');
        if (mutation === 'named') field.name='attachment';
        else document.querySelector('form').append(field);
    })""", mutation)
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "type", "Search jobs", text="abc"))["code"] == "manual_review"
    assert actor.locator("#query").input_value() == "a"
    assert actor.url == HOME


@pytest.mark.parametrize("kind", ["click", "press"])
def test_file_selected_after_typing_prevents_get_submission(actor, kind):
    append_file_picker(actor)
    first = observation(actor)
    assert execute(actor, action_for(first, "type", "Search jobs", text="public query"))["status"] == "executed"
    select_fixture_file(actor)
    snapshot = observation(actor)
    action = action_for(snapshot, "click", "Go") if kind == "click" else action_for(snapshot, "press", "Search jobs", key="Enter")
    assert failure(actor, action)["code"] == "manual_review"
    assert actor.url == HOME


@pytest.mark.parametrize("boundary", ["post", "credential"])
def test_empty_auxiliary_picker_does_not_relax_other_form_boundaries(actor, boundary):
    append_file_picker(actor)
    actor.evaluate("""boundary => {
        const form=document.querySelector('form');
        if (boundary === 'post') form.method='post';
        else { const credential=document.createElement('input'); credential.type='hidden'; credential.name='access_token'; form.append(credential); }
    }""", boundary)
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "type", "Search jobs", text="blocked"))["code"] == "manual_review"
    assert actor.locator("#query").input_value() == ""
    assert actor.url == HOME


def test_direct_file_control_target_still_requires_manual_handling(actor):
    append_file_picker(actor, hidden=False)
    actor.evaluate("() => document.querySelector('#aux-file').setAttribute('aria-label','Search file')")
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "click", "Search file"))["code"] == "manual_review"
    assert actor.evaluate("() => document.querySelector('#aux-file').files.length") == 0


def test_link_click_uses_observed_public_destination(actor):
    snapshot = observation(actor)
    result = execute(actor, action_for(snapshot, "click", "Documentation"))
    assert result["navigation"] is True
    actor.wait_for_url(HOME + "guide")


def test_extract_returns_exact_visible_text_and_no_input_values(actor):
    actor.locator("#query").fill("secret-query-not-in-innerText")
    snapshot = observation(actor)
    result = execute(actor, action_for(snapshot, "extract"))
    assert result["text"] == snapshot["text"]
    assert "secret-query-not-in-innerText" not in result["text"]
    assert result["url"] == HOME


def test_replaced_reference_and_mutated_password_target_fail_closed(actor):
    snapshot = observation(actor)
    actor.evaluate("() => { const old = document.querySelector('#query'); old.replaceWith(old.cloneNode(true)); }")
    assert failure(actor, action_for(snapshot, "type", "Search jobs", text="blocked"))["code"] == "changed_control"
    snapshot = observation(actor)
    actor.evaluate("() => document.querySelector('#query').type = 'password'")
    assert failure(actor, action_for(snapshot, "type", "Search jobs", text="blocked"))["code"] == "changed_control"
    assert actor.locator("#query").input_value() == ""


def test_first_input_focus_redirection_blocks_remaining_characters(actor):
    actor.evaluate("() => document.querySelector('#query').addEventListener('input', event => { if (event.target.value === 'a') document.querySelector('#other').focus(); })")
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "type", "Search jobs", text="abc"))["code"] == "focus_changed"
    assert actor.locator("#query").input_value() == "a"
    assert actor.locator("#other").input_value() == ""


def test_first_input_password_mutation_blocks_remaining_characters(actor):
    actor.evaluate("() => document.querySelector('#query').addEventListener('input', event => { if (event.target.value === 'a') event.target.type = 'password'; })")
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "type", "Search jobs", text="abc"))["code"] == "changed_control"
    assert actor.locator("#query").input_value() == "a"


def test_port_disconnect_during_typing_stops_before_next_character(actor):
    actor.evaluate("() => document.querySelector('#query').addEventListener('input', event => { if (event.target.value === 'a') fixture.port.disconnect(); })")
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "type", "Search jobs", text="abc"))["name"] == "AbortError"
    assert actor.locator("#query").input_value() == "a"


def test_non_get_and_consequential_controls_require_manual_handling(actor):
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "type", "Search", text="blocked"))["code"] == "manual_review"
    assert failure(actor, action_for(snapshot, "click", "Delete account"))["code"] == "manual_review"
    assert actor.locator("#post-query").input_value() == ""


def test_hidden_credential_control_prevents_get_submission(actor):
    actor.evaluate("() => { const field = document.createElement('input'); field.type='hidden'; field.name='access_token'; field.value='private'; document.querySelector('form').append(field); }")
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "click", "Go"))["code"] == "manual_review"
    assert actor.url == HOME


def test_new_observation_invalidates_previous_action(actor):
    first = observation(actor)
    observation(actor)
    assert failure(actor, action_for(first, "type", "Search jobs", text="blocked"))["code"] == "stale_snapshot"


def load_driver(page):
    page.evaluate("""async () => {
      const {BrowserDriver} = await import('/extension/browser-driver.mjs');
      window.driver = new BrowserDriver({maxSteps:12,typingDelayMs:0,requestTimeoutMs:30000,searchUrl:'https://search-fixture.example/search',searchParameter:'q'});
      await driver.bindCurrentTab();
    }""")


def test_driver_targets_one_main_frame_document_and_never_retargets(actor):
    load_driver(actor)
    snapshot = actor.evaluate("() => driver.observe()")
    assert snapshot["document_id"] == "document-A"
    assert actor.evaluate("() => fixture.lastConnect") == {"id": 7, "name": "jev-browser-v1", "documentId": "document-A"}
    assert actor.evaluate("() => fixture.lastInjection.target") == {"tabId": 7, "frameIds": [0]}
    actor.evaluate("() => { fixture.activeTabId = 8; }")
    assert actor.evaluate("async () => { try { await driver.observe(); } catch(e) { return e.code; } }") == "tab_changed"


def test_driver_rejects_unexpected_document_replacement(actor):
    load_driver(actor)
    actor.evaluate("() => driver.observe()")
    actor.evaluate("() => { fixture.documentId = 'document-B'; }")
    assert actor.evaluate("async () => { try { await driver.observe(); } catch(e) { return e.code; } }") == "stale_snapshot"


def test_driver_cancel_disconnects_typing_and_pending_navigation_wait(actor):
    load_driver(actor)
    actor.evaluate("() => document.querySelector('#query').addEventListener('input', event => { if(event.target.value==='a') driver.cancel(); })")
    snapshot = actor.evaluate("() => driver.observe()")
    action = action_for(snapshot, "type", "Search jobs", text="abc")
    assert actor.evaluate("async action => { try { await driver.execute(action); } catch(e) { return e.name; } }", action) == "AbortError"
    assert actor.locator("#query").input_value() == "a"
    actor.evaluate("async () => { await driver.bindCurrentTab(); fixture.loading=true; window.waitResult=driver.observe().catch(e=>e.name); }")
    actor.wait_for_function("() => fixture.updated.handlers.size === 1")
    actor.evaluate("() => driver.cancel()")
    assert actor.evaluate("() => waitResult") == "AbortError"
    assert actor.evaluate("() => fixture.updated.handlers.size") == 0


def test_website_grant_requests_only_the_selected_host(actor):
    load_driver(actor)
    assert actor.evaluate("() => driver.grantCurrentSite()") is True
    assert actor.evaluate("() => fixture.permissionOrigins") == [["https://browser-fixture.example/*"]]


@pytest.mark.parametrize("attribute,value", [
    ("formmethod", "post"),
    ("formaction", "https://other-fixture.example/account/delete"),
    ("formtarget", "_blank"),
])
@pytest.mark.parametrize("kind", ["click", "press"])
def test_native_submitter_overrides_are_blocked_before_click_or_enter(actor, attribute, value, kind):
    actor.evaluate("([attribute,value]) => document.querySelector('#go').setAttribute(attribute,value)", [attribute, value])
    snapshot = observation(actor)
    action = action_for(snapshot, "click", "Go") if kind == "click" else action_for(snapshot, "press", "Search jobs", key="Enter")
    assert failure(actor, action)["code"] == "manual_review"
    assert actor.url == HOME


def test_submitter_override_mutation_invalidates_observed_fingerprint(actor):
    snapshot = observation(actor)
    actor.evaluate("() => document.querySelector('#go').setAttribute('formmethod','post')")
    assert failure(actor, action_for(snapshot, "click", "Go"))["code"] == "changed_control"
    assert actor.url == HOME


def test_navigation_acknowledgment_waits_for_real_chrome_readiness_and_keeps_origin(actor):
    load_driver(actor)
    snapshot = actor.evaluate("() => driver.observe()")
    action = action_for(snapshot, "click", "Documentation")
    actor.evaluate("""action => {
      fixture.deferAction = true;
      fixture.executed = false;
      window.navigationResult = driver.execute(action).then(result => { fixture.executed=true; return result; });
    }""", action)
    actor.wait_for_function("() => Boolean(fixture.pendingAction)")
    actor.evaluate("() => fixture.confirmAction({status:'executed',url:location.href,title:document.title,navigation:true,destination:'https://other-fixture.example/guide'})")
    actor.wait_for_function("() => driver.pendingOrigin === 'https://other-fixture.example'")
    assert actor.evaluate("() => fixture.executed") is False
    actor.evaluate("() => { fixture.loading=true; fixture.queryUrl='https://other-fixture.example/guide'; fixture.updated.emit(7,{status:'loading',url:fixture.queryUrl}); }")
    assert actor.evaluate("() => fixture.executed") is False
    actor.evaluate("() => { fixture.loading=false; fixture.urlVisible=false; fixture.updated.emit(7,{status:'complete'}); }")
    assert actor.evaluate("() => navigationResult")["status"] == "executed"
    assert actor.evaluate("() => driver.grantCurrentSite()") is True
    assert actor.evaluate("() => fixture.permissionOrigins") == [["https://other-fixture.example/*"]]
    assert actor.evaluate("() => fixture.updated.handlers.size") == 0


def test_stop_cancels_acked_navigation_before_document_readiness(actor):
    load_driver(actor)
    snapshot = actor.evaluate("() => driver.observe()")
    action = action_for(snapshot, "click", "Documentation")
    actor.evaluate("action => { fixture.deferAction=true; window.navigationResult=driver.execute(action).catch(error=>error.name); }", action)
    actor.wait_for_function("() => Boolean(fixture.pendingAction)")
    actor.evaluate("() => fixture.confirmAction({status:'executed',url:location.href,title:document.title,navigation:true,destination:'https://other-fixture.example/guide'})")
    actor.wait_for_function("() => driver.pendingOrigin === 'https://other-fixture.example'")
    actor.evaluate("() => driver.cancel()")
    assert actor.evaluate("() => navigationResult") == "AbortError"
    assert actor.evaluate("() => fixture.updated.handlers.size") == 0



def install_worker_fixture(actor, *, reject_configuration=False, reject_open=False):
    """Execute the packaged worker with observable action and side-panel APIs."""
    actor.evaluate("""options => {
        fixture.worker = { handlers: [], behaviors: [], opened: [], errors: [] };
        console.error = (...args) => fixture.worker.errors.push(args.map(String));
        chrome.action = { onClicked: { addListener: handler => fixture.worker.handlers.push(handler) } };
        chrome.sidePanel = {
            setPanelBehavior: behavior => {
                fixture.worker.behaviors.push(behavior);
                if (options.reject_configuration) return Promise.reject(new TypeError('private configuration detail'));
                return new Promise(resolve => { fixture.worker.finishConfiguration = resolve; });
            },
            open: options => {
                fixture.worker.opened.push(options);
                return options && fixture.worker.rejectOpen
                    ? Promise.reject(new TypeError('private opening detail')) : Promise.resolve();
            },
        };
        fixture.worker.rejectOpen = options.reject_open;
    }""", {"reject_configuration": reject_configuration, "reject_open": reject_open})
    actor.add_script_tag(content=(ROOT / "background.js").read_text())


def test_toolbar_handler_opens_clicked_window_before_configuration_settles(actor):
    install_worker_fixture(actor)
    assert actor.evaluate("() => fixture.worker.behaviors") == [{"openPanelOnActionClick": False}]
    assert actor.evaluate("() => fixture.worker.handlers.length") == 1
    assert actor.evaluate("""() => {
        fixture.worker.handlers[0]({windowId:42});
        return fixture.worker.opened;
    }""") == [{"windowId": 42}]
    assert actor.evaluate("() => fixture.worker.errors") == []


@pytest.mark.parametrize("tab", [None, {}, {"windowId": None}, {"windowId": "42"}, {"windowId": -1}])
def test_toolbar_handler_rejects_invalid_window_without_opening(actor, tab):
    install_worker_fixture(actor)
    actor.evaluate("tab => fixture.worker.handlers[0](tab)", tab)
    assert actor.evaluate("() => fixture.worker.opened") == []
    assert actor.evaluate("() => fixture.worker.errors") == [["Ollama Copilot could not identify the clicked window."]]


def test_toolbar_handler_retains_action_and_reports_configuration_failure(actor):
    install_worker_fixture(actor, reject_configuration=True)
    actor.wait_for_function("() => fixture.worker.errors.length === 1")
    actor.evaluate("() => fixture.worker.handlers[0]({windowId:42})")
    assert actor.evaluate("() => fixture.worker.opened") == [{"windowId": 42}]
    assert actor.evaluate("() => fixture.worker.errors") == [["Ollama Copilot could not configure its side panel:", "TypeError"]]


def test_toolbar_handler_reports_panel_failure_without_sensitive_error_text(actor):
    install_worker_fixture(actor, reject_open=True)
    actor.evaluate("() => fixture.worker.handlers[0]({windowId:42})")
    actor.wait_for_function("() => fixture.worker.errors.length === 1")
    assert actor.evaluate("() => fixture.worker.errors") == [["Ollama Copilot could not open its side panel:", "TypeError"]]


def test_unpacked_extension_loads_real_worker_panel_storage_and_csp(tmp_path, playwright_runtime):
    """Real MV3 APIs in a disposable profile; no permission shim or model call."""
    context = playwright_runtime.chromium.launch_persistent_context(
        tmp_path / "unpacked-profile", channel="chromium", headless=True,
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
    )
    try:
        workers = context.service_workers
        worker = workers[0] if workers else context.wait_for_event("serviceworker", timeout=TIMEOUT_MS)
        extension_id = urlsplit(worker.url).hostname
        assert extension_id
        assert worker.evaluate("() => chrome.runtime.getManifest().manifest_version") == 3
        panel = context.new_page()
        errors = []
        panel.on("pageerror", lambda error: errors.append(str(error)))
        panel.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        panel.goto(f"chrome-extension://{extension_id}/sidepanel.html")
        panel.wait_for_function("() => document.querySelector('#ollama-url').value.startsWith('http://')")
        panel.wait_for_function("async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick === false")
        assert panel.locator("#goal").is_enabled()
        assert panel.evaluate("""async () => {
            await chrome.storage.local.set({smoke:'local'});
            await chrome.storage.session.set({smoke:'session'});
            const local = await chrome.storage.local.get('smoke');
            const session = await chrome.storage.session.get('smoke');
            await chrome.storage.local.remove('smoke');
            await chrome.storage.session.remove('smoke');
            return [local.smoke, session.smoke];
        }""") == ["local", "session"]
        manifest = panel.evaluate("() => chrome.runtime.getManifest()")
        assert set(manifest["permissions"]) == {"activeTab", "sidePanel", "scripting", "storage"}
        assert "unsafe-eval" not in manifest["content_security_policy"]["extension_pages"]
        assert "unsafe-inline" not in manifest["content_security_policy"]["extension_pages"]
        assert panel.evaluate("() => chrome.runtime.id") == extension_id
        assert errors == []
        screenshot = os.environ.get("JEV_EXTENSION_SCREENSHOT")
        if screenshot:
            panel.screenshot(path=screenshot, full_page=True)
    finally:
        context.close()


@pytest.mark.parametrize("label", ["Close account", "Deactivate my account", "Terminate subscription", "Open bank account"])
def test_account_lifecycle_buttons_never_dispatch_a_consequential_handler(actor, label):
    actor.evaluate("label => { window.consequentialClicked=0; const button=document.createElement('button'); button.textContent=label; button.onclick=()=>consequentialClicked++; document.querySelector('main').append(button); }", label)
    snapshot = observation(actor)
    assert failure(actor, action_for(snapshot, "click", label))["code"] == "manual_review"
    assert actor.evaluate("() => consequentialClicked") == 0


def test_close_dialog_remains_a_supported_reading_ui_control(actor):
    actor.evaluate("() => { window.dialogClosed=false; const button=document.createElement('button'); button.textContent='Close dialog'; button.onclick=()=>dialogClosed=true; document.querySelector('main').append(button); }")
    snapshot = observation(actor)
    assert execute(actor, action_for(snapshot, "click", "Close dialog"))["status"] == "executed"
    assert actor.evaluate("() => dialogClosed") is True


def test_prevented_get_submission_does_not_invent_native_navigation(actor):
    actor.evaluate("() => document.querySelector('form').addEventListener('submit', event => event.preventDefault())")
    snapshot = observation(actor)
    result = execute(actor, action_for(snapshot, "click", "Go"))
    assert result["status"] == "executed"
    assert "navigation" not in result
    assert actor.url == HOME


def test_native_get_enter_reports_navigation_for_the_readiness_barrier(actor):
    snapshot = observation(actor)
    result = execute(actor, action_for(snapshot, "press", "Search jobs", key="Enter"))
    assert result["navigation"] is True
    assert result["destination"] == HOME + "search"
    actor.wait_for_url("**/search?**")


def test_driver_does_not_confirm_an_action_when_its_document_disconnects_before_ack(actor):
    load_driver(actor)
    snapshot = actor.evaluate("() => driver.observe()")
    action = action_for(snapshot, "click", "Documentation")
    actor.evaluate("action => { fixture.deferAction=true; window.unconfirmed=driver.execute(action).then(result=>({status:result.status}),error=>({code:error.code})); }", action)
    actor.wait_for_function("() => Boolean(fixture.pendingAction)")
    actor.evaluate("() => fixture.connections.at(-1).disconnect()")
    assert actor.evaluate("() => unconfirmed") == {"code": "document_disconnected"}
    assert actor.evaluate("() => fixture.updated.handlers.size") == 0



def test_unpacked_content_actor_supports_insecure_http_without_random_uuid(tmp_path, playwright_runtime):
    """Real isolated-world actor, with only this exact synthetic host granted in the test copy."""
    fixture_home = "http://crypto-fixture.example/"
    unpacked = shutil.copytree(ROOT, tmp_path / "http-extension", ignore=shutil.ignore_patterns("tests", "node_modules", "__pycache__", ".pytest_cache", ".git", ".venv", ".test-venv"))
    manifest_path = unpacked / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["host_permissions"].append(fixture_home + "*")
    manifest_path.write_text(json.dumps(manifest))
    context = playwright_runtime.chromium.launch_persistent_context(
        tmp_path / "http-profile", channel="chromium", headless=True,
        args=[f"--disable-extensions-except={unpacked}", f"--load-extension={unpacked}"],
    )
    try:
        context.set_default_timeout(TIMEOUT_MS)
        context.route(fixture_home + "**", lambda route: route.fulfill(body=HTML, content_type="text/html"))
        workers = context.service_workers
        worker = workers[0] if workers else context.wait_for_event("serviceworker", timeout=TIMEOUT_MS)
        extension_id = urlsplit(worker.url).hostname
        target = context.new_page()
        target.goto(fixture_home)
        panel = context.new_page()
        panel.goto(f"chrome-extension://{extension_id}/sidepanel.html")
        panel.wait_for_function("() => document.querySelector('#ollama-url').value.startsWith('http://')")
        binding = panel.evaluate("""async home => {
            const [tab] = await chrome.tabs.query({url: home + '*'});
            const [capabilities] = await chrome.scripting.executeScript({
                target: {tabId: tab.id, frameIds: [0]}, world: 'ISOLATED',
                func: () => ({secure: isSecureContext, uuid: typeof crypto.randomUUID, rng: typeof crypto.getRandomValues}),
            });
            const [injection] = await chrome.scripting.executeScript({
                target: {tabId: tab.id, frameIds: [0]}, world: 'ISOLATED', files: ['content.js'],
            });
            return {tabId: tab.id, documentId: injection.documentId, capabilities: capabilities.result};
        }""", fixture_home)
        assert binding["capabilities"] == {"secure": False, "uuid": "undefined", "rng": "function"}
        target.bring_to_front()
        snapshots = panel.evaluate("""async ({tabId, documentId}) => {
            const port = chrome.tabs.connect(tabId, {name:'jev-browser-v1', documentId});
            const pending = new Map();
            port.onMessage.addListener(message => {
                const request = pending.get(message.id);
                if (!request) return;
                pending.delete(message.id);
                if (message.ok) request.resolve(message.result);
                else request.reject(new Error(message.error.code + ': ' + message.error.message));
            });
            port.onDisconnect.addListener(() => {
                for (const request of pending.values()) request.reject(new Error(chrome.runtime.lastError?.message || 'Document disconnected'));
                pending.clear();
            });
            const request = (op, args = {}) => new Promise((resolve, reject) => {
                const id = crypto.randomUUID();
                pending.set(id, {resolve, reject}); port.postMessage({id, op, ...args});
            });
            try {
                const first = await request('observe');
                const second = await request('observe');
                const control = second.elements.find(element => element.label === 'Search jobs');
                const result = await request('execute', {typingDelayMs: 0,
                    action: {kind:'type', snapshot_id:second.snapshot_id, target_id:control.id, text:'HTTP research'}});
                return {first, second, result};
            } finally { port.disconnect(); }
        }""", binding)
        assert snapshots["first"]["url"] == fixture_home
        assert snapshots["second"]["url"] == fixture_home
        assert snapshots["first"]["snapshot_id"] != snapshots["second"]["snapshot_id"]
        for observation in [snapshots["first"], snapshots["second"]]:
            assert len(observation["snapshot_id"]) == 32
            assert all(character in "0123456789abcdef" for character in observation["snapshot_id"])
        assert snapshots["result"]["status"] == "executed"
        assert target.locator("#query").input_value() == "HTTP research"
    finally:
        context.close()


def test_open_tab_resolves_a_fresh_reading_anchor_without_page_navigation(actor):
    snapshot = observation(actor)
    result = execute(actor, action_for(snapshot, "open_tab", "Documentation"))
    assert result["destination"] == HOME + "guide"
    assert result["url"] == HOME
    assert "navigation" not in result
    assert actor.url == HOME
    assert failure(actor, action_for(snapshot, "open_tab", "Documentation"))["code"] == "stale_snapshot"


def test_open_tab_checks_current_anchor_fingerprint_and_download_policy(actor):
    first = observation(actor)
    actor.evaluate("() => document.querySelector('#docs').href = '/changed'")
    assert failure(actor, action_for(first, "open_tab", "Documentation"))["code"] == "changed_control"
    actor.evaluate("() => { document.querySelector('#docs').href = '/guide'; document.querySelector('#docs').setAttribute('download',''); }")
    current = observation(actor)
    assert failure(actor, action_for(current, "open_tab", "Documentation"))["code"] == "manual_review"
    assert actor.url == HOME


def test_driver_opens_only_a_task_tab_and_switches_only_observed_owned_refs(actor):
    # The native tab API transport is simulated; the packaged actor still resolves
    # the actual observed DOM anchor. The unpacked workflow covers separate real pages.
    actor.evaluate("() => document.querySelector('#docs').href = location.href")
    load_driver(actor)
    first = actor.evaluate("() => driver.observe()")
    initial_ref = first["tab_ref"]
    assert first["tabs"] == [{"ref": initial_ref, "title": "Public fixture", "url": HOME, "active": True}]
    opened = actor.evaluate("action => driver.execute(action)", action_for(first, "open_tab", "Documentation"))
    assert opened["status"] == "executed"
    assert opened["tab_ref"] != initial_ref
    assert actor.evaluate("() => fixture.createdTabs") == [{"url": HOME, "active": True, "windowId": 11, "openerTabId": 7}]
    assert actor.evaluate("() => driver.observation") is None
    second = actor.evaluate("() => driver.observe()")
    assert len(second["tabs"]) == 2
    assert not any("id" in tab or "tabId" in tab for tab in second["tabs"])
    unknown = action_for(second, "switch_tab", tab_ref="other-user-tab")
    assert actor.evaluate("async action => { try { await driver.execute(action); } catch(e) { return e.code; } }", unknown) == "unknown_tab"
    same = action_for(second, "switch_tab", tab_ref=second["tab_ref"])
    assert actor.evaluate("async action => { try { await driver.execute(action); } catch(e) { return e.code; } }", same) == "unknown_tab"
    assert actor.evaluate("() => fixture.activatedTabs") == []
    switched = actor.evaluate("action => driver.execute(action)", action_for(second, "switch_tab", tab_ref=initial_ref))
    assert switched["tab_ref"] == initial_ref
    assert actor.evaluate("() => fixture.activatedTabs") == [{"id": 7, "active": True}]
    assert actor.evaluate("() => driver.observation") is None
    third = actor.evaluate("() => driver.observe()")
    assert third["tab_ref"] == initial_ref
    assert third["snapshot_id"] != first["snapshot_id"]
    actor.evaluate("() => { fixture.activeTabId=99; }")
    assert actor.evaluate("async () => { try { await driver.observe(); } catch(e) { return e.code; } }") == "tab_changed"


def test_driver_retains_independent_history_and_rejects_background_document_replacement(actor):
    actor.evaluate("() => document.querySelector('#docs').href = location.href")
    load_driver(actor)
    first = actor.evaluate("() => driver.observe()")
    initial_ref = first["tab_ref"]
    actor.evaluate("() => driver.history.unshift(location.href + 'earlier')")
    actor.evaluate("action => driver.execute(action)", action_for(first, "open_tab", "Documentation"))
    second = actor.evaluate("() => driver.observe()")
    assert actor.evaluate("() => driver.history") == [HOME]
    assert actor.evaluate("async action => { try { await driver.execute(action); } catch(e) { return e.code; } }", action_for(second, "back")) == "no_history"
    actor.evaluate("action => driver.execute(action)", action_for(second, "switch_tab", tab_ref=initial_ref))
    assert actor.evaluate("() => driver.history") == [HOME + "earlier", HOME]
    actor.evaluate("() => { fixture.documentId='replaced-while-background'; }")
    assert actor.evaluate("async () => { try { await driver.observe(); } catch(e) { return e.code; } }") == "stale_snapshot"


def test_stop_before_link_resolution_prevents_native_tab_creation(actor):
    load_driver(actor)
    snapshot = actor.evaluate("() => driver.observe()")
    actor.evaluate("action => { fixture.deferAction=true; window.tabAction=driver.execute(action).catch(e=>e.name); }", action_for(snapshot, "open_tab", "Documentation"))
    actor.wait_for_function("() => Boolean(fixture.pendingAction)")
    actor.evaluate("() => driver.cancel()")
    assert actor.evaluate("() => tabAction") == "AbortError"
    assert actor.evaluate("() => fixture.createdTabs") == []


def test_stop_during_committed_tab_creation_never_adopts_or_observes_the_tab(actor):
    load_driver(actor)
    snapshot = actor.evaluate("() => driver.observe()")
    initial_ref = snapshot["tab_ref"]
    actor.evaluate("action => { fixture.deferCreate=true; window.tabAction=driver.execute(action).catch(e=>e.name); }", action_for(snapshot, "open_tab", "Documentation"))
    actor.wait_for_function("() => Boolean(fixture.confirmCreate)")
    actor.evaluate("() => { driver.cancel(); fixture.confirmCreate(); }")
    assert actor.evaluate("() => tabAction") == "AbortError"
    assert actor.evaluate("() => driver.tabRef") == initial_ref
    assert actor.evaluate("() => driver.taskTabs.size") == 1
    assert actor.evaluate("() => fixture.createdTabs.length") == 1
    assert actor.evaluate("() => fixture.lastInjection.target.tabId") == 7


def test_new_tab_grant_keeps_only_its_known_destination_origin(actor):
    load_driver(actor)
    snapshot = actor.evaluate("() => driver.observe()")
    actor.evaluate("action => driver.execute(action)", action_for(snapshot, "open_tab", "Documentation"))
    actor.evaluate("() => { fixture.tabData.get(fixture.activeTabId).url=undefined; }")
    assert actor.evaluate("async () => { try { await driver.observe(); } catch(e) { return e.code; } }") == "site_access_required"
    assert actor.evaluate("() => driver.grantCurrentSite()") is True
    assert actor.evaluate("() => fixture.permissionOrigins") == [["https://browser-fixture.example/*"]]


@pytest.mark.parametrize("has_site_access", [True, False])
def test_new_tab_waits_for_complete_metadata_before_any_injection(actor, has_site_access):
    actor.evaluate("() => document.querySelector('#docs').href = location.href")
    load_driver(actor)
    first = actor.evaluate("() => driver.observe()")
    actor.evaluate("action => driver.execute(action)", action_for(first, "open_tab", "Documentation"))
    actor.evaluate("() => { const tab=fixture.tabData.get(fixture.activeTabId); tab.url=undefined; tab.status='loading'; window.tabObservation=driver.observe().then(result=>({result}),error=>({code:error.code})); }")
    actor.wait_for_function("() => fixture.updated.handlers.size === 1")
    assert actor.evaluate("() => fixture.lastInjection.target.tabId") == 7
    actor.evaluate("hasAccess => { const tab=fixture.tabData.get(fixture.activeTabId); tab.url=hasAccess ? location.href : undefined; tab.status='complete'; fixture.updated.emit(tab.id,{status:'complete'}); }", has_site_access)
    outcome = actor.evaluate("() => tabObservation")
    if has_site_access:
        assert outcome["result"]["url"] == HOME
        assert actor.evaluate("() => fixture.lastInjection.target.tabId") == 8
    else:
        assert outcome == {"code": "site_access_required"}
        assert actor.evaluate("() => fixture.lastInjection.target.tabId") == 7
    assert actor.evaluate("() => fixture.updated.handlers.size") == 0


def test_tab_budget_and_moved_registry_tab_cannot_dispatch_an_extra_browser_action(actor):
    actor.evaluate("() => document.querySelector('#docs').href = location.href")
    load_driver(actor)
    actor.evaluate("() => { driver.settings.maxSteps=1; }")
    first = actor.evaluate("() => driver.observe()")
    actor.evaluate("action => driver.execute(action)", action_for(first, "open_tab", "Documentation"))
    second = actor.evaluate("() => driver.observe()")
    assert actor.evaluate("async action => { try { await driver.execute(action); } catch(e) { return e.code; } }", action_for(second, "open_tab", "Documentation")) == "tab_limit"
    assert actor.evaluate("() => fixture.createdTabs.length") == 1
    actor.evaluate("() => fixture.tabData.set(7,{id:7,windowId:12,url:location.href,status:'complete'})")
    assert actor.evaluate("async action => { try { await driver.execute(action); } catch(e) { return e.code; } }", action_for(second, "switch_tab", tab_ref=first["tab_ref"])) == "tab_changed"
    assert actor.evaluate("() => fixture.activatedTabs") == []


def test_stop_during_committed_tab_switch_does_not_adopt_or_observe_the_destination(actor):
    actor.evaluate("() => document.querySelector('#docs').href = location.href")
    load_driver(actor)
    first = actor.evaluate("() => driver.observe()")
    actor.evaluate("action => driver.execute(action)", action_for(first, "open_tab", "Documentation"))
    second = actor.evaluate("() => driver.observe()")
    actor.evaluate("action => { fixture.deferUpdate=true; window.tabSwitch=driver.execute(action).catch(e=>e.name); }", action_for(second, "switch_tab", tab_ref=first["tab_ref"]))
    actor.wait_for_function("() => Boolean(fixture.confirmUpdate)")
    actor.evaluate("() => { driver.cancel(); fixture.confirmUpdate(); }")
    assert actor.evaluate("() => tabSwitch") == "AbortError"
    assert actor.evaluate("() => driver.tabRef") == second["tab_ref"]
    assert actor.evaluate("() => fixture.lastInjection.target.tabId") == 8
    assert actor.evaluate("() => fixture.activatedTabs") == [{"id": 7, "active": True}]
