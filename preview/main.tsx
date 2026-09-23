import { createRoot } from "react-dom/client";
import { State } from "../app/workspace";
import PreviewAuth from "./preview-auth";
import "../app/globals.css";

const initialState: State = {
  activities: [],
  tasks: [],
  meetings: [],
  notices: [],
  registrationForms: [],
  registrationSubmissions: [],
};

createRoot(document.getElementById("root")!).render(<PreviewAuth initialState={initialState} />);
