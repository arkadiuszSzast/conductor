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

    for (const changeEl of root.querySelectorAll(".change")) {
      changeEl.addEventListener("click", () => openModal(changeEl.dataset.name))
    }

    for (const item of root.querySelectorAll(".archived-item")) {
      item.addEventListener("click", () => openModal(item.dataset.name))
    }
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

  // --- Detail modal -------------------------------------------------
  //
  // Everything below builds DOM via createElement/textContent only —
  // proposal and requirement text comes from files in the target
  // project's repo, not from this plugin, so it is rendered as data,
  // never as HTML.

  let currentModal = null
  let currentModalKeydownHandler = null

  function closeModal() {
    if (currentModalKeydownHandler !== null) {
      document.removeEventListener("keydown", currentModalKeydownHandler)
      currentModalKeydownHandler = null
    }
    if (currentModal !== null) {
      currentModal.remove()
      currentModal = null
    }
  }

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
    details.className = "modal-section"
    const summary = document.createElement("summary")
    summary.textContent = titleText
    details.appendChild(summary)
    const sectionBody = document.createElement("div")
    sectionBody.className = "modal-section-body"
    details.appendChild(sectionBody)
    return { details, sectionBody }
  }

  function renderModalError(body, message) {
    body.textContent = ""
    const errorEl = document.createElement("p")
    errorEl.className = "error-message"
    errorEl.textContent = message
    body.appendChild(errorEl)
  }

  function renderModalDetail(body, data) {
    body.textContent = ""

    if (Array.isArray(data.tasks) && data.tasks.length > 0) {
      const done = data.tasks.filter(task => task.done).length
      const progressLine = document.createElement("div")
      progressLine.className = "progress-label"
      progressLine.textContent = done + " / " + data.tasks.length + " tasks"
      body.appendChild(progressLine)
    }

    const why = document.createElement("div")
    why.className = "modal-why"
    if (typeof data.why === "string" && data.why !== "") {
      renderMarkdownInto(why, data.why)
    } else {
      const empty = document.createElement("p")
      empty.className = "empty"
      empty.textContent = "No description yet."
      why.appendChild(empty)
    }
    body.appendChild(why)

    if (typeof data.whatChanges === "string" && data.whatChanges !== "") {
      const { details, sectionBody } = createCollapsibleSection("What Changes")
      renderMarkdownInto(sectionBody, data.whatChanges)
      body.appendChild(details)
    }

    if (Array.isArray(data.specs) && data.specs.length > 0) {
      const { details, sectionBody } = createCollapsibleSection("Requirements")
      for (const spec of data.specs) {
        const capabilityHeading = document.createElement("h3")
        capabilityHeading.className = "modal-capability"
        capabilityHeading.textContent = spec.capability
        sectionBody.appendChild(capabilityHeading)
        for (const requirement of spec.requirements || []) {
          const reqHeading = document.createElement("p")
          reqHeading.className = "modal-requirement-heading"
          const strong = document.createElement("strong")
          strong.textContent = requirement.heading
          reqHeading.appendChild(strong)
          sectionBody.appendChild(reqHeading)
          const reqBody = document.createElement("div")
          renderMarkdownInto(reqBody, requirement.body)
          sectionBody.appendChild(reqBody)
        }
      }
      body.appendChild(details)
    }

    if (Array.isArray(data.tasks) && data.tasks.length > 0) {
      const { details, sectionBody } = createCollapsibleSection("Tasks")
      const list = document.createElement("ul")
      list.className = "modal-tasks"
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
      body.appendChild(details)
    }

    if (!data.archived) {
      const actions = document.createElement("div")
      actions.className = "change-actions"
      const button = document.createElement("button")
      button.type = "button"
      button.className = "start-work"
      button.textContent = "Start work"
      const errorEl = document.createElement("div")
      errorEl.className = "error-message"
      errorEl.hidden = true
      button.addEventListener("click", () => runStartWork(data.name, button, errorEl))
      actions.appendChild(button)
      body.appendChild(actions)
      body.appendChild(errorEl)
    }
  }

  async function loadModalDetail(name, body) {
    try {
      const response = await fetch(withQuery("../change?name=" + encodeURIComponent(name)))
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null) {
        renderModalError(body, (payload && payload.error) || "failed to load change")
        return
      }
      renderModalDetail(body, payload)
    } catch (error) {
      renderModalError(body, String(error))
    }
  }

  function openModal(name) {
    if (!name) return
    closeModal()

    const overlay = document.createElement("div")
    overlay.className = "modal-overlay"
    overlay.addEventListener("click", event => {
      if (event.target === overlay) closeModal()
    })

    const panel = document.createElement("div")
    panel.className = "modal-panel"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-modal", "true")
    overlay.appendChild(panel)

    const header = document.createElement("div")
    header.className = "modal-header"
    const title = document.createElement("h2")
    title.className = "modal-title"
    title.textContent = name
    const closeButton = document.createElement("button")
    closeButton.type = "button"
    closeButton.className = "modal-close"
    closeButton.setAttribute("aria-label", "Close")
    closeButton.textContent = "×"
    closeButton.addEventListener("click", closeModal)
    header.appendChild(title)
    header.appendChild(closeButton)
    panel.appendChild(header)

    const body = document.createElement("div")
    body.className = "modal-body"
    const loading = document.createElement("p")
    loading.className = "loading"
    loading.textContent = "Loading…"
    body.appendChild(loading)
    panel.appendChild(body)

    document.body.appendChild(overlay)
    currentModal = overlay

    currentModalKeydownHandler = event => {
      if (event.key === "Escape") closeModal()
    }
    document.addEventListener("keydown", currentModalKeydownHandler)

    loadModalDetail(name, body)
  }

  postToHost("ready", { v: BRIDGE_VERSION })
  load()
})()
