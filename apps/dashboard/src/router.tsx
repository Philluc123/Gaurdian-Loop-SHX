// Three routes don't warrant a router dependency.
//   /                 live view of the latest call
//   /call/:callId     live view of one call — the link in the guardian's notification
//   /history[/:id]    call history and one call's stored record

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

export type Route =
  | { name: "live"; callId: string | "latest" }
  | { name: "history"; callId?: string };

export function parseRoute(pathname: string): Route {
  const call = pathname.match(/^\/call\/([^/]+)\/?$/);
  if (call) return { name: "live", callId: decodeURIComponent(call[1]) };
  const hist = pathname.match(/^\/history(?:\/([^/]+))?\/?$/);
  if (hist) return { name: "history", callId: hist[1] && decodeURIComponent(hist[1]) };
  return { name: "live", callId: "latest" };
}

export function navigate(to: string) {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return parseRoute(path);
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
