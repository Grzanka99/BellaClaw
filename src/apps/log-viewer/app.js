const THEME_STORAGE_KEY = "bellaclaw-log-viewer-theme";

function getActiveTheme() {
  const selected = document.documentElement.dataset.theme;

  if (selected === "light" || selected === "dark") {
    return selected;
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function initializeTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);

  if (saved === "light" || saved === "dark") {
    document.documentElement.dataset.theme = saved;
  }

  updateThemeControls();
}

function updateThemeControls() {
  const activeTheme = getActiveTheme();
  document.documentElement.dataset.currentTheme = activeTheme;

  for (const label of document.querySelectorAll("[data-theme-label]")) {
    label.textContent = activeTheme === "dark" ? "Light mode" : "Dark mode";
  }

  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.setAttribute("aria-label", activeTheme === "dark" ? "Use light mode" : "Use dark mode");
    button.setAttribute("title", activeTheme === "dark" ? "Use light mode" : "Use dark mode");
  }
}

function toggleTheme() {
  const nextTheme = getActiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  updateThemeControls();
}

function formatTimestamp(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));

  if (seconds < 10) {
    return "just now";
  }

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);

  if (days < 7) {
    return `${days}d ago`;
  }

  return date.toLocaleString();
}

function updateLocalTimes(root = document) {
  for (const element of root.querySelectorAll("time.local-time")) {
    const value = element.getAttribute("datetime");
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      continue;
    }

    element.textContent = formatTimestamp(date);
    element.title = date.toLocaleString();
  }
}

function selectEvent(row, manual) {
  const template = row.querySelector(":scope > .event-inspector-template");
  const inspector = document.querySelector("#event-inspector-content");

  if (!(template instanceof HTMLTemplateElement) || !inspector) {
    return;
  }

  for (const candidate of document.querySelectorAll("[data-event-selectable]")) {
    const selected = candidate === row;
    candidate.classList.toggle("selected", selected);

    if (selected) {
      candidate.setAttribute("aria-current", "true");
    } else {
      candidate.removeAttribute("aria-current");
    }
  }

  inspector.replaceChildren(template.content.cloneNode(true));
  updateLocalTimes(inspector);

  if (manual) {
    document.documentElement.dataset.eventSelection = "manual";
  }
}

function currentEventJson() {
  const content = document.querySelector("#event-inspector-content [data-event-json]");
  return content?.dataset.eventJson;
}

setInterval(() => updateLocalTimes(), 30_000);
initializeTheme();

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (document.documentElement.dataset.theme === undefined) {
    updateThemeControls();
  }
});

document.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const themeToggle = event.target.closest("[data-theme-toggle]");

  if (themeToggle) {
    toggleTheme();
    return;
  }

  const copyCurrentEventButton = event.target.closest("button[data-copy-current-event]");

  if (copyCurrentEventButton) {
    const value = currentEventJson();

    if (value !== undefined) {
      await updateCopyButton(copyCurrentEventButton, value);
    }
    return;
  }

  const copyButton = event.target.closest("button[data-copy]");

  if (copyButton) {
    await updateCopyButton(copyButton, copyButton.dataset.copy ?? "");
    return;
  }

  const row = event.target.closest("[data-event-selectable]");

  if (!row || event.target.closest("a, button, input, select, summary, details")) {
    return;
  }

  selectEvent(row, true);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  if (!(event.target instanceof Element)) {
    return;
  }

  const row = event.target.closest("[data-event-selectable]");

  if (!row || event.target !== row) {
    return;
  }

  event.preventDefault();
  selectEvent(row, true);
});

async function updateCopyButton(button, value) {
  const label = button.textContent;

  try {
    await copyText(value);
    button.textContent = "Copied";
  } catch (_error) {
    button.textContent = "Copy failed";
  }

  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Copy command failed");
  }
}

function handleUpdatedContent(root) {
  updateLocalTimes(root);
  updateThemeControls();
  const warning = document.querySelector("#transient-warning");

  if (warning) {
    warning.hidden = true;
  }

  const liveStatus = document.querySelector("#live-status[data-new-count]");

  if (!liveStatus || Number(liveStatus.dataset.newCount) === 0) {
    return;
  }

  if (document.documentElement.dataset.eventSelection === "manual") {
    return;
  }

  const activeElement = document.activeElement;

  if (activeElement instanceof Element && activeElement.closest(".search-panel") !== null) {
    return;
  }

  if (window.scrollY < 160 && document.querySelector("details[open]") === null) {
    const link = liveStatus.querySelector("a[href]");

    if (link) {
      window.location.assign(link.href);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => handleUpdatedContent(document));
document.body.addEventListener("htmx:afterSwap", (event) => handleUpdatedContent(event.target));
document.body.addEventListener("logViewerWarning", (event) => {
  const warning = document.querySelector("#transient-warning");

  if (!warning) {
    return;
  }

  warning.textContent = event.detail.message;
  warning.hidden = false;
});
