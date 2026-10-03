// SHARD — tiny hash-free router over the History API. Routes:
// "/" landing, "/new" session setup, "/room/:id" E2EE chat,
// "/donate" support, "/security" & "/terms" documentation pages.
import { useEffect, useState } from "react";
import Landing from "./pages/Landing";
import SessionSetup from "./pages/SessionSetup";
import Donate from "./pages/Donate";
import Security from "./pages/Security";
import Terms from "./pages/Terms";
import { Room } from "./components/chat/Room";

export type Route =
  | { name: "landing" }
  | { name: "setup" }
  | { name: "donate" }
  | { name: "security" }
  | { name: "terms" }
  | { name: "room"; roomId: string };

export function readRoute(): Route {
  const path = window.location.pathname;
  if (path === "/new") return { name: "setup" };
  if (path === "/donate") return { name: "donate" };
  if (path === "/security") return { name: "security" };
  if (path === "/terms") return { name: "terms" };
  const m = path.match(/^\/room\/([A-Za-z0-9]+)/);
  if (m?.[1]) return { name: "room", roomId: m[1] };
  return { name: "landing" };
}

/** Programmatic navigation with a real history entry (back button works). */
export function navigate(to: string) {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const sync = () => setRoute(readRoute());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  switch (route.name) {
    case "setup":
      return <SessionSetup />;
    case "donate":
      return <Donate />;
    case "security":
      return <Security />;
    case "terms":
      return <Terms />;
    case "room":
      return (
        <Room
          roomId={route.roomId}
          onExit={() => {
            window.history.pushState(null, "", "/");
            setRoute({ name: "landing" });
          }}
        />
      );
    default:
      return <Landing />;
  }
}
