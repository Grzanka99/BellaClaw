import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { type HTMLElement, type HTMLInputElement, Window } from "happy-dom";

const script = await Bun.file(new URL("./app.js", import.meta.url)).text();

test("live swaps preserve interaction state and loaded history", async () => {
  const window = new Window({ url: "http://localhost/?live=1" });
  const document = window.document;
  document.body.innerHTML = `
    <div id="app-shell">
      <form class="search-panel"><input value="draft search"></form>
      <details data-mobile-collapse open><summary>Filters</summary></details>
      <details open><summary>Recent turns</summary></details>
      <div class="results-title"><strong>1 events</strong></div>
      <div id="live-status"></div>
      <div id="events-list"><div class="event-list">
        <article data-event-id="1" data-event-selectable tabindex="0">
          <template class="event-inspector-template"><p>Selected event</p></template>
        </article>
      </div><div id="load-more"><button>Older events</button></div></div>
      <div id="event-inspector-content"></div>
    </div>`;
  try {
    runInNewContext(script, { window, document, setInterval() {} });
    const selected = document.querySelector<HTMLElement>("[data-event-id='1']");
    assert(selected);
    selected.click();
    const inspector = document.querySelector<HTMLElement>("#event-inspector-content");
    assert(inspector);
    inspector.scrollTop = 42;
    const inspectorContent = inspector.firstChild;
    const input = document.querySelector<HTMLInputElement>("input");
    assert(input);
    input.focus();
    input.setSelectionRange(2, 5);
    const pagination = document.querySelector("#load-more");
    const eventsList = document.querySelector<HTMLElement>("#events-list");
    assert(eventsList);
    eventsList.scrollTop = 200;
    selected.getBoundingClientRect = () => {
      const rect = new window.DOMRect();
      rect.y = eventsList.querySelectorAll("article").length * 50 - eventsList.scrollTop;
      return rect;
    };
    const anchorTop = selected.getBoundingClientRect().top;

    for (let repeat = 0; repeat < 2; repeat += 1) {
      const liveStatus = document.querySelector("#live-status");
      assert(liveStatus);
      liveStatus.innerHTML = `<template data-live-events><div class="event-list">
        <article data-event-id="2" data-event-selectable>New event</article>
      </div></template>`;
      liveStatus.dispatchEvent(new window.CustomEvent("htmx:afterSwap", { bubbles: true }));
    }

    expect([...eventsList.querySelectorAll("article")].map((row) => row.dataset.eventId)).toEqual([
      "2",
      "1",
    ]);
    expect(selected.getBoundingClientRect().top).toBe(anchorTop);
    expect(eventsList.scrollTop).toBe(250);
    expect(document.querySelector("[data-event-id='1']")).toBe(selected);
    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(inspector.firstChild).toBe(inspectorContent);
    expect(inspector.scrollTop).toBe(42);
    expect(document.documentElement.dataset.inspectorOpen).toBe("1");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("draft search");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(5);
    expect(document.querySelectorAll("details[open]").length).toBe(2);
    expect(document.querySelector("#load-more")).toBe(pagination);
    expect(document.querySelector(".results-title strong")?.textContent).toBe("2 events");
    expect(window.location.href).toBe("http://localhost/?live=1");
  } finally {
    await window.happyDOM.close();
  }
});

test("live updates populate empty results without opening the inspector", async () => {
  const window = new Window({ url: "http://localhost/?live=1" });
  const document = window.document;
  document.body.innerHTML = `
    <div class="results-title"><strong>0 events</strong></div>
    <div id="live-status"></div>
    <div id="events-list"><div class="empty-state">No events</div></div>
    <div id="event-inspector-content">Select an event</div>`;
  try {
    runInNewContext(script, { window, document, setInterval() {} });
    const liveStatus = document.querySelector("#live-status");
    assert(liveStatus);
    liveStatus.innerHTML = `<template data-live-events><div class="event-list">
      <article data-event-id="1">First event</article>
    </div></template>`;
    liveStatus.dispatchEvent(new window.CustomEvent("htmx:afterSwap", { bubbles: true }));
    expect(document.querySelector(".empty-state")).toBeNull();
    expect(document.querySelector("#events-list article")?.textContent).toBe("First event");
    expect(document.querySelector<HTMLElement>("#events-list")?.scrollTop).toBe(0);
    expect(document.documentElement.dataset.inspectorOpen).toBeUndefined();
  } finally {
    await window.happyDOM.close();
  }
});
