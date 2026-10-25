"""Real unpacked Chrome APIs, with deterministic Ollama and public website fixtures."""

import json
import os
import shutil
from hashlib import sha256
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import sync_playwright

EXTENSION = Path(__file__).resolve().parents[1]
FIXTURE_HOST = "workflow-fixture.example"
HOME = f"https://{FIXTURE_HOST}/"
TIMEOUT_MS = 15000
CHECKPOINT_POLL_MS = 50
ACTION_KINDS = ["type", "click", "back", "extract", "done"]
HOME_HTML = """<!doctype html><html lang="en"><head><title>Asyncio fixture overview</title></head>
<body><main><h1>Asyncio fixture overview</h1>
<p>This fixture describes async/await syntax and asyncio.run for concurrent I/O.</p>
<form action="/search" method="get"><label>Search docs <input type="search" name="q"></label>
<button type="submit">Search</button></form>
<a href="/reference">Read reference</a></main></body></html>"""
SEARCH_HTML = """<!doctype html><html lang="en"><head><title>Asyncio fixture search</title></head>
<body><main><h1>Search results for asyncio</h1><p>The requested result is the fixture overview.</p>
<a href="/">Asyncio fixture overview</a></main></body></html>"""


def test_unpacked_extension_completes_typed_get_search_back_and_capture(tmp_path):
    """Exercise production clients, driver, actor, ports, controller and storage together."""
    copied = Path(shutil.copytree(EXTENSION, tmp_path / "extension"))
    manifest_path = copied / "manifest.json"
    production_manifest = (EXTENSION / "manifest.json").read_bytes()
    manifest = json.loads(manifest_path.read_text())
    fixture_permission = f"https://{FIXTURE_HOST}/*"
    manifest["host_permissions"].append(fixture_permission)
    manifest_path.write_text(json.dumps(manifest))
    requests = []
    chat_actions = []
    settings = {}
    errors = []

    def mocked_request(route):
        request = route.request
        parsed = urlsplit(request.url)
        requests.append((request.method, request.url))
        if parsed.scheme == "chrome-extension":
            route.continue_()
            return
        if parsed.hostname == FIXTURE_HOST:
            assert request.method == "GET", "The fixture only supports reading and GET search."
            if parsed.path == "/":
                route.fulfill(body=HOME_HTML, content_type="text/html")
            elif parsed.path == "/search":
                assert parse_qs(parsed.query) == {"q": ["asyncio"]}
                route.fulfill(body=SEARCH_HTML, content_type="text/html")
            elif parsed.path == "/favicon.ico":
                route.fulfill(status=204)
            else:
                raise AssertionError(f"Unexpected fixture page: {request.url}")
            return
        assert parsed.hostname in {"localhost", "127.0.0.1"}, f"Unexpected network destination: {request.url}"
        assert settings, "Models must not be called before the user starts."
        if parsed.path == "/api/tags":
            assert request.method == "GET"
            response = {"models": [{"name": name} for name in sorted(set(settings.values()))]}
        else:
            assert request.method == "POST"
            payload = request.post_data_json
            if parsed.path == "/api/show":
                assert payload["model"] in set(settings.values())
                response = {"capabilities": ["decision"] if payload["model"] == settings["decision"] else ["completion", "tools"]}
            elif parsed.path == "/v1/systemone":
                assert payload["model"] == settings["decision"]
                if set(payload["questions"]) == {"model", "tool"}:
                    response = {"model": payload["model"], "answers": {
                        "model": {"type": "choice", "choice": "fast", "confidence": 0.95,
                                  "probabilities": {"fast": 0.95, "strong": 0.05}},
                        "tool": {"type": "choice", "choice": "interact", "confidence": 0.96,
                                 "probabilities": {"read": 0.02, "interact": 0.96, "search": 0.02}},
                    }}
                else:
                    assert set(payload["questions"]) == {"useful"}
                    response = {"model": payload["model"], "answers": {"useful": {"type": "noul", "noul": 0.99}}}
            elif parsed.path == "/api/chat":
                assert payload["model"] == settings["fast"]
                context = json.loads(payload["messages"][-1]["content"])
                observation = context["observation"]
                assert len(chat_actions) < len(ACTION_KINDS), "The task repeated beyond its scripted fixture workflow."
                kind = ACTION_KINDS[len(chat_actions)]
                assert kind in payload["format"]["properties"]["kind"]["enum"]
                action = {"kind": kind, "snapshot_id": observation["snapshot_id"], "reason": f"Fixture step: {kind}"}
                if kind == "type":
                    target = next(item for item in observation["elements"] if item.get("tag") == "input" and item.get("type") == "search")
                    action.update(target_id=target["id"], text="asyncio")
                elif kind == "click":
                    target = next(item for item in observation["elements"] if item.get("tag") == "button" and item.get("label") == "Search")
                    action["target_id"] = target["id"]
                chat_actions.append(action)
                response = {"model": payload["model"], "done": True,
                            "message": {"role": "assistant", "content": json.dumps(action)}}
            else:
                raise AssertionError(f"Unexpected model endpoint: {request.url}")
        route.fulfill(json=response)

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            tmp_path / "profile", channel="chromium", headless=True,
            args=[f"--disable-extensions-except={copied}", f"--load-extension={copied}"],
        )
        try:
            context.set_default_timeout(TIMEOUT_MS)
            context.route("**/*", mocked_request)
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
            extension_id = urlsplit(worker.url).hostname
            assert extension_id
            panel = context.new_page()
            panel.on("pageerror", lambda error: errors.append(str(error)))
            panel.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
            panel.goto(f"chrome-extension://{extension_id}/sidepanel.html")
            panel.wait_for_function("() => document.querySelector('#ollama-url').value.length > 0")
            settings.update(decision=panel.locator("#decision-model").input_value(),
                            fast=panel.locator("#fast-model").input_value(),
                            strong=panel.locator("#strong-model").input_value())
            panel.locator("#goal").fill("Fixture workflow: type asyncio in Search docs, click Search, go back, capture the overview and finish.")
            website = context.new_page()
            website.on("pageerror", lambda error: errors.append(str(error)))
            website.goto(HOME)
            expected_text = website.locator("main").inner_text().strip()
            website.bring_to_front()
            assert website.evaluate("document.visibilityState") == "visible"
            panel.evaluate("""() => {
                globalThis.fixtureCheckpoint = null;
                chrome.storage.onChanged.addListener((changes, area) => {
                    if (area === 'session' && changes.jevCheckpoint?.newValue) {
                        globalThis.fixtureCheckpoint = changes.jevCheckpoint.newValue;
                    }
                });
                document.querySelector('#task-form').requestSubmit();
            }""")
            result = panel.wait_for_function("""() => {
                const state = globalThis.fixtureCheckpoint;
                return state && ['stopped','completed','paused','failed','limit_reached','interrupted'].includes(state.status) ? state : false;
            }""", polling=CHECKPOINT_POLL_MS)
            state = result.json_value()
            assert state["status"] == "completed", (state["error"], [(method, url) for method, url in requests if urlsplit(url).scheme != "chrome-extension"], errors)
            assert [action["kind"] for action in state["actions"]] == ACTION_KINDS
            assert all(action["status"] == "executed" for action in state["actions"])
            assert len(chat_actions) == len(ACTION_KINDS)
            assert len(state["sources"]) == 1
            source = state["sources"][0]
            assert source["url"] == HOME
            assert source["text"] == expected_text
            assert source["contentHash"] == sha256(expected_text.encode()).hexdigest()
            assert source["capturedAt"]
            assert "[1]" in state["report"] and HOME in state["report"]
            assert website.url == HOME
            assert any(urlsplit(url).path == "/search" for _, url in requests)
            assert errors == []
            assert (EXTENSION / "manifest.json").read_bytes() == production_manifest
            assert fixture_permission not in json.loads(production_manifest)["host_permissions"]
            screenshot = os.environ.get("JEV_EXTENSION_WORKFLOW_SCREENSHOT")
            if screenshot:
                panel.bring_to_front()
                panel.set_viewport_size({"width": 420, "height": 900})
                panel.screenshot(path=screenshot, full_page=True)
        finally:
            context.close()
