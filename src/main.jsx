import React from "react";
import ReactDOM from "react-dom/client";
import "./storage.js"; // moet vóór App geladen worden: zet window.storage klaar
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
