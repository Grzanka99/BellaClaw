const THEME_STORAGE_KEY = "bellaclaw-log-viewer-theme";

function getActiveTheme() {
  const selected = document.documentElement.dataset.theme;

  if (selected !== undefined) {
    return selected;
  }

  if (window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }

  return "dark";
}

function updateThemeControls() {
  const activeTheme = getActiveTheme();
  let labelText;
  let controlText;

  if (activeTheme === "dark") {
    labelText = "Light mode";
    controlText = "Use light mode";
  } else {
    labelText = "Dark mode";
    controlText = "Use dark mode";
  }

  document.documentElement.dataset.currentTheme = activeTheme;

  for (const label of document.querySelectorAll("[data-theme-label]")) {
    label.textContent = labelText;
  }

  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.setAttribute("aria-label", controlText);
    button.setAttribute("title", controlText);
  }
}

function toggleTheme() {
  let nextTheme;

  if (getActiveTheme() === "dark") {
    nextTheme = "light";
  } else {
    nextTheme = "dark";
  }

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

    element.textContent = formatTimestamp(date);
    element.title = date.toLocaleString();
  }
}

function selectEvent(row) {
  const template = row.querySelector(":scope > .event-inspector-template");
  const inspector = document.querySelector("#event-inspector-content");

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
  document.documentElement.dataset.eventSelection = "manual";
}

setInterval(() => updateLocalTimes(), 30_000);
updateThemeControls();

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (document.documentElement.dataset.theme === undefined) {
    updateThemeControls();
  }
});

document.addEventListener("click", async (event) => {
  const themeToggle = event.target.closest("[data-theme-toggle]");

  if (themeToggle) {
    toggleTheme();
    return;
  }

  const copyCurrentEventButton = event.target.closest("button[data-copy-current-event]");

  if (copyCurrentEventButton) {
    const content = copyCurrentEventButton.closest("[data-event-json]");
    await updateCopyButton(copyCurrentEventButton, content.dataset.eventJson);
    return;
  }

  const copyButton = event.target.closest("button[data-copy]");

  if (copyButton) {
    await updateCopyButton(copyButton, copyButton.dataset.copy);
    return;
  }

  const row = event.target.closest("[data-event-selectable]");

  if (!row || event.target.closest("a, button, input, select, summary, details")) {
    return;
  }

  selectEvent(row);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  const row = event.target.closest("[data-event-selectable]");

  if (!row || event.target !== row) {
    return;
  }

  event.preventDefault();
  selectEvent(row);
});

async function updateCopyButton(button, value) {
  const label = button.textContent;

  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
  } catch (_error) {
    button.textContent = "Copy failed";
  }

  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

function handleUpdatedContent(root) {
  updateLocalTimes(root);
  updateThemeControls();

  if (root.id === "app-shell") {
    delete document.documentElement.dataset.eventSelection;
  }

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

  if (activeElement.closest(".search-panel") !== null) {
    return;
  }

  const eventsList = document.querySelector("#events-list");

  if (eventsList.scrollTop < 160 && document.querySelector("details[open]") === null) {
    const link = liveStatus.querySelector("a[href]");
    window.location.assign(link.href);
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
