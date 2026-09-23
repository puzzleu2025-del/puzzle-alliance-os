import { createRoot } from "react-dom/client";
import { State } from "../app/workspace";
import PreviewAuth from "./preview-auth";
import SharedEntry from "./shared-entry";
import "../app/globals.css";

const initialState: State = {
  activities: [],
  tasks: [],
  meetings: [],
  notices: [],
  registrationForms: [],
  registrationSubmissions: [],
};

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(window.location.search).get("local") === "1"
    ? <PreviewAuth initialState={initialState} />
    : <SharedEntry initialState={initialState} />,
);
