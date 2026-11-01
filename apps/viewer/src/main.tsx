import { useSignal } from "@preact/signals";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { ErrorBoundary, LocationProvider, Route, Router } from "preact-iso";
import { InstallSheet } from "./components/install.tsx";
import { Sheet } from "./components/sheets.tsx";
import { askInstall } from "./notify.ts";
import { Activity } from "./routes/activity.tsx";
import { AlmostReady } from "./routes/almost-ready.tsx";
import { ArtifactPage } from "./routes/artifact.tsx";
import { ComparePage } from "./routes/compare.tsx";
import { Connect } from "./routes/connect.tsx";
import { RecentlyDeleted } from "./routes/deleted-list.tsx";
import { Device } from "./routes/device.tsx";
import { GuestLanding } from "./routes/guest.tsx";
import { Home } from "./routes/home.tsx";
import { Join } from "./routes/join.tsx";
import { NotFound } from "./routes/not-found.tsx";
import { PageRoute } from "./routes/page.tsx";
import { ProjectPage } from "./routes/project.tsx";
import { Projects } from "./routes/projects.tsx";
import { Reset } from "./routes/reset.tsx";
import { SearchBox, SearchPage } from "./routes/search.tsx";
import { Settings } from "./routes/settings.tsx";
import { SignIn } from "./routes/sign-in.tsx";
import { boot, bootFailed, me, meta, ready } from "./session.ts";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/kit.css";

/** ⌘K, anywhere for anyone signed in (board 04). */
function QuickSearch() {
  const open = useSignal(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey) && me.value) {
        event.preventDefault();
        open.value = !open.value;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  if (!open.value) return null;
  const close = () => {
    open.value = false;
  };
  return (
    <Sheet title="Search" onClose={close}>
      <SearchBox onPick={close} />
    </Sheet>
  );
}

function App() {
  if (!ready.value) return null;
  if (bootFailed.value) {
    return (
      <main class="screen">
        <h1 class="h1 m">The server isn't answering</h1>
      </main>
    );
  }
  // In setup mode, every route renders the same page (06).
  if (!meta.value?.orgName) return <AlmostReady />;
  return (
    <LocationProvider>
      <ErrorBoundary>
        <Router>
          <Route path="/" component={Home} />
          <Route path="/projects" component={Projects} />
          <Route path="/activity" component={Activity} />
          <Route path="/search" component={SearchPage} />
          <Route path="/sign-in" component={SignIn} />
          <Route path="/device" component={Device} />
          <Route path="/device/connect" component={Connect} />
          <Route path="/reset/:token" component={Reset} />
          <Route path="/join/:token" component={Join} />
          <Route path="/s/:token" component={GuestLanding} />
          <Route path="/settings" component={Settings} />
          <Route path="/settings/deleted" component={RecentlyDeleted} />
          <Route path="/settings/:section" component={Settings} />
          <Route path="/settings/teams/:slug" component={Settings} />
          <Route path="/:project" component={ProjectPage} />
          <Route path="/:project/:artifact" component={ArtifactPage} />
          <Route path="/:project/:artifact/compare" component={ComparePage} />
          <Route path="/:project/:artifact/v/:n" component={PageRoute} />
          <Route path="/:project/:artifact/v/:n/:page" component={PageRoute} />
          <Route path="/:project/:artifact/:page" component={PageRoute} />
          <Route default component={NotFound} />
        </Router>
        <QuickSearch />
        {askInstall.value && (
          <InstallSheet
            onClose={() => {
              askInstall.value = false;
            }}
          />
        )}
      </ErrorBoundary>
    </LocationProvider>
  );
}

boot();
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
render(<App />, document.getElementById("app") as HTMLElement);
