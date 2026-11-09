/** @jsxImportSource hono/jsx/dom */

import { render } from "hono/jsx/dom";
import { App } from "./app";

const root = document.getElementById("root");

if (root !== null) {
  render(<App />, root);
}
