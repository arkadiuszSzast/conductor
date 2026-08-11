import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./styles/global.css"
import { App } from "./app.tsx"

const el = document.getElementById("root")
if (el === null) throw new Error("#root element not found")
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
