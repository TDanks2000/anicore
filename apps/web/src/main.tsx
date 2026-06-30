import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import "./styles.css";
import { ThemeProvider } from "./theme-provider";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Root element not found");
}

createRoot(root).render(
	<StrictMode>
		<ThemeProvider defaultTheme="system">
			<App />
		</ThemeProvider>
	</StrictMode>,
);
