import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import NotificationDialogProvider from "./components/NotificationDialogProvider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <NotificationDialogProvider>
        <App />
      </NotificationDialogProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
