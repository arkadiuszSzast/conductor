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
  // resolution and silently operate on the wrong project. `relativePath`
  // may already carry its own query string (e.g. `../change?name=x`),
  // so the project query is merged onto it rather than blindly appended.
  function withQuery(relativePath) {
    const projectSearch = window.location.search
    if (projectSearch === "") return relativePath
    const separator = relativePath.includes("?") ? "&" : "?"
    return relativePath + separator + projectSearch.slice(1)
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

  // At most one change/archived entry is expanded at a time — the panel
  // is narrow (mobile sheet, desktop side column), so an accordion keeps
  // it readable. Both refs are reset whenever the listing is rebuilt
  // (refresh), since the DOM nodes they'd otherwise point at are gone.
  let expandedTile = null
  let expandedContainer = null

  function collapseExpanded() {
    if (expandedTile === null) return
    expandedTile.setAttribute("aria-expanded", "false")
    expandedContainer.hidden = true
    expandedTile = null
    expandedContainer = null
  }

  function toggleExpansion(tileEl, container, name) {
    if (expandedContainer === container) {
      collapseExpanded()
      return
    }
    collapseExpanded()
    tileEl.setAttribute("aria-expanded", "true")
    container.hidden = false
    expandedTile = tileEl
    expandedContainer = container
    if (container.dataset.loaded !== "true") loadDetail(name, container)
  }

  function attachExpansion(tileEl) {
    const name = tileEl.dataset.name
    // A `<li>` tile (archived entries) gets a `<li>` detail sibling so
    // the `<ul>` stays validly nested; regular tiles get a `<div>`.
    const container = document.createElement(tileEl.tagName === "LI" ? "li" : "div")
    container.className = "change-detail"
    container.hidden = true
    tileEl.insertAdjacentElement("afterend", container)

    tileEl.setAttribute("tabindex", "0")
    tileEl.setAttribute("role", "button")
    tileEl.setAttribute("aria-expanded", "false")

    const toggle = () => toggleExpansion(tileEl, container, name)
    tileEl.addEventListener("click", toggle)
    tileEl.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return
      if (event.target !== tileEl) return
      event.preventDefault()
      toggle()
    })
  }

  // The listing and the queue are loaded separately so a daemon that
  // cannot serve the queue (e.g. project not configured) degrades the
  // panel to start-work only, with the reason shown, instead of hiding
  // the changes.
  let listing = null
  let queue = null
  let queueError = null

  const LIVE_STARTED = ["starting", "running", "escalated"]

  /** The entry that represents a change in the queue: a live one wins
   *  over a final (`merged`) one. */
  function entryFor(name) {
    if (queue === null) return null
    let found = null
    for (const entry of queue.entries) {
      if (entry.change !== name) continue
      if (entry.status !== "merged") return entry
      found = entry
    }
    return found
  }

  function isQueued(entry) {
    return entry !== null && entry.status !== "merged"
  }

  function canDequeue(entry) {
    return isQueued(entry) && !LIVE_STARTED.includes(entry.status)
  }

  function stateKind(entry) {
    return entry.status || (entry.state && entry.state.kind)
  }

  function renderDependencies(change) {
    const deps = Array.isArray(change.dependsOn) ? change.dependsOn : []
    let html = '<div class="change-deps">'
    if (deps.length === 0) {
      html += '<span class="muted">No dependencies declared</span>'
    } else {
      html += '<span class="muted">Depends on</span> ' + deps.map(dep => "<code>" + escapeHtml(dep) + "</code>").join(", ")
    }
    html += "</div>"
    if (typeof change.dependsOnWarning === "string") {
      html += '<div class="change-warning">' + escapeHtml(change.dependsOnWarning) + "</div>"
    }
    return html
  }

  function renderQueueState(entry) {
    if (entry === null) return ""
    const kind = stateKind(entry)
    let html = '<div class="queue-state"><span class="badge badge-' + escapeHtml(kind) + '">' + escapeHtml(kind) + "</span>"
    if (typeof entry.reason === "string" && entry.reason !== "") {
      html += '<span class="queue-reason">' + escapeHtml(entry.reason) + "</span>"
    }
    return html + "</div>"
  }

  function renderQueueControls() {
    if (queue === null) {
      if (queueError === null) return ""
      return '<div class="queue-controls"><div class="queue-warning">Queue unavailable: ' + escapeHtml(queueError) + "</div></div>"
    }
    const paused = queue.settings.paused
    return (
      '<div class="queue-controls">' +
      '<span class="queue-title">Queue</span>' +
      (paused ? '<span class="badge badge-paused">paused</span>' : "") +
      '<button type="button" id="queue-pause">' + (paused ? "Resume" : "Pause") + "</button>" +
      '<label class="queue-limit">Parallelism ' +
      '<input type="number" id="queue-parallelism" min="1" step="1" value="' + escapeHtml(queue.settings.parallelism) + '" />' +
      "</label>" +
      '<div class="error-message" id="queue-error" hidden></div>' +
      "</div>"
    )
  }

  function renderChanges() {
    const active = listing.active || []
    const archived = listing.archived || []

    expandedTile = null
    expandedContainer = null

    let html =
      '<div class="toolbar"><h1>OpenSpec</h1><button type="button" id="refresh">Refresh</button></div>' +
      renderQueueControls()

    if (active.length === 0) {
      html += '<p class="empty">No active changes.</p>'
    } else {
      for (const change of active) {
        const entry = entryFor(change.name)
        let actions = '<button type="button" class="start-work">Start work</button>'
        if (queue !== null && canDequeue(entry)) {
          actions = '<button type="button" class="dequeue" data-entry="' + escapeHtml(entry.id) + '">Dequeue</button>' + actions
        } else if (queue !== null && !isQueued(entry)) {
          actions = '<button type="button" class="enqueue">Queue</button>' + actions
        }
        html +=
          '<div class="change" data-name="' + escapeHtml(change.name) + '">' +
          '<div class="change-name">' + escapeHtml(change.name) + "</div>" +
          renderDependencies(change) +
          renderQueueState(entry) +
          renderProgress(change.taskProgress) +
          '<div class="change-actions">' + actions + "</div>" +
          '<div class="error-message" hidden></div>' +
          "</div>"
      }
    }

    if (archived.length > 0) {
      html += '<div class="section-title">Archived</div><ul class="archived-list">'
      for (const name of archived) {
        html += '<li class="archived-item" data-name="' + escapeHtml(name) + '">' + escapeHtml(name) + "</li>"
      }
      html += "</ul>"
    }

    root.innerHTML = html

    const refreshButton = document.getElementById("refresh")
    if (refreshButton) refreshButton.addEventListener("click", load)

    for (const button of root.querySelectorAll(".start-work")) {
      button.addEventListener("click", event => {
        event.stopPropagation()
        startWork(button)
      })
    }

    for (const button of root.querySelectorAll(".enqueue")) {
      button.addEventListener("click", event => {
        event.stopPropagation()
        enqueue(button)
      })
    }

    for (const button of root.querySelectorAll(".dequeue")) {
      button.addEventListener("click", event => {
        event.stopPropagation()
        dequeue(button)
      })
    }

    const pauseButton = document.getElementById("queue-pause")
    if (pauseButton) pauseButton.addEventListener("click", () => updateQueueSettings({ paused: !queue.settings.paused }))
    const parallelismInput = document.getElementById("queue-parallelism")
    if (parallelismInput) {
      parallelismInput.addEventListener("change", () => {
        const value = Number(parallelismInput.value)
        if (parallelismInput.value.trim() === "" || !Number.isFinite(value)) {
          showQueueError("parallelism must be a whole number of at least 1")
          return
        }
        updateQueueSettings({ parallelism: value })
      })
    }

    for (const changeEl of root.querySelectorAll(".change")) attachExpansion(changeEl)
    for (const item of root.querySelectorAll(".archived-item")) attachExpansion(item)
  }

  function showError(errorEl, message) {
    errorEl.textContent = message
    errorEl.hidden = false
  }

  function showQueueError(message) {
    const errorEl = document.getElementById("queue-error")
    if (errorEl) showError(errorEl, message)
  }

  /** A request to the plugin backend; an API refusal resolves to
   *  `{ ok: false, message }` carrying the daemon's message verbatim. */
  async function request(method, path, body) {
    try {
      const response = await fetch(withQuery(path), {
        method,
        ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        return { ok: false, message: payload && payload.error ? String(payload.error) : "request failed (" + response.status + ")" }
      }
      return { ok: true, payload }
    } catch (error) {
      return { ok: false, message: String(error) }
    }
  }

  async function reloadQueue() {
    const result = await request("GET", "../queue")
    if (result.ok && result.payload && result.payload.settings && Array.isArray(result.payload.entries)) {
      queue = result.payload
      queueError = null
    } else {
      queue = null
      queueError = result.ok ? "unexpected response" : result.message
    }
  }

  async function enqueue(button) {
    const changeEl = button.closest(".change")
    const errorEl = changeEl.querySelector(".error-message")
    errorEl.hidden = true
    button.disabled = true
    const result = await request("POST", "../queue/entries", { change: changeEl.dataset.name })
    if (!result.ok) {
      showError(errorEl, result.message)
      button.disabled = false
      return
    }
    await reloadQueue()
    renderChanges()
  }

  async function dequeue(button) {
    const changeEl = button.closest(".change")
    const errorEl = changeEl.querySelector(".error-message")
    errorEl.hidden = true
    button.disabled = true
    const result = await request("DELETE", "../queue/entries/" + encodeURIComponent(button.dataset.entry))
    if (!result.ok) {
      showError(errorEl, result.message)
      button.disabled = false
      return
    }
    await reloadQueue()
    renderChanges()
  }

  async function updateQueueSettings(settings) {
    const result = await request("PATCH", "../queue", settings)
    if (!result.ok) {
      showQueueError(result.message)
      return
    }
    await reloadQueue()
    renderChanges()
  }

  async function runStartWork(name, button, errorEl) {
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

  function startWork(button) {
    const changeEl = button.closest(".change")
    const name = changeEl.dataset.name
    const errorEl = changeEl.querySelector(".error-message")
    return runStartWork(name, button, errorEl)
  }

  async function load() {
    root.innerHTML = '<p class="loading">Loading…</p>'
    try {
      const [response] = await Promise.all([fetch(withQuery("../changes")), reloadQueue()])
      const data = await response.json()
      if (!data.openspec) {
        renderEmptyState()
        return
      }
      listing = data
      renderChanges()
    } catch (error) {
      root.innerHTML = '<p class="error-message">' + escapeHtml(String(error)) + "</p>"
    }
  }

  // --- Change detail expansion ---------------------------------------
  //
  // Everything below builds DOM via createElement/textContent only —
  // proposal and requirement text comes from files in the target
  // project's repo, not from this plugin, so it is rendered as data,
  // never as HTML.

  function renderInlineNodes(text) {
    const nodes = []
    const codeParts = String(text).split(/(`[^`]+`)/g)
    for (const part of codeParts) {
      if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
        const code = document.createElement("code")
        code.textContent = part.slice(1, -1)
        nodes.push(code)
        continue
      }
      const boldParts = part.split(/(\*\*[^*]+\*\*)/g)
      for (const boldPart of boldParts) {
        if (boldPart === "") continue
        if (boldPart.length >= 4 && boldPart.startsWith("**") && boldPart.endsWith("**")) {
          const strong = document.createElement("strong")
          strong.textContent = boldPart.slice(2, -2)
          nodes.push(strong)
        } else {
          nodes.push(document.createTextNode(boldPart))
        }
      }
    }
    return nodes
  }

  /** Minimal, safe markdown rendering: paragraphs (blank-line
   *  separated), bullet lists (`- `), inline `code`, **bold**. A line
   *  that is itself a heading (`#`+) renders as a bold paragraph —
   *  fidelity beyond that is out of scope for this panel. */
  function renderMarkdownInto(container, markdown) {
    const blocks = String(markdown || "").split(/\n\s*\n/)
    for (const block of blocks) {
      const trimmedBlock = block.trim()
      if (trimmedBlock === "") continue
      const lines = trimmedBlock.split("\n").map(line => line.trim()).filter(line => line !== "")
      if (lines.length === 0) continue

      const isList = lines.every(line => /^[-*]\s+/.test(line))
      if (isList) {
        const list = document.createElement("ul")
        for (const line of lines) {
          const item = document.createElement("li")
          for (const node of renderInlineNodes(line.replace(/^[-*]\s+/, ""))) item.appendChild(node)
          list.appendChild(item)
        }
        container.appendChild(list)
        continue
      }

      const headingMatch = lines.length === 1 ? /^#{1,6}\s+(.*)$/.exec(lines[0]) : null
      const paragraph = document.createElement("p")
      if (headingMatch !== null) {
        const strong = document.createElement("strong")
        strong.textContent = headingMatch[1]
        paragraph.appendChild(strong)
      } else {
        for (const node of renderInlineNodes(lines.join(" "))) paragraph.appendChild(node)
      }
      container.appendChild(paragraph)
    }
  }

  function createCollapsibleSection(titleText) {
    const details = document.createElement("details")
    details.className = "detail-section"
    const summary = document.createElement("summary")
    summary.textContent = titleText
    details.appendChild(summary)
    const sectionBody = document.createElement("div")
    sectionBody.className = "detail-section-body"
    details.appendChild(sectionBody)
    return { details, sectionBody }
  }

  function renderDetailError(container, message) {
    container.textContent = ""
    const errorEl = document.createElement("p")
    errorEl.className = "error-message"
    errorEl.textContent = message
    container.appendChild(errorEl)
  }

  function renderDetailBody(container, data) {
    container.textContent = ""

    if (Array.isArray(data.tasks) && data.tasks.length > 0) {
      const done = data.tasks.filter(task => task.done).length
      const progressLine = document.createElement("div")
      progressLine.className = "progress-label"
      progressLine.textContent = done + " / " + data.tasks.length + " tasks"
      container.appendChild(progressLine)
    }

    const why = document.createElement("div")
    why.className = "detail-why"
    if (typeof data.why === "string" && data.why !== "") {
      renderMarkdownInto(why, data.why)
    } else {
      const empty = document.createElement("p")
      empty.className = "empty"
      empty.textContent = "No description yet."
      why.appendChild(empty)
    }
    container.appendChild(why)

    if (typeof data.whatChanges === "string" && data.whatChanges !== "") {
      const { details, sectionBody } = createCollapsibleSection("What Changes")
      renderMarkdownInto(sectionBody, data.whatChanges)
      container.appendChild(details)
    }

    if (Array.isArray(data.specs) && data.specs.length > 0) {
      const { details, sectionBody } = createCollapsibleSection("Requirements")
      for (const spec of data.specs) {
        const capabilityHeading = document.createElement("h3")
        capabilityHeading.className = "detail-capability"
        capabilityHeading.textContent = spec.capability
        sectionBody.appendChild(capabilityHeading)
        for (const requirement of spec.requirements || []) {
          const reqHeading = document.createElement("p")
          reqHeading.className = "detail-requirement-heading"
          const strong = document.createElement("strong")
          strong.textContent = requirement.heading
          reqHeading.appendChild(strong)
          sectionBody.appendChild(reqHeading)
          const reqBody = document.createElement("div")
          renderMarkdownInto(reqBody, requirement.body)
          sectionBody.appendChild(reqBody)
        }
      }
      container.appendChild(details)
    }

    if (Array.isArray(data.tasks) && data.tasks.length > 0) {
      const { details, sectionBody } = createCollapsibleSection("Tasks")
      const list = document.createElement("ul")
      list.className = "detail-tasks"
      for (const task of data.tasks) {
        const item = document.createElement("li")
        item.className = task.done ? "task-done" : "task-pending"
        const checkbox = document.createElement("input")
        checkbox.type = "checkbox"
        checkbox.checked = task.done
        checkbox.disabled = true
        const label = document.createElement("span")
        label.textContent = task.text
        item.appendChild(checkbox)
        item.appendChild(label)
        list.appendChild(item)
      }
      sectionBody.appendChild(list)
      container.appendChild(details)
    }
    // No start-work button here: the tile's own button stays visible
    // above the expanded area, so a second one would be redundant.
  }

  async function loadDetail(name, container) {
    container.textContent = ""
    const loading = document.createElement("p")
    loading.className = "loading"
    loading.textContent = "Loading…"
    container.appendChild(loading)
    try {
      const response = await fetch(withQuery("../change?name=" + encodeURIComponent(name)))
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null) {
        renderDetailError(container, (payload && payload.error) || "failed to load change")
        return
      }
      renderDetailBody(container, payload)
      container.dataset.loaded = "true"
    } catch (error) {
      renderDetailError(container, String(error))
    }
  }

  postToHost("ready", { v: BRIDGE_VERSION })
  load()
})()
