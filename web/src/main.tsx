import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppRoutes } from "@/App";
import { loadRuntimeConfig, RuntimeConfigProvider } from "@/config/runtime-config";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/theme/theme";
import "./index.css";

async function boot() {
  const config = await loadRuntimeConfig();
  document.title = config.appName;
  const root = document.getElementById("root");
  if (!root) throw new Error("#root not found");
  createRoot(root).render(
    <StrictMode>
      <RuntimeConfigProvider config={config}>
        <ThemeProvider>
          <TooltipProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </RuntimeConfigProvider>
    </StrictMode>,
  );
}

void boot();
