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

setInterval(() => updateLocalTimes(), 30_000);

document.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const button = event.target.closest("button[data-copy]");

  if (!button) {
    return;
  }

  const label = button.textContent;

  try {
    await copyText(button.dataset.copy);
    button.textContent = "Copied";
  } catch (_error) {
    button.textContent = "Copy failed";
  }

  setTimeout(() => {
    button.textContent = label;
  }, 1200);
});

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
  const warning = document.querySelector("#transient-warning");

  if (warning) {
    warning.hidden = true;
  }

  const liveStatus = document.querySelector("#live-status[data-new-count]");

  if (!liveStatus || Number(liveStatus.dataset.newCount) === 0) {
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
