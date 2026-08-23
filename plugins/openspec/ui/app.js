(function () {
  "use strict"

  const BRIDGE_VERSION = 1
  const root = document.getElementById("root")
  const hostOrigin = window.location.origin

  function postToHost(type, payload) {
    if (window.parent === window) return
    window.parent.postMessage({ conductor: true, v: BRIDGE_VERSION, type, payload }, hostOrigin)
  }

  // The panel's own iframe src carries `?project=<id>` (the host appends
  // it so the daemon's proxy resolves THIS project's plugin when the
  // same plugin id is installed in more than one project — see M7 in
  // the plugin-system change). Panel fetches must preserve that same
  // query string, or they would fall back to the daemon's global-first
  // resolution and silently operate on the wrong project.
  function withQuery(relativePath) {
    return relativePath + window.location.search
  }

  function parseHostMessage(data) {
    if (typeof data !== "object" || data === null) return null
    if (data.conductor !== true || data.v !== BRIDGE_VERSION) return null
    if (data.type !== "context" && data.type !== "context-changed") return null
    return data
  }

  window.addEventListener("message", event => {
    if (event.origin !== hostOrigin) return
    const message = parseHostMessage(event.data)
    if (message === null) return
    applyTheme(message.payload && message.payload.theme)
  })

  function applyTheme(theme) {
    if (theme && theme.mode) document.documentElement.dataset.theme = theme.mode
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]))
  }

  function renderProgress(progress) {
    if (!progress) return ""
    const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
    return (
      '<div class="progress-track"><div class="progress-fill" style="width:' + percent + '%"></div></div>' +
      '<div class="progress-label">' + progress.done + " / " + progress.total + " tasks</div>"
    )
  }

  function renderEmptyState() {
    root.innerHTML =
      '<div class="empty">' +
      "<p>OpenSpec is not initialised in this project.</p>" +
      '<p>Run <code>openspec init</code> to get started.</p>' +
      "</div>"
  }

  function renderChanges(data) {
    const active = data.active || []
    const archived = data.archived || []

    let html = '<div class="toolbar"><h1>OpenSpec</h1><button type="button" id="refresh">Refresh</button></div>'

    if (active.length === 0) {
      html += '<p class="empty">No active changes.</p>'
    } else {
      for (const change of active) {
        html +=
          '<div class="change" data-name="' + escapeHtml(change.name) + '">' +
          '<div class="change-name">' + escapeHtml(change.name) + "</div>" +
          renderProgress(change.taskProgress) +
          '<div class="change-actions"><button type="button" class="start-work">Start work</button></div>' +
          '<div class="error-message" hidden></div>' +
          "</div>"
      }
    }

    if (archived.length > 0) {
      html += '<div class="section-title">Archived</div><ul class="archived-list">'
      for (const name of archived) html += "<li>" + escapeHtml(name) + "</li>"
      html += "</ul>"
    }

    root.innerHTML = html

    const refreshButton = document.getElementById("refresh")
    if (refreshButton) refreshButton.addEventListener("click", load)

    for (const button of root.querySelectorAll(".start-work")) {
      button.addEventListener("click", () => startWork(button))
    }
  }

  async function startWork(button) {
    const changeEl = button.closest(".change")
    const name = changeEl.dataset.name
    const errorEl = changeEl.querySelector(".error-message")
    errorEl.hidden = true
    button.disabled = true
    button.textContent = "Starting…"
    try {
      const response = await fetch(withQuery("../start-work"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ change: name }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || !payload.featureId) {
        const message = payload && payload.error ? payload.error : "failed to start work"
        errorEl.textContent = message
        errorEl.hidden = false
        button.disabled = false
        button.textContent = "Start work"
        return
      }
      postToHost("navigate", { to: { feature: payload.featureId } })
    } catch (error) {
      errorEl.textContent = String(error)
      errorEl.hidden = false
      button.disabled = false
      button.textContent = "Start work"
    }
  }

  async function load() {
    root.innerHTML = '<p class="loading">Loading…</p>'
    try {
      const response = await fetch(withQuery("../changes"))
      const data = await response.json()
      if (!data.openspec) {
        renderEmptyState()
        return
      }
      renderChanges(data)
    } catch (error) {
      root.innerHTML = '<p class="error-message">' + escapeHtml(String(error)) + "</p>"
    }
  }

  postToHost("ready", { v: BRIDGE_VERSION })
  load()
})()
